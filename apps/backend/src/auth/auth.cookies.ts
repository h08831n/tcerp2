import { Response } from 'express';
import { AppConfig } from '../config/configuration';

export const ACCESS_TOKEN_COOKIE = 'access_token';
export const REFRESH_TOKEN_COOKIE = 'refresh_token';

function parseTtlToMs(ttl: string): number {
  const match = ttl.match(/^(\d+)([smhd])$/);
  if (!match) return 15 * 60_000;
  const value = Number(match[1]);
  const unitMs: Record<string, number> = {
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return value * unitMs[match[2]];
}

/**
 * Cookie strategy (architecture doc): access token cookie covers the whole
 * site; the refresh token cookie is scoped to the auth endpoints only.
 * Both HttpOnly + SameSite=Lax (CSRF-safe for a JSON API).
 */
export function setAuthCookies(
  response: Response,
  config: AppConfig,
  accessToken: string,
  refreshToken: string,
): void {
  response.cookie(ACCESS_TOKEN_COOKIE, accessToken, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: parseTtlToMs(config.ACCESS_TOKEN_TTL),
  });
  response.cookie(REFRESH_TOKEN_COOKIE, refreshToken, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/api/auth',
    maxAge: config.REFRESH_TOKEN_TTL_DAYS * 86_400_000,
  });
}

export function clearAuthCookies(response: Response): void {
  response.clearCookie(ACCESS_TOKEN_COOKIE, { httpOnly: true, sameSite: 'lax', path: '/' });
  response.clearCookie(REFRESH_TOKEN_COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/api/auth',
  });
}
