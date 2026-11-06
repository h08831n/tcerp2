import { Prisma, PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { describeIntegration, TEST_INTEGRATION } from './testing/integration';
import { assertSafeIntegrationDatabase } from './testing/db-guard';
import { CliContext, CliError, confirmTargetGate, dbLabel, parseArgs, writeAudit } from '../scripts/cli-lib';
import { runCli } from '../scripts/cli';
import * as resetPassword from '../scripts/cli-commands/reset-password';
import * as unlock from '../scripts/cli-commands/unlock';
import * as setStatus from '../scripts/cli-commands/set-status';

jest.setTimeout(120_000);
const DB_URL = process.env.DATABASE_URL;
if (TEST_INTEGRATION) assertSafeIntegrationDatabase(DB_URL);

/**
 * CLI-04 — automated tests for the operator CLI (scripts/cli-commands/*).
 *
 * The command modules are invoked IN-PROCESS (run(prisma, args, ctx)) against
 * the integration test database — no real account is ever touched. Failure
 * injection replaces the transaction client's delegates (CLI-01 rollback
 * proofs) or ctx.audit. NOTE: --stdin scenarios require a NON-TTY stdin
 * (jest workers pipe stdin; run jest with `< /dev/null` if in doubt).
 */
describeIntegration('ops-cli (in-process command runs on the test DB)', () => {
  let prisma: PrismaClient;
  const marker = `clispec-${Date.now()}`;
  const createdUserIds: string[] = [];
  let foreignUserId = '';
  const PASSWORD = 'Cli-Spec-Passw0rd!9';
  // CLI-05: the FULL destructive target — every destructive run must confirm
  // THIS exact string (host:port/database), not just the database name.
  const TARGET = 'localhost:5433/tcerp_test';
  const itif = TEST_INTEGRATION && DB_URL ? it : it.skip;

  // CLI-06: unique usernames per RUN — re-runs never collide and no broad
  // cleanup by name prefix is needed (or allowed).
  const u = (name: string): string => `cli-spec-${marker}-${name}`;

  const args = (...argv: string[]): CliContext['args'] => parseArgs(argv);

  function makeCtx(overrides: Partial<CliContext> = {}): CliContext {
    return {
      args: args(),
      target: TARGET,
      production: false,
      operator: 'spec-operator',
      stdin: async () => PASSWORD,
      confirmInput: async () => TARGET,
      audit: (client, entry) => writeAudit(client, entry, 'spec-operator'),
      ...overrides,
    };
  }

  /** CLI-01 rollback proofs: poison ONE delegate of the transaction client. */
  function withInjectedFailure(client: PrismaClient, model: string, method: string): PrismaClient {
    const poison = (trx: object): object =>
      new Proxy(trx, {
        get(target, prop, receiver) {
          if (prop === model) {
            const delegate = Reflect.get(target, prop, receiver) as Record<string, unknown>;
            return new Proxy(delegate, {
              get(dTarget, dProp, dReceiver) {
                if (dProp === method) {
                  return () => Promise.reject(new Error(`INJECTED_FAILURE:${model}.${method}`));
                }
                return Reflect.get(dTarget, dProp, dReceiver);
              },
            });
          }
          return Reflect.get(target, prop, receiver);
        },
      });
    return new Proxy(client, {
      get(target, prop, receiver) {
        if (prop === '$transaction') {
          return (cb: (trx: unknown) => Promise<unknown>) =>
            target.$transaction(async (trx) => cb(poison(trx as unknown as object)));
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as PrismaClient;
  }

  async function createUser(username: string, opts: { status?: 'ACTIVE' | 'DISABLED' | 'LOCKED'; failed?: number; locked?: boolean; token?: boolean } = {}): Promise<string> {
    const user = await prisma.user.create({
      data: {
        username,
        passwordHash: bcrypt.hashSync('Original-Passw0rd!1', 4),
        status: opts.status ?? 'ACTIVE',
        mustChangePassword: false,
        failedLoginCount: opts.failed ?? 0,
        lockedUntil: opts.locked ? new Date(Date.now() + 600_000) : null,
      },
    });
    createdUserIds.push(user.id);
    if (opts.token) {
      await prisma.refreshToken.create({
        data: { userId: user.id, tokenHash: ('b'.repeat(32) + randomUUID().replace(/-/g, '')).slice(0, 64), expiresAt: new Date(Date.now() + 3_600_000) },
      });
    }
    return user.id;
  }

  async function auditsFor(userId: string): Promise<{ action: string; actorName: string | null; reason: string | null; oldValues: Prisma.JsonValue | null; newValues: Prisma.JsonValue | null }[]> {
    return prisma.auditLog.findMany({ where: { entityType: 'user', entityId: userId, actorName: 'cli:spec-operator' }, orderBy: { createdAt: 'asc' } });
  }

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient();
    await prisma.$connect();
    // CLI-06: NO broad cleanup — every test deletes exactly what it created
    // (tracked ids in afterAll) and names are unique per run. A FOREIGN user
    // with a similar prefix must SURVIVE the whole suite (tripwire below).
    const foreign = await prisma.user.create({
      data: {
        username: u('foreign'),
        passwordHash: bcrypt.hashSync('Foreign-Passw0rd!1', 4),
        status: 'ACTIVE',
      },
    });
    foreignUserId = foreign.id;
  });

  afterAll(async () => {
    if (!prisma) return;
    // CLI-06 tripwire: the FOREIGN user must still exist — any cleanup that
    // touches records this suite does not own fails the suite here.
    const foreign = await prisma.user.findUnique({ where: { id: foreignUserId } });
    if (!foreign) throw new Error('CLI-06: the FOREIGN cli-spec user was DELETED by suite cleanup');
    // The tripwire proved its point — remove THIS run's foreign fixture by
    // its own tracked id (still never a bulk delete).
    await prisma.user.delete({ where: { id: foreignUserId } });
    for (const id of createdUserIds) {
      await prisma.auditLog.deleteMany({ where: { entityType: 'user', entityId: id } });
      await prisma.refreshToken.deleteMany({ where: { userId: id } });
      await prisma.user.deleteMany({ where: { id } });
    }
    await prisma.$disconnect();
  });

  // ------------------------------------------------------ reset-password

  itif('1/3/14: reset succeeds — bcrypt.compare OK, mustChange, lockout cleared, ALL refresh tokens revoked', async () => {
    const id = await createUser(u('reset'), { failed: 5, locked: true, token: true });
    await prisma.refreshToken.create({ data: { userId: id, tokenHash: 'c'.repeat(64), expiresAt: new Date(Date.now() + 3_600_000) } });

    const code = await resetPassword.run(prisma, args(u('reset'), '--stdin', '--yes'), makeCtx());
    expect(code).toBe(0);

    const user = await prisma.user.findUniqueOrThrow({ where: { id } });
    expect(await bcrypt.compare(PASSWORD, user.passwordHash)).toBe(true); // 14: self-verify against the STORED hash
    expect(user.mustChangePassword).toBe(true);
    expect(user.failedLoginCount).toBe(0);
    expect(user.lockedUntil).toBeNull();
    const tokens = await prisma.refreshToken.findMany({ where: { userId: id } }); // 3: ALL revoked
    expect(tokens.length).toBeGreaterThanOrEqual(2);
    expect(tokens.every((t) => t.revokedAt !== null)).toBe(true);
  });

  itif('2: a weak password is rejected and the database is unchanged', async () => {
    const id = await createUser(u('weak'));
    const before = await prisma.user.findUniqueOrThrow({ where: { id } });
    const ctx = makeCtx({ stdin: async () => 'short1!' });
    const code = await resetPassword.run(prisma, args(u('weak'), '--stdin', '--yes'), ctx);
    expect(code).toBe(1);
    const after = await prisma.user.findUniqueOrThrow({ where: { id } });
    expect(after.passwordHash).toBe(before.passwordHash); // unchanged
    expect(after.mustChangePassword).toBe(false);
  });

  itif('4: an audit failure rolls EVERYTHING back (no partial reset)', async () => {
    const id = await createUser(u('auditfail'), { token: true });
    const before = await prisma.user.findUniqueOrThrow({ where: { id } });
    const ctx = makeCtx({
      audit: async () => {
        throw new Error('INJECTED_AUDIT_FAILURE');
      },
    });
    await expect(resetPassword.run(prisma, args(u('auditfail'), '--stdin', '--yes'), ctx)).rejects.toThrow('INJECTED_AUDIT_FAILURE');
    const after = await prisma.user.findUniqueOrThrow({ where: { id } });
    expect(after.passwordHash).toBe(before.passwordHash); // password NOT changed
    expect(after.mustChangePassword).toBe(false);
    expect(after.failedLoginCount).toBe(0);
    const tokens = await prisma.refreshToken.findMany({ where: { userId: id } });
    expect(tokens.every((t) => t.revokedAt === null)).toBe(true); // revocation rolled back too
  });

  itif('5: a refresh-token revocation failure rolls the password change back', async () => {
    const id = await createUser(u('tokenfail'), { token: true });
    const before = await prisma.user.findUniqueOrThrow({ where: { id } });
    const poisoned = withInjectedFailure(prisma, 'refreshToken', 'updateMany');
    await expect(resetPassword.run(poisoned, args(u('tokenfail'), '--stdin', '--yes'), makeCtx())).rejects.toThrow('INJECTED_FAILURE:refreshToken.updateMany');
    const after = await prisma.user.findUniqueOrThrow({ where: { id } });
    expect(after.passwordHash).toBe(before.passwordHash); // password NOT changed
    expect(after.mustChangePassword).toBe(false);
  });

  itif('13: the password (and its hash) are NEVER printed to stdout/stderr', async () => {
    const id = await createUser(u('quiet'), { token: true });
    const logSpy = jest.spyOn(console, 'log');
    const errSpy = jest.spyOn(console, 'error');
    try {
      const code = await resetPassword.run(prisma, args(u('quiet'), '--stdin', '--yes'), makeCtx());
      expect(code).toBe(0);
      const stored = (await prisma.user.findUniqueOrThrow({ where: { id } })).passwordHash;
      for (const spy of [logSpy, errSpy]) {
        for (const call of spy.mock.calls) {
          const line = call.join(' ');
          expect(line).not.toContain(PASSWORD);
          expect(line).not.toContain(stored);
        }
      }
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  itif('15: re-running the command is side-effect free', async () => {
    const id = await createUser(u('rerun'), { token: true });
    const argv = args(u('rerun'), '--stdin', '--yes', '--reason', 'spec rerun');
    expect(await resetPassword.run(prisma, argv, makeCtx())).toBe(0);
    const auditsAfterFirst = (await auditsFor(id)).length;
    expect(await resetPassword.run(prisma, argv, makeCtx())).toBe(0);
    const audits = await auditsFor(id);
    expect(audits.length).toBe(auditsAfterFirst + 1); // exactly one more audit row
    const user = await prisma.user.findUniqueOrThrow({ where: { id } });
    expect(await bcrypt.compare(PASSWORD, user.passwordHash)).toBe(true);
  });

  // ------------------------------------------------------ unlock

  itif('6: unlock on a LOCKED account → ACTIVE + counters cleared + audit', async () => {
    const id = await createUser(u('locked'), { status: 'LOCKED', failed: 3, locked: true });
    const code = await unlock.run(prisma, args(u('locked'), '--yes', '--reason', 'spec unlock'), makeCtx());
    expect(code).toBe(0);
    const user = await prisma.user.findUniqueOrThrow({ where: { id } });
    expect(user.status).toBe('ACTIVE');
    expect(user.failedLoginCount).toBe(0);
    expect(user.lockedUntil).toBeNull();
    const audits = await auditsFor(id); // 9: correct audit shape
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe('UPDATE');
    expect((audits[0].oldValues as { status: string }).status).toBe('LOCKED');
    expect((audits[0].newValues as { status: string }).status).toBe('ACTIVE');
  });

  itif('7: unlock on a DISABLED account does NOT activate it', async () => {
    const id = await createUser(u('disabled'), { status: 'DISABLED', failed: 2, locked: true });
    const code = await unlock.run(prisma, args(u('disabled'), '--yes'), makeCtx());
    expect(code).toBe(0);
    const user = await prisma.user.findUniqueOrThrow({ where: { id } });
    expect(user.status).toBe('DISABLED'); // untouched
    expect(user.failedLoginCount).toBe(0); // lockout window cleared
    expect(user.lockedUntil).toBeNull();
  });

  // ------------------------------------------------------ set-status

  itif('8: set-status ACTIVE→DISABLED→ACTIVE with audit rows', async () => {
    const id = await createUser(u('status'));
    expect(await setStatus.run(prisma, args(u('status'), 'DISABLED', '--yes', '--reason', 'spec'), makeCtx())).toBe(0);
    expect((await prisma.user.findUniqueOrThrow({ where: { id } })).status).toBe('DISABLED');
    expect(await setStatus.run(prisma, args(u('status'), 'ACTIVE', '--yes', '--reason', 'spec'), makeCtx())).toBe(0);
    expect((await prisma.user.findUniqueOrThrow({ where: { id } })).status).toBe('ACTIVE');
    const audits = await auditsFor(id);
    expect(audits.map((a) => a.action)).toEqual(['UPDATE', 'UPDATE']);
  });

  itif('8b: an invalid status value is rejected with exit 2', async () => {
    await createUser(u('badstatus'));
    const code = await setStatus.run(prisma, args(u('badstatus'), 'SUSPENDED', '--yes'), makeCtx());
    expect(code).toBe(2);
  });

  // ------------------------------------------------------ errors & safety

  itif('10: an unknown user fails with exit 2 (no mutation)', async () => {
    await expect(unlock.run(prisma, args('cli-spec-does-not-exist', '--yes'), makeCtx())).rejects.toMatchObject({
      name: 'CliError',
      exitCode: 2,
    });
  });

  itif('11: a non-interactive run WITHOUT --yes aborts with exit 2', async () => {
    await createUser(u('noconfirm'), { token: true });
    await expect(resetPassword.run(prisma, args(u('noconfirm'), '--stdin'), makeCtx())).rejects.toMatchObject({
      name: 'CliError',
      exitCode: 2,
    });
  });

  itif('12 + CLI-05: PRODUCTION target confirmation happens at the DISPATCHER, pre-connect (runCli)', async () => {
    const id = await createUser(u('prod'), { token: true });
    const before = await prisma.user.findUniqueOrThrow({ where: { id } });

    // no --confirm-target (non-interactive) → exit 2, NOTHING touched
    expect(await runCli(['unlock', u('prod'), '--yes', '--reason', 'r'], { production: true })).toBe(2);
    // wrong host → exit 2
    expect(await runCli(['unlock', u('prod'), '--yes', '--reason', 'r', '--confirm-target', '10.9.9.9:5433/tcerp_test'], { production: true })).toBe(2);
    // name-only value → exit 2
    expect(await runCli(['unlock', u('prod'), '--yes', '--reason', 'r', '--confirm-target', 'tcerp_test'], { production: true })).toBe(2);

    const after = await prisma.user.findUniqueOrThrow({ where: { id } });
    expect(after.version).toBe(before.version); // NO mutation (not even a failed one)
    expect(after.status).toBe(before.status);
    expect(await prisma.auditLog.count({ where: { entityType: 'user', entityId: id } })).toBe(0);

    // the CORRECT full target proceeds (production + reason present)
    expect(await runCli(['unlock', u('prod'), '--yes', '--reason', 'r', '--confirm-target', TARGET], { production: true })).toBe(0);
    expect((await prisma.user.findUniqueOrThrow({ where: { id } })).failedLoginCount).toBe(0);
  });

  itif('CLI-05: the full-target gate is the FIRST control — a refused target never reaches the command (mutation boundary)', async () => {
    const id = await createUser(u('boundary'), { token: true });
    const before = await prisma.user.findUniqueOrThrow({ where: { id } });

    expect(await runCli(['reset-password', u('boundary'), '--stdin', '--yes', '--reason', 'r', '--confirm-target', 'other-host:5432/tcerp_test'], { production: false })).toBe(2);

    const after = await prisma.user.findUniqueOrThrow({ where: { id } });
    expect(after.version).toBe(before.version); // optimistic-lock version untouched = zero writes
    expect(after.passwordHash).toBe(before.passwordHash);
    expect((await prisma.refreshToken.findMany({ where: { userId: id } })).every((t) => t.revokedAt === null)).toBe(true);
  });

  itif('CLI-05: the SAME database name on a DIFFERENT host does NOT satisfy the confirmation (gate level)', async () => {
    // The gate is pure args/ctx logic — it touches NO database at all; a
    // same-NAME target on another host is a DIFFERENT target.
    await expect(
      confirmTargetGate(
        args('--yes', '--confirm-target', TARGET),
        { target: 'prod-db.internal:5432/tcerp_test', action: 'unlock' },
      ),
    ).rejects.toMatchObject({ name: 'CliError', exitCode: 2 });
  });

  itif('CLI-05: the gate is UNIVERSAL — non-production runs must confirm the full target too', async () => {
    await expect(
      confirmTargetGate(args('--yes'), { target: TARGET, action: 'unlock' }),
    ).rejects.toMatchObject({ name: 'CliError', exitCode: 2 }); // non-interactive without the flag
    await expect(
      confirmTargetGate(args('--yes', '--confirm-target', 'localhost:5433/other-db'), { target: TARGET, action: 'unlock' }),
    ).rejects.toMatchObject({ name: 'CliError', exitCode: 2 });
    await expect(
      confirmTargetGate(args('--yes', '--confirm-target', TARGET), { target: TARGET, action: 'unlock' }),
    ).resolves.toBeUndefined();
  });

  itif('CLI-05: INTERACTIVE runs type the full target — correct proceeds, wrong refused', async () => {
    await expect(
      confirmTargetGate(args('--yes'), {
        target: TARGET,
        action: 'unlock',
        interactive: true,
        confirmInput: async (question) => {
          expect(question).toContain(TARGET);
          return 'localhost:5433/other-db';
        },
      }),
    ).rejects.toMatchObject({ name: 'CliError', exitCode: 2 });
    await expect(
      confirmTargetGate(args('--yes'), {
        target: TARGET,
        action: 'unlock',
        interactive: true,
        confirmInput: async () => TARGET,
      }),
    ).resolves.toBeUndefined();
  });

  itif('CLI-05: the gate banner and errors never contain credentials or query parameters', async () => {
    const target = dbLabel('postgresql://admin:super-secret-pw@db.prod.internal:5432/tcerp?schema=public');
    expect(target).toBe('db.prod.internal:5432/tcerp');
    const logSpy = jest.spyOn(console, 'log');
    const errSpy = jest.spyOn(console, 'error');
    try {
      await expect(
        confirmTargetGate(args('--yes', '--confirm-target', 'localhost:5433/tcerp_test'), { target, action: 'unlock' }),
      ).rejects.toMatchObject({ name: 'CliError', exitCode: 2 });
      for (const spy of [logSpy, errSpy]) {
        for (const call of spy.mock.calls) {
          const line = call.join(' ');
          expect(line).not.toContain('super-secret-pw');
          expect(line).not.toContain('schema=public');
        }
      }
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  itif('12b: PRODUCTION requires --reason for destructive commands', async () => {
    await createUser(u('prodreason'), { token: true });
    const prodCtx = makeCtx({ production: true });
    await expect(
      unlock.run(prisma, args(u('prodreason'), '--yes'), prodCtx),
    ).rejects.toMatchObject({ name: 'CliError', exitCode: 2 });
  });

  itif('9: reset-password writes a PASSWORD_RESET audit row with the operator identity', async () => {
    const id = await createUser(u('auditrow'), { token: true });
    await resetPassword.run(prisma, args(u('auditrow'), '--stdin', '--yes', '--reason', 'audit check'), makeCtx());
    const audits = await auditsFor(id);
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe('PASSWORD_RESET');
    expect(audits[0].actorName).toBe('cli:spec-operator');
    expect(audits[0].reason).toBe('audit check');
    expect((audits[0].newValues as { refreshTokensRevoked: number }).refreshTokensRevoked).toBeGreaterThanOrEqual(1);
  });
});
