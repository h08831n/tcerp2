import { Module } from '@nestjs/common';
import { PartiesModule } from '../parties/parties.module';
import { LeadsController, LostReasonsController, OpportunitiesController, PaymentTermsController } from './crm.controller';
import { LeadsService } from './leads.service';
import { OpportunitiesService } from './opportunities.service';
import { LostReasonsService } from './lost-reasons.service';
import { PaymentTermsService } from './payment-terms.service';

/**
 * CRM funnel (Phase 4 + CR-001): Leads → Opportunities → Quotations (sales
 * module). PrismaModule and AuditModule are global; CompanyContextService
 * comes from the global CompaniesModule; PartiesModule supplies the shared
 * TimelineService (lead/opportunity chatter = same timeline machinery as
 * parties — NO parallel history system).
 */
@Module({
  imports: [PartiesModule],
  controllers: [LeadsController, OpportunitiesController, LostReasonsController, PaymentTermsController],
  providers: [LeadsService, OpportunitiesService, LostReasonsService, PaymentTermsService],
  exports: [LeadsService, OpportunitiesService, LostReasonsService, PaymentTermsService],
})
export class CrmModule {}
