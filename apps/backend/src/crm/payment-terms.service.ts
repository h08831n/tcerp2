import { Injectable } from '@nestjs/common';
import { PaymentTerm, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit.dto';
import { ConflictError, NotFoundError } from '../common/errors';
import { RequestContext } from '../auth/auth.service';
import { Paginated } from '../common/dto/pagination.dto';
import { CreatePaymentTermDto, PaymentTermQueryDto, UpdatePaymentTermDto } from './crm.dto';

/**
 * Configurable payment terms (REQUIREMENTS §9 field list). Reads are open to
 * `crm.view` holders (salespeople need them on quotation forms); writes are
 * `paymentterm.manage`. Four Persian defaults are seeded per company.
 */
@Injectable()
export class PaymentTermsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async create(
    companyId: string,
    dto: CreatePaymentTermDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<PaymentTerm> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const term = await tx.paymentTerm.create({
          data: {
            companyId,
            code: dto.code,
            nameFa: dto.nameFa,
            nameEn: dto.nameEn,
            description: dto.description,
            daysOffset: dto.daysOffset,
            active: dto.active ?? true,
          },
        });
        await this.auditService.recordTx(tx, {
          entityType: 'payment_term',
          entityId: term.id,
          action: AuditAction.CREATE,
          companyId,
          actor,
          newValues: { code: term.code, nameFa: term.nameFa, daysOffset: term.daysOffset },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return term;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictError('PAYMENT_TERM_CODE_EXISTS', { code: dto.code });
      }
      throw error;
    }
  }

  async update(
    companyId: string,
    id: string,
    dto: UpdatePaymentTermDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<PaymentTerm> {
    const existing = await this.prisma.paymentTerm.findFirst({ where: { id, companyId } });
    if (!existing) throw new NotFoundError('Payment term not found', { id });
    return this.prisma.$transaction(async (tx) => {
      const term = await tx.paymentTerm.update({
        where: { id: existing.id },
        data: {
          nameFa: dto.nameFa,
          nameEn: dto.nameEn,
          description: dto.description,
          daysOffset: dto.daysOffset,
          active: dto.active,
        },
      });
      await this.auditService.recordTx(tx, {
        entityType: 'payment_term',
        entityId: term.id,
        action: AuditAction.UPDATE,
        companyId,
        actor,
        oldValues: { nameFa: existing.nameFa, daysOffset: existing.daysOffset, active: existing.active },
        newValues: { nameFa: term.nameFa, daysOffset: term.daysOffset, active: term.active },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return term;
    });
  }

  async getById(companyId: string, id: string): Promise<PaymentTerm> {
    const term = await this.prisma.paymentTerm.findFirst({ where: { id, companyId } });
    if (!term) throw new NotFoundError('Payment term not found', { id });
    return term;
  }

  async list(companyId: string, query: PaymentTermQueryDto): Promise<Paginated<PaymentTerm>> {
    const where: Prisma.PaymentTermWhereInput = {
      companyId,
      ...(query.active === true ? { active: true } : query.active === false ? { active: false } : {}),
      ...(query.search ? { OR: [{ nameFa: { contains: query.search } }, { code: { contains: query.search } }] } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.paymentTerm.findMany({
        where,
        orderBy: { code: 'asc' },
        skip: query.skip,
        take: query.take,
      }),
      this.prisma.paymentTerm.count({ where }),
    ]);
    return { items, total, page: query.page, pageSize: query.pageSize };
  }
}
