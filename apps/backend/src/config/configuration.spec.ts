import { randomBytes } from 'node:crypto';

describe('configuration — portal OTP rate-limit defaults', () => {
  const REQUIRED = {
    DATABASE_URL: 'postgresql://tcerp:tcerp@localhost:5433/tcerp_test?schema=public',
    JWT_SECRET: 'unit-test-jwt-secret-0123456789',
    JWT_REFRESH_SECRET: 'unit-test-jwt-refresh-secret-0123456789',
  };

  it('D2-11: defaults match the ratified policy — mobile 1/min, IP 10/hour (docs/15)', () => {
    const config = loadConfigFor(REQUIRED);
    expect(config.PORTAL_OTP_MOBILE_PER_MINUTE).toBe(1);
    expect(config.PORTAL_OTP_IP_PER_HOUR).toBe(10);
  });

  it('D2-11: both limits are overridable via env', () => {
    const config = loadConfigFor({ ...REQUIRED, PORTAL_OTP_MOBILE_PER_MINUTE: '2', PORTAL_OTP_IP_PER_HOUR: '25' });
    expect(config.PORTAL_OTP_MOBILE_PER_MINUTE).toBe(2);
    expect(config.PORTAL_OTP_IP_PER_HOUR).toBe(25);
  });
});

describe('configuration — production insecure-sample guard', () => {
  // Positive-case secrets are GENERATED at test runtime (crypto RNG) — real
  // credentials are never committed to the repository.
  const randomSecret = () => randomBytes(48).toString('base64url');
  const strongPassword = () => randomBytes(18).toString('base64url') + '!Aa1';
  const PROD = {
    DATABASE_URL: 'postgresql://tcerp:tcerp@localhost:5433/tcerp_test?schema=public',
    NODE_ENV: 'production',
  };

  it('production REFUSES the .env.example seed password placeholder', () => {
    expect(() =>
      loadConfigFor({ ...PROD, JWT_SECRET: randomSecret(), JWT_REFRESH_SECRET: randomSecret(), SEED_ADMIN_PASSWORD: 'change-me-strong-password' }),
    ).toThrow(/well-known default seed admin password/);
  });

  it('production REFUSES the legacy Admin@12345', () => {
    expect(() =>
      loadConfigFor({ ...PROD, JWT_SECRET: randomSecret(), JWT_REFRESH_SECRET: randomSecret(), SEED_ADMIN_PASSWORD: 'Admin@12345' }),
    ).toThrow(/well-known default seed admin password/);
  });

  it('production REFUSES BOTH sample JWT secrets (public values, valid length)', () => {
    expect(() =>
      loadConfigFor({ ...PROD, JWT_SECRET: 'change-me-to-a-long-random-string', JWT_REFRESH_SECRET: randomSecret(), SEED_ADMIN_PASSWORD: strongPassword() }),
    ).toThrow(/JWT_SECRET is a public sample value/);
    expect(() =>
      loadConfigFor({ ...PROD, JWT_SECRET: randomSecret(), JWT_REFRESH_SECRET: 'change-me-to-another-long-random-string', SEED_ADMIN_PASSWORD: strongPassword() }),
    ).toThrow(/JWT_REFRESH_SECRET is a public sample value/);
  });

  it('development still boots with ALL sample values (guard is production-only)', () => {
    const config = loadConfigFor({
      DATABASE_URL: PROD.DATABASE_URL,
      NODE_ENV: 'development',
      JWT_SECRET: 'change-me-to-a-long-random-string',
      JWT_REFRESH_SECRET: 'change-me-to-another-long-random-string',
      SEED_ADMIN_PASSWORD: 'change-me-strong-password',
    });
    expect(config.NODE_ENV).toBe('development');
  });

  it('production ACCEPTS real generated-for-test secrets (same policy, strong values)', () => {
    const jwt = randomSecret();
    const config = loadConfigFor({
      ...PROD,
      JWT_SECRET: jwt,
      JWT_REFRESH_SECRET: randomSecret(),
      SEED_ADMIN_PASSWORD: strongPassword(),
    });
    expect(config.JWT_SECRET).toBe(jwt);
  });
});

/** loadConfig caches process-wide; the cached instance would leak the first
 *  test's env into the second. Reset through the module's own back door —
 *  acceptable in a unit test because each run boots a fresh process. */
function loadConfigFor(env: Record<string, string>) {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { loadConfig: fresh } = require('./configuration');
  const saved = Object.entries(env).map(([k]) => [k, process.env[k]] as const);
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  try {
    return fresh();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
