import { Module } from '@nestjs/common';
import { LoadingController } from './loading.controller';
import { LoadingService } from './loading.service';
import { PartiesModule } from '../parties/parties.module';
import { DocumentFlowModule } from '../document-flow/document-flow.module';
import { InventoryModule } from '../inventory/inventory.module';
import { ApprovalsModule } from '../approvals/approvals.module';

/**
 * Loading (Phase 6): header + lines + allocations with the ratified
 * DRAFT → CONFIRMED lifecycle. Dependencies: PartiesModule (timeline),
 * DocumentFlowModule (RELATED relations), InventoryModule (default-warehouse
 * resolution + stock), ApprovalsModule (debt-gate release decisions).
 */
@Module({
  imports: [PartiesModule, DocumentFlowModule, InventoryModule, ApprovalsModule],
  controllers: [LoadingController],
  providers: [LoadingService],
  exports: [LoadingService],
})
export class LoadingModule {}
