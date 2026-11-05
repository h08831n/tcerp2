import * as readline from 'readline';
import { Prisma, PrismaClient } from '@prisma/client';
import { isForbiddenSeedPassword } from '../src/config/configuration';

/**
 * Shared helpers for the TCERP operator CLI (scripts/cli.ts).
 *
 * Conventions:
 *  - Commands NEVER print secrets (passwords, hashes) — only the outcome.
 *  - Destructive commands print a target banner (db + username) and require
 *    an interactive `y` confirmation UNLESS `--yes` is passed; non-interactive
 *    runs (no TTY) REQUIRE `--yes` so scripts are explicit about intent.
 *  - Every mutation writes an AuditLog row with actorName 'cli' (same shape
 *    as AuditService.record — see src/audit/audit.service.ts auditData()).
 */

/** Error carrying a process exit code — the dispatcher turns it into exit(n). */
export class CliError extends Error {
  constructor(readonly exitCode: number, message: string) {
    super(message);
    this.name = 'CliError';
  }
}

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

/** Minimal arg parser: `--flag value`, `--flag` (boolean), positionals. */
export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

export function strFlag(flags: Record<string, string | boolean>, key: string): string | undefined {
  const value = flags[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/** host:port/database for the safety banner (never logs credentials). */
export function dbLabel(url: string | undefined): string {
  if (!url) return '(DATABASE_URL not set)';
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port || 5432}${parsed.pathname}`;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

/** Hidden (non-echoed) prompt — works on Windows terminals too. */
export function askHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new CliError(2, 'interactive password prompt requires a TTY — use --password <pw> or pipe with --stdin'));
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const swallower = rl as unknown as { _writeToOutput: (s: string) => void };
    const defaultWrite = swallower._writeToOutput.bind(rl);
    swallower._writeToOutput = (s: string): void => {
      if (s.includes(question)) defaultWrite(question);
      else if (s.includes('\n') || s.includes('\r')) defaultWrite('\n');
      // typed characters are swallowed — never echoed
    };
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/** Interactive y/n confirmation (non-TTY → refused, caller decides). */
export async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question(`${question} `, resolve));
  rl.close();
  process.stdout.write('\n');
  return /^y(es)?$/i.test(answer.trim());
}

/** Read a piped password from stdin (trailing newline stripped). */
export function readStdinAll(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

/**
 * Password policy for the CLI — mirrors ResetPasswordDto (8..128) plus the
 * production forbidden list from configuration.ts.
 */
export function validatePasswordPolicy(password: string, production: boolean): string | null {
  if (password.length < 8) return 'password must be at least 8 characters (ResetPasswordDto MinLength(8))';
  if (password.length > 128) return 'password must be at most 128 characters (ResetPasswordDto MaxLength(128))';
  if (production && isForbiddenSeedPassword(password)) return 'this password is on the forbidden-for-production list';
  return null;
}

export interface CliUser {
  id: string;
  username: string;
  status: 'ACTIVE' | 'DISABLED' | 'LOCKED';
  mustChangePassword: boolean;
  failedLoginCount: number;
  lockedUntil: Date | null;
}

/** Lookup by username; a not-found error lists close usernames. */
export async function findUserOrThrow(prisma: PrismaClient, username: string): Promise<CliUser> {
  const user = await prisma.user.findUnique({
    where: { username },
    select: { id: true, username: true, status: true, mustChangePassword: true, failedLoginCount: true, lockedUntil: true },
  });
  if (user) return user;
  const similar = await prisma.user.findMany({
    where: { username: { contains: username.slice(0, 3), mode: 'insensitive' } },
    select: { username: true },
    take: 5,
    orderBy: { username: 'asc' },
  });
  throw new CliError(
    2,
    `user "${username}" not found${similar.length > 0 ? ` — similar: ${similar.map((u) => u.username).join(', ')}` : ''}`,
  );
}

export interface AuditEntryLite {
  entityType: string;
  entityId: string;
  action: string;
  oldValues?: unknown;
  newValues?: unknown;
  reason?: string;
}

/** Everything a command gets from the dispatcher. */
export interface CliContext {
  args: ParsedArgs;
  dbLabel: string;
  production: boolean;
  audit: (prisma: PrismaClient, entry: AuditEntryLite) => Promise<void>;
}

/** Same row shape as AuditService.record (auditData) with actor 'cli'. */
export async function writeAudit(prisma: PrismaClient, entry: AuditEntryLite): Promise<void> {
  const data: Prisma.AuditLogUncheckedCreateInput = {
    entityType: entry.entityType,
    entityId: entry.entityId,
    action: entry.action,
    actorId: null,
    actorName: 'cli',
    reason: entry.reason ?? null,
    ip: 'cli',
    userAgent: 'tcerp-cli',
  };
  if (entry.oldValues !== undefined) {
    data.oldValues = JSON.parse(JSON.stringify(entry.oldValues)) as Prisma.InputJsonValue;
  }
  if (entry.newValues !== undefined) {
    data.newValues = JSON.parse(JSON.stringify(entry.newValues)) as Prisma.InputJsonValue;
  }
  await prisma.auditLog.create({ data });
}

/** Destructive-command gate: banner + confirm (non-TTY requires --yes). */
export async function guardDestructive(
  args: ParsedArgs,
  banner: string,
): Promise<void> {
  console.log(banner);
  if (args.flags['yes'] === true) return;
  if (!process.stdin.isTTY) {
    throw new CliError(2, 'non-interactive run requires --yes (explicit operator intent)');
  }
  const okFlag = await confirm('Apply? (y/N)');
  if (!okFlag) throw new CliError(1, 'aborted — nothing changed');
}
