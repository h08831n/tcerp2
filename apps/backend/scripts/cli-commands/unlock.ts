import { PrismaClient } from '@prisma/client';
import {
  CliContext,
  CliUser,
  findUserOrThrow,
  guardDestructive,
  strFlag,
} from '../cli-lib';

/**
 * unlock <username> [--yes] [--reason "..."] [--confirm-db <db>] [--operator <name>]
 *
 * Clears BOTH independent lock mechanisms (src/auth/auth.service.ts login)
 * in ONE transaction together with the audit row (CLI-01):
 *   - the failed-login lockout window (failedLoginCount=0, lockedUntil=null)
 *   - the administrative hard lock (status LOCKED → ACTIVE)
 * A DISABLED account is left DISABLED on purpose — unlocking a lockout is
 * NOT an enable; use "set-status <user> ACTIVE" if that is intended.
 */
export async function run(prisma: PrismaClient, args: CliContext['args'], ctx: CliContext): Promise<number> {
  const username = args.positionals[0];
  if (!username) {
    console.error('usage: cli unlock <username> [--yes] [--reason "..."] [--confirm-db <db>] [--operator <name>]');
    return 2;
  }
  const user = await findUserOrThrow(prisma, username);

  if (user.status === 'DISABLED') {
    console.error(`NOTE: ${user.username} is DISABLED — unlocking the lockout window will NOT re-enable it; use "cli set-status ${user.username} ACTIVE" if that is intended`);
  }

  await guardDestructive(
    args,
    `target: db=${ctx.dbLabel}  user=${user.username} (status=${user.status}, failed=${user.failedLoginCount}, lockedUntil=${user.lockedUntil?.toISOString() ?? 'null'})  action=unlock`,
    { production: ctx.production, dbName: ctx.dbName, requiresReason: true },
  );

  const newStatus: CliUser['status'] = user.status === 'LOCKED' ? 'ACTIVE' : user.status;
  const reason = strFlag(args.flags, 'reason');

  await prisma.$transaction(async (trx) => {
    await trx.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null, status: newStatus },
    });
    await ctx.audit(trx, {
      entityType: 'user',
      entityId: user.id,
      action: 'UPDATE',
      oldValues: { status: user.status, failedLoginCount: user.failedLoginCount, lockedUntil: user.lockedUntil },
      newValues: { status: newStatus, failedLoginCount: 0, lockedUntil: null },
      reason,
    });
  });

  console.log(`OK ${user.username} unlocked (operator: ${ctx.operator})`);
  if (user.status === 'LOCKED') console.log('  administrative LOCKED → ACTIVE');
  if (user.status === 'DISABLED') console.log('  NOTE: account is still DISABLED (status untouched)');
  console.log(`  audit: UPDATE by 'cli:${ctx.operator}'${reason ? ` (reason: ${reason})` : ''}`);
  return 0;
}
