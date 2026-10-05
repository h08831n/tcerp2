/**
 * Pure lockout decision functions (kept dependency-free so they can be unit
 * tested without a database). REQUIREMENTS §61: "Failed Login Lock".
 */

export interface LockableUser {
  failedLoginCount: number;
  lockedUntil: Date | null;
}

/**
 * Given the UPDATED failed-attempt count, decide the new `lockedUntil`.
 * Returns null when the account should not be locked.
 */
export function computeLockout(
  failedCount: number,
  maxAttempts: number,
  lockMinutes: number,
  now: Date = new Date(),
): Date | null {
  if (failedCount >= maxAttempts) {
    return new Date(now.getTime() + lockMinutes * 60_000);
  }
  return null;
}

/** Whether an existing `lockedUntil` is still active. */
export function isLocked(user: Pick<LockableUser, 'lockedUntil'>, now: Date = new Date()): boolean {
  return !!user.lockedUntil && user.lockedUntil.getTime() > now.getTime();
}
