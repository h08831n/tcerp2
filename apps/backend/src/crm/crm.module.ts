import { Module } from '@nestjs/common';
import { PartiesModule } from '../parties/parties.module';
import { LeadsController, LostReasonsController, PaymentTermsController } from './crm.controller';
import { LeadsService } from './leads.service';
import { LostReasonsService } from './lost-reasons.service';
import { PaymentTermsService } from './payment-terms.service';

/**
 * CRM (Phase 4 + CR-001 R2): Leads = Parties with the LEAD role → Quotations
 * (sales module). The Opportunity stage is REMOVED from the operational flow
 * (R2 §1); the opportunities.service.ts file is retained ONLY as historical
 * reference for the preserved data — no routes are exposed. PrismaModule and
 * AuditModule are global; CompanyContextService comes from the global
 * CompaniesModule; PartiesModule supplies the shared TimelineService.
 */
@Module({
  imports: [PartiesModule],
  controllers: [LeadsController, LostReasonsController, PaymentTermsController],
  providers: [LeadsService, LostReasonsService, PaymentTermsService],
  exports: [LeadsService, LostReasonsService, PaymentTermsService],
})
export class CrmModule {}
