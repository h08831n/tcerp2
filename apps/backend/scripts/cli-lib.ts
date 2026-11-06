import * as readline from 'readline';
import { Prisma, PrismaClient } from '@prisma/client';
import { isForbiddenSeedPassword } from '../src/config/configuration';

/**
 * Shared helpers for the TCERP operator CLI (scripts/cli.ts).
 *
 * Conventions (CLI-02/CLI-03):
 *  - Commands NEVER print secrets (passwords, hashes, connection strings,
 *    tokens) — output states outcomes only; the DB banner shows host/db only.
 *  - Password input is interactive-hidden (double confirm) or piped --stdin;
 *    there is deliberately NO --password flag (raw secrets on the command
 *    line leak via shell history and process listings).
 *  - Destructive commands confirm the FULL target `host:port/db` at the
 *    dispatcher, BEFORE any connection or query (CLI-05 stage 1) —
 *    interactive runs type it, automation passes --confirm-target verbatim;
 *    --yes does NOT bypass it. Stage 2 (inside the command) adds the
 *    generic y/N confirm (--yes skips) and the production --reason rule.
 *  - Every mutation runs in ONE Prisma transaction together with its audit
 *    row (CLI-01) — audit actor is `cli:<operator>` (CLI-03 identity).
 *  - In production a `--reason` is REQUIRED for destructive commands.
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

/** host:port/db for the safety banner (never logs credentials). */
export function dbLabel(url: string | undefined): string {
  if (!url) return '(DATABASE_URL not set)';
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port || 5432}${parsed.pathname}`;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

/** Database name from a postgres URL — the production confirmation token. */
export function dbNameFromUrl(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).pathname.replace(/^\//, '');
  } catch {
    return '';
  }
}

/** Hidden (non-echoed) prompt — works on Windows terminals too. */
export function askHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new CliError(2, 'interactive password prompt requires a TTY — pipe the password with --stdin'));
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
  /**
   * CLI-05: the FULL destructive target `host:port/database` extracted from
   * the REAL DATABASE_URL — credentials and query parameters are excluded.
   * Confirmation must match THIS exact string, not just the database name
   * (two databases can share a name across hosts).
   */
  target: string;
  production: boolean;
  /** Audit identity: --operator override, else the OS user (documented). */
  operator: string;
  /** Piped password source (overridable for tests). */
  stdin: () => Promise<string>;
  /** Interactive typed confirmation (overridable for tests). */
  confirmInput: (question: string) => Promise<string>;
  /** TTY override for tests (undefined = process.stdin.isTTY). */
  interactive?: boolean;
  /** Write the audit row through the CALLER's transaction client (CLI-01). */
  audit: (client: PrismaClient | Prisma.TransactionClient, entry: AuditEntryLite) => Promise<void>;
}

/** Same row shape as AuditService.record (auditData) with actor 'cli:<operator>'. */
export async function writeAudit(
  client: PrismaClient | Prisma.TransactionClient,
  entry: AuditEntryLite,
  operator: string,
): Promise<void> {
  const data: Prisma.AuditLogUncheckedCreateInput = {
    entityType: entry.entityType,
    entityId: entry.entityId,
    action: entry.action,
    actorId: null,
    actorName: `cli:${operator}`,
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
  await client.auditLog.create({ data });
}

/**
 * CLI-05 gate — STAGE 1, runs at the DISPATCHER before the Prisma client is
 * even created (no connection, no query, obviously no mutation). Confirms
 * the FULL target `host:port/database` of the REAL DATABASE_URL — ALWAYS,
 * independent of NODE_ENV, including --yes and non-interactive runs
 * (a same-named database on another host does NOT match). Interactive runs
 * type the target; automation passes --confirm-target verbatim. Credentials
 * and query parameters are never part of the target or the output.
 */
export async function confirmTargetGate(
  args: ParsedArgs,
  opts: { target: string; action: string; confirmInput?: (question: string) => Promise<string>; interactive?: boolean },
): Promise<void> {
  console.log(`target: db=${opts.target}  action=${opts.action}`);
  const provided = strFlag(args.flags, 'confirm-target');
  if (provided === undefined) {
    const interactive = opts.interactive ?? process.stdin.isTTY;
    if (interactive) {
      const typed = (await (opts.confirmInput ?? defaultConfirmInput)(`Type the full target (${opts.target}) to confirm: `)).trim();
      if (typed !== opts.target) {
        throw new CliError(2, `target confirmation mismatch — expected "${opts.target}", nothing changed`);
      }
    } else {
      throw new CliError(2, `target confirmation required — pass --confirm-target "${opts.target}" (the exact host:port/database of DATABASE_URL)`);
    }
  } else if (provided !== opts.target) {
    throw new CliError(2, `target confirmation mismatch — expected "${opts.target}", got "${provided}" — nothing changed`);
  }
}

/**
 * CLI-01/CLI-03 gate — STAGE 2, runs inside the command AFTER the user row
 * is resolved and BEFORE the mutation transaction:
 *  1. the user-detail banner (state about to change)
 *  2. PRODUCTION: --reason is required for the audit trail
 *  3. generic confirmation: skipped by --yes; a non-TTY run without --yes
 *     aborts (exit 2)
 * The TARGET was already confirmed in stage 1 — no confirmation logic here
 * can re-open a refused target.
 */
export async function guardMutation(
  args: ParsedArgs,
  banner: string,
  opts: { production: boolean; requiresReason?: boolean },
): Promise<void> {
  console.log(banner);
  if (opts.production && opts.requiresReason && !strFlag(args.flags, 'reason')) {
    throw new CliError(2, '--reason is REQUIRED in production for sensitive operations');
  }
  if (args.flags['yes'] === true) return;
  if (!process.stdin.isTTY) {
    throw new CliError(2, 'non-interactive run requires --yes (explicit operator intent)');
  }
  const okFlag = await confirm('Apply? (y/N)');
  if (!okFlag) throw new CliError(1, 'aborted — nothing changed');
}

/** Echoed typed confirmation of the target name (not a secret). */
export function defaultConfirmInput(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}
