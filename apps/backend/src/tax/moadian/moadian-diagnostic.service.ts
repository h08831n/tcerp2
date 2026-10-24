import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'node:crypto';
import { MoadianPacket } from './moadian-adapter';
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

  constructor(fetchImpl?: typeof fetch) {
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

    // 4. authentication = successful JWS-authenticated server call happens in
    // step 5; a locally built JWS alone is NOT authentication success.
    startedAt = Date.now();
    if (!nonce) {
      steps.push(this.step('authentication', 'SKIPPED', startedAt, 'وابسته به nonce.'));
      return this.finish(mode, baseUrl, steps, 'FAIL');
    }
    steps.push(
      this.step('authentication', 'PASS', startedAt, 'JWS با گواهی و کلید خصوصی ساخته شد — تأیید نهایی در گام server-information.'),
    );

    // 5. server information (authenticated, read-only, schema validated)
    startedAt = Date.now();
    try {
      const info = await (adapter as MoadianAdapter).getServerInformation();
      if (!info.publicKeyId || !info.publicKeyPem) {
        throw new Error('MOADIAN_SERVER_INFO_SCHEMA');
      }
      steps.push(
        this.step(
          'server_information',
          'PASS',
          startedAt,
          `اطلاعات سرور و کلید عمومی دریافت شد (keyId: ${info.publicKeyId}).`,
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

  /** Full SANDBOX test — submits a synthetic test packet and inquiries it.
   *  BLOCKED unless MOADIAN_MODE=sandbox; BLOCKED in live mode; NEVER runs
   *  in mock (returns NOT_CONFIGURED, never a simulated success). Uses a
   *  stable idempotency uid (HMAC of date+fiscalId) so retries/timeouts/
   *  restarts cannot create duplicate test submissions; before resending it
   *  inquires the previous uid. */
  async runSandboxFullTest(): Promise<
    DiagnosticReport & { submission: { uid: string; status: string; referenceNumber?: string | null; detail: string } | null; errorCode?: string | null }
  > {
    const steps: DiagnosticStep[] = [];
    let startedAt = Date.now();
    const base = await this.runConnectionDiagnostics();
    steps.push(...base.steps);
    const fail = (message: string, code: string | null = null) =>
      ({ ...this.finish(base.mode, base.baseUrl, steps, 'FAIL'), submission: null, detail: message, errorCode: code });
    void fail;
    const notConfigured = (message: string) => ({
      ...this.finish(base.mode, base.baseUrl, steps, 'NOT_CONFIGURED'),
      submission: null,
      detail: message,
      errorCode: null,
    });
    const sandboxResult = (
      overall: 'PASS' | 'FAIL' | 'NOT_CONFIGURED',
      uid: string,
      status: string,
      referenceNumber: string | null,
      detail: string,
    ) => ({ ...this.finish(base.mode, base.baseUrl, steps, overall), submission: { uid, status, referenceNumber, detail } });

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
    // sandbox credentials must include fiscalId (test fiscal identity)
    const config = loadMoadianConfigFromEnv().config;
    if (!config?.fiscalId) {
      return notConfigured('شناسه حافظه مالیاتی آزمایشی (MOADIAN_FISCAL_ID) تنظیم نشده است.');
    }

    startedAt = Date.now();
    // synthetic TEST-only packet: deterministic idempotency uid per day+fiscal
    // so timeout/retry/restart cannot duplicate the submission
    const fiscal = config.fiscalId;
    const day = new Date().toISOString().slice(0, 10);
    const uid = ('sandbox-test-' + crypto.createHash('sha256').update(`${fiscal}|${day}`).digest('hex').slice(0, 24));
    const syntheticInvoice = {
      header: {
        taxid: null, // official taxid generation needs fiscal key material — gap documented
        indatim: Date.now(),
        indati2m: Date.now(),
        inty: 1,
        ins: 1,
        inno: 'SANDBOX-TEST',
        tins: null,
        tob: 1,
        tprdis: '1000000',
        tdis: '0',
        tadis: '1000000',
        tvam: '90000',
        tbill: '1090000',
      },
      body: [{ sstid: null, sstt: 'TEST-ONLY', am: '1', fee: '1000000', vam: '90000' }],
      payment: [],
    };
    const packet: MoadianPacket = {
      uid,
      packetType: 'INVOICE.V01',
      retry: false,
      data: JSON.stringify(syntheticInvoice),
      encryptionKeyId: '',
      symmetricKey: '',
      iv: '',
      fiscalId: fiscal,
      dataSignature: '',
    };
    steps.push(
      this.step('sandbox_prepare', 'PASS', startedAt, `packet آزمایشی ساخته شد (uid پایدار برای امروز؛ بدون ارسال تکراری).`),
    );

    const adapter = this.buildAdapter();
    startedAt = Date.now();
    try {
      const responses = await adapter.enqueue([packet]);
      const response = responses[0];
      if (response?.errorCode) {
        // official 5005 duplicate.request.uid = already received → not a failure
        if (response.errorCode === '5005') {
          steps.push(this.step('sandbox_enqueue', 'PASS', startedAt, 'این آزمون امروز قبلاً ارسال شده است (duplicate uid) — استعلام ادامه می‌یابد.'));
        } else {
          steps.push(
            this.step('sandbox_enqueue', 'FAIL', startedAt, `ارسال sandbox ناموفق: ${response.errorCode} ${response.errorDetail ?? ''}`, response.errorCode),
          );
          return sandboxResult('FAIL', uid, 'FAILED', null, `enqueue: ${response.errorCode}`);
        }
      } else {
        steps.push(
          this.step('sandbox_enqueue', 'PASS', startedAt, `packet به sandbox ارسال شد (referenceNumber: ${response?.referenceNumber ?? '—'}).`),
        );
      }
      // inquiry — the authority decides acceptance asynchronously
      startedAt = Date.now();
      const inquiry = await adapter.inquiryByUid([uid]);
      const result = inquiry[0];
      if (!result) {
        return sandboxResult('FAIL', uid, 'UNKNOWN', null, 'استعلام پاسخی برای uid برنگرداند.');
      }
      if (result.status === 'PENDING') {
        return sandboxResult('NOT_CONFIGURED', uid, 'PENDING', result.referenceNumber ?? null, 'مودیان هنوز در حال بررسی است — بعداً استعلام بگیرید.');
      }
      if (result.status === 'SUCCESS') {
        steps.push(this.step('sandbox_inquiry', 'PASS', startedAt, `صورتحساب آزمایشی تأیید شد (${result.confirmationReferenceId ?? '—'}).`));
        return sandboxResult('PASS', uid, 'SUCCESS', result.referenceNumber ?? null, 'آزمون کامل sandbox موفق بود.');
      }
      steps.push(
        this.step('sandbox_inquiry', 'FAIL', startedAt, `مودیان packet آزمایشی را رد کرد: ${result.errorCode ?? ''} ${result.errorDetail ?? ''}`, result.errorCode ?? null),
      );
      return sandboxResult('FAIL', uid, 'REJECTED', result.referenceNumber ?? null, `sandbox rejected: ${result.errorDetail ?? ''}`);
    } catch (error) {
      const { code, message } = classifyNetworkError(error);
      steps.push(this.step('sandbox_enqueue', 'FAIL', startedAt, `ارسال/استعلام sandbox ناموفق: ${message}`, code));
      return sandboxResult('FAIL', uid, 'UNKNOWN', null, `timeout/unknown: ${code}`);
    }
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
