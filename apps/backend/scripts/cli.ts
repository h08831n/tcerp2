import { PrismaClient } from '@prisma/client';
import { loadConfig } from '../src/config/configuration';
import {
  CliContext,
  dbLabel,
  parseArgs,
  writeAudit,
  type AuditEntryLite,
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
 *   reset-password <username> [--password <pw>|--stdin] [--yes] [--reason "..."] [--no-force-change]
 *   unlock <username> [--yes] [--reason "..."]
 *   set-status <username> <ACTIVE|DISABLED> [--yes] [--reason "..."]
 *   list-users [--status <s>]
 *
 * Safety: destructive commands print the target database + user and require
 * an interactive confirmation unless --yes; non-interactive runs REQUIRE
 * --yes. Every mutation writes an AuditLog row with actorName 'cli'.
 */

interface Command {
  description: string;
  run: (prisma: PrismaClient, args: CliContext['args'], ctx: CliContext) => Promise<number>;
}

const COMMANDS: Record<string, Command> = {
  'reset-password': { description: 'set a new password for a user (revokes refresh tokens, clears lockout, forces change at next login)', run: resetPassword.run },
  unlock: { description: 'clear failed-login lockout + administrative LOCKED (LOCKED → ACTIVE)', run: unlock.run },
  'set-status': { description: 'enable/disable a user (ACTIVE|DISABLED)', run: setStatus.run },
  'list-users': { description: 'read-only user table (find exact usernames)', run: listUsers.run },
};

function printHelp(): void {
  console.log('TCERP operator CLI — run from apps/backend (uses .env / DATABASE_URL)\n');
  console.log('usage: npm run cli -- <command> [args] [flags]\n');
  for (const [name, cmd] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(16)} ${cmd.description}`);
  }
  console.log('\ncommon flags: --yes (skip confirmation)  --reason "..." (stored in audit)');
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

  const config = loadConfig(); // loads .env + validates (same config the backend boots with)
  const prisma = new PrismaClient();
  await prisma.$connect();
  try {
    const ctx: CliContext = {
      // ONE parse for the whole argv — the command takes the first positional
      // and the command receives the remaining positionals + the SAME flags
      // (re-parsing only `rest` would drop every --flag).
      args: { positionals: rest, flags: parsed.flags },
      dbLabel: dbLabel(process.env.DATABASE_URL),
      production: config.NODE_ENV === 'production',
      audit: writeAudit,
    };
    return await cmd.run(prisma, ctx.args, ctx);
  } finally {
    await prisma.$disconnect();
  }
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
