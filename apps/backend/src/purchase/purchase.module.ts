import { Module } from '@nestjs/common';
import { PartiesModule } from '../parties/parties.module';
import { DocumentFlowModule } from '../document-flow/document-flow.module';
import { DailyPriceService } from '../pricing/daily-price.service';
import { PurchaseController } from './purchase.controller';
import { SalesToPurchaseFlowController } from './flow.controller';
import { PurchaseDocumentsService } from './purchase-documents.service';

/**
 * Purchase documents (Phase 4, REQUIREMENTS §11-12). SequencesService is
 * global; PartiesModule supplies the shared TimelineService;
 * DocumentFlowModule the DocumentRelationService.
 *
 * DailyPriceService is PROVIDED here (not via `imports: [PricingModule]`)
 * because that import is circular (PricingModule → PriceRequestModule →
 * PurchaseModule). DailyPriceService only needs the global Prisma/Audit
 * modules — it reads today's price for the p5c line price-source wiring.
 */
@Module({
  imports: [PartiesModule, DocumentFlowModule],
  controllers: [PurchaseController, SalesToPurchaseFlowController],
  providers: [PurchaseDocumentsService, DailyPriceService],
  exports: [PurchaseDocumentsService],
})
export class PurchaseModule {}
