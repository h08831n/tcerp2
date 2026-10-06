import { Module } from '@nestjs/common';
import { PartiesModule } from '../parties/parties.module';
import { DocumentFlowModule } from '../document-flow/document-flow.module';
import { SalesModule } from '../sales/sales.module';
import { PurchaseModule } from '../purchase/purchase.module';
import { PriceRequestsController } from './price-request.controller';
import { PriceRequestsService } from './price-requests.service';
import { SupplierOffersService } from './supplier-offers.service';
import { NullTodayPriceProvider, TODAY_PRICE_PROVIDER } from './today-price.provider';

/**
 * Price requests + supplier offers (Phase 4, REQUIREMENTS §14-16).
 * SalesModule/PurchaseModule provide the document creation for the
 * §16 flows; neither imports this module, so no cycles. The daily pricing
 * engine (Phase 5) overrides TODAY_PRICE_PROVIDER.
 */
@Module({
  imports: [PartiesModule, DocumentFlowModule, SalesModule, PurchaseModule],
  controllers: [PriceRequestsController],
  providers: [
    PriceRequestsService,
    SupplierOffersService,
    { provide: TODAY_PRICE_PROVIDER, useClass: NullTodayPriceProvider },
  ],
  exports: [PriceRequestsService, SupplierOffersService],
})
export class PriceRequestModule {}
