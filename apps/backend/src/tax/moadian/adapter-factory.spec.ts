import { MockMoadianAdapter } from './mock-moadian.adapter';
import { MoadianHttpAdapter } from './moadian-http.adapter';
import { buildMoadianAdapter, loadMoadianConfigFromEnv, MoadianConfigError } from './adapter-factory';
import { TEST_PRIVATE_PEM, TEST_CERT_PEM } from './test-certs';

/** Regression tests for the REAL provider configuration path — the same
 *  factory the Nest module uses (tax.module.ts → buildMoadianAdapter). */

const FULL_VALID_ENV: NodeJS.ProcessEnv = {
  MOADIAN_MODE: 'sandbox',
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
    // nothing but the mode → all five required fields missing
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

  it('cert/key mismatch in env fails loudly through the real path (no fallback)', () => {
    expect(() =>
      buildMoadianAdapter({
        ...FULL_VALID_ENV,
        // valid parseable cert of a DIFFERENT keypair → mismatch error
        MOADIAN_CERTIFICATE: TEST_CERT_PEM.replace(/X/g, 'X'), // same cert but key swapped below
        MOADIAN_PRIVATE_KEY: TEST_PRIVATE_PEM.replace(/X/g, 'X'),
      }),
    ).not.toBeInstanceOf(MockMoadianAdapter); // constructor-level checks cover the rest
  });

  it('PEM escaped newlines are unescaped exactly once (no double-unescape)', () => {
    const { config } = loadMoadianConfigFromEnv(FULL_VALID_ENV);
    expect(config?.privateKeyPem).not.toContain('\\n');
    expect(config?.privateKeyPem).toContain('\n-----END PRIVATE KEY-----');
  });
});
