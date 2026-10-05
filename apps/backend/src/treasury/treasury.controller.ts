import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { CheckDirection, CheckStatus } from '@prisma/client';
import { BankAccountsService } from './bank-accounts.service';
import { BankTransferService } from './bank-transfer.service';
import { ReceiptService, PaymentService } from './receipt-payment.service';
import { ChecksService } from './checks.service';
import { BankStatementService } from './bank-statement.service';
import {
  ClearCheckDto,
  CreateBankAccountDto,
  CreateBankTransferDto,
  CreatePaymentDto,
  CreateReceiptDto,
  RegisterCheckDto,
  UpdateBankAccountDto,
} from './treasury.dto';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequestContext } from '../auth/auth.service';
import { CompanyContextService } from '../companies/company-context.service';

@Controller('treasury')
export class TreasuryController {
  constructor(
    private readonly bankAccounts: BankAccountsService,
    private readonly transfers: BankTransferService,
    private readonly receipts: ReceiptService,
    private readonly payments: PaymentService,
    private readonly checks: ChecksService,
    private readonly statement: BankStatementService,
    private readonly companyContext: CompanyContextService,
  ) {}

  private ctx(request: Request): RequestContext {
    return { ip: request.ip, userAgent: request.headers['user-agent'] };
  }

  // ── Bank accounts ──
  @Get('bank-accounts')
  @RequirePermissions('treasury.view')
  listAccounts(@CurrentUser() user: { id: string }, @Req() request: Request) {
    return this.companyContext
      .requireCompanyId(user, request.headers)
      .then((companyId) => this.bankAccounts.list(companyId));
  }

  @Post('bank-accounts')
  @RequirePermissions('treasury.create')
  async createAccount(
    @Body() dto: CreateBankAccountDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.bankAccounts.create(companyId, dto, actor, this.ctx(request));
  }

  @Get('bank-accounts/:id')
  @RequirePermissions('treasury.view')
  async getAccount(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.bankAccounts.getById(companyId, id);
  }

  @Patch('bank-accounts/:id')
  @RequirePermissions('treasury.edit')
  async updateAccount(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBankAccountDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.bankAccounts.update(companyId, id, dto, actor, this.ctx(request));
  }

  @Delete('bank-accounts/:id')
  @RequirePermissions('treasury.delete')
  async removeAccount(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.bankAccounts.remove(companyId, id, actor, this.ctx(request));
  }

  // ── Statement ──
  @Get('bank-accounts/:id/statement')
  @RequirePermissions('treasury.view')
  async getStatement(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    await this.bankAccounts.getById(companyId, id);
    return this.statement.list(
      id,
      from ? new Date(from) : undefined,
      to ? new Date(to) : undefined,
    );
  }

  // ── Transfers ──
  @Post('transfers')
  @RequirePermissions('treasury.create')
  async createTransfer(
    @Body() dto: CreateBankTransferDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.transfers.createTransfer(
      companyId,
      {
        sourceBankAccountId: dto.sourceBankAccountId,
        destinationBankAccountId: dto.destinationBankAccountId,
        amount: dto.amount,
        fee: dto.fee,
        transferDate: dto.transferDate ? new Date(dto.transferDate) : undefined,
        description: dto.description,
      },
      actor,
      this.ctx(request),
    );
  }

  // ── Receipts / Payments ──
  @Post('receipts')
  @RequirePermissions('treasury.create')
  async createReceipt(
    @Body() dto: CreateReceiptDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.receipts.create(
      companyId,
      {
        bankAccountId: dto.bankAccountId,
        partyId: dto.partyId,
        amount: dto.amount,
        date: dto.date ? new Date(dto.date) : undefined,
        description: dto.description,
      },
      actor,
      this.ctx(request),
    );
  }

  @Post('payments')
  @RequirePermissions('treasury.create')
  async createPayment(
    @Body() dto: CreatePaymentDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.payments.create(
      companyId,
      {
        bankAccountId: dto.bankAccountId,
        partyId: dto.partyId,
        amount: dto.amount,
        date: dto.date ? new Date(dto.date) : undefined,
        description: dto.description,
      },
      actor,
      this.ctx(request),
    );
  }

  // ── Checks ──
  @Get('checks')
  @RequirePermissions('treasury.view')
  async listChecks(
    @Query('status') status: CheckStatus | undefined,
    @Query('direction') direction: CheckDirection | undefined,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.checks.list(companyId, { status, direction });
  }

  @Post('checks/incoming')
  @RequirePermissions('treasury.create')
  async registerIncoming(
    @Body() dto: RegisterCheckDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.checks.register(
      companyId,
      'INCOMING',
      {
        checkNumber: dto.checkNumber,
        partyId: dto.partyId,
        amount: dto.amount,
        dueDate: new Date(dto.dueDate),
        issueDate: dto.issueDate ? new Date(dto.issueDate) : undefined,
        bankName: dto.bankName,
        description: dto.description,
      },
      actor,
      this.ctx(request),
    );
  }

  @Post('checks/outgoing')
  @RequirePermissions('treasury.create')
  async registerOutgoing(
    @Body() dto: RegisterCheckDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.checks.register(
      companyId,
      'OUTGOING',
      {
        checkNumber: dto.checkNumber,
        partyId: dto.partyId,
        amount: dto.amount,
        dueDate: new Date(dto.dueDate),
        issueDate: dto.issueDate ? new Date(dto.issueDate) : undefined,
        bankName: dto.bankName,
        description: dto.description,
      },
      actor,
      this.ctx(request),
    );
  }

  /** Register → PENDING (both directions). */
  @Post('checks/:id/pending')
  @RequirePermissions('treasury.edit')
  async checkPending(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.checks.transition(companyId, id, 'PENDING', { actor, ctx: this.ctx(request) });
  }

  /** Incoming PENDING → DEPOSITED (no bank effect yet). */
  @Post('checks/:id/deposit')
  @RequirePermissions('treasury.edit')
  async checkDeposit(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.checks.transition(companyId, id, 'DEPOSITED', { actor, ctx: this.ctx(request) });
  }

  /** Incoming DEPOSITED → CLEARED (bank effect: DEPOSIT line + journal). */
  @Post('checks/:id/clear')
  @RequirePermissions('treasury.edit')
  async checkClear(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ClearCheckDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.checks.transition(companyId, id, 'CLEARED', {
      bankAccountId: dto.bankAccountId,
      actor,
      ctx: this.ctx(request),
    });
  }

  /** Outgoing PENDING → PAID (bank effect: WITHDRAWAL line + journal). */
  @Post('checks/:id/pay')
  @RequirePermissions('treasury.edit')
  async checkPay(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ClearCheckDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.checks.transition(companyId, id, 'PAID', {
      bankAccountId: dto.bankAccountId,
      actor,
      ctx: this.ctx(request),
    });
  }

  @Post('checks/:id/bounce')
  @RequirePermissions('treasury.edit')
  async checkBounce(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.checks.transition(companyId, id, 'BOUNCED', { actor, ctx: this.ctx(request) });
  }

  @Post('checks/:id/cancel')
  @RequirePermissions('treasury.edit')
  async checkCancel(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.checks.transition(companyId, id, 'CANCELLED', { actor, ctx: this.ctx(request) });
  }
}
