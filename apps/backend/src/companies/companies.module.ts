import { Global, Module } from '@nestjs/common';
import { CompaniesController } from './companies.controller';
import { CompaniesService } from './companies.service';
import { CompanyContextService } from './company-context.service';

/**
 * Global: every company-scoped module injects CompanyContextService without
 * importing this module (same pattern as AuditModule).
 */
@Global()
@Module({
  controllers: [CompaniesController],
  providers: [CompaniesService, CompanyContextService],
  exports: [CompaniesService, CompanyContextService],
})
export class CompaniesModule {}
