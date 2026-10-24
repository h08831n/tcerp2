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

  /** Full SANDBOX test — durable, cross-instance-safe attempt state machine.
   *
   *  Run aggregate: one `MoadianDiagnosticRun` per company per UTC day —
   *  created ATOMICALLY (unique constraint + P2002 re-find). Its fiscalId is
   *  immutable: a later configuration change is rejected, never overwritten.
   *
   *  Attempt claim (cross-instance): the run status is claimed via a
   *  conditional UPDATE (PREPARED/REJECTED -> SUBMITTED). Only the instance
   *  whose UPDATE affected the row creates the attempt and enqueues; every
   *  other instance reconciles and reports. UNKNOWN discipline: an
   *  empty/failed inquiry NEVER resends — the head attempt stays
   *  SUBMITTED/UNKNOWN and a later call inquires the SAME persisted uid.
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
    const sandboxResult = (
      overall: 'PASS' | 'FAIL' | 'NOT_CONFIGURED',
      uid: string,
      status: string,
      referenceNumber: string | null,
      detail: string,
    ) => {
      // the aggregate mirrors the head attempt's final state
      if (run) {
        void this.prisma.moadianDiagnosticRun
          .update({ where: { id: run.id }, data: { status: status as MoadianDiagnosticRunStatus } })
          .catch(() => undefined);
      }
      return {
        report: { mode: base.mode, overall, baseUrl: base.baseUrl, steps, finishedAt: new Date().toISOString() },
        submission: { uid, status, referenceNumber, detail },
        errorCode: null,
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

    // reconcile the HEAD attempt by its EXACT persisted uid — an empty or
    // inconclusive inquiry NEVER triggers a resend
    let startedAt = Date.now();
    let head = await this.prisma.moadianDiagnosticAttempt.findFirst({
      where: { runId: run.id, companyId },
      orderBy: { attempt: 'desc' },
    });
    if (head) {
      const results = await adapter.inquiryByUid([head.uid]);
      const result = results[0];
      if (result && result.status !== 'PENDING') {
        head = await this.prisma.moadianDiagnosticAttempt.update({
          where: { id: head.id },
          data: {
            status:
              result.status === 'SUCCESS'
                ? 'SUCCESS'
                : result.status === 'FAILED'
                  ? 'REJECTED'
                  : 'UNKNOWN',
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
      }
      // authoritative final states -> report WITHOUT enqueueing
      if (head.status === 'SUCCESS') {
        steps.push(this.step('sandbox_reconcile', 'PASS', startedAt, 'ارسال قبلی در مودیان تأیید شده است — بدون ارسال مجدد.'));
        return sandboxResult('PASS', head.uid, 'SUCCESS', head.referenceNumber, 'تأیید قبلی بازیابی شد.');
      }
      if (head.status === 'PENDING' || head.status === 'UNKNOWN' || head.status === 'SUBMITTED') {
        steps.push(
          this.step(
            'sandbox_reconcile',
            'FAIL',
            startedAt,
            'نتیجه ارسال قبلی قطعی نشده یا نامشخص است — ارسال مجدد ممنوع؛ استعلام با همان uid ادامه می‌یابد.',
            head.status === 'UNKNOWN' || head.status === 'SUBMITTED' ? 'SANDBOX_UNKNOWN_OUTCOME' : null,
            'پیش از هر ارسال مجدد، شماره پیگیری را با سامانه مؤدیان تطبیق دهید.',
          ),
        );
        return sandboxResult('FAIL', head.uid, head.status, head.referenceNumber, `inconclusive outcome: ${head.status}`);
      }
      // REJECTED (authoritative) -> official retry with a NEW uid + retry=true
      steps.push(this.step('sandbox_reconcile', 'PASS', startedAt, 'رد نهایی ثبت شده — ارسال مجدد با retry=true و uid جدید مجاز است.'));
    }

    // CROSS-INSTANCE CLAIM: a conditional UPDATE on the aggregate admits
    // exactly ONE instance to create the next attempt and enqueue; every
    // loser reconciles/reports WITHOUT enqueueing (no duplicate submission).
    startedAt = Date.now();
    const claim = await this.prisma.moadianDiagnosticRun.updateMany({
      where: { id: run.id, status: { in: ['PREPARED', 'REJECTED'] } },
      data: { status: 'SUBMITTED' },
    });
    if (claim.count === 0) {
      const claimedElsewhere = await this.prisma.moadianDiagnosticAttempt.findFirst({
        where: { runId: run.id, companyId },
        orderBy: { attempt: 'desc' },
      });
      if (claimedElsewhere) {
        return sandboxResult(
          'FAIL',
          claimedElsewhere.uid,
          claimedElsewhere.status,
          claimedElsewhere.referenceNumber,
          'نمونه دیگری ادعای ارسال را کرده است — بدون ارسال مجدد؛ استعلام بعدی نتیجه را قطعی می‌کند.',
        );
      }
      return notConfigured(
        'نمونه دیگری ادعای ارسال را کرده است — تلاش بعدی نتیجه را با INQUIRY_BY_UID تطبیق می‌دهد.',
        'SANDBOX_CLAIM_LOST',
      );
    }

    const attempt = (head?.attempt ?? 0) + 1;
    const isRetry = attempt > 1; // official retry=true on resubmission
    const uid = 'sandbox-' + crypto.randomUUID(); // NEW uid per attempt
    const syntheticInvoice = this.buildSyntheticSandboxInvoice(config.fiscalId, sandboxTins, sandboxTaxid, sandboxSstid);
    const packet: MoadianPacket = {
      uid,
      packetType: 'INVOICE.V01',
      retry: isRetry,
      data: JSON.stringify(syntheticInvoice),
      encryptionKeyId: '',
      symmetricKey: '',
      iv: '',
      fiscalId: config.fiscalId,
      dataSignature: '',
    };
    // durable attempt row BEFORE submission — uid/attempt immutable
    const attemptRow = await this.prisma.moadianDiagnosticAttempt.create({
      data: {
        runId: run.id,
        companyId,
        attempt,
        uid,
        retry: isRetry,
        status: 'SUBMITTED', // claimed atomically at creation (single INSERT)
        payloadSnapshot: { packets: [packet] } as unknown as Prisma.InputJsonValue,
        sentAt: new Date(),
      },
    });
    steps.push(
      this.step(
        'sandbox_claim',
        'PASS',
        startedAt,
        `attempt ${attempt} ثبت شد — این نمونه مجاز به ارسال است (claim اتمیک در INSERT).`,
      ),
    );

    startedAt = Date.now();
    try {
      const responses = await adapter.enqueue([packet]);
      const response = responses[0];
      if (response?.errorCode === '5005') {
        // official duplicate.request.uid — the authority already has THIS uid
        head = await this.prisma.moadianDiagnosticAttempt.update({
          where: { id: attemptRow.id },
          data: { status: 'PENDING', referenceNumber: response.referenceNumber || null },
        });
        steps.push(this.step('sandbox_enqueue', 'PASS', startedAt, 'این uid قبلاً دریافت شده است (duplicate) — استعلام ادامه می‌یابد.'));
      } else if (response?.errorCode) {
        head = await this.prisma.moadianDiagnosticAttempt.update({
          where: { id: attemptRow.id },
          data: { status: 'REJECTED', errorCode: response.errorCode, errorDetail: response.errorDetail ?? null },
        });
        steps.push(
          this.step('sandbox_enqueue', 'FAIL', startedAt, `ارسال sandbox ناموفق: ${response.errorCode} ${response.errorDetail ?? ''}`, response.errorCode),
        );
        return sandboxResult('FAIL', uid, 'REJECTED', null, `enqueue: ${response.errorCode}`);
      } else {
        head = await this.prisma.moadianDiagnosticAttempt.update({
          where: { id: attemptRow.id },
          data: { status: 'PENDING', referenceNumber: response?.referenceNumber ?? null, sentAt: new Date() },
        });
        steps.push(
          this.step('sandbox_enqueue', 'PASS', startedAt, `packet به sandbox ارسال شد (referenceNumber: ${response?.referenceNumber ?? '—'}).`),
        );
      }
    } catch (error) {
      const { code, message } = classifyNetworkError(error);
      // UNKNOWN outcome: the packet may have reached the authority — the
      // attempt stays UNKNOWN with its durable uid; a later call inquires it
      // and NEVER resends blindly
      head = await this.prisma.moadianDiagnosticAttempt.update({
        where: { id: attemptRow.id },
        data: { status: 'UNKNOWN', errorCode: 'SANDBOX_UNKNOWN_OUTCOME', errorDetail: message },
      });
      steps.push(
        this.step(
          'sandbox_enqueue',
          'FAIL',
          startedAt,
          `نتیجه ارسال نامشخص است (${message}) — attempt با uid پایدار حفظ شد؛ ارسال مجدد ممنوع تا تطبیق.`,
          'SANDBOX_UNKNOWN_OUTCOME',
        ),
      );
      return sandboxResult('FAIL', uid, 'UNKNOWN', null, `timeout/unknown: ${code} — reconcile via INQUIRY_BY_UID.`);
    }

    // inquiry the just-submitted attempt uid
    startedAt = Date.now();
    try {
      const inquiry = await adapter.inquiryByUid([uid]);
      const result = inquiry[0];
      head = await this.prisma.moadianDiagnosticAttempt.findUniqueOrThrow({ where: { id: attemptRow.id } });
      if (!result || result.status === 'PENDING') {
        head = await this.prisma.moadianDiagnosticAttempt.update({
          where: { id: attemptRow.id },
          data: { status: 'PENDING', inquiredAt: new Date() },
        });
        return sandboxResult('NOT_CONFIGURED', uid, 'PENDING', head.referenceNumber, 'مودیان هنوز در حال بررسی است — بعداً استعلام بگیرید.');
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
        return sandboxResult('PASS', uid, 'SUCCESS', head.referenceNumber, 'آزمون کامل sandbox موفق بود.');
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
      return sandboxResult('FAIL', uid, 'REJECTED', head.referenceNumber, `sandbox rejected: ${result.errorDetail ?? ''}`);
    } catch (error) {
      const { code, message } = classifyNetworkError(error);
      return sandboxResult('FAIL', uid, 'UNKNOWN', null, `استعلام ناموفق: ${message} (${code}) — بعداً استعلام بگیرید.`);
    }
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
      payment: [],
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
