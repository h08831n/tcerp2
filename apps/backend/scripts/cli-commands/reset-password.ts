import * as bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { BCRYPT_ROUNDS } from '../../src/users/users.service';
import {
  askHidden,
  CliContext,
  findUserOrThrow,
  guardDestructive,
  readStdinAll,
  strFlag,
  validatePasswordPolicy,
} from '../cli-lib';

/**
 * reset-password <username> [--password <pw> | --stdin] [--yes] [--reason "..."] [--no-force-change]
 *
 * Mirrors UsersService.resetPassword() EXACTLY (src/users/users.service.ts):
 *   bcrypt hash (BCRYPT_ROUNDS) + mustChangePassword=true +
 *   failedLoginCount=0 + lockedUntil=null + revoke ALL refresh tokens
 *   + AuditLog PASSWORD_RESET.
 *
 * --no-force-change is for service accounts that never log in interactively.
 * The password itself is never printed; a bcrypt.compare self-verify runs
 * after the write and FAILS the command if it does not match.
 */
export async function run(prisma: PrismaClient, args: CliContext['args'], ctx: CliContext): Promise<number> {
  const username = args.positionals[0];
  if (!username) {
    console.error('usage: cli reset-password <username> [--password <pw>|--stdin] [--yes] [--reason "..."] [--no-force-change]');
    return 2;
  }
  const user = await findUserOrThrow(prisma, username);

  let password: string;
  if (args.flags['stdin'] === true) {
    password = (await readStdinAll()).replace(/\r?\n$/, '');
  } else if (typeof args.flags['password'] === 'string') {
    password = args.flags['password'];
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
  );

  const mustChangePassword = args.flags['no-force-change'] !== true;
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash, mustChangePassword, failedLoginCount: 0, lockedUntil: null },
  });
  // Sessions die with the refresh tokens — the admin-reset semantics.
  const revoked = await prisma.refreshToken.updateMany({
    where: { userId: user.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  const reason = strFlag(args.flags, 'reason');
  await ctx.audit(prisma, {
    entityType: 'user',
    entityId: user.id,
    action: 'PASSWORD_RESET',
    newValues: { mustChangePassword, lockoutCleared: true, refreshTokensRevoked: revoked.count },
    reason,
  });

  // Self-verify: the stored hash MUST accept the new password.
  const fresh = await prisma.user.findUniqueOrThrow({
    where: { id: user.id },
    select: { passwordHash: true },
  });
  const verified = await bcrypt.compare(password, fresh.passwordHash);

  console.log(`OK password reset for ${user.username}`);
  console.log(`  mustChangePassword: ${mustChangePassword}`);
  console.log(`  lockout cleared (failedLoginCount=0, lockedUntil=null)`);
  console.log(`  refresh tokens revoked: ${revoked.count}`);
  console.log(`  audit: PASSWORD_RESET by 'cli'${reason ? ` (reason: ${reason})` : ''}`);
  console.log(`  self-verify bcrypt.compare: ${verified ? 'OK' : 'FAILED'}`);
  return verified ? 0 : 1;
}
