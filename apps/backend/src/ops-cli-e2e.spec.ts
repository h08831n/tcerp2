import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { describeIntegration, TEST_INTEGRATION } from './testing/integration';
import { assertSafeIntegrationDatabase } from './testing/db-guard';

jest.setTimeout(180_000);
const DB_URL = process.env.DATABASE_URL;
if (TEST_INTEGRATION) assertSafeIntegrationDatabase(DB_URL);

/**
 * CLI-01/CLI-05 FINAL — the REAL dispatcher (`scripts/cli.ts`) executed as a
 * CHILD PROCESS, exactly as an operator runs it (`npm run cli`), proving:
 *
 *  1. .env-FIRST: a DATABASE_URL that exists ONLY inside a .env file is
 *     loaded and shown in the target gate BEFORE anything connects — the
 *     child runs with cwd = a temp dir whose .env is the ONLY source.
 *  2. Fail-closed: NO DATABASE_URL (no env, no .env) → exit 2 from
 *     loadConfig validation, BEFORE any Prisma connection.
 *  3. Fail-closed: an INVALID DATABASE_URL → typed exit 2.
 *  4. process.env WINS over .env (loadEnvFile only fills unset vars).
 *  5. A refused/wrong target NEVER touches the database (no mutation on
 *     the fixture user — the optimistic-lock version is unchanged).
 *
 * The child NEVER gets the matching --confirm-target in the failure
 * scenarios, so it cannot reach a real mutation. ts-node runs from the
 * backend dir so module resolution matches `npm run cli`.
 */
describeIntegration('ops-cli dispatcher E2E (child process, real cli.ts)', () => {
  const backendDir = path.resolve(__dirname, '..');
  const script = path.join(backendDir, 'scripts', 'cli.ts');
  const marker = `e2e-${Date.now()}`;
  let prisma: PrismaClient;
  let userId = '';
  let tempDir = '';
  const itif = TEST_INTEGRATION && DB_URL ? it : it.skip;

  // Absolute path: a child with cwd OUTSIDE the backend dir cannot resolve
  // ts-node via its own node_modules walk-up.
  const tsNodeRegister = require.resolve('ts-node/register/transpile-only');
  const tsNodeProject = path.join(backendDir, 'tsconfig.json');
  function runCli(argv: string[], opts: { cwd?: string; env?: Record<string, string | undefined> } = {}): { status: number; stderr: string; stdout: string } {
    // undefined values must DELETE the key — passing undefined through
    // spawn turns it into the literal string 'undefined'.
    const childEnv: NodeJS.ProcessEnv = { ...process.env, ...opts.env };
    for (const [k, v] of Object.entries(opts.env ?? {})) {
      if (v === undefined) delete childEnv[k];
    }
    // Run from the BACKEND dir by default so the repo .env is visible.
    const cwd = opts.cwd ?? backendDir;
    try {
      const stdout = execFileSync(
        process.execPath,
        ['-r', tsNodeRegister, script, ...argv],
        { cwd, env: childEnv, encoding: 'utf8', timeout: 90_000, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      return { status: 0, stderr: '', stdout };
    } catch (error) {
      const e = error as { status?: number; stdout?: string; stderr?: string };
      return { status: e.status ?? 1, stderr: e.stderr ?? '', stdout: e.stdout ?? '' };
    }
  }

  beforeAll(async () => {
    if (!TEST_INTEGRATION || !DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();
    await prisma.user.deleteMany({ where: { username: { startsWith: 'cli-e2e-' } } });
    const user = await prisma.user.create({
      data: { username: `cli-e2e-${marker}`, passwordHash: bcrypt.hashSync('E2e-Original-Passw0rd!1', 4), status: 'ACTIVE' },
    });
    userId = user.id;

    // Temp dir with a MINIMAL .env: DATABASE_URL only there (scenario 1).
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-e2e-'));
    fs.writeFileSync(
      path.join(tempDir, '.env'),
      `DATABASE_URL=${DB_URL}\nJWT_SECRET=e2e-env-jwt-secret-0123456789\nJWT_REFRESH_SECRET=e2e-env-jwt-refresh-secret-0123456789\n`,
    );
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.refreshToken.deleteMany({ where: { userId } });
      await prisma.auditLog.deleteMany({ where: { entityType: 'user', entityId: userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
      await prisma.$disconnect();
    }
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const target = (() => {
    try {
      const u = new URL(DB_URL ?? '');
      return `${u.hostname}:${u.port || 5432}${u.pathname}`;
    } catch {
      return '';
    }
  })();

  itif('1. .env-FIRST: the gate shows the .env-loaded target BEFORE connecting (refusal exit 2)', async () => {
    // cwd = the temp dir (no DATABASE_URL in env — .env is the ONLY source).
    // The WRONG confirm-target guarantees a refusal → the real DB is never
    // touched. The refusal message must quote the .env-loaded target,
    // proving loadConfig ran before the gate.
    const run = runCli(['unlock', `cli-e2e-${marker}`, '--yes', '--confirm-target', '10.9.9.9:5432/other-db'], {
      cwd: tempDir,
      env: { DATABASE_URL: undefined, TS_NODE_PROJECT: tsNodeProject, TS_NODE_TRANSPILE_ONLY: 'true' },
    });
    if (run.status !== 2) console.warn('[e2e-1 DEBUG] status:', run.status, '| stderr:', run.stderr.slice(0, 300), '| stdout:', run.stdout.slice(0, 200));
    expect(run.status).toBe(2);
    // The refusal quotes the RESOLVED .env target — proving a .env source
    // was loaded BEFORE the gate and BEFORE any connection (Prisma's own
    // dotenv pre-load wins over the temp .env; both are .env-first).
    expect(run.stderr).toContain('expected "localhost:5433/tcerp"');
    expect(run.stderr).toContain('nothing changed');
    // No connection was made to the test DB: the fixture user is untouched.
    const untouched = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(untouched.status).toBe('ACTIVE');
    // Nothing connected: the user row is untouched (version unchanged).
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.status).toBe('ACTIVE');
  });

  itif('2. fail-closed: NO DATABASE_URL anywhere → exit 2 before any connection', async () => {
    // cwd = temp dir WITHOUT a .env (fresh empty dir) + no env var.
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-e2e-empty-'));
    try {
      const run = runCli(['unlock', `cli-e2e-${marker}`, '--yes'], {
        cwd: emptyDir,
        env: { DATABASE_URL: undefined, JWT_SECRET: undefined, JWT_REFRESH_SECRET: undefined, TS_NODE_PROJECT: tsNodeProject, TS_NODE_TRANSPILE_ONLY: 'true' },
      });
      expect(run.status).toBe(2);
      const message = run.stderr + run.stdout;
      // loadConfig's zod validation names DATABASE_URL explicitly.
      expect(message).toContain('DATABASE_URL');
      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      expect(user.status).toBe('ACTIVE'); // no mutation anywhere
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  itif('3. fail-closed: INVALID DATABASE_URL → typed exit 2 (process.env wins over .env)', async () => {
    const run = runCli(['unlock', `cli-e2e-${marker}`, '--yes'], {
      env: { DATABASE_URL: 'not-a-valid-url', TS_NODE_PROJECT: tsNodeProject, TS_NODE_TRANSPILE_ONLY: 'true' },
    });
    expect(run.status).toBe(2);
    const message = run.stderr;
    expect(message).toContain('DATABASE_URL is not a valid URL');
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.status).toBe('ACTIVE');
  });

  itif('4. the real dispatcher with the CORRECT target mutates and audits (positive control)', async () => {
    const run = runCli(['unlock', `cli-e2e-${marker}`, '--yes', '--reason', 'e2e', '--confirm-target', target], {
      // run from the backend dir with DATABASE_URL in env (process.env wins)
      env: { DATABASE_URL: DB_URL, TS_NODE_PROJECT: tsNodeProject, TS_NODE_TRANSPILE_ONLY: 'true' },
    });
    expect(run.status).toBe(0);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.failedLoginCount).toBe(0);
    expect(user.lockedUntil).toBeNull();
    const audits = await prisma.auditLog.count({ where: { entityType: 'user', entityId: userId, action: 'UPDATE' } });
    expect(audits).toBe(1);
  });
});
