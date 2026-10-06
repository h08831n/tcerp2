import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from './config/config.module';
import { PrismaModule } from './prisma/prisma.module';
import { PermissionsModule } from './permissions/permissions.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { PermissionsGuard } from './common/guards/permissions.guard';
import { AuditModule } from './audit/audit.module';
import { CompaniesModule } from './companies/companies.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { RolesModule } from './roles/roles.module';
import { TeamsModule } from './teams/teams.module';
import { SettingsModule } from './settings/settings.module';
import { SequencesModule } from './sequences/sequences.module';
import { QueueModule } from './queue/queue.module';
import { FilesModule } from './files/files.module';
import { AccountingModule } from './accounting/accounting.module';
import { TreasuryModule } from './treasury/treasury.module';
import { ClaimsModule } from './claims/claims.module';
import { PartiesModule } from './parties/parties.module';
import { ProductsModule } from './products/products.module';
import { TaxModule } from './tax/tax.module';
import { SupplierProductModule } from './supplierproduct/supplier-product.module';
import { LoadingModule } from './loading/loading.module';
import { WorkflowTimerModule } from './workflow-timer/workflow-timer.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PortalModule } from './portal/portal.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { HealthModule } from './health/health.module';

/**
 * Global guards (registration order = execution order):
 *   1. JwtAuthGuard — authenticates every route except @Public().
 *   2. PermissionsGuard — enforces @RequirePermissions metadata.
 *
 * Global feature modules: CompaniesModule (CompanyContextService), QueueModule
 * (QueueService + handler registry), AuditModule, PermissionsModule, ConfigModule.
 */
@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    PermissionsModule,
    AuditModule,
    CompaniesModule,
    QueueModule,
    AuthModule,
    UsersModule,
    RolesModule,
    TeamsModule,
    SettingsModule,
    SequencesModule,
    FilesModule,
    AccountingModule,
    TreasuryModule,
    ClaimsModule,
    PartiesModule,
    ProductsModule,
    TaxModule,
    SupplierProductModule,
    LoadingModule,
    WorkflowTimerModule,
    NotificationsModule,
    PortalModule,
    IntegrationsModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule {}
