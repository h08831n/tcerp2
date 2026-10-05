import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from './config/config.module';
import { PrismaModule } from './prisma/prisma.module';
import { PermissionsModule } from './permissions/permissions.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { PermissionsGuard } from './common/guards/permissions.guard';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { RolesModule } from './roles/roles.module';
import { TeamsModule } from './teams/teams.module';
import { SettingsModule } from './settings/settings.module';
import { SequencesModule } from './sequences/sequences.module';
import { QueueModule } from './queue/queue.module';
import { FilesModule } from './files/files.module';
import { HealthModule } from './health/health.module';

/**
 * Global guards (registration order = execution order):
 *   1. JwtAuthGuard — authenticates every route except @Public().
 *   2. PermissionsGuard — enforces @RequirePermissions metadata.
 */
@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    PermissionsModule,
    AuditModule,
    AuthModule,
    UsersModule,
    RolesModule,
    TeamsModule,
    SettingsModule,
    SequencesModule,
    QueueModule,
    FilesModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule {}
