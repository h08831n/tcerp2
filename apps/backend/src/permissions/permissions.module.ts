import { Global, Module } from '@nestjs/common';
import { PermissionsService } from './permissions.service';

/**
 * Global shared permissions service: used by PermissionsGuard, auth (/auth/me)
 * and feature modules that resolve record scopes (e.g. parties).
 */
@Global()
@Module({
  providers: [PermissionsService],
  exports: [PermissionsService],
})
export class PermissionsModule {}
