import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthService, RequestContext } from './auth.service';
import { LoginDto } from './auth.dto';
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
}
