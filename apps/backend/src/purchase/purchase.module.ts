import { Module } from '@nestjs/common';
import { PartiesModule } from '../parties/parties.module';
import { DocumentFlowModule } from '../document-flow/document-flow.module';
import { PurchaseController } from './purchase.controller';
import { SalesToPurchaseFlowController } from './flow.controller';
import { PurchaseDocumentsService } from './purchase-documents.service';

/**
 * Purchase documents (Phase 4, REQUIREMENTS §11-12). SequencesService is
 * global; PartiesModule supplies the shared TimelineService;
 * DocumentFlowModule the DocumentRelationService.
 */
@Module({
  imports: [PartiesModule, DocumentFlowModule],
  controllers: [PurchaseController, SalesToPurchaseFlowController],
  providers: [PurchaseDocumentsService],
  exports: [PurchaseDocumentsService],
})
export class PurchaseModule {}
