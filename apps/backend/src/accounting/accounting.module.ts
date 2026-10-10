import { Module } from '@nestjs/common';
import { JournalService } from './journal.service';
import { FiscalYearService } from './fiscal-year.service';
import { FiscalYearController } from './fiscal-year.controller';
import { AccountingEventService } from './accounting-event.service';
import { PostingRuleService } from './posting-rule.service';
import { AccountingController } from './accounting.controller';

@Module({
  controllers: [FiscalYearController, AccountingController],
  providers: [JournalService, FiscalYearService, AccountingEventService, PostingRuleService],
  exports: [JournalService, FiscalYearService, AccountingEventService],
})
export class AccountingModule {}
