import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response, Request } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { PortalOtpService, PORTAL_SESSION_TTL_MS } from './portal-auth.service';
import { PortalAuthGuard, PORTAL_SESSION_COOKIE } from './portal-auth.guard';
import { UnauthorizedError } from '../common/errors';
import { AppConfig, CONFIG } from '../config/configuration';
import { Inject } from '@nestjs/common';

function parseTtlToMs(ttl: string): number {
  const match = ttl.match(/^(\d+)([smhd])$/);
  if (!match) return 15 * 60_000;
  const value = Number(match[1]);
  const unitMs: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return value * unitMs[match[2]];
}

/**
 * D2-17: cookie options for BOTH portal cookies. The pending-selection and
 * session cookies share the same hardening; `secure` is on in production
 * exactly like the session cookie.
 */
export function portalCookieOptions(maxAgeMs: number, production: boolean) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/api/portal',
    maxAge: maxAgeMs,
    ...(production ? { secure: true } : {}),
  };
}

/**
 * Portal auth endpoints (Gate D-2 Phase 1):
 *   POST /api/portal/request-otp    @Public — mobile-only, send OTP via SMS
 *   POST /api/portal/verify-otp     @Public — verify code → session (or PENDING_SELECTION)
 *   POST /api/portal/select-company @Public + PENDING cookie → final session
 *   POST /api/portal/logout         PortalAuthGuard — revoke session, clear cookie
 *   GET  /api/portal/me             PortalAuthGuard — session identity
 *
 * D2-13 — GET /api/portal/me has EXACTLY ONE contract for the whole portal:
 * the session identity `{companyId, partyId}` served by THIS controller. The
 * Phase 2 business read-models must expose the customer profile at
 * /api/portal/profile — never as a second /me handler (route shadowing).
 *
 * D2-18 — the PENDING_SELECTION response carries the SAFE allowed options
 * `{portalAccountId, companyName}` (docs/17 §1) so the client can actually
 * choose; no company list exists before a VALID OTP.
 */
@Controller('portal')
export class PortalAuthController {
  constructor(
    private readonly otpService: PortalOtpService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @Post('request-otp')
  @HttpCode(200)
  async requestOtp(
    @Req() request: Request,
    @Body() body: { mobile: string; companyId?: string },
  ) {
    // D2-10: MOBILE-ONLY contract (docs/15) — companyId is intentionally not
    // part of the flow (company selection happens after verification). Legacy
    // callers may still send it; it is ignored. Invalid/missing mobile is a
    // typed 422 from normalizeIranMobile — never a 500.
    return this.otpService.requestOtp(body.mobile, request.ip);
  }

  @Public()
  @Post('verify-otp')
  @HttpCode(200)
  async verifyOtp(
    @Body() body: { mobile: string; challengeId: string; code: string },
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.otpService.verifyOtp(body.mobile, body.challengeId, body.code);

    if (result.sessionToken) {
      this.setSessionCookie(response, result.sessionToken);
      return { sessionActive: true, companyId: result.companyId, partyId: result.partyId };
    }
    if (result.pendingToken) {
      // PENDING_SELECTION cookie (short-lived, HttpOnly, Secure in production)
      response.cookie('portal_pending', result.pendingToken, portalCookieOptions(5 * 60_000, process.env.NODE_ENV === 'production'));
      return {
        sessionActive: false,
        pendingSelection: result.pendingOptions ?? [],
      };
    }
    return { sessionActive: false };
  }

  @Public()
  @Post('select-company')
  @HttpCode(200)
  async selectCompany(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: { portalAccountId: string },
  ) {
    const raw = request.cookies?.portal_pending;
    if (!raw) throw new UnauthorizedError('SELECTION_EXPIRED');
    const result = await this.otpService.selectCompany(raw, body.portalAccountId);
    this.setSessionCookie(response, result.sessionToken);
    response.clearCookie('portal_pending', { path: '/api/portal' });
    return { sessionActive: true, companyId: result.companyId, partyId: result.partyId };
  }

  // Logout contract: revoke the STORED session (row deleted → every other
  // copy of the cookie dies too) and clear the browser cookie.
  @Public()
  @UseGuards(PortalAuthGuard)
  @Post('logout')
  @HttpCode(200)
  async logout(
    @Req() request: Request & { portalSession?: { sessionId?: string } },
    @Res({ passthrough: true }) response: Response,
  ) {
    const sessionId = request.portalSession?.sessionId;
    if (sessionId) {
      await this.otpService.revokeSession(sessionId);
    }
    response.clearCookie(PORTAL_SESSION_COOKIE, {
      ...portalCookieOptions(PORTAL_SESSION_TTL_MS, process.env.NODE_ENV === 'production'),
      maxAge: 0,
      expires: new Date(0),
    });
    return { loggedOut: true };
  }

  // R6-S1: @Public() skips JwtAuthGuard (no employee token on portal requests);
  // PortalAuthGuard provides the portal-session authentication instead.
  // THE single /me handler — see the D2-13 note on the class docblock.
  @Public()
  @UseGuards(PortalAuthGuard)
  @Get('me')
  async me(@Req() request: Request & { portalSession?: { companyId: string; partyId: string } }) {
    return {
      companyId: request.portalSession!.companyId,
      partyId: request.portalSession!.partyId,
    };
  }

  private setSessionCookie(response: Response, rawToken: string): void {
    response.cookie(PORTAL_SESSION_COOKIE, rawToken, portalCookieOptions(PORTAL_SESSION_TTL_MS, process.env.NODE_ENV === 'production'));
  }
}

// Re-export for the module
export { PortalAuthGuard };
