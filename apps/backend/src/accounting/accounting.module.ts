import { Module } from '@nestjs/common';
import { JournalService } from './journal.service';
import { FiscalYearService } from './fiscal-year.service';
import { FiscalYearController } from './fiscal-year.controller';
import { AccountingEventService } from './accounting-event.service';
import { PostingRuleService } from './posting-rule.service';
import { AccountingController } from './accounting.controller';
import { ReportsService } from './reports.service';
import { ProfitReportService } from './profit-report.service';
import { ValuationReportService } from './valuation-report.service';
import { SubsidiaryLedgerService } from './subsidiary-ledger.service';
import { OpeningBalanceService } from './opening-balance.service';
import { ReportsController } from './reports.controller';
import { OpeningBalanceController } from './reports.controller';

@Module({
  controllers: [FiscalYearController, AccountingController, ReportsController, OpeningBalanceController],
  providers: [
    JournalService,
    FiscalYearService,
    AccountingEventService,
    PostingRuleService,
    ReportsService,
    ProfitReportService,
    ValuationReportService,
    SubsidiaryLedgerService,
    OpeningBalanceService,
  ],
  exports: [JournalService, FiscalYearService, AccountingEventService],
})
export class AccountingModule {}
