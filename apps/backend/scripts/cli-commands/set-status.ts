import { PrismaClient } from '@prisma/client';
import {
  CliContext,
  findUserOrThrow,
  guardDestructive,
  strFlag,
} from '../cli-lib';

/**
 * set-status <username> <ACTIVE|DISABLED> [--yes] [--reason "..."]
 *
 * Mirrors UsersService.enable()/disable() — the status gate is checked on
 * EVERY request (R6-S1), so DISABLED takes effect from the next request.
 * LOCKED is deliberately NOT settable here (an administrative hard lock is
 * managed by the user-management API); unlock() is the way out of it.
 */
export async function run(prisma: PrismaClient, args: CliContext['args'], ctx: CliContext): Promise<number> {
  const [username, targetStatus] = args.positionals;
  if (!username || !targetStatus) {
    console.error('usage: cli set-status <username> <ACTIVE|DISABLED> [--yes] [--reason "..."]');
    return 2;
  }
  const status = targetStatus.toUpperCase();
  if (status !== 'ACTIVE' && status !== 'DISABLED') {
    console.error('ERROR: status must be ACTIVE or DISABLED');
    return 2;
  }
  const user = await findUserOrThrow(prisma, username);
  if (user.status === status) {
    console.log(`OK ${user.username} is already ${status} — nothing to do`);
    return 0;
  }

  await guardDestructive(
    args,
    `target: db=${ctx.dbLabel}  user=${user.username} (${user.status} → ${status})  action=set-status`,
  );

  await prisma.user.update({ where: { id: user.id }, data: { status } });

  const reason = strFlag(args.flags, 'reason');
  await ctx.audit(prisma, {
    entityType: 'user',
    entityId: user.id,
    action: 'UPDATE',
    oldValues: { status: user.status },
    newValues: { status },
    reason,
  });

  console.log(`OK ${user.username}: ${user.status} → ${status}`);
  console.log(`  audit: UPDATE by 'cli'${reason ? ` (reason: ${reason})` : ''}`);
  return 0;
}
