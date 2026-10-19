// P0 guard unit tests: DATABASE_URL host/port/database validation with negative
// cases — run without DB (pure validation logic).
import { assertSafeIntegrationDatabase } from './db-guard';

describe('DATABASE_URL guard', () => {
  const OLD_OPT_IN = process.env.TCERP_INTEGRATION_ALLOW_DEV_DB;

  afterEach(() => {
    if (OLD_OPT_IN === undefined) delete process.env.TCERP_INTEGRATION_ALLOW_DEV_DB;
    else process.env.TCERP_INTEGRATION_ALLOW_DEV_DB = OLD_OPT_IN;
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

  it('refuses the development database "tcerp" unless explicitly opted in', () => {
    delete process.env.TCERP_INTEGRATION_ALLOW_DEV_DB;
    expect(() =>
      assertSafeIntegrationDatabase('postgresql://tcerp:tcerp@localhost:5433/tcerp?schema=public'),
    ).toThrow(/development database "tcerp".*TCERP_INTEGRATION_ALLOW_DEV_DB/s);
    // explicit opt-in allows it (documented escape hatch)
    process.env.TCERP_INTEGRATION_ALLOW_DEV_DB = '1';
    expect(() =>
      assertSafeIntegrationDatabase('postgresql://tcerp:tcerp@localhost:5433/tcerp?schema=public'),
    ).not.toThrow();
  });

  it('rejects non-local hosts (localhost.evil.example and others)', () => {
    expect(() =>
      assertSafeIntegrationDatabase('postgresql://u:p@localhost.evil.example:5432/tcerp_test'),
    ).toThrow(/host .* is not local/);
    expect(() =>
      assertSafeIntegrationDatabase('postgresql://u:p@db.production.example/tcerp_test'),
    ).toThrow(/is not local/);
  });

  it('rejects invalid/incomplete URLs', () => {
    expect(() => assertSafeIntegrationDatabase('not a url at all')).toThrow(/not a valid URL/);
    expect(() => assertSafeIntegrationDatabase('mysql://u:p@localhost/tcerp_test')).toThrow(
      /unexpected protocol/,
    );
  });

  it('rejects disallowed ports and unknown databases', () => {
    expect(() => assertSafeIntegrationDatabase('postgresql://u:p@localhost:9999/tcerp_test')).toThrow(
      /unexpected port 9999/,
    );
    expect(() =>
      assertSafeIntegrationDatabase('postgresql://u:p@localhost:5432/production_db'),
    ).toThrow(/unexpected database production_db/);
  });
});
