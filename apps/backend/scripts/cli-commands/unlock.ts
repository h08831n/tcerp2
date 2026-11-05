import { PrismaClient } from '@prisma/client';
import {
  CliContext,
  CliUser,
  findUserOrThrow,
  guardDestructive,
  strFlag,
} from '../cli-lib';

/**
 * unlock <username> [--yes] [--reason "..."]
 *
 * Clears BOTH independent lock mechanisms (src/auth/auth.service.ts login):
 *   - the failed-login lockout window (failedLoginCount=0, lockedUntil=null)
 *   - the administrative hard lock (status LOCKED → ACTIVE)
 * A DISABLED account is left DISABLED on purpose — use set-status to enable.
 */
export async function run(prisma: PrismaClient, args: CliContext['args'], ctx: CliContext): Promise<number> {
  const username = args.positionals[0];
  if (!username) {
    console.error('usage: cli unlock <username> [--yes] [--reason "..."]');
    return 2;
  }
  const user = await findUserOrThrow(prisma, username);

  if (user.status === 'DISABLED') {
    console.error(`ERROR: ${user.username} is DISABLED — unlocking the lockout window will NOT re-enable it; use "cli set-status ${user.username} ACTIVE" if intended`);
  }

  await guardDestructive(
    args,
    `target: db=${ctx.dbLabel}  user=${user.username} (status=${user.status}, failed=${user.failedLoginCount}, lockedUntil=${user.lockedUntil?.toISOString() ?? 'null'})  action=unlock`,
  );

  const newStatus: CliUser['status'] = user.status === 'LOCKED' ? 'ACTIVE' : user.status;
  await prisma.user.update({
    where: { id: user.id },
    data: { failedLoginCount: 0, lockedUntil: null, status: newStatus },
  });

  const reason = strFlag(args.flags, 'reason');
  await ctx.audit(prisma, {
    entityType: 'user',
    entityId: user.id,
    action: 'UPDATE',
    oldValues: { status: user.status, failedLoginCount: user.failedLoginCount, lockedUntil: user.lockedUntil },
    newValues: { status: newStatus, failedLoginCount: 0, lockedUntil: null },
    reason,
  });

  console.log(`OK ${user.username} unlocked`);
  if (user.status === 'LOCKED') console.log('  administrative LOCKED → ACTIVE');
  if (user.status === 'DISABLED') console.log('  NOTE: account is still DISABLED (status untouched)');
  console.log(`  audit: UPDATE by 'cli'${reason ? ` (reason: ${reason})` : ''}`);
  return 0;
}
