import { Module } from '@nestjs/common';
import { AccountingModule } from '../accounting/accounting.module';
import { SequencesModule } from '../sequences/sequences.module';
import { TreasuryController } from './treasury.controller';
import { BankAccountsService } from './bank-accounts.service';
import { BankStatementService } from './bank-statement.service';
import { BankTransferService } from './bank-transfer.service';
import { ReceiptService, PaymentService } from './receipt-payment.service';
import { ChecksService } from './checks.service';

@Module({
  imports: [AccountingModule, SequencesModule],
  controllers: [TreasuryController],
  providers: [
    BankAccountsService,
    BankStatementService,
    BankTransferService,
    ReceiptService,
    PaymentService,
    ChecksService,
  ],
  exports: [BankStatementService, BankTransferService, ReceiptService, PaymentService, ChecksService],
})
export class TreasuryModule {}
