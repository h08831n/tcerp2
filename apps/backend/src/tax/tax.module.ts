import { Module } from '@nestjs/common';
import { TaxController } from './tax.controller';
import { TaxAllocationService, TaxDefinitionService } from './tax.service';
import { TaxInvoiceService } from './tax-invoice.service';
import { TaxInvoiceController } from './tax-invoice.controller';
import { MockMoadianAdapter } from './moadian/mock-moadian.adapter';
import { MoadianHttpAdapter } from './moadian/moadian-http.adapter';
import { MOADIAN_ADAPTER, MoadianAdapter } from './moadian/moadian-adapter';
import { SequencesModule } from '../sequences/sequences.module';

/** Moadian adapter selection: mock (default) | sandbox | live — docs/08.
 *  sandbox/live REQUIRE runtime credentials (fiscalId, economic code, private
 *  key) via env and are UNVERIFIED against the real service; they throw at
 *  construction when the material is missing so misconfiguration is loud. */
function buildMoadianAdapter(): MoadianAdapter {
  const mode = (process.env.MOADIAN_MODE ?? 'mock') as 'mock' | 'sandbox' | 'live';
  if (mode === 'mock') return new MockMoadianAdapter();
  return new MoadianHttpAdapter({
    baseUrl: process.env.MOADIAN_BASE_URL,
    fiscalId: process.env.MOADIAN_FISCAL_ID,
    economicCode: process.env.MOADIAN_ECONOMIC_CODE,
    privateKeyPem: process.env.MOADIAN_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  });
}

@Module({
  imports: [SequencesModule],
  controllers: [TaxController, TaxInvoiceController],
  providers: [
    TaxDefinitionService,
    TaxAllocationService,
    TaxInvoiceService,
    { provide: MOADIAN_ADAPTER, useFactory: buildMoadianAdapter },
  ],
  exports: [TaxDefinitionService, TaxAllocationService, TaxInvoiceService],
})
export class TaxModule {}
