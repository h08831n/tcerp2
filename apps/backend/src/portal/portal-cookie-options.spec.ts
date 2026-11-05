import { portalCookieOptions } from './portal-auth.controller';

/**
 * D2-17: BOTH portal cookies (session + pending selection) share the same
 * hardening contract; `secure` is on exactly in production.
 */
describe('portalCookieOptions (D2-17)', () => {
  it('production → Secure + HttpOnly + SameSite=Lax + scoped path', () => {
    const opts = portalCookieOptions(86_400_000, true);
    expect(opts).toMatchObject({
      httpOnly: true,
      sameSite: 'lax',
      path: '/api/portal',
      maxAge: 86_400_000,
      secure: true,
    });
  });

  it('non-production → Secure ABSENT (plain-HTTP dev/test boots still work)', () => {
    const opts = portalCookieOptions(86_400_000, false);
    expect(opts.secure).toBeUndefined();
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe('lax');
  });
});
