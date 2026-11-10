import { Body, Controller, Get, HttpCode, Patch, Post, Req, Res } from '@nestjs/common';

import { createHash } from 'node:crypto';
import { Request, Response } from 'express';
import { AuthService, RequestContext } from './auth.service';
import { ChangePasswordDto, LoginDto, UpdateProfileDto } from './auth.dto';
import { setAuthCookies, clearAuthCookies, REFRESH_TOKEN_COOKIE } from './auth.cookies';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UnauthorizedError } from '../common/errors';
import { AppConfig, CONFIG } from '../config/configuration';
import { Inject } from '@nestjs/common';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  private requestContext(request: Request): RequestContext {
    return {
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    };
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() dto: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.authService.login(
      dto.identifier,
      dto.password,
      this.requestContext(request),
    );
    setAuthCookies(response, this.config, result.accessToken, result.refreshToken);
    return { accessToken: result.accessToken, user: result.user };
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const cookies = request.cookies as Record<string, string | undefined> | undefined;
    const result = await this.authService.refresh(
      cookies?.[REFRESH_TOKEN_COOKIE],
      this.requestContext(request),
    );
    setAuthCookies(response, this.config, result.accessToken, result.refreshToken);
    return { accessToken: result.accessToken, user: result.user };
  }

  @Public()
  @Post('logout')
  @HttpCode(200)
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const cookies = request.cookies as Record<string, string | undefined> | undefined;
    await this.authService.logout(
      cookies?.[REFRESH_TOKEN_COOKIE],
      this.requestContext(request),
    );
    clearAuthCookies(response);
    return { success: true };
  }

  @Get('me')
  async me(@CurrentUser('id') userId: string) {
    return this.authService.me(userId);
  }

  /**
   * CORE-004 — self-profile update. Authenticated (NOT @Public) so the guard
   * identifies the caller; the service whitelist makes privilege escalation
   * by payload shape impossible (no status/roles/company fields accepted).
   */
  @Patch('profile')
  async updateOwnProfile(
    @CurrentUser('id') userId: string,
    @CurrentUser() actor: { id: string; username: string },
    @Body() dto: UpdateProfileDto,
    @Req() request: Request,
  ) {
    await this.authService.updateOwnProfile(userId, dto, actor, this.requestContext(request));
    return this.authService.me(userId);
  }

  /**
   * CORE-004 — self-service password change: verifies the CURRENT password,
   * keeps the current session alive, revokes other devices. Audited.
   */
  @Post('change-password')
  @HttpCode(200)
  async changeOwnPassword(
    @CurrentUser('id') userId: string,
    @CurrentUser() actor: { id: string; username: string },
    @Body() dto: ChangePasswordDto,
    @Req() request: Request,
  ) {
    const cookies = request.cookies as Record<string, string | undefined> | undefined;
    const currentHash = cookies?.[REFRESH_TOKEN_COOKIE]
      ? createHash('sha256').update(cookies[REFRESH_TOKEN_COOKIE]).digest('hex')
      : undefined;
    await this.authService.changeOwnPassword(
      userId,
      dto.currentPassword,
      dto.newPassword,
      actor,
      this.requestContext(request),
      currentHash,
    );
    return { success: true };
  }
}
