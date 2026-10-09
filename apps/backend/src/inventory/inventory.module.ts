import { Module } from '@nestjs/common';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';

/**
 * Inventory (Phase 6): computed stock, movement ledger, warehouses. The
 * service is exported — LoadingService (default-warehouse resolution) and
 * PurchaseDocumentsService (receive → IN movements) depend on it.
 */
@Module({
  controllers: [InventoryController],
  providers: [InventoryService],
  exports: [InventoryService],
})
export class InventoryModule {}
