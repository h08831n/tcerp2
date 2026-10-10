import { Module } from '@nestjs/common';
import { AccountingModule } from '../accounting/accounting.module';
import { PartiesModule } from '../parties/parties.module';
import { DocumentFlowModule } from '../document-flow/document-flow.module';
import { InventoryModule } from '../inventory/inventory.module';
import { PurchaseModule } from '../purchase/purchase.module';
import { GoodsReceiptController } from './goods-receipt.controller';
import { GoodsReceiptService } from './goods-receipt.service';

/**
 * Goods receipts (Integrity Gate #9): real partial receipts drive stock.
 * Dependencies: PartiesModule (timeline), DocumentFlowModule (RELATED
 * relations), InventoryModule (location resolution + movement write seam).
 * SequencesService is global (GRN numbering).
 */
@Module({
  imports: [PartiesModule, DocumentFlowModule, InventoryModule, PurchaseModule, AccountingModule],
  controllers: [GoodsReceiptController],
  providers: [GoodsReceiptService],
  exports: [GoodsReceiptService],
})
export class GoodsReceiptModule {}
