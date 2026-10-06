import { Module } from '@nestjs/common';
import { PartiesModule } from '../parties/parties.module';
import { DocumentFlowModule } from '../document-flow/document-flow.module';
import { SalesController } from './sales.controller';
import { PurchaseToSalesFlowController } from './flow.controller';
import { SalesDocumentsService } from './sales-documents.service';

/**
 * Sales documents (Phase 4, REQUIREMENTS §9-10). SequencesService is global;
 * PartiesModule supplies the shared TimelineService; DocumentFlowModule the
 * DocumentRelationService. Cross-flow endpoints (create purchase from sale /
 * create sale from purchase) live in the flow controllers of the owning
 * module so the sales and purchase modules never import each other.
 */
@Module({
  imports: [PartiesModule, DocumentFlowModule],
  controllers: [SalesController, PurchaseToSalesFlowController],
  providers: [SalesDocumentsService],
  exports: [SalesDocumentsService],
})
export class SalesModule {}
