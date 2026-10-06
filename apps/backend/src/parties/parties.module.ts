import { Module } from '@nestjs/common';
import { PartiesController } from './parties.controller';
import { PartiesService } from './parties.service';
import { FinancialResponsibilityService } from './financial-responsibility.service';
import { CustomerScoreService } from './customer-score.service';
import { TimelineService } from './timeline.service';

/**
 * Party / CRM core (Phase 3A). PrismaModule and AuditModule are global;
 * the controller resolves the request company through CompanyContextService
 * (CompaniesModule, global) and permissions through PermissionsService
 * (PermissionsModule, global).
 */
@Module({
  controllers: [PartiesController],
  providers: [PartiesService, FinancialResponsibilityService, CustomerScoreService, TimelineService],
  exports: [PartiesService, CustomerScoreService, FinancialResponsibilityService, TimelineService],
})
export class PartiesModule {}
