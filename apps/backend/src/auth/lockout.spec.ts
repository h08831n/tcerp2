import { computeLockout, isLocked } from './lockout';

describe('computeLockout', () => {
  const now = new Date('2026-01-01T10:00:00Z');

  it('locks when the failed count reaches maxAttempts', () => {
    const lockedUntil = computeLockout(5, 5, 15, now);
    expect(lockedUntil).not.toBeNull();
    expect(lockedUntil!.getTime()).toBe(now.getTime() + 15 * 60_000);
  });

  it('locks beyond maxAttempts too', () => {
    expect(computeLockout(7, 5, 15, now)).not.toBeNull();
  });

  it('does not lock below maxAttempts', () => {
    expect(computeLockout(4, 5, 15, now)).toBeNull();
    expect(computeLockout(0, 5, 15, now)).toBeNull();
  });

  it('defaults "now" to the current time', () => {
    const lockedUntil = computeLockout(1, 1, 1);
    expect(lockedUntil!.getTime()).toBeGreaterThan(Date.now() + 30_000);
  });
});

describe('isLocked', () => {
  const now = new Date('2026-01-01T10:00:00Z');

  it('returns true while the lock window is active', () => {
    expect(isLocked({ lockedUntil: new Date(now.getTime() + 60_000) }, now)).toBe(true);
  });

  it('returns false once the window has expired', () => {
    expect(isLocked({ lockedUntil: new Date(now.getTime() - 1) }, now)).toBe(false);
  });

  it('returns false when there is no lock', () => {
    expect(isLocked({ lockedUntil: null }, now)).toBe(false);
  });
});
