import { Module } from '@nestjs/common';
import { TaxController } from './tax.controller';
import { TaxAllocationService, TaxDefinitionService } from './tax.service';
import { TaxInvoiceService } from './tax-invoice.service';
import { TaxInvoiceController } from './tax-invoice.controller';
import { MOADIAN_ADAPTER } from './moadian/moadian-adapter';
import { buildMoadianAdapter } from './moadian/adapter-factory';
import { SequencesModule } from '../sequences/sequences.module';

/** The REAL provider definition — exported so tests can exercise the exact
 *  factory wiring the module uses (adapter-factory.spec.ts). */
export const MOADIAN_ADAPTER_PROVIDER = {
  provide: MOADIAN_ADAPTER,
  useFactory: () => buildMoadianAdapter(),
} as const;

/** The MOADIAN_ADAPTER provider uses buildMoadianAdapter() from
 *  adapter-factory.ts — the SAME factory covered by adapter-factory.spec.ts
 *  (mock default, strict mode validation, all credentials wired, fail-fast,
 *  no silent mock fallback). docs/08. */
@Module({
  imports: [SequencesModule],
  controllers: [TaxController, TaxInvoiceController],
  providers: [
    TaxDefinitionService,
    TaxAllocationService,
    TaxInvoiceService,
    MOADIAN_ADAPTER_PROVIDER,
  ],
  exports: [TaxDefinitionService, TaxAllocationService, TaxInvoiceService],
})
export class TaxModule {}
