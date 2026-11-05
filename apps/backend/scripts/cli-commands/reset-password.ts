import * as bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { BCRYPT_ROUNDS } from '../../src/users/users.service';
import {
  askHidden,
  CliContext,
  CliError,
  findUserOrThrow,
  guardDestructive,
  strFlag,
  validatePasswordPolicy,
} from '../cli-lib';

/**
 * reset-password <username> [--stdin] [--yes] [--reason "..."] [--no-force-change] [--confirm-db <db>] [--operator <name>]
 *
 * Mirrors UsersService.resetPassword() EXACTLY (src/users/users.service.ts)
 * and is ATOMIC (CLI-01): the password change, the lockout clear, the
 * refresh-token revocation and the audit row are ONE Prisma transaction —
 * any failure leaves NO partial state. bcrypt.hash runs BEFORE the
 * transaction so the tx stays short.
 *
 * Password input (CLI-02): interactive hidden prompt (double confirm) or
 * piped --stdin. There is NO --password flag — raw secrets on the command
 * line leak via shell history and process listings. The password, its hash,
 * tokens and connection string are never printed.
 *
 * LOCKED accounts (CLI-03): the lockout WINDOW is cleared, but the
 * administrative status LOCKED is NOT — the account stays locked until
 * `cli unlock <username>` is run (LOCKED → ACTIVE). The output states this.
 */
export async function run(prisma: PrismaClient, args: CliContext['args'], ctx: CliContext): Promise<number> {
  const username = args.positionals[0];
  if (!username) {
    console.error('usage: cli reset-password <username> [--stdin] [--yes] [--reason "..."] [--no-force-change] [--confirm-db <db>] [--operator <name>]');
    return 2;
  }
  const user = await findUserOrThrow(prisma, username);

  let password: string;
  if (args.flags['stdin'] === true) {
    if (process.stdin.isTTY) {
      throw new CliError(2, '--stdin expects a PIPED password (e.g. pwgen | npm run cli -- reset-password <user> --stdin) — for interactive input omit flags');
    }
    password = (await ctx.stdin()).replace(/\r?\n$/, '');
  } else {
    password = await askHidden('New password: ');
    const again = await askHidden('Confirm password: ');
    if (password !== again) {
      console.error('ERROR: the two passwords do not match');
      return 1;
    }
  }

  const policyError = validatePasswordPolicy(password, ctx.production);
  if (policyError) {
    console.error(`ERROR: ${policyError}`);
    return 1;
  }

  await guardDestructive(
    args,
    `target: db=${ctx.dbLabel}  user=${user.username} (status=${user.status})  action=reset-password`,
    { production: ctx.production, dbName: ctx.dbName, requiresReason: true },
  );

  const mustChangePassword = args.flags['no-force-change'] !== true;
  // Hash OUTSIDE the transaction — the tx must stay short (CLI-01).
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const reason = strFlag(args.flags, 'reason');

  await prisma.$transaction(async (trx) => {
    await trx.user.update({
      where: { id: user.id },
      data: { passwordHash, mustChangePassword, failedLoginCount: 0, lockedUntil: null },
    });
    // Sessions die with the refresh tokens — the admin-reset semantics.
    const revoked = await trx.refreshToken.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await ctx.audit(trx, {
      entityType: 'user',
      entityId: user.id,
      action: 'PASSWORD_RESET',
      newValues: { mustChangePassword, lockoutCleared: true, refreshTokensRevoked: revoked.count },
      reason,
    });
  });

  // Self-verify: the stored hash MUST accept the new password.
  const fresh = await prisma.user.findUniqueOrThrow({
    where: { id: user.id },
    select: { passwordHash: true },
  });
  const verified = await bcrypt.compare(password, fresh.passwordHash);

  console.log(`OK password reset for ${user.username} (operator: ${ctx.operator})`);
  console.log(`  mustChangePassword: ${mustChangePassword}`);
  console.log(`  lockout window cleared (failedLoginCount=0, lockedUntil=null)`);
  if (user.status === 'LOCKED') {
    console.log(`  NOTE: status is LOCKED (administrative) — the lockout window was cleared but`);
    console.log(`  the account REMAINS locked; run "cli unlock ${user.username}" to clear it (LOCKED → ACTIVE).`);
  }
  console.log(`  audit: PASSWORD_RESET by 'cli:${ctx.operator}'${reason ? ` (reason: ${reason})` : ''}`);
  console.log(`  self-verify bcrypt.compare: ${verified ? 'OK' : 'FAILED'}`);
  return verified ? 0 : 1;
}
