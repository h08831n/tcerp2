import { Module } from '@nestjs/common';
import { PermissionsService } from './permissions.service';

/**
 * Shared permissions module: provides PermissionsService to the guards
 * (PermissionsGuard) and to auth (GET /auth/me).
 */
@Module({
  providers: [PermissionsService],
  exports: [PermissionsService],
})
export class PermissionsModule {}
