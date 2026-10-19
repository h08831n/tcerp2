// P0 guard unit tests: DATABASE_URL host/port/database validation with negative
// cases — run without DB (pure validation logic). Regression coverage for the
// DB Safety Gate: fail closed on a missing URL during an integration run,
// dev-database opt-in policy, and credential-free error messages.
import { assertSafeIntegrationDatabase } from './db-guard';

describe('DATABASE_URL guard', () => {
  const SAVED = {
    TCERP_INTEGRATION_ALLOW_DEV_DB: process.env.TCERP_INTEGRATION_ALLOW_DEV_DB,
    TEST_INTEGRATION: process.env.TEST_INTEGRATION,
    DATABASE_URL: process.env.DATABASE_URL,
  };

  afterEach(() => {
    for (const [k, v] of Object.entries(SAVED)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('accepts local hosts on allowed ports against dedicated test databases', () => {
    expect(() =>
      assertSafeIntegrationDatabase('postgresql://tcerp:tcerp@localhost:5433/tcerp_test?schema=public'),
    ).not.toThrow();
    expect(() =>
      assertSafeIntegrationDatabase('postgres://u:p@127.0.0.1:5432/tcerp_test'),
    ).not.toThrow();
    expect(() => assertSafeIntegrationDatabase('postgresql://u:p@[::1]:5432/tcerp_shadow')).not.toThrow();
  });

  it('FAILS CLOSED when TEST_INTEGRATION=1 and DATABASE_URL is missing', () => {
    process.env.TEST_INTEGRATION = '1';
    delete process.env.DATABASE_URL;
    expect(() => assertSafeIntegrationDatabase(undefined)).toThrow(
      /TEST_INTEGRATION=1 but DATABASE_URL is not set/,
    );
  });

  it('does NOT throw on a missing URL outside integration mode (unit runs skip)', () => {
    delete process.env.TEST_INTEGRATION;
    delete process.env.DATABASE_URL;
    expect(() => assertSafeIntegrationDatabase(undefined)).not.toThrow();
  });

  it('refuses a direct Jest integration run whose .env resolves to the development database', () => {
    // simulates TEST_INTEGRATION=1 with no exported DATABASE_URL while
    // Prisma's dotenv load populated process.env.DATABASE_URL from .env (tcerp)
    process.env.TEST_INTEGRATION = '1';
    process.env.DATABASE_URL = 'postgresql://tcerp:tcerp@localhost:5433/tcerp?schema=public';
    expect(() => assertSafeIntegrationDatabase(process.env.DATABASE_URL)).toThrow(
      /development database "tcerp"/,
    );
  });

  it('allows the development database ONLY with the explicit opt-in', () => {
    process.env.DATABASE_URL = 'postgresql://tcerp:tcerp@localhost:5433/tcerp?schema=public';
    process.env.TEST_INTEGRATION = '1';
    delete process.env.TCERP_INTEGRATION_ALLOW_DEV_DB;
    expect(() => assertSafeIntegrationDatabase(process.env.DATABASE_URL)).toThrow(
      /TCERP_INTEGRATION_ALLOW_DEV_DB/,
    );
    process.env.TCERP_INTEGRATION_ALLOW_DEV_DB = '1';
    expect(() => assertSafeIntegrationDatabase(process.env.DATABASE_URL)).not.toThrow();
  });

  it('rejects non-local hosts (localhost.evil.example and others)', () => {
    expect(() =>
      assertSafeIntegrationDatabase('postgresql://u:p@localhost.evil.example:5432/tcerp_test'),
    ).toThrow(/host .* is not local/);
    expect(() =>
      assertSafeIntegrationDatabase('postgresql://u:p@db.production.example/tcerp_test'),
    ).toThrow(/is not local/);
  });

  it('rejects invalid URLs, wrong protocols, bad ports and unknown databases', () => {
    expect(() => assertSafeIntegrationDatabase('not a url at all')).toThrow(/not a valid URL/);
    expect(() => assertSafeIntegrationDatabase('mysql://u:p@localhost/tcerp_test')).toThrow(
      /unexpected protocol/,
    );
    expect(() => assertSafeIntegrationDatabase('postgresql://u:p@localhost:9999/tcerp_test')).toThrow(
      /unexpected port 9999/,
    );
    expect(() =>
      assertSafeIntegrationDatabase('postgresql://u:p@localhost:5432/production_db'),
    ).toThrow(/unexpected database production_db/);
  });

  it('NEVER leaks credentials in thrown error messages', () => {
    const secretPassword = 'SECRETPW_DO_NOT_LEAK_9f3a';
    const cases = [
      'not a url at all',
      `not$ a url ${secretPassword}`,
      `mysql://admin:${secretPassword}@localhost/tcerp_test`,
      `postgresql://admin:${secretPassword}@db.production.example:5432/tcerp_test`,
      `postgresql://admin:${secretPassword}@localhost:9999/tcerp_test`,
      `postgresql://admin:${secretPassword}@localhost:5432/production_db`,
      `postgresql://admin:${secretPassword}@localhost:5433/tcerp`,
    ];
    for (const url of cases) {
      try {
        assertSafeIntegrationDatabase(url);
      } catch (e) {
        expect((e as Error).message).not.toContain(secretPassword);
        expect((e as Error).message).not.toContain(`${secretPassword}@`);
      }
    }
  });
});
