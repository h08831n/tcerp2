import { Module } from '@nestjs/common';
import { JournalService } from './journal.service';
import { FiscalYearService } from './fiscal-year.service';
import { FiscalYearController } from './fiscal-year.controller';

@Module({
  controllers: [FiscalYearController],
  providers: [JournalService, FiscalYearService],
  exports: [JournalService, FiscalYearService],
})
export class AccountingModule {}
