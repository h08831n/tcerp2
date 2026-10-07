import { Module } from '@nestjs/common';
import { PricingController } from './pricing.controller';
import { DailyPriceService } from './daily-price.service';
import { DailyPriceTodayPriceProvider } from './daily-price-today.provider';
import { AutomationModule } from '../automation/automation.module';
import { AutomationService } from '../automation/automation.service';
import { PriceRequestModule } from '../price-request/price-request.module';

/**
 * Daily Pricing Engine (Phase 5, REQUIREMENTS §17). Depends on:
 *   - AutomationModule: the PRICE_UPDATED trigger fires after each price
 *     write commits (AutomationService implements PriceUpdatedHook);
 *   - PriceRequestModule: the cheapest-supplier report reuses the Phase 4
 *     SupplierOffersService daily-lowest RANK() query.
 * AuditModule/QueueModule are global.
 */
@Module({
  imports: [AutomationModule, PriceRequestModule],
  controllers: [PricingController],
  providers: [
    DailyPriceService,
    DailyPriceTodayPriceProvider,
    { provide: 'PRICE_UPDATED_HOOK', useExisting: AutomationService },
  ],
  exports: [DailyPriceService, DailyPriceTodayPriceProvider],
})
export class PricingModule {}
