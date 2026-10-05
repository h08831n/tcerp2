import { Module } from '@nestjs/common';
import { RolesController } from './roles.controller';
import { PermissionsCatalogController } from './permissions-catalog.controller';
import { RolesService } from './roles.service';

@Module({
  controllers: [RolesController, PermissionsCatalogController],
  providers: [RolesService],
  exports: [RolesService],
})
export class RolesModule {}
