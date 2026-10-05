import { Injectable } from '@nestjs/common';
import { Prisma, BankAccount } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit.dto';
import { NotFoundError, ConflictError } from '../common/errors';
import { RequestContext } from '../auth/auth.service';
import { CreateBankAccountDto, UpdateBankAccountDto } from './treasury.dto';

@Injectable()
export class BankAccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async list(companyId: string): Promise<BankAccount[]> {
    return this.prisma.bankAccount.findMany({
      where: { companyId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async getById(companyId: string, id: string): Promise<BankAccount> {
    const account = await this.prisma.bankAccount.findUnique({ where: { id } });
    if (!account || account.companyId !== companyId) {
      throw new NotFoundError('Bank account not found', { id });
    }
    return account;
  }

  async create(
    companyId: string,
    dto: CreateBankAccountDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<BankAccount> {
    const account = await this.prisma.bankAccount.create({
      data: {
        companyId,
        name: dto.name,
        bankName: dto.bankName,
        accountNumber: dto.accountNumber,
        iban: dto.iban,
        currency: dto.currency ?? 'IRR',
        isActive: dto.isActive ?? true,
      },
    });
    await this.auditService.record({
      entityType: 'bank_account',
      entityId: account.id,
      action: AuditAction.CREATE,
      actor,
      companyId,
      newValues: { name: account.name, bankName: account.bankName },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return account;
  }

  async update(
    companyId: string,
    id: string,
    dto: UpdateBankAccountDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<BankAccount> {
    const existing = await this.getById(companyId, id);
    const updated = await this.prisma.bankAccount.update({
      where: { id: existing.id },
      data: {
        name: dto.name,
        bankName: dto.bankName,
        accountNumber: dto.accountNumber,
        iban: dto.iban,
        currency: dto.currency,
        isActive: dto.isActive,
      },
    });
    await this.auditService.record({
      entityType: 'bank_account',
      entityId: id,
      action: AuditAction.UPDATE,
      actor,
      companyId,
      oldValues: { name: existing.name, isActive: existing.isActive },
      newValues: { name: updated.name, isActive: updated.isActive },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return updated;
  }

  async remove(
    companyId: string,
    id: string,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<void> {
    const existing = await this.getById(companyId, id);
    try {
      await this.prisma.bankAccount.delete({ where: { id } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') {
        throw new ConflictError('Bank account has dependent records and cannot be deleted', { id });
      }
      throw error;
    }
    await this.auditService.record({
      entityType: 'bank_account',
      entityId: id,
      action: AuditAction.DELETE,
      actor,
      companyId,
      oldValues: { name: existing.name },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  }
}
