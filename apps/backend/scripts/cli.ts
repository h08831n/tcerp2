import { PrismaClient } from '@prisma/client';
import { loadConfig } from '../src/config/configuration';
import {
  CliContext,
  confirmTargetGate,
  dbLabel,
  defaultConfirmInput,
  parseArgs,
  readStdinAll,
  resolveTarget,
  writeAudit,
} from './cli-lib';
import * as resetPassword from './cli-commands/reset-password';
import * as unlock from './cli-commands/unlock';
import * as setStatus from './cli-commands/set-status';
import * as listUsers from './cli-commands/list-users';

/**
 * TCERP operator CLI (runs against the SAME database the backend uses).
 *
 *   cd apps/backend
 *   npm run cli -- <command> [args] [flags]
 *
 * Commands:
 *   reset-password <username> [--stdin] [--yes] [--reason "..."] [--no-force-change] [--confirm-target "<host:port/db>"] [--operator <name>]
 *   unlock <username> [--yes] [--reason "..."] [--confirm-target "<host:port/db>"] [--operator <name>]
 *   set-status <username> <ACTIVE|DISABLED> [flags...]
 *   list-users [--status <s>]
 *
 * Safety (CLI-02/CLI-03):
 *  - passwords come from a hidden interactive prompt or piped --stdin —
 *    there is NO --password flag; no secret is ever printed.
 *  - destructive commands ALWAYS confirm the FULL target `host:port/db`
 *    (CLI-05): interactive runs type it, automation passes --confirm-target
 *    verbatim; --yes does NOT bypass it. Production additionally requires
 *    --reason (audit identity is 'cli:<operator>' — --operator overrides
 *    the OS user).
 *  - mutations + their audit row run in ONE Prisma transaction (CLI-01).
 *  - unknown flags are rejected (exit 2).
 */

interface Command {
  description: string;
  allowedFlags: string[];
  run: (prisma: PrismaClient, args: CliContext['args'], ctx: CliContext) => Promise<number>;
}

const DESTRUCTIVE_FLAGS = ['yes', 'reason', 'confirm-target', 'operator'];
const DESTRUCTIVE_COMMANDS = new Set(['reset-password', 'unlock', 'set-status']);

const COMMANDS: Record<string, Command> = {
  'reset-password': {
    description: 'set a new password for a user (atomic: revokes refresh tokens, clears lockout window, forces change at next login)',
    allowedFlags: [...DESTRUCTIVE_FLAGS, 'stdin', 'no-force-change'],
    run: resetPassword.run,
  },
  unlock: {
    description: 'clear failed-login lockout + administrative LOCKED (LOCKED → ACTIVE); DISABLED stays DISABLED',
    allowedFlags: [...DESTRUCTIVE_FLAGS],
    run: unlock.run,
  },
  'set-status': {
    description: 'enable/disable a user (ACTIVE|DISABLED)',
    allowedFlags: [...DESTRUCTIVE_FLAGS],
    run: setStatus.run,
  },
  'list-users': {
    description: 'read-only user table (find exact usernames)',
    allowedFlags: ['status'],
    run: listUsers.run,
  },
};

function printHelp(): void {
  console.log('TCERP operator CLI — run from apps/backend (uses .env / DATABASE_URL)\n');
  console.log('usage: npm run cli -- <command> [args] [flags]\n');
  for (const [name, cmd] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(16)} ${cmd.description}`);
  }
  console.log('\nflags: --yes (skip generic confirm)  --reason "..." (audit)  --operator <name> (audit identity)');
  console.log('       production additionally requires --reason');
  console.log('       passwords: interactive hidden prompt, or pipe with --stdin — never --password');
}

/**
 * CLI-05 ordering guarantee: the FULL-TARGET gate runs BEFORE the Prisma
 * client is created and connected — a refused target never opens a
 * connection, runs a query, and therefore can never mutate anything.
 * Exported so the automated tests can drive the real dispatcher.
 */
export async function runCli(argv: string[], opts: { production?: boolean } = {}): Promise<number> {
  try {
    return await runCliInner(argv, opts);
  } catch (error: unknown) {
    // Same contract as the process exit path: typed CliErrors carry their
    // own exit code; anything else is a fatal 1.
    const message = error instanceof Error ? error.message : String(error);
    const code = typeof (error as { exitCode?: number })?.exitCode === 'number' ? (error as { exitCode: number }).exitCode : 1;
    console.error(`ERROR: ${message}`);
    return code;
  }
}

async function runCliInner(argv: string[], opts: { production?: boolean } = {}): Promise<number> {
  const parsed = parseArgs(argv);
  const [command, ...rest] = parsed.positionals;

  if (!command || parsed.flags['help'] === true) {
    printHelp();
    return command ? 0 : 2;
  }
  const cmd = COMMANDS[command];
  if (!cmd) {
    console.error(`ERROR: unknown command "${command}"
`);
    printHelp();
    return 2;
  }

  // Unknown flags are a hard error — a mistyped flag must never silently
  // change semantics of a destructive operation.
  const allowed = new Set(cmd.allowedFlags);
  const unknown = Object.keys(parsed.flags).filter((flag) => !allowed.has(flag));
  if (unknown.length > 0) {
    console.error(`ERROR: unknown flag(s) for "${command}": ${unknown.map((f) => `--${f}`).join(', ')}`);
    console.error(`       allowed: ${cmd.allowedFlags.map((f) => `--${f}`).join(', ')}`);
    return 2;
  }

  // .env is loaded FIRST (loadConfig is env-only — no DB), so a DATABASE_URL
  // provided ONLY via .env is visible to the target gate; a missing/invalid
  // URL fails closed with a typed refusal BEFORE anything connects.
  const config = loadConfig();
  const target = await resolveTarget(process.env.DATABASE_URL);

  // STAGE 1 — full-target confirmation BEFORE any connection or query.
  if (DESTRUCTIVE_COMMANDS.has(command)) {
    await confirmTargetGate(parsed, {
      target,
      action: command,
      confirmInput: defaultConfirmInput,
    });
  }

  const prisma = new PrismaClient();
  await prisma.$connect();
  try {
    const ctx: CliContext = {
      // ONE parse for the whole argv — the command takes the first positional
      // and the command receives the remaining positionals + the SAME flags.
      args: { positionals: rest, flags: parsed.flags },
      target: dbLabel(process.env.DATABASE_URL),
      production: opts.production ?? config.NODE_ENV === 'production',
      operator:
        (typeof parsed.flags['operator'] === 'string' ? parsed.flags['operator'].trim() : '') ||
        process.env.USERNAME ||
        process.env.USER ||
        'unknown',
      stdin: readStdinAll,
      confirmInput: defaultConfirmInput,
      audit: (client, entry) => writeAudit(client, entry, ctxOperator(parsed.flags)),
    };
    return await cmd.run(prisma, ctx.args, ctx);
  } finally {
    await prisma.$disconnect();
  }
}

async function main(): Promise<number> {
  return runCli(process.argv.slice(2));
}

function ctxOperator(flags: Record<string, string | boolean>): string {
  return (
    (typeof flags['operator'] === 'string' && flags['operator'].trim()) ||
    process.env.USERNAME ||
    process.env.USER ||
    'unknown'
  );
}

// Auto-run ONLY as a real script — importing this module for runCli (the
// ops-cli spec does) must NOT execute main() with the IMPORTER's argv:
// jest's argv has no command positional, so main() resolved to help (exit 2)
// and poisoned process.exitCode AFTER the suite had already passed green.
if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      const code = typeof (error as { exitCode?: number })?.exitCode === 'number' ? (error as { exitCode: number }).exitCode : 1;
      console.error(`ERROR: ${message}`);
      process.exitCode = code;
    });
}
