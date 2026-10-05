import { Module } from '@nestjs/common';
import { TaxController } from './tax.controller';
import { TaxAllocationService, TaxDefinitionService } from './tax.service';

@Module({
  controllers: [TaxController],
  providers: [TaxDefinitionService, TaxAllocationService],
  exports: [TaxDefinitionService, TaxAllocationService],
})
export class TaxModule {}
