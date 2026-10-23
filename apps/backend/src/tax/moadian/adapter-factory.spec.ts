import { Test } from '@nestjs/testing';
import { MockMoadianAdapter } from './mock-moadian.adapter';
import { MoadianHttpAdapter } from './moadian-http.adapter';
import { MOADIAN_ADAPTER, MoadianAdapter } from './moadian-adapter';
import { buildMoadianAdapter, loadMoadianConfigFromEnv, MoadianConfigError } from './adapter-factory';
import { MOADIAN_ADAPTER_PROVIDER } from '../tax.module';
import { TEST_PRIVATE_PEM, TEST_CERT_PEM, OTHER_CERT_PEM } from './test-certs';

/** Regression tests for the REAL provider configuration path — the same
 *  factory the Nest module uses (tax.module.ts → MOADIAN_ADAPTER provider →
 *  buildMoadianAdapter). The provider-level tests compile the actual TaxModule
 *  through @nestjs/testing and resolve the injected MOADIAN_ADAPTER token. */

const FULL_VALID_ENV: NodeJS.ProcessEnv = {
  MOADIAN_MODE: 'sandbox',
  MOADIAN_BASE_URL: 'https://tp.tax.gov.ir/requestsmanager/api/v2',
  MOADIAN_FISCAL_ID: 'TESTFISCAL',
  MOADIAN_ECONOMIC_CODE: '411111111111',
  MOADIAN_CLIENT_ID: 'test-client-id',
  // PEM with escaped newlines — exactly how it arrives from a real
  // environment (.env / CI secret); the factory must unescape it
  MOADIAN_PRIVATE_KEY: TEST_PRIVATE_PEM.replace(/\n/g, '\\n'),
  MOADIAN_CERTIFICATE: TEST_CERT_PEM.replace(/\n/g, '\\n'),
};

describe('Moadian adapter factory (real provider configuration path)', () => {
  const SAVED_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...SAVED_ENV };
  });

  it('MOADIAN_MODE unset (default) selects ONLY the mock adapter', () => {
    const adapter = buildMoadianAdapter({});
    expect(adapter).toBeInstanceOf(MockMoadianAdapter);
    expect(adapter).not.toBeInstanceOf(MoadianHttpAdapter);
  });

  it('MOADIAN_MODE=mock selects ONLY the mock adapter even when credentials exist', () => {
    const adapter = buildMoadianAdapter({ ...FULL_VALID_ENV, MOADIAN_MODE: 'mock' });
    expect(adapter).toBeInstanceOf(MockMoadianAdapter);
  });

  it('sandbox mode passes EVERY required field and constructs the HTTP adapter', () => {
    const adapter = buildMoadianAdapter(FULL_VALID_ENV);
    expect(adapter).toBeInstanceOf(MoadianHttpAdapter);
    // every field wired through the REAL path (env var names → constructor)
    const http = adapter as MoadianHttpAdapter;
    expect(http.base).toBe('https://tp.tax.gov.ir/requestsmanager/api/v2');
    expect(http.fiscalId).toBe('TESTFISCAL');
    expect(http.economicCode).toBe('411111111111');
    expect(http.clientId).toBe('test-client-id');
    expect(http.privateKeyPem).toBe(TEST_PRIVATE_PEM); // unescaped correctly
    expect(http.certificatePem).toBe(TEST_CERT_PEM);
  });

  it('live mode also constructs with the same credential wiring', () => {
    expect(buildMoadianAdapter({ ...FULL_VALID_ENV, MOADIAN_MODE: 'live' })).toBeInstanceOf(
      MoadianHttpAdapter,
    );
  });

  it('missing credentials fail EXPLICITLY with every missing env name', () => {
    expect(() => buildMoadianAdapter({ MOADIAN_MODE: 'sandbox' })).toThrow(MoadianConfigError);
    try {
      loadMoadianConfigFromEnv({ MOADIAN_MODE: 'sandbox' });
      fail('should have thrown');
    } catch (e) {
      const message = (e as Error).message;
      expect(message).toContain('MOADIAN_MODE=sandbox');
      for (const name of [
        'MOADIAN_FISCAL_ID',
        'MOADIAN_ECONOMIC_CODE',
        'MOADIAN_CLIENT_ID',
        'MOADIAN_PRIVATE_KEY',
        'MOADIAN_CERTIFICATE',
      ]) {
        expect(message).toContain(name);
      }
    }
  });

  it('missing ONLY clientId/certificate still fails (the fields the old factory forgot)', () => {
    const { MOADIAN_CLIENT_ID, MOADIAN_CERTIFICATE, ...withoutBoth } = FULL_VALID_ENV;
    void MOADIAN_CLIENT_ID;
    void MOADIAN_CERTIFICATE;
    expect(() => buildMoadianAdapter(withoutBoth)).toThrow(/MOADIAN_CLIENT_ID, MOADIAN_CERTIFICATE/);
  });

  it('a configuration error NEVER silently falls back to mock mode', () => {
    let threw = false;
    try {
      buildMoadianAdapter({ MOADIAN_MODE: 'live' }); // no credentials at all
    } catch (e) {
      threw = true;
      expect(e).toBeInstanceOf(MoadianConfigError);
    }
    expect(threw).toBe(true); // no MockMoadianAdapter was returned
  });

  it('genuine SECOND keypair certificate → MOADIAN_CERT_KEY_MISMATCH, never mock fallback', () => {
    let threw = false;
    try {
      // valid parseable X.509 of a DIFFERENT keypair with our private key
      buildMoadianAdapter({ ...FULL_VALID_ENV, MOADIAN_CERTIFICATE: OTHER_CERT_PEM });
    } catch (e) {
      threw = true;
      expect((e as Error).message).toContain('MOADIAN_CERT_KEY_MISMATCH');
      expect(e).not.toBeInstanceOf(MoadianConfigError); // cert-level, not env-level
    }
    expect(threw).toBe(true); // loud failure — MockMoadianAdapter never returned
  });

  it('PEM escaped newlines are unescaped exactly once (no double-unescape)', () => {
    const { config } = loadMoadianConfigFromEnv(FULL_VALID_ENV);
    expect(config?.privateKeyPem).not.toContain('\\n');
    expect(config?.privateKeyPem).toContain('\n-----END PRIVATE KEY-----');
  });

  describe('strict MOADIAN_MODE validation', () => {
    it('invalid non-empty value is rejected with a dedicated error (never treated as live)', () => {
      for (const bad of ['production', 'LIVE', ' ', 'test', '1']) {
        expect(() => buildMoadianAdapter({ ...FULL_VALID_ENV, MOADIAN_MODE: bad })).toThrow(
          MoadianConfigError,
        );
        expect(() => loadMoadianConfigFromEnv({ MOADIAN_MODE: bad })).toThrow(/invalid value/);
      }
    });

    it('valid modes pass: mock, sandbox, live', () => {
      expect(loadMoadianConfigFromEnv({}).mode).toBe('mock');
      expect(loadMoadianConfigFromEnv({ MOADIAN_MODE: 'mock' }).mode).toBe('mock');
      expect(loadMoadianConfigFromEnv({ ...FULL_VALID_ENV, MOADIAN_MODE: 'sandbox' }).mode).toBe(
        'sandbox',
      );
      expect(loadMoadianConfigFromEnv({ ...FULL_VALID_ENV, MOADIAN_MODE: 'live' }).mode).toBe('live');
    });
  });
});

describe('MOADIAN_ADAPTER NestJS provider (the REAL TaxModule wiring)', () => {
  const SAVED_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...SAVED_ENV };
  });

  async function resolveProvider(env: NodeJS.ProcessEnv): Promise<MoadianAdapter> {
    process.env = env; // the real provider factory reads process.env at construction
    const moduleRef = await Test.createTestingModule({
      providers: [MOADIAN_ADAPTER_PROVIDER],
    }).compile();
    return moduleRef.get<MoadianAdapter>(MOADIAN_ADAPTER);
  }

  it('default env → the injected provider is the MOCK adapter', async () => {
    const env = { ...SAVED_ENV };
    delete env.MOADIAN_MODE;
    const adapter = await resolveProvider(env);
    expect(adapter).toBeInstanceOf(MockMoadianAdapter);
  });

  it('sandbox env with valid test credentials → the injected provider is the HTTP adapter with every field', async () => {
    const adapter = await resolveProvider({ ...FULL_VALID_ENV });
    expect(adapter).toBeInstanceOf(MoadianHttpAdapter);
    const http = adapter as MoadianHttpAdapter;
    expect(http.fiscalId).toBe('TESTFISCAL');
    expect(http.economicCode).toBe('411111111111');
    expect(http.clientId).toBe('test-client-id');
    expect(http.privateKeyPem).toBe(TEST_PRIVATE_PEM);
    expect(http.certificatePem).toBe(TEST_CERT_PEM);
  });

  it('sandbox env with missing credentials → provider resolution FAILS (no mock fallback)', async () => {
    await expect(resolveProvider({ MOADIAN_MODE: 'sandbox' })).rejects.toThrow(MoadianConfigError);
  });

  it('invalid MOADIAN_MODE → provider resolution FAILS', async () => {
    await expect(
      resolveProvider({ ...FULL_VALID_ENV, MOADIAN_MODE: 'production' }),
    ).rejects.toThrow(/invalid value/);
  });
});
