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
