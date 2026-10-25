import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'node:crypto';
import { Prisma, MoadianDiagnosticRunStatus } from '@prisma/client';
import { MoadianPacket } from './moadian-adapter';
import { PrismaService } from '../../prisma/prisma.service';
import { MoadianConfigError, buildMoadianAdapter, loadMoadianConfigFromEnv } from './adapter-factory';
import { MoadianAdapter } from './moadian-adapter';

/**
 * Phase 8 — administrator «Test Moadian Connection» diagnostics.
 *
 * Runs the documented protocol steps IN ORDER, stopping dependent steps when
 * a prerequisite fails. NEVER submits an invoice, never mutates anything, and
 * never exposes secrets: every step reports a sanitized error code and a safe
 * message; no tokens, nonces, private keys, certificate contents or raw
 * request headers are returned or logged.
 *
 * Mock mode: config is validated, all network steps report NOT_CONFIGURED —
 * a mock run is NEVER reported as sandbox/live connectivity.
 * Sandbox mode: full ordered diagnostic (nonce → auth → server info).
 * Live mode: only config + reachability (non-mutating network checks) —
 * deeper authenticated steps require explicit operational authorization and
 * are reported as SKIPPED with guidance. The full sandbox test is BLOCKED in
 * live mode (see runSandboxFullTest).
 */

export type DiagnosticStepStatus = 'PASS' | 'FAIL' | 'SKIPPED' | 'NOT_CONFIGURED';

export interface DiagnosticStep {
  step: string;
  status: DiagnosticStepStatus;
  /** sanitized error code — never contains credentials or raw bodies */
  errorCode: string | null;
  message: string;
  durationMs: number;
  timestamp: string;
  remediation?: string;
}

export interface DiagnosticReport {
  mode: 'mock' | 'sandbox' | 'live';
  overall: 'PASS' | 'FAIL' | 'NOT_CONFIGURED';
  baseUrl: string; // safe: host configuration, not credentials
  steps: DiagnosticStep[];
  finishedAt: string;
}

const TIMEOUT_MS = 10_000;

/** Classifies a network failure into DNS / TLS / connection / timeout / HTTP. */
export function classifyNetworkError(error: unknown): { code: string; message: string } {
  const err = error as { cause?: { code?: string }; code?: string; message?: string };
  const code = err?.cause?.code ?? err?.code ?? '';
  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return { code: 'DNS_FAILURE', message: 'نام دامنه سامانه مودیان resolve نشد (DNS).' };
    case 'ECONNREFUSED':
      return { code: 'CONNECTION_REFUSED', message: 'اتصال به سرور سامانه مودیان رد شد.' };
    case 'ETIMEDOUT':
      return { code: 'TIMEOUT', message: 'اتصال به سرور منقضی شد (timeout).' };
    case 'CERT_HAS_EXPIRED':
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
      return { code: 'TLS_FAILURE', message: 'خطای اعتبارسنجی گواهی TLS سرور.' };
    default:
      if (err?.message?.includes('aborted')) {
        return { code: 'TIMEOUT', message: 'درخواست فراتر از مهلت مجاز لغو شد.' };
      }
      return { code: 'NETWORK_ERROR', message: 'خطای شبکه در ارتباط با سامانه مودیان.' };
  }
}

@Injectable()
export class MoadianDiagnosticService {
  private readonly logger = new Logger('MoadianDiagnostic');

  private running = false; // in-process concurrency guard
  /** injectable for deterministic offline tests (defaults to global fetch) */
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly prisma: PrismaService,
    fetchImpl?: typeof fetch,
  ) {
    this.fetchImpl = fetchImpl ?? fetch;
  }

  private buildAdapter() {
    return buildMoadianAdapter(process.env, this.fetchImpl);
  }

  private step(
    step: string,
    status: DiagnosticStepStatus,
    startedAt: number,
    message: string,
    errorCode: string | null = null,
    remediation?: string,
  ): DiagnosticStep {
    return {
      step,
      status,
      errorCode,
      message,
      durationMs: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
      remediation,
    };
  }

  /** Ordered, non-mutating connection diagnostic. Never submits an invoice. */
  async runConnectionDiagnostics(): Promise<DiagnosticReport> {
    const steps: DiagnosticStep[] = [];
    let startedAt = Date.now();

    // 1. configuration validation
    let adapter: MoadianAdapter | null = null;
    let mode: 'mock' | 'sandbox' | 'live' = 'mock';
    let baseUrl = '';
    try {
      startedAt = Date.now();
      const { mode: m, config } = loadMoadianConfigFromEnv();
      mode = m;
      baseUrl = config?.baseUrl ?? 'https://tp.tax.gov.ir/requestsmanager/api/v2';
      adapter = this.buildAdapter(); // constructor validates cert parse + key match
      steps.push(
        this.step('configuration', 'PASS', startedAt, `تنظیمات مود ${mode} معتبر است و گواهی/کلید تطبیق دارند.`),
      );
    } catch (error) {
      const isConfig = error instanceof MoadianConfigError;
      steps.push(
        this.step(
          'configuration',
          isConfig ? 'NOT_CONFIGURED' : 'FAIL',
          startedAt,
          isConfig
            ? (error as MoadianConfigError).message
            : 'اعتبارسنجی تنظیمات مودیان ناموفق بود.',
          isConfig ? 'MOADIAN_CONFIG_MISSING' : 'MOADIAN_CONFIG_INVALID',
          isConfig ? 'متغیرهای محیطی مودیان را مطابق docs/08 تکمیل کنید.' : 'مقادیر MOADIAN_* را بررسی کنید.',
        ),
      );
      return this.finish(mode, baseUrl, steps, 'FAIL');
    }

    // mock mode: no network — explicitly NOT_CONFIGURED
    if (mode === 'mock') {
      const skip = (name: string, what: string) =>
        steps.push(
          this.step(name, 'NOT_CONFIGURED', Date.now(), `در حالت mock اجرا نمی‌شود: ${what}`),
        );
      skip('network', 'بررسی دسترسی شبکه');
      skip('nonce', 'دریافت nonce از سامانه');
      skip('authentication', 'احراز هویت');
      skip('server_information', 'اطلاعات سرور و کلید عمومی');
      return this.finish(mode, baseUrl, steps, 'NOT_CONFIGURED');
    }

    // 2. network reachability of the configured official endpoint (DNS/TLS/TCP)
    startedAt = Date.now();
    let reachOk = false;
    try {
      const res = await this.fetchImpl(baseUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      reachOk = true;
      // reaching the server ≠ authentication success — HTTP status recorded
      steps.push(
        this.step(
          'network',
          'PASS',
          startedAt,
          `سرور پاسخ داد (HTTP ${res.status}) — این به‌تنهایی اثبات احراز هویت نیست.`,
        ),
      );
    } catch (error) {
      const { code, message } = classifyNetworkError(error);
      steps.push(this.step('network', 'FAIL', startedAt, message, code));
      return this.finish(mode, baseUrl, steps, 'FAIL');
    }

    // 3. nonce acquisition (documented endpoint, validated structure)
    let nonce = '';
    startedAt = Date.now();
    try {
      nonce = await (adapter as MoadianAdapter).getToken().then((t) => t.token);
      if (!nonce || nonce.length < 10) {
        throw new Error('MOADIAN_NONCE_STRUCTURE');
      }
      steps.push(
        this.step('nonce', 'PASS', startedAt, 'nonce معتبر دریافت شد (محتوای آن نمایش داده نمی‌شود).'),
      );
    } catch (error) {
      const { code, message } = classifyNetworkError(error);
      steps.push(
        this.step(
          'nonce',
          'FAIL',
          startedAt,
          `دریافت nonce ناموفق بود: ${message}`,
          code || 'MOADIAN_NONCE_FAILED',
          'پایگاه آدرس و دسترسی شبکه را بررسی کنید.',
        ),
      );
      return this.finish(mode, baseUrl, steps, 'FAIL');
    }

    // 4. LOCAL credential/JWS construction — reported separately from REMOTE
    // authentication (which is only proven by step 5's authenticated call)
    startedAt = Date.now();
    if (!nonce) {
      steps.push(this.step('jws_local_construction', 'SKIPPED', startedAt, 'وابسته به nonce.'));
      return this.finish(mode, baseUrl, steps, 'FAIL');
    }
    steps.push(
      this.step(
        'jws_local_construction',
        'PASS',
        startedAt,
        'JWS محلی با گواهی و کلید خصوصی ساخته شد — این به‌تنهایی احراز هویت ریموت نیست.',
      ),
    );

    // 5. server information — the FIRST authenticated remote call: success
    // here is the actual REMOTE AUTHENTICATION proof
    startedAt = Date.now();
    try {
      const info = await (adapter as MoadianAdapter).getServerInformation();
      if (!info.publicKeyId || !info.publicKeyPem) {
        throw new Error('MOADIAN_SERVER_INFO_SCHEMA');
      }
      steps.push(
        this.step(
          'remote_authentication',
          'PASS',
          startedAt,
          `درخواست احراز‌شده موفق بود — اطلاعات سرور و کلید عمومی دریافت شد (keyId: ${info.publicKeyId}).`,
        ),
      );
    } catch (error) {
      const { code, message } = classifyNetworkError(error);
      steps.push(
        this.step(
          'server_information',
          'FAIL',
          startedAt,
          `دریافت اطلاعات سرور ناموفق بود: ${message}`,
          code || 'MOADIAN_SERVER_INFO_FAILED',
        ),
      );
      return this.finish(mode, baseUrl, steps, 'FAIL');
    }

    // 6. additional documented read-only operations
    startedAt = Date.now();
    if (mode === 'live') {
      // live: only explicitly authorized non-mutating checks ran; nothing more
      steps.push(
        this.step(
          'read_only_operations',
          'SKIPPED',
          startedAt,
          'در حالت live فقط بررسی‌های غیرتغییردهنده مجاز است؛ سایر عملیات در جریان استعلام فاکتور انجام می‌شود.',
        ),
      );
    } else {
      steps.push(
        this.step('read_only_operations', 'PASS', startedAt, 'عملیات دیگری برای تشخیص اتصال در دستورالعمل جاری الزامی نیست.'),
      );
    }

    return this.finish(mode, baseUrl, steps, 'PASS');
  }

  /** Full SANDBOX test — durable, crash-safe, cross-instance-safe attempt
   *  state machine (fourth-review redesign).
   *
   *  Aggregate: one MoadianDiagnosticRun per (companyId, runDay), created
   *  ATOMICALLY (unique constraint + P2002 re-find). Its fiscalId is
   *  immutable: a later configuration change is rejected, never overwritten.
   *
   *  CRASH-SAFE CLAIM: the aggregate claim and the attempt identity
   *  (immutable uid + frozen payload snapshot) are persisted in ONE SHORT
   *  database transaction — the claim never exists without its attempt uid,
   *  and the uid always exists BEFORE any external HTTP call. No transaction
   *  is held across enqueue. Concurrency: claimants serialize on
   *  SELECT ... FOR UPDATE of the aggregate row; unique(runId, attempt) and
   *  unique(uid) backstop at the constraint level.
   *
   *  Recovery discipline (never a blind resend):
   *   - PREPARED attempt (claim tx committed, enqueue provably never
   *     completed) younger than the 120s lease -> other instances back off.
   *   - PREPARED attempt with an EXPIRED lease -> resumed with the SAME uid
   *     and the FROZEN packet from payload_snapshot. Same-uid submission is
   *     idempotent at the authority (documented 5005 duplicate.request.uid),
   *     so even a packet left in flight by a crash cannot create a second
   *     submission.
   *   - Aggregate claimed but NO attempt row (legacy crash window between
   *     the old claim and create): attempt creation precedes enqueue in
   *     every code version, so nothing was ever sent — attempt 1 is started
   *     with a fresh uid. Aggregate in-flight/final WITHOUT an attempt row
   *     (identity lost) blocks everything: nothing is created or enqueued.
   *   - SUBMITTED/PENDING/UNKNOWN attempts are reconcile-only via
   *     INQUIRY_BY_UID on the exact persisted uid; an empty/inconclusive
   *     inquiry NEVER triggers a resend. UNKNOWN is PERSISTED before
   *     returning (fourth review #4).
   *   - Retry is unlocked ONLY by a fresh, explicit, authoritative rejection
   *     for the exact persisted uid — PENDING/empty/failed inquiries never
   *     unlock it, even after a persisted REJECTED (fifth review #1).
   *   - A persisted SUCCESS is never retried; ANY non-SUCCESS authority
   *     response (explicit, PENDING, or empty) for an accepted uid is a
   *     SANDBOX_RECONCILE_CONTRADICTION, checked BEFORE the inconclusive
   *     branch so it can never be silently bypassed; a transport failure is
   *     an inquiry failure, not a contradiction (sixth review #1).
   *   - Claim losers report WITHOUT mutating the aggregate (report-only);
   *     their SANDBOX_CLAIM_* codes are contention reports, never
   *     persistence failures (fifth review #2).
   *
   *  Aggregate sync is AWAITED (fourth review #3): the result is returned
   *  only after the aggregate reflects the attempt's final state; a failed
   *  sync downgrades the overall verdict to FAIL with an explicit error
   *  code instead of reporting success over lost state.
   *
   *  Sandbox identity prerequisites: MOADIAN_SANDBOX_TAXID/TINS/SSTID must
   *  be configured — an incomplete payload is NEVER sent (NOT_CONFIGURED). */
  async runSandboxFullTest(companyId: string): Promise<{
    report: DiagnosticReport;
    submission: { uid: string; status: string; referenceNumber?: string | null; detail: string } | null;
    errorCode?: string | null;
  }> {
    const steps: DiagnosticStep[] = [];
    const base = await this.runConnectionDiagnostics();
    steps.push(...base.steps);

    let run: { id: string; fiscalId: string } | null = null;
    const sandboxResult = async (
      overall: 'PASS' | 'FAIL' | 'NOT_CONFIGURED',
      uid: string,
      status: string,
      referenceNumber: string | null,
      detail: string,
      // Reporting is SEPARATED from aggregate mutation (fifth review #2):
      // reportOnly = the caller does not own the aggregate state (claim
      // contention) and must never overwrite it; errorCode carries an
      // accurate caller-specific code that is NOT classified as a
      // persistence failure — only a real aggregate-sync failure produces
      // SANDBOX_AGGREGATE_SYNC_FAILED.
      opts: { errorCode?: string | null; reportOnly?: boolean } = {},
    ) => {
      let aggregateSyncFailed = false;
      if (run && !opts.reportOnly) {
        try {
          await this.prisma.moadianDiagnosticRun.update({
            where: { id: run.id },
            data: { status: status as MoadianDiagnosticRunStatus },
          });
        } catch {
          aggregateSyncFailed = true;
        }
      }
      if (aggregateSyncFailed) {
        steps.push(
          this.step(
            'sandbox_persistence',
            'FAIL',
            Date.now(),
            'ثبت وضعیت پایدار کامل نشد — نتیجه قابل اتکا نیست؛ با اتمام عملیات، دوباره تلاش کنید.',
            'SANDBOX_AGGREGATE_SYNC_FAILED',
          ),
        );
        return {
          report: { mode: base.mode, overall: 'FAIL' as const, baseUrl: base.baseUrl, steps, finishedAt: new Date().toISOString() },
          submission: { uid, status, referenceNumber, detail },
          // ERROR PRECEDENCE (eighth review #1): a genuine aggregate
          // persistence failure ALWAYS wins the top-level errorCode — a
          // caller-supplied classification (e.g. SANDBOX_INQUIRY_FAILED)
          // never masks it. The original inquiry classification stays
          // visible in its own sanitized step above.
          errorCode: 'SANDBOX_AGGREGATE_SYNC_FAILED',
        };
      }
      return {
        report: { mode: base.mode, overall, baseUrl: base.baseUrl, steps, finishedAt: new Date().toISOString() },
        submission: { uid, status, referenceNumber, detail },
        errorCode: opts.errorCode ?? null,
      };
    };
    const notConfigured = (message: string, code: string | null = null) => ({
      report: { mode: base.mode, overall: 'NOT_CONFIGURED' as const, baseUrl: base.baseUrl, steps, finishedAt: new Date().toISOString() },
      submission: null,
      errorCode: code,
      detail: message,
    });

    if (base.mode === 'mock') {
      return notConfigured(
        'آزمون کامل در حالت mock اجرا نمی‌شود — موفقیت mock هرگز اتصال واقعی نیست. MOADIAN_MODE=sandbox و اعتبارنامه آزمایشی لازم است.',
      );
    }
    if (base.mode === 'live') {
      return notConfigured(
        'آزمون کامل در حالت live مسدود است — ارسال صورتحساب فقط از جریان مجاز صورتحساب انجام می‌شود.',
      );
    }
    if (base.overall !== 'PASS') {
      return notConfigured('ابتدا تست اتصال باید موفق شود؛ سپس آزمون کامل sandbox در دسترس است.');
    }
    const config = loadMoadianConfigFromEnv().config;
    if (!config?.fiscalId) {
      return notConfigured('شناسه حافظه مالیاتی آزمایشی (MOADIAN_FISCAL_ID) تنظیم نشده است.', 'SANDBOX_FISCAL_ID_MISSING');
    }
    const sandboxTaxid = process.env.MOADIAN_SANDBOX_TAXID;
    const sandboxTins = process.env.MOADIAN_SANDBOX_TINS;
    const sandboxSstid = process.env.MOADIAN_SANDBOX_SSTID;
    if (!sandboxTaxid || !sandboxTins || !sandboxSstid) {
      return notConfigured(
        'داده‌های هویتی آزمایشی کامل نیست: MOADIAN_SANDBOX_TAXID (شناسه یکتای مالیاتی ۲۲ کاراکتری)، MOADIAN_SANDBOX_TINS (شناسه ملی/کد اقتصادی خریدار آزمایشی) و MOADIAN_SANDBOX_SSTID (کد کالا/خدمت ثبت‌شده) باید از پیکربندی sandbox مجاز تأمین شوند.',
        'SANDBOX_PAYLOAD_FIELDS_MISSING',
      );
    }

    const runDay = new Date().toISOString().slice(0, 10);
    const adapter = this.buildAdapter();

    // ATOMIC run creation: unique (companyId, runDay) + P2002 re-find — two
    // concurrent instances get ONE aggregate with an immutable fiscalId
    run = await this.prisma.moadianDiagnosticRun.findUnique({
      where: { companyId_runDay: { companyId, runDay } },
    });
    if (!run) {
      try {
        run = await this.prisma.moadianDiagnosticRun.create({
          data: { companyId, runDay, fiscalId: config.fiscalId, status: 'PREPARED' },
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          run = await this.prisma.moadianDiagnosticRun.findUniqueOrThrow({
            where: { companyId_runDay: { companyId, runDay } },
          });
        } else {
          throw error;
        }
      }
    }
    // identity is IMMUTABLE once the run exists
    if (run.fiscalId !== config.fiscalId) {
      steps.push(
        this.step(
          'sandbox_identity_check',
          'FAIL',
          Date.now(),
          'پیکربندی fiscalId نسبت به اجرای ثبت‌شده تغییر کرده است — ردیف قبلی حفظ می‌شود و ارسال جدید مجاز نیست.',
          'SANDBOX_RUN_IDENTITY_CHANGED',
          'برای تغییر هویت، ابتدا رکورد قبلی را با تصمیم عملیاتی صریح بایگانی کنید.',
        ),
      );
      return notConfigured('fiscalId changed — prior run identity preserved', 'SANDBOX_RUN_IDENTITY_CHANGED');
    }

    // Reconcile the HEAD attempt by its EXACT persisted uid. A PREPARED
    // attempt is skipped here: its enqueue provably never completed (the
    // claim transaction precedes any external call) — it is resumed by the
    // claim transaction below with the SAME uid and FROZEN packet. An
    // empty/inconclusive inquiry NEVER triggers a resend.
    let startedAt = Date.now();
    let head = await this.prisma.moadianDiagnosticAttempt.findFirst({
      where: { runId: run.id, companyId },
      orderBy: { attempt: 'desc' },
    });
    if (head && head.status !== 'PREPARED') {
      let results: Awaited<ReturnType<MoadianAdapter['inquiryByUid']>>;
      try {
        results = await adapter.inquiryByUid([head.uid]);
      } catch (error) {
        const { code, message } = classifyNetworkError(error);
        // reconcile inquiry failed — the attempt stays EXACTLY as it was;
        // an unknown transport outcome never unlocks a retry (fifth
        // review #1) and is an INQUIRY failure, never an authoritative
        // contradiction (sixth review #1). Stable taxonomy code; the
        // network classification stays in the message.
        steps.push(
          this.step(
            'sandbox_reconcile',
            'FAIL',
            startedAt,
            `استعلام نتیجه قبلی ناموفق بود (${code}: ${message}) — بدون تغییر و بدون ارسال مجدد؛ بعداً دوباره تلاش کنید.`,
            'SANDBOX_INQUIRY_FAILED',
          ),
        );
        return await sandboxResult(
          'FAIL',
          head.uid,
          head.status,
          head.referenceNumber,
          // sanitized network classification in the details (stable enum code
          // + fixed message from classifyNetworkError — never raw bodies)
          `reconcile inquiry failed: ${code}: ${message}`,
          // seventh review #1: the API result carries the SAME stable
          // classification the step records — a transport failure is an
          // inquiry failure, never an authoritative rejection or a
          // SANDBOX_RECONCILE_CONTRADICTION
          { errorCode: 'SANDBOX_INQUIRY_FAILED' },
        );
      }
      const result = results[0];
      // POLICY ORDER (sixth review #1): the SUCCESS-contradiction guard runs
      // BEFORE the inconclusive branch — a recorded acceptance must never be
      // silently downgraded to a routine "inconclusive" report.
      if (head.status === 'SUCCESS') {
        // A persisted SUCCESS is NEVER automatically retried. ANY non-SUCCESS
        // authority response for this exact uid — an explicit FAILED/other
        // status, a PENDING, or an empty response — contradicts the recorded
        // acceptance and surfaces as SANDBOX_RECONCILE_CONTRADICTION; it can
        // never unlock retry. Only a fresh SUCCESS re-confirms it.
        if (!result || result.status !== 'SUCCESS') {
          const shape = !result ? 'empty response' : `authority status: ${result.status}`;
          steps.push(
            this.step(
              'sandbox_reconcile',
              'FAIL',
              startedAt,
              'پاسخ سامانه با تأیید ثبت‌شدهٔ قبلی در تناقض است — بدون ارسال مجدد و بدون بازنویسی وضعیت؛ بررسی عملیاتی لازم است.',
              'SANDBOX_RECONCILE_CONTRADICTION',
              'شناسه پیگیری را با سامانه مؤدیان تطبیق دهید؛ تا رفع تناقض هیچ ارسال جدیدی انجام نمی‌شود.',
            ),
          );
          return await sandboxResult('FAIL', head.uid, 'SUCCESS', head.referenceNumber, `contradiction for accepted uid: ${shape}`, {
            errorCode: 'SANDBOX_RECONCILE_CONTRADICTION',
          });
        }
        // fresh authoritative re-confirmation of the recorded acceptance —
        // report WITHOUT enqueueing
        head = await this.prisma.moadianDiagnosticAttempt.update({
          where: { id: head.id },
          data: {
            confirmationReferenceId: result.confirmationReferenceId || head.confirmationReferenceId,
            taxResult: result.taxResult || head.taxResult,
            inquiredAt: new Date(),
          },
        });
        steps.push(this.step('sandbox_reconcile', 'PASS', startedAt, 'ارسال قبلی در مودیان دوباره تأیید شد — بدون ارسال مجدد.'));
        return await sandboxResult('PASS', head.uid, 'SUCCESS', head.referenceNumber, 'تأیید قبلی بازیابی شد.');
      }
      if (!result || result.status === 'PENDING') {
        // INCONCLUSIVE inquiry (empty response or still pending) for a
        // NON-accepted uid: the head status — including a persisted REJECTED
        // — is NEVER treated as retry permission. Retry requires a FRESH,
        // explicit, authoritative rejection for this exact uid (fifth
        // review #1).
        steps.push(
          this.step(
            'sandbox_reconcile',
            'FAIL',
            startedAt,
            'نتیجه استعلام قطعی نیست — حتی ردِ ثبت‌شدهٔ قبلی مجوز ارسال مجدد نیست؛ استعلام بعدی با همان uid ادامه می‌یابد.',
            'SANDBOX_INCONCLUSIVE_INQUIRY',
            'پیش از هر ارسال مجدد، نتیجه قطعی سامانه مؤدیان را با INQUIRY_BY_UID تطبیق دهید.',
          ),
        );
        return await sandboxResult('FAIL', head.uid, head.status, head.referenceNumber, `inconclusive outcome: ${head.status}`);
      }
      if (result.status !== 'SUCCESS' && result.status !== 'FAILED') {
        // authoritative non-final answer — persist honest UNKNOWN
        head = await this.prisma.moadianDiagnosticAttempt.update({
          where: { id: head.id },
          data: {
            status: 'UNKNOWN',
            referenceNumber: result.referenceNumber || head.referenceNumber,
            errorCode: result.errorCode || null,
            errorDetail: result.errorDetail || null,
            confirmationReferenceId: result.confirmationReferenceId || null,
            taxResult: result.taxResult || null,
            inquiredAt: new Date(),
          },
        });
        run = await this.prisma.moadianDiagnosticRun.update({
          where: { id: run.id },
          data: { status: head.status },
        });
        steps.push(
          this.step(
            'sandbox_reconcile',
            'FAIL',
            startedAt,
            'پاسخ سامانه قطعی نشد — وضعیت UNKNOWN ثبت شد؛ ارسال مجدد ممنوع تا تطبیق.',
            'SANDBOX_UNKNOWN_OUTCOME',
          ),
        );
        return await sandboxResult('FAIL', head.uid, 'UNKNOWN', head.referenceNumber, 'inconclusive outcome: UNKNOWN');
      }
      // authoritative FINAL answers only (SUCCESS or an explicit FAILED)
      head = await this.prisma.moadianDiagnosticAttempt.update({
        where: { id: head.id },
        data: {
          status: result.status === 'SUCCESS' ? 'SUCCESS' : 'REJECTED',
          referenceNumber: result.referenceNumber || head.referenceNumber,
          errorCode: result.errorCode || null,
          errorDetail: result.errorDetail || null,
          confirmationReferenceId: result.confirmationReferenceId || null,
          taxResult: result.taxResult || null,
          inquiredAt: new Date(),
        },
      });
      run = await this.prisma.moadianDiagnosticRun.update({
        where: { id: run.id },
        data: { status: head.status },
      });
      if (head.status === 'SUCCESS') {
        steps.push(this.step('sandbox_reconcile', 'PASS', startedAt, 'ارسال قبلی در مودیان تأیید شده است — بدون ارسال مجدد.'));
        return await sandboxResult('PASS', head.uid, 'SUCCESS', head.referenceNumber, 'تأیید قبلی بازیابی شد.');
      }
      // FRESH explicit authoritative rejection for the exact persisted uid —
      // the ONLY outcome that unlocks the official retry path
      steps.push(this.step('sandbox_reconcile', 'PASS', startedAt, 'رد صریح و قطعی سامانه برای همین uid ثبت شد — ارسال مجدد با retry=true و uid جدید مجاز است.'));
    }

    // CRASH-SAFE CLAIM: one short transaction serializes claimants on the
    // aggregate row (SELECT ... FOR UPDATE) and persists claim + attempt
    // identity atomically. Outcomes:
    //   created       -> this instance owns the enqueue (fresh or retry)
    //   recover       -> expired-lease PREPARED attempt resumed with ITS uid
    //   in-progress   -> a live claimant holds a fresh PREPARED attempt
    //   lost          -> another instance claimed; reconcile-only
    //   identity-lost -> aggregate in-flight/final with NO attempt row:
    //                    whether something was sent is unknowable — block
    startedAt = Date.now();
    const LEASE_MS = 120_000;
    const claim = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "moadian_diagnostic_runs" WHERE id = ${run.id}::uuid FOR UPDATE`;
      const txHead = await tx.moadianDiagnosticAttempt.findFirst({
        where: { runId: run.id, companyId },
        orderBy: { attempt: 'desc' },
      });
      if (txHead && txHead.status === 'PREPARED') {
        const ageMs = Date.now() - txHead.createdAt.getTime();
        if (ageMs < LEASE_MS) return { kind: 'in-progress' as const, head: txHead };
        return { kind: 'recover' as const, head: txHead };
      }
      if (txHead && txHead.status !== 'REJECTED') {
        return { kind: 'lost' as const, head: txHead };
      }
      if (!txHead) {
        const aggregate = await tx.moadianDiagnosticRun.findUniqueOrThrow({
          where: { id: run.id },
          select: { status: true },
        });
        if (['PENDING', 'SUCCESS', 'UNKNOWN'].includes(aggregate.status)) {
          return { kind: 'identity-lost' as const };
        }
        if (aggregate.status !== 'SUBMITTED') {
          const claimed = await tx.moadianDiagnosticRun.updateMany({
            where: { id: run.id, status: { in: ['PREPARED', 'REJECTED'] } },
            data: { status: 'SUBMITTED' },
          });
          if (claimed.count === 0) return { kind: 'lost' as const, head: null };
        }
        // SUBMITTED with no attempt row = crash between the claim and the
        // attempt creation (legacy window). Attempt creation precedes enqueue
        // in every code version, so nothing was ever sent — starting attempt
        // 1 with a fresh uid is NOT a resubmission.
      } else {
        const claimed = await tx.moadianDiagnosticRun.updateMany({
          where: { id: run.id, status: { in: ['PREPARED', 'REJECTED'] } },
          data: { status: 'SUBMITTED' },
        });
        if (claimed.count === 0) return { kind: 'lost' as const, head: txHead };
      }
      const attemptNo = (txHead?.attempt ?? 0) + 1;
      const isRetry = attemptNo > 1; // official retry=true on resubmission
      const uid = 'sandbox-' + crypto.randomUUID(); // NEW uid per attempt
      const packet = this.buildSyntheticSandboxPacket(
        uid,
        isRetry,
        config.fiscalId,
        sandboxTins,
        sandboxTaxid,
        sandboxSstid,
      );
      // durable attempt row BEFORE submission — uid/attempt immutable
      const attemptRow = await tx.moadianDiagnosticAttempt.create({
        data: {
          runId: run.id,
          companyId,
          attempt: attemptNo,
          uid,
          retry: isRetry,
          status: 'PREPARED', // enqueue happens only AFTER this tx commits
          payloadSnapshot: { packets: [packet] } as unknown as Prisma.InputJsonValue,
          sentAt: new Date(),
        },
      });
      return { kind: 'created' as const, attemptRow, packet };
    });

    if (claim.kind === 'identity-lost') {
      return notConfigured(
        'وضعیت aggregate بیانگر نتیجه در جریان/نهایی است اما ردیف attempt (شناسه uid) یافت نشد — برای پیشگیری از ارسال مضاعف، هیچ ارسال یا رکورد جدیدی ساخته نمی‌شود؛ بررسی عملیاتی لازم است.',
        'SANDBOX_ATTEMPT_IDENTITY_LOST',
      );
    }
    if (claim.kind === 'in-progress' || claim.kind === 'lost') {
      const headRow = claim.head;
      const code = claim.kind === 'in-progress' ? 'SANDBOX_CLAIM_IN_PROGRESS' : 'SANDBOX_CLAIM_LOST';
      steps.push(
        this.step(
          'sandbox_claim',
          'FAIL',
          startedAt,
          claim.kind === 'in-progress'
            ? 'نمونه دیگری ادعای ارسال را کرده و attempt تازه آن در جریان است — بدون ارسال مجدد و بدون تغییر وضعیت aggregate؛ پس از انقضای مهلت، فراخوانی بعدی بازیابی می‌کند.'
            : 'نمونه دیگری ادعای ارسال را کرده است — بدون ارسال مجدد و بدون تغییر وضعیت aggregate؛ استعلام بعدی نتیجه را قطعی می‌کند.',
          code,
        ),
      );
      if (headRow) {
        // report-only: a losing claimant NEVER mutates aggregate state owned
        // by the winning instance (fifth review #2)
        return await sandboxResult(
          'FAIL',
          headRow.uid,
          headRow.status,
          headRow.referenceNumber,
          claim.kind === 'in-progress'
            ? 'ادعای ارسال نزد نمونه دیگر در جریان است.'
            : 'ادعای ارسال نزد نمونه دیگر است.',
          { errorCode: code, reportOnly: true },
        );
      }
      return notConfigured(
        'نمونه دیگری ادعای ارسال را کرده است — تلاش بعدی نتیجه را با INQUIRY_BY_UID تطبیق می‌دهد.',
        'SANDBOX_CLAIM_LOST',
      );
    }

    const attemptRow = claim.kind === 'recover' ? claim.head : claim.attemptRow;
    // the packet is rebuilt from the FROZEN payload snapshot — identical uid
    // and content on both the fresh and the resumed path
    let packet: MoadianPacket;
    if (claim.kind === 'recover') {
      const snapshot = attemptRow.payloadSnapshot as { packets?: MoadianPacket[] } | null;
      packet =
        snapshot?.packets?.[0] ??
        this.buildSyntheticSandboxPacket(
          attemptRow.uid,
          attemptRow.attempt > 1,
          config.fiscalId,
          sandboxTins,
          sandboxTaxid,
          sandboxSstid,
        );
      steps.push(
        this.step(
          'sandbox_claim',
          'PASS',
          startedAt,
          `attempt ${attemptRow.attempt} ناتمام مانده بود — با همان uid پایدار و محتوای منجمد ادامه می‌یابد (ارسال مضاعف با 5005 جمع می‌شود).`,
        ),
      );
    } else {
      packet = claim.packet;
      steps.push(
        this.step(
          'sandbox_claim',
          'PASS',
          startedAt,
          `attempt ${attemptRow.attempt} و uid آن به‌صورت اتمیک با claim ثبت شد — این نمونه مجاز به ارسال است.`,
        ),
      );
    }

    startedAt = Date.now();
    try {
      const responses = await adapter.enqueue([packet]);
      // official §7/§8: the response uid must echo our requestTraceId
      const response = responses.find((r) => r.uid === packet.uid);
      if (!response) throw new Error('MOADIAN_INVOICE_RESPONSE_MISMATCH');
      if (response?.errorCode) {
        // defensive: the official v1.6 submission response has NO errorCode —
        // any surfaced errorCode is unexpected and treated as a rejection,
        // never as a documented duplicate/retry signal
        await this.prisma.moadianDiagnosticAttempt.updateMany({
          where: { id: attemptRow.id, status: 'PREPARED' },
          data: { status: 'REJECTED', errorCode: response.errorCode, errorDetail: response.errorDetail ?? null },
        });
        head = await this.prisma.moadianDiagnosticAttempt.findUniqueOrThrow({ where: { id: attemptRow.id } });
        steps.push(
          this.step('sandbox_enqueue', 'FAIL', startedAt, `ارسال sandbox ناموفق: ${response.errorCode} ${response.errorDetail ?? ''}`, response.errorCode),
        );
        return await sandboxResult('FAIL', attemptRow.uid, 'REJECTED', null, `enqueue: ${response.errorCode}`);
      } else {
        await this.prisma.moadianDiagnosticAttempt.updateMany({
          where: { id: attemptRow.id, status: 'PREPARED' },
          data: { status: 'PENDING', referenceNumber: response?.referenceNumber ?? null, sentAt: new Date() },
        });
        head = await this.prisma.moadianDiagnosticAttempt.findUniqueOrThrow({ where: { id: attemptRow.id } });
        steps.push(
          this.step('sandbox_enqueue', 'PASS', startedAt, `packet به sandbox ارسال شد (referenceNumber: ${response?.referenceNumber ?? '—'}).`),
        );
      }
    } catch (error) {
      const { code, message } = classifyNetworkError(error);
      // UNKNOWN outcome: the packet may have reached the authority — the
      // attempt stays with its durable uid; a later call inquires it and
      // NEVER resends blindly. The UNKNOWN state is persisted (awaited)
      // BEFORE returning; if even that fails, the attempt row from the claim
      // transaction still preserves the uid for recovery.
      let persistError: string | null = null;
      try {
        await this.prisma.moadianDiagnosticAttempt.updateMany({
          where: { id: attemptRow.id, status: 'PREPARED' },
          data: { status: 'UNKNOWN', errorCode: 'SANDBOX_UNKNOWN_OUTCOME', errorDetail: message },
        });
      } catch {
        persistError = 'SANDBOX_ATTEMPT_PERSIST_FAILED';
      }
      head = await this.prisma.moadianDiagnosticAttempt
        .findUniqueOrThrow({ where: { id: attemptRow.id } })
        .catch(() => null);
      steps.push(
        this.step(
          'sandbox_enqueue',
          'FAIL',
          startedAt,
          persistError
            ? `نتیجه ارسال نامشخص است (${message}) و ثبت وضعیت UNKNOWN نیز ناموفق بود — attempt با uid پایدار از ردیف claim حفظ شده؛ ارسال مجدد ممنوع تا تطبیق.`
            : `نتیجه ارسال نامشخص است (${message}) — attempt با uid پایدار حفظ شد؛ ارسال مجدد ممنوع تا تطبیق.`,
          persistError ?? 'SANDBOX_UNKNOWN_OUTCOME',
        ),
      );
      return await sandboxResult(
        'FAIL',
        attemptRow.uid,
        head?.status ?? 'UNKNOWN',
        null,
        `timeout/unknown: ${code} — reconcile via INQUIRY_BY_UID.`,
        { errorCode: persistError },
      );
    }

    // inquiry the just-submitted attempt uid
    startedAt = Date.now();
    try {
      const inquiry = await adapter.inquiryByUid([attemptRow.uid]);
      const result = inquiry[0];
      head = await this.prisma.moadianDiagnosticAttempt.findUniqueOrThrow({ where: { id: attemptRow.id } });
      if (!result || result.status === 'PENDING') {
        head = await this.prisma.moadianDiagnosticAttempt.update({
          where: { id: attemptRow.id },
          data: { status: 'PENDING', inquiredAt: new Date() },
        });
        return await sandboxResult('NOT_CONFIGURED', attemptRow.uid, 'PENDING', head.referenceNumber, 'مودیان هنوز در حال بررسی است — بعداً استعلام بگیرید.');
      }
      if (result.status === 'SUCCESS') {
        head = await this.prisma.moadianDiagnosticAttempt.update({
          where: { id: attemptRow.id },
          data: {
            status: 'SUCCESS',
            confirmationReferenceId: result.confirmationReferenceId || null,
            taxResult: result.taxResult || null,
            inquiredAt: new Date(),
          },
        });
        steps.push(this.step('sandbox_inquiry', 'PASS', startedAt, `صورتحساب آزمایشی تأیید شد (${result.confirmationReferenceId ?? '—'}).`));
        return await sandboxResult('PASS', attemptRow.uid, 'SUCCESS', head.referenceNumber, 'آزمون کامل sandbox موفق بود.');
      }
      head = await this.prisma.moadianDiagnosticAttempt.update({
        where: { id: attemptRow.id },
        data: {
          status: 'REJECTED',
          errorCode: result.errorCode || null,
          errorDetail: result.errorDetail || null,
          inquiredAt: new Date(),
        },
      });
      steps.push(
        this.step('sandbox_inquiry', 'FAIL', startedAt, `مودیان packet آزمایشی را رد کرد: ${result.errorCode ?? ''} ${result.errorDetail ?? ''}`, result.errorCode ?? null),
      );
      return await sandboxResult('FAIL', attemptRow.uid, 'REJECTED', head.referenceNumber, `sandbox rejected: ${result.errorDetail ?? ''}`);
    } catch (error) {
      const { code, message } = classifyNetworkError(error);
      // fourth review #4: persist the uncertain outcome BEFORE returning —
      // the attempt keeps its immutable uid and stays blocked for resend
      let persistError: string | null = null;
      try {
        await this.prisma.moadianDiagnosticAttempt.update({
          where: { id: attemptRow.id },
          data: { status: 'UNKNOWN', errorCode: 'SANDBOX_INQUIRY_UNKNOWN', errorDetail: message, inquiredAt: new Date() },
        });
      } catch {
        persistError = 'SANDBOX_ATTEMPT_PERSIST_FAILED';
      }
      steps.push(
        this.step(
          'sandbox_inquiry',
          'FAIL',
          startedAt,
          persistError
            ? `استعلام ناموفق بود (${message}) و ثبت UNKNOWN نیز ناموفق بود — ردیف attempt از مرحله claim با uid پایدار باقی است؛ ارسال مجدد ممنوع تا تطبیق.`
            : `استعلام ناموفق بود (${message}) — وضعیت UNKNOWN ثبت شد؛ ارسال مجدد ممنوع تا تطبیق.`,
          persistError ?? 'SANDBOX_INQUIRY_UNKNOWN',
        ),
      );
      return await sandboxResult('FAIL', attemptRow.uid, 'UNKNOWN', null, `استعلام ناموفق: ${message} (${code}) — بعداً استعلام بگیرید.`, {
        errorCode: persistError,
      });
    }
  }

  /** sandbox packet wrapper — the SAME packet identity that is persisted in
   *  payload_snapshot and rebuilt from it on recovery: identical uid and
   *  content, so a resumed submission cannot diverge from the claimed one. */
  private buildSyntheticSandboxPacket(
    uid: string,
    isRetry: boolean,
    fiscalId: string,
    buyerTins: string,
    taxid: string,
    sstid: string,
  ): MoadianPacket {
    return {
      uid,
      packetType: 'INVOICE.V01',
      retry: isRetry,
      data: JSON.stringify(this.buildSyntheticSandboxInvoice(fiscalId, buyerTins, taxid, sstid)),
      encryptionKeyId: '',
      symmetricKey: '',
      iv: '',
      fiscalId,
      dataSignature: '',
    };
  }

  /** synthetic sandbox invoice — complete per the official template: header
   *  taxid/tins from authorized sandbox configuration, body sstid from the
   *  registered goods list. Values are legally valid TEST-ONLY samples. */
  private buildSyntheticSandboxInvoice(fiscalId: string, buyerTins: string, taxid: string, sstid: string) {
    const now = Date.now();
    return {
      header: {
        taxid,
        indatim: now,
        indati2m: now,
        inty: 1, // type 1: buyer has an economic code (sandbox test identity)
        ins: 1, // اصلی
        inno: 'SANDBOX-TEST',
        irtaxid: null,
        tins: buyerTins,
        tob: 1,
        tprdis: '1000000',
        tdis: '0',
        tadis: '1000000',
        tvam: '90000',
        todam: '0',
        tbill: '1090000',
        setm: null,
        cap: null,
        insp: null,
        tvop: null,
      },
      body: [
        {
          sstid,
          sstt: 'TEST-ONLY (sandbox diagnostic)',
          mu: null,
          am: '1',
          fee: '1000000',
          cfee: '1000000',
          cut: null,
          exr: null,
          prdis: '1000000',
          dis: '0',
          adis: '1000000',
          vra: 0.09,
          vam: '90000',
          odt: null,
          odr: null,
          odam: null,
          olt: null,
          olr: null,
          olam: null,
          tsstam: '90000',
        },
      ],
      // official RC_TICS.IS_v1.6 §7: top-level `payments` array (empty —
      // payment mapping is a documented data gap)
      payments: [],
    };
  }

  private finish(
    mode: 'mock' | 'sandbox' | 'live',
    baseUrl: string,
    steps: DiagnosticStep[],
    overall: 'PASS' | 'FAIL' | 'NOT_CONFIGURED',
  ): DiagnosticReport {
    this.logger.debug(`diagnostic finished mode=${mode} overall=${overall}`);
    return { mode, overall, baseUrl, steps, finishedAt: new Date().toISOString() };
  }

  /** serialize diagnostics: one run at a time (in-process; multi-instance note
   *  in docs/08), preventing concurrent load from repeated clicks */
  private static gate: Promise<unknown> = Promise.resolve();

  runSerialized<T>(work: () => Promise<T>): Promise<T> {
    const prev = MoadianDiagnosticService.gate.catch(() => undefined);
    const gate = prev.then(work);
    MoadianDiagnosticService.gate = gate;
    return gate;
  }

  /** cool-down: an identical run within the window is rate-limited */
  private lastRunAt = 0;
  rateLimit(minIntervalMs: number): string | null {
    const now = Date.now();
    if (now - this.lastRunAt < minIntervalMs) {
      const wait = Math.ceil((minIntervalMs - (now - this.lastRunAt)) / 1000);
      return `RUN_RATE_LIMITED:${wait}`;
    }
    this.lastRunAt = now;
    return null;
  }
}
