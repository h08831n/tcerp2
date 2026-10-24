import { MockMoadianAdapter } from './mock-moadian.adapter';
import { FakeMoadianAdapter } from './fake-moadian-fixtures';
import { TEST_CERT_PEM, TEST_PRIVATE_PEM } from './test-certs';
import {
  classifyNetworkError,
  MoadianDiagnosticService,
} from './moadian-diagnostic.service';

/** Deterministic offline tests for the administrator connection diagnostic:
 *  mocked global fetch for DNS/TLS/HTTP/timeout paths; mock-mode config;
 *  never-mutating behavior; sanitized errors. No real network, no secrets. */

function makeService(fetchImpl: typeof fetch, prisma: unknown = { moadianDiagnosticRun: { findUnique: async () => null, findUniqueOrThrow: async () => null, upsert: async (a: unknown) => a, update: async (a: unknown) => a, create: async (a: unknown) => a }, company: { delete: async () => undefined } }): MoadianDiagnosticService {
  return new MoadianDiagnosticService(prisma as never, fetchImpl);
}

const okResponse = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe('MoadianDiagnosticService — connection diagnostics', () => {
  const SAVED_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...SAVED_ENV };
    jest.restoreAllMocks();
  });

  it('mock mode: config validates, ALL network steps are NOT_CONFIGURED, overall NOT_CONFIGURED', async () => {
    const svc = makeService(async () => { throw new Error('no network in mock'); });
    const report = await svc.runConnectionDiagnostics();
    expect(report.mode).toBe('mock');
    expect(report.overall).toBe('NOT_CONFIGURED');
    const byStep = Object.fromEntries(report.steps.map((s) => [s.step, s.status]));
    expect(byStep.configuration).toBe('PASS');
    expect(byStep.network).toBe('NOT_CONFIGURED');
    expect(byStep.nonce).toBe('NOT_CONFIGURED');
    expect(byStep.authentication).toBe('NOT_CONFIGURED');
    expect(byStep.server_information).toBe('NOT_CONFIGURED');
    // NEVER a submission in the basic diagnostic
    expect(report.steps.some((s) => s.step.startsWith('sandbox'))).toBe(false);
  });

  it('mock success is NEVER represented as sandbox/live connectivity', async () => {
    const report = await makeService(async () => {
      throw new Error('no network in mock');
    }).runConnectionDiagnostics();
    expect(report.mode).toBe('mock');
    expect(report.overall).not.toBe('PASS');
  });

  it('DNS failure classified and diagnostic FAILS before authentication', async () => {
    process.env = {
      MOADIAN_MODE: 'sandbox',
      MOADIAN_FISCAL_ID: 'F',
      MOADIAN_ECONOMIC_CODE: 'E',
      MOADIAN_CLIENT_ID: 'C',
      MOADIAN_PRIVATE_KEY: TEST_PRIVATE_PEM,
      MOADIAN_CERTIFICATE: TEST_CERT_PEM,
    };
    const report = await makeService(async () => {
      throw Object.assign(new Error('getaddrinfo failed'), { cause: { code: 'ENOTFOUND' } });
    }).runConnectionDiagnostics();
    const network = report.steps.find((s) => s.step === 'network');
    expect(network?.errorCode).toBe('DNS_FAILURE');
    expect(report.overall).toBe('FAIL');
    // dependent steps never ran
    expect(report.steps.some((s) => s.step === 'nonce')).toBe(false);
  });

  it('TLS failure classified', async () => {
    process.env = {
      MOADIAN_MODE: 'sandbox',
      MOADIAN_FISCAL_ID: 'F',
      MOADIAN_ECONOMIC_CODE: 'E',
      MOADIAN_CLIENT_ID: 'C',
      MOADIAN_PRIVATE_KEY: TEST_PRIVATE_PEM,
      MOADIAN_CERTIFICATE: TEST_CERT_PEM,
    };
    const report = await makeService(async () => {
      throw Object.assign(new Error('cert expired'), { cause: { code: 'CERT_HAS_EXPIRED' } });
    }).runConnectionDiagnostics();
    expect(report.steps.find((s) => s.step === 'network')?.errorCode).toBe('TLS_FAILURE');
  });

  it('timeout classified as TIMEOUT', async () => {
    process.env = {
      MOADIAN_MODE: 'sandbox',
      MOADIAN_FISCAL_ID: 'F',
      MOADIAN_ECONOMIC_CODE: 'E',
      MOADIAN_CLIENT_ID: 'C',
      MOADIAN_PRIVATE_KEY: TEST_PRIVATE_PEM,
      MOADIAN_CERTIFICATE: TEST_CERT_PEM,
    };
    const report = await makeService(async () => {
      throw Object.assign(new Error('The operation was aborted'), { cause: { code: 'ETIMEDOUT' } });
    }).runConnectionDiagnostics();
    expect(report.steps.find((s) => s.step === 'network')?.errorCode).toBe('TIMEOUT');
  });

  it('HTTP 404: server reachable (PASS) but authentication still fails → overall FAIL', async () => {
    process.env = {
      MOADIAN_MODE: 'sandbox',
      MOADIAN_FISCAL_ID: 'F',
      MOADIAN_ECONOMIC_CODE: 'E',
      MOADIAN_CLIENT_ID: 'C',
      MOADIAN_PRIVATE_KEY: TEST_PRIVATE_PEM,
      MOADIAN_CERTIFICATE: TEST_CERT_PEM,
    };
    const report = await makeService(async (input) => {
      const url = String(input);
      if (url.includes('/nonce')) {
        return new Response(JSON.stringify({ nonce: 'n'.repeat(32), expDate: 1 }), {
          status: 200,
        }) as never;
      }
      return new Response('not found', { status: 404 }) as never;
    }).runConnectionDiagnostics();
    expect(report.steps.find((s) => s.step === 'network')?.status).toBe('PASS');
    const nonce = report.steps.find((s) => s.step === 'nonce');
    expect(nonce?.status).toBe('PASS');
    expect(report.steps.find((s) => s.step === 'server_information')?.status).toBe('FAIL');
    expect(report.overall).toBe('FAIL');
  });

  it('full sandbox flow: nonce OK + server info OK → ordered PASS through server_information', async () => {
    const stubPrisma = {
      moadianDiagnosticRun: {
        findUnique: async () => null,
        upsert: async (args: unknown) => args,
        update: async (args: unknown) => args,
      },
    };
    process.env = {
      MOADIAN_MODE: 'sandbox',
      MOADIAN_FISCAL_ID: 'F',
      MOADIAN_ECONOMIC_CODE: 'E',
      MOADIAN_CLIENT_ID: 'C',
      MOADIAN_PRIVATE_KEY: TEST_PRIVATE_PEM,
      MOADIAN_CERTIFICATE: TEST_CERT_PEM,
    };
    const report = await makeService(async (input, init) => {
      const url = String(input);
      if (url.includes('/nonce')) {
        return new Response(JSON.stringify({ nonce: 'n'.repeat(32), expDate: Date.now() + 1000 }), {
          status: 200,
        }) as never;
      }
      if (url.includes('server-information')) {
        // requires the Bearer JWS header — a valid one was built locally
        const auth = (init as RequestInit | undefined)?.headers as Record<string, string>;
        expect(auth.Authorization).toMatch(/^Bearer /);
        return new Response(
          JSON.stringify({ result: { publicKeyId: 'key-1', publicKey: 'pub' } }),
          { status: 200 },
        ) as never;
      }
      return new Response('not found', { status: 404 }) as never;
    }, stubPrisma).runConnectionDiagnostics();
    const byStep = Object.fromEntries(report.steps.map((s) => [s.step, s.status]));
    expect(byStep.configuration).toBe('PASS');
    expect(byStep.network).toBe('PASS');
    expect(byStep.nonce).toBe('PASS');
    expect(byStep.jws_local_construction).toBe('PASS');
    expect(byStep.remote_authentication).toBe('PASS');
    expect(report.overall).toBe('PASS');
  });

  it('basic diagnostic NEVER submits an invoice (no normal-enqueue call even in sandbox)', async () => {
    process.env = {
      MOADIAN_MODE: 'sandbox',
      MOADIAN_FISCAL_ID: 'F',
      MOADIAN_ECONOMIC_CODE: 'E',
      MOADIAN_CLIENT_ID: 'C',
      MOADIAN_PRIVATE_KEY: TEST_PRIVATE_PEM,
      MOADIAN_CERTIFICATE: TEST_CERT_PEM,
    };
    const urls: string[] = [];
    const report = await makeService(async (input) => {
      urls.push(String(input));
      if (String(input).includes('/nonce')) {
        return new Response(JSON.stringify({ nonce: 'n'.repeat(32) }), { status: 200 }) as never;
      }
      return new Response(
        JSON.stringify({ result: { publicKeyId: 'k', publicKey: 'p' } }),
        { status: 200 },
      ) as never;
    }).runConnectionDiagnostics();
    expect(urls.some((u) => u.includes('normal-enqueue'))).toBe(false);
  });
});
