import { PrismaClient } from '@prisma/client';
import { CliContext } from '../cli-lib';

/**
 * list-users [--status ACTIVE|DISABLED|LOCKED]
 *
 * Read-only — no audit row. Helps operators find exact usernames before a
 * destructive command. Lock state shows the EFFECTIVE lock (lockedUntil in
 * the future OR administrative LOCKED status).
 */
export async function run(prisma: PrismaClient, args: CliContext['args'], ctx: CliContext): Promise<number> {
  void ctx;
  const status = typeof args.flags['status'] === 'string' ? args.flags['status'] : undefined;
  const users = await prisma.user.findMany({
    where: status ? { status: status as never } : undefined,
    select: {
      username: true,
      status: true,
      mustChangePassword: true,
      failedLoginCount: true,
      lockedUntil: true,
      lastLoginAt: true,
    },
    orderBy: { username: 'asc' },
  });

  const now = new Date();
  const rows = users.map((u) => ({
    username: u.username,
    status: u.status,
    locked: (u.lockedUntil !== null && u.lockedUntil > now) || u.status === 'LOCKED' ? 'yes' : '-',
    failed: String(u.failedLoginCount),
    pwChange: u.mustChangePassword ? 'yes' : '-',
    lastLogin: u.lastLoginAt ? u.lastLoginAt.toISOString().slice(0, 16).replace('T', ' ') : 'never',
  }));

  const width = (rows: string[], header: string): number =>
    Math.max(header.length, ...rows.map((r) => r.length));
  const cols: (keyof typeof rows[number])[] = ['username', 'status', 'locked', 'failed', 'pwChange', 'lastLogin'];
  const header: Record<string, string> = {
    username: 'USERNAME', status: 'STATUS', locked: 'LOCKED', failed: 'FAILED', pwChange: 'PW-CHANGE', lastLogin: 'LAST-LOGIN',
  };
  const widths = cols.map((c) => width(rows.map((r) => r[c] as string), header[c]));
  const line = (cells: string[]): string =>
    cells.map((cell, i) => cell.padEnd(widths[i])).join('  ');
  console.log(line(cols.map((c) => header[c])));
  for (const row of rows) console.log(line(cols.map((c) => row[c] as string)));
  console.log(`\n(${rows.length} user${rows.length === 1 ? '' : 's'})`);
  return 0;
}
