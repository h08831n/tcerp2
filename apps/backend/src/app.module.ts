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
import { CrmModule } from './crm/crm.module';
import { SalesModule } from './sales/sales.module';
import { PurchaseModule } from './purchase/purchase.module';
import { AllocationsModule } from './allocations/allocations.module';
import { PriceRequestModule } from './price-request/price-request.module';
import { DocumentFlowModule } from './document-flow/document-flow.module';
import { LoadingModule } from './loading/loading.module';
import { GoodsReceiptModule } from './goods-receipt/goods-receipt.module';
import { InventoryModule } from './inventory/inventory.module';
import { ApprovalsModule } from './approvals/approvals.module';
import { WorkflowTimerModule } from './workflow-timer/workflow-timer.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PortalModule } from './portal/portal.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { PricingModule } from './pricing/pricing.module';
import { PublishingModule } from './publishing/publishing.module';
import { AutomationModule } from './automation/automation.module';
import { PublicApiModule } from './public-api/public-api.module';
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
    CrmModule,
    SalesModule,
    PurchaseModule,
    AllocationsModule,
    PriceRequestModule,
    DocumentFlowModule,
    LoadingModule,
    InventoryModule,
    GoodsReceiptModule,
    ApprovalsModule,
    WorkflowTimerModule,
    NotificationsModule,
    PortalModule,
    IntegrationsModule,
    PricingModule,
    PublishingModule,
    AutomationModule,
    PublicApiModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule {}
