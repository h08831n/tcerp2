// P0 DATABASE_URL guard: parse with the standard URL parser and validate
// host/port/database exactly — used by integration test suites to refuse
// running against anything but a dedicated test database.
//
// Policy:
//  - FAIL CLOSED: during a real integration run (TEST_INTEGRATION=1) a
//    missing DATABASE_URL is an error, never a silent pass — otherwise the
//    Prisma client could fall back to loading `.env` (which points at the
//    development database) without any target validation.
//  - `tcerp_test` / `tcerp_shadow` are the designated test databases — always
//    allowed.
//  - `tcerp` is the DEVELOPMENT database. Running destructive integration
//    tests against it requires an EXPLICIT opt-in: set
//    `TCERP_INTEGRATION_ALLOW_DEV_DB=1` in the environment. Without it the
//    guard throws — the dev database is never silently treated as a test
//    database.
//  - Error messages NEVER contain the URL or any credentials.
export function assertSafeIntegrationDatabase(url: string | undefined): void {
  if (!url) {
    if (process.env.TEST_INTEGRATION === '1') {
      throw new Error(
        'SAFETY: TEST_INTEGRATION=1 but DATABASE_URL is not set — refusing to guess the database ' +
          'target (a Prisma client would fall back to .env). Export DATABASE_URL pointing at a ' +
          'dedicated test database, or use `npm run test:integration` which defaults to tcerp_test.',
      );
    }
    return; // unit mode / no DB → suites skip loudly below
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('SAFETY: DATABASE_URL is not a valid URL');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error(`SAFETY: unexpected protocol ${parsed.protocol}`);
  }
  // Node URL keeps brackets for IPv6 literals — strip before comparing
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  const ALLOWED_HOSTS = ['localhost', '127.0.0.1', '::1'];
  if (!ALLOWED_HOSTS.includes(host)) {
    throw new Error(`SAFETY: integration tests refused — host ${host} is not local`);
  }
  const port = parsed.port || '5432';
  const ALLOWED_PORTS = ['5432', '5433'];
  if (!ALLOWED_PORTS.includes(port)) {
    throw new Error(`SAFETY: unexpected port ${port}`);
  }
  const db = parsed.pathname.replace(/^\//, '');
  if (/^(tcerp_test|tcerp_shadow)$/.test(db)) return; // dedicated test databases
  if (db === 'tcerp') {
    // development database — explicit opt-in required, never implicit
    if (process.env.TCERP_INTEGRATION_ALLOW_DEV_DB !== '1') {
      throw new Error(
        'SAFETY: integration tests refused — DATABASE_URL targets the development database "tcerp". ' +
          'Use the dedicated test database "tcerp_test" (npm run test:integration sets it automatically), ' +
          'or set TCERP_INTEGRATION_ALLOW_DEV_DB=1 to explicitly opt in.',
      );
    }
    return;
  }
  throw new Error(`SAFETY: unexpected database ${db}`);
}
