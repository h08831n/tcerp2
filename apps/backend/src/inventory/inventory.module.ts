import { Module } from '@nestjs/common';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { NormalizationService } from './normalization.service';

/**
 * Inventory (Phase 6 / Integrity Gate): computed stock (location semantics),
 * movement ledger, stock locations, transfers, warehouses. Both services are
 * exported — LoadingService / PurchaseDocumentsService / GoodsReceiptService
 * depend on them.
 */
@Module({
  controllers: [InventoryController],
  providers: [InventoryService, NormalizationService],
  exports: [InventoryService, NormalizationService],
})
export class InventoryModule {}
