// P0 guard unit tests: DATABASE_URL host/port/database validation with negative
// cases — run without DB (pure validation logic).
import { assertSafeIntegrationDatabase } from './db-guard';

describe('g7i-p0 DATABASE_URL guard', () => {
  it('accepts localhost / 127.0.0.1 / ::1 with allowed ports and tcerp databases', () => {
    expect(() =>
      assertSafeIntegrationDatabase('postgresql://tcerp:tcerp@localhost:5433/tcerp?schema=public'),
    ).not.toThrow();
    expect(() =>
      assertSafeIntegrationDatabase('postgres://u:p@127.0.0.1:5432/tcerp_test'),
    ).not.toThrow();
    expect(() => assertSafeIntegrationDatabase('postgresql://u:p@[::1]:5432/tcerp_shadow')).not.toThrow();
    // default port 5432 when omitted
    expect(() => assertSafeIntegrationDatabase('postgresql://u:p@localhost/tcerp')).not.toThrow();
  });

  it('rejects non-local hosts (localhost.evil.example and others)', () => {
    expect(() =>
      assertSafeIntegrationDatabase('postgresql://u:p@localhost.evil.example:5432/tcerp'),
    ).toThrow(/host .* is not local/);
    expect(() => assertSafeIntegrationDatabase('postgresql://u:p@db.production.example/tcerp')).toThrow(
      /is not local/,
    );
  });

  it('rejects invalid/incomplete URLs', () => {
    expect(() => assertSafeIntegrationDatabase('not a url at all')).toThrow(/not a valid URL/);
    expect(() => assertSafeIntegrationDatabase('mysql://u:p@localhost/tcerp')).toThrow(/unexpected protocol/);
  });

  it('rejects disallowed ports and databases', () => {
    expect(() => assertSafeIntegrationDatabase('postgresql://u:p@localhost:9999/tcerp')).toThrow(
      /unexpected port 9999/,
    );
    expect(() => assertSafeIntegrationDatabase('postgresql://u:p@localhost:5432/production_db')).toThrow(
      /unexpected database production_db/,
    );
  });
});
