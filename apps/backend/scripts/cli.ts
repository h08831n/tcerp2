import { PrismaClient } from '@prisma/client';
import { loadConfig } from '../src/config/configuration';
import {
  CliContext,
  dbNameFromUrl,
  dbLabel,
  parseArgs,
  readStdinAll,
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
 *   reset-password <username> [--stdin] [--yes] [--reason "..."] [--no-force-change] [--confirm-db <db>] [--operator <name>]
 *   unlock <username> [--yes] [--reason "..."] [--confirm-db <db>] [--operator <name>]
 *   set-status <username> <ACTIVE|DISABLED> [flags...]
 *   list-users [--status <s>]
 *
 * Safety (CLI-02/CLI-03):
 *  - passwords come from a hidden interactive prompt or piped --stdin —
 *    there is NO --password flag; no secret is ever printed.
 *  - destructive commands: banner + confirm; production additionally
 *    requires --confirm-db <dbname> and --reason (audit identity is
 *    'cli:<operator>' — --operator overrides the OS user).
 *  - mutations + their audit row run in ONE Prisma transaction (CLI-01).
 *  - unknown flags are rejected (exit 2).
 */

interface Command {
  description: string;
  allowedFlags: string[];
  run: (prisma: PrismaClient, args: CliContext['args'], ctx: CliContext) => Promise<number>;
}

const DESTRUCTIVE_FLAGS = ['yes', 'reason', 'confirm-db', 'operator'];

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
  console.log('       production: --confirm-db <dbname> is REQUIRED (typed target; --yes is not enough)');
  console.log('       passwords: interactive hidden prompt, or pipe with --stdin — never --password');
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  const [command, ...rest] = parsed.positionals;

  if (!command || parsed.flags['help'] === true) {
    printHelp();
    return command ? 0 : 2;
  }
  const cmd = COMMANDS[command];
  if (!cmd) {
    console.error(`ERROR: unknown command "${command}"\n`);
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

  const config = loadConfig(); // loads .env + validates (same config the backend boots with)
  const prisma = new PrismaClient();
  await prisma.$connect();
  try {
    const ctx: CliContext = {
      // ONE parse for the whole argv — the command takes the first positional
      // and the command receives the remaining positionals + the SAME flags.
      args: { positionals: rest, flags: parsed.flags },
      dbLabel: dbLabel(process.env.DATABASE_URL),
      dbName: dbNameFromUrl(process.env.DATABASE_URL),
      production: config.NODE_ENV === 'production',
      operator:
        (typeof parsed.flags['operator'] === 'string' ? parsed.flags['operator'].trim() : '') ||
        process.env.USERNAME ||
        process.env.USER ||
        'unknown',
      stdin: readStdinAll,
      audit: (client, entry) => writeAudit(client, entry, ctxOperator(parsed.flags)),
    };
    return await cmd.run(prisma, ctx.args, ctx);
  } finally {
    await prisma.$disconnect();
  }
}

function ctxOperator(flags: Record<string, string | boolean>): string {
  return (
    (typeof flags['operator'] === 'string' && flags['operator'].trim()) ||
    process.env.USERNAME ||
    process.env.USER ||
    'unknown'
  );
}

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
