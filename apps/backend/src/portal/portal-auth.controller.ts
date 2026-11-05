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
 * Portal auth endpoints (Gate D-2 Phase 1):
 *   POST /api/portal/request-otp   @Public — send OTP via SMS
 *   POST /api/portal/verify-otp    @Public — verify code → session (or PENDING_SELECTION)
 *   POST /api/portal/select-company @Public + PENDING cookie → final session
 *   GET  /api/portal/me            PortalAuthGuard — session identity
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
    @Body() body: { mobile: string; companyId?: string },
  ) {
    if (!body.mobile) throw new Error('Mobile is required');
    return this.otpService.requestOtp(body.mobile, body.companyId ?? '');
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
      // PENDING_SELECTION cookie (short-lived, HttpOnly)
      response.cookie('portal_pending', result.pendingToken, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/api/portal',
        maxAge: 5 * 60_000,
      });
      return {
        sessionActive: false,
        pendingSelection: (result.portalAccountIds ?? []).length,
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
    if (!raw) throw new Error('Selection expired');
    const result = await this.otpService.selectCompany(raw, body.portalAccountId);
    this.setSessionCookie(response, result.sessionToken);
    response.clearCookie('portal_pending', { path: '/api/portal' });
    return { sessionActive: true, companyId: result.companyId, partyId: result.partyId };
  }

  // R6-S1: @Public() skips JwtAuthGuard (no employee token on portal requests);
  // PortalAuthGuard provides the portal-session authentication instead.
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
    response.cookie('portal_session', rawToken, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/api/portal',
      maxAge: PORTAL_SESSION_TTL_MS,
      ...(process.env.NODE_ENV === 'production' ? { secure: true } : {}),
    });
  }
}

// Re-export for the module
export { PortalAuthGuard };
