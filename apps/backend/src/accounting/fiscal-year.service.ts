import { Injectable } from '@nestjs/common';
import { FiscalYearStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../common/errors';

export interface CreateFiscalYearInput {
  code: string; // Jalali year label, e.g. 1405
  nameFa: string;
  startDate: string; // ISO date
  endDate: string; // ISO date
  /** When true (default), 12 monthly periods are generated from startDate. */
  generateMonthlyPeriods?: boolean;
}

type Tx = Prisma.TransactionClient;

/**
 * Fiscal years & periods (Phase 7A-1): the posting gate for the journal
 * engine. Company-scoped; closing is audited and irreversible via API
 * (a CLOSED year is reopened only by direct DBA action, documented).
 */
@Injectable()
export class FiscalYearService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async create(companyId: string, input: CreateFiscalYearInput, actor: { id: string; username: string }) {
    const start = new Date(input.startDate);
    const end = new Date(input.endDate);
    if (!(start < end)) throw new ValidationError('INVALID_FISCAL_RANGE', { start: input.startDate, end: input.endDate });
    if (await this.prisma.fiscalYear.findFirst({ where: { companyId, code: input.code } })) {
      throw new ConflictError('FISCAL_YEAR_EXISTS', { code: input.code });
    }
    return this.prisma.$transaction(async (tx) => {
      const year = await tx.fiscalYear.create({
        data: {
          companyId,
          code: input.code,
          nameFa: input.nameFa,
          startDate: start,
          endDate: end,
          status: 'OPEN',
        },
      });
      if (input.generateMonthlyPeriods !== false) {
        await this.generateMonthlyPeriods(tx, year.id, start, end);
      }
      await this.auditService.recordTx(tx, {
        entityType: 'fiscal_year',
        entityId: year.id,
        action: 'CREATE',
        companyId,
        actor,
        newValues: { code: year.code, start: input.startDate, end: input.endDate },
      });
      return this.getById(companyId, year.id);
    });
  }

  /** Twelve calendar-month periods from startDate (documented approximation). */
  private async generateMonthlyPeriods(tx: Tx, fiscalYearId: string, start: Date, end: Date) {
    const rows: Prisma.FiscalPeriodCreateManyInput[] = [];
    for (let m = 0; m < 12; m++) {
      const pStart = new Date(start);
      pStart.setUTCMonth(pStart.getUTCMonth() + m);
      const pEnd = new Date(start);
      pEnd.setUTCMonth(pEnd.getUTCMonth() + m + 1);
      pEnd.setUTCDate(pEnd.getUTCDate() - 1);
      rows.push({
        fiscalYearId,
        code: `${m + 1}`.padStart(2, '0'),
        nameFa: `ماه ${`${m + 1}`.padStart(2, '0')}`,
        startDate: pStart > end ? end : pStart,
        endDate: pEnd > end ? end : pEnd,
        status: 'OPEN',
      });
      if (pEnd >= end) break;
    }
    await tx.fiscalPeriod.createMany({ data: rows });
  }

  async list(companyId: string) {
    return this.prisma.fiscalYear.findMany({
      where: { companyId },
      orderBy: { code: 'desc' },
      include: { periods: { orderBy: { code: 'asc' } } },
    });
  }

  async getById(companyId: string, id: string) {
    const year = await this.prisma.fiscalYear.findFirst({
      where: { id, companyId },
      include: { periods: { orderBy: { code: 'asc' } } },
    });
    if (!year) throw new NotFoundError('Fiscal year not found', { id });
    return year;
  }

  /** Close a fiscal year: all periods close first, then the year. Audited. */
  async closeYear(companyId: string, id: string, actor: { id: string; username: string }) {
    return this.prisma.$transaction(async (tx) => {
      const year = await tx.fiscalYear.findFirst({ where: { id, companyId } });
      if (!year) throw new NotFoundError('Fiscal year not found', { id });
      if (year.status === 'CLOSED') throw new ConflictError('FISCAL_YEAR_ALREADY_CLOSED');
      await tx.fiscalPeriod.updateMany({ where: { fiscalYearId: id }, data: { status: 'CLOSED' } });
      const updated = await tx.fiscalYear.update({
        where: { id },
        data: { status: FiscalYearStatus.CLOSED },
      });
      await this.auditService.recordTx(tx, {
        entityType: 'fiscal_year',
        entityId: id,
        action: 'CLOSE',
        companyId,
        actor,
        oldValues: { status: year.status },
        newValues: { status: 'CLOSED' },
      });
      return updated;
    });
  }

  async setPeriodStatus(companyId: string, yearId: string, periodId: string, status: 'OPEN' | 'CLOSED', actor: { id: string; username: string }) {
    return this.prisma.$transaction(async (tx) => {
      const year = await tx.fiscalYear.findFirst({ where: { id: yearId, companyId } });
      if (!year) throw new NotFoundError('Fiscal year not found', { yearId });
      if (year.status === 'CLOSED') {
        throw new ForbiddenError('FISCAL_YEAR_CLOSED', { fiscalYearCode: year.code });
      }
      const period = await tx.fiscalPeriod.findFirst({ where: { id: periodId, fiscalYearId: yearId } });
      if (!period) throw new NotFoundError('Fiscal period not found', { periodId });
      const updated = await tx.fiscalPeriod.update({ where: { id: periodId }, data: { status } });
      await this.auditService.recordTx(tx, {
        entityType: 'fiscal_period',
        entityId: periodId,
        action: status === 'CLOSED' ? 'CLOSE' : 'REOPEN',
        companyId,
        actor,
        oldValues: { status: period.status },
        newValues: { status },
      });
      return updated;
    });
  }
}
