import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { Readable } from 'node:stream';

import { createHash } from 'node:crypto';
import { Request, Response } from 'express';
import { AuthService, RequestContext } from './auth.service';
import { ChangePasswordDto, LoginDto, UpdateProfileDto } from './auth.dto';
import { setAuthCookies, clearAuthCookies, REFRESH_TOKEN_COOKIE } from './auth.cookies';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { NotFoundError, UnauthorizedError, ValidationError } from '../common/errors';
import { UploadedFilePayload } from '../files/files.service';
import { CompanyContextService } from '../companies/company-context.service';
import { AppConfig, CONFIG } from '../config/configuration';
import { Inject } from '@nestjs/common';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly companyContext: CompanyContextService,
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

  // ── CORE-004: avatar — real upload through the Files/MinIO infrastructure ─

  /**
   * Upload/replace the caller's avatar image (png/jpeg/webp, ≤2MB). The
   * bytes are stored via the Files module (sha256-deduped MinIO blob +
   * company-scoped attachment); the user row points at the stable
   * /api/auth/avatar/:id route. entityId is ALWAYS the caller — a client
   * can never write another user's avatar.
   */
  @Post('avatar')
  @HttpCode(200)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 2 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype)) {
          cb(new ValidationError('AVATAR_INVALID_TYPE'), false);
          return;
        }
        cb(null, true);
      },
    }),
  )
  async uploadAvatar(
    @UploadedFile() file: UploadedFilePayload | undefined,
    @CurrentUser('id') userId: string,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    if (!file) throw new ValidationError('Multipart field "file" is required');
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.authService.setOwnAvatar(
      userId,
      file,
      companyId,
      actor,
      this.requestContext(request),
    );
  }

  /** Remove the caller's avatar. */
  @Delete('avatar')
  async removeAvatar(
    @CurrentUser('id') userId: string,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    return this.authService.clearOwnAvatar(userId, actor, this.requestContext(request));
  }

  /**
   * Serve a user's uploaded avatar. AUTHENTICATED (no @Public) — image bytes
   * are only reachable with a valid session; the lookup is pinned to
   * user_avatar attachments. ETag = blob sha256 (safe to revalidate).
   */
  @Get('avatar/:userId')
  async getAvatar(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const result = await this.authService.resolveAvatar(userId);
    if (!result) throw new NotFoundError('Avatar not found');
    response.setHeader('Content-Type', result.contentType);
    response.setHeader('Content-Length', String(result.size));
    response.setHeader('Cache-Control', 'private, max-age=60');
    response.setHeader('ETag', `"${result.etag}"`);
    return new StreamableFile(result.stream);
  }
}
