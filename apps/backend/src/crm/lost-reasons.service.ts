import { Injectable } from '@nestjs/common';
import { LostReason, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit.dto';
import { ConflictError, NotFoundError } from '../common/errors';
import { RequestContext } from '../auth/auth.service';
import { Paginated } from '../common/dto/pagination.dto';
import { CreateLostReasonDto, LostReasonQueryDto, UpdateLostReasonDto } from './crm.dto';

/**
 * Configurable lost reasons (REQUIREMENTS §10) — never hard-coded strings.
 * Six Persian defaults are seeded per company; every row is reportable.
 */
@Injectable()
export class LostReasonsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async create(
    companyId: string,
    dto: CreateLostReasonDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<LostReason> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const reason = await tx.lostReason.create({
          data: {
            companyId,
            code: dto.code,
            nameFa: dto.nameFa,
            nameEn: dto.nameEn,
            sortOrder: dto.sortOrder ?? 0,
            active: dto.active ?? true,
          },
        });
        await this.auditService.recordTx(tx, {
          entityType: 'lost_reason',
          entityId: reason.id,
          action: AuditAction.CREATE,
          companyId,
          actor,
          newValues: { code: reason.code, nameFa: reason.nameFa },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return reason;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictError('LOST_REASON_CODE_EXISTS', { code: dto.code });
      }
      throw error;
    }
  }

  async update(
    companyId: string,
    id: string,
    dto: UpdateLostReasonDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<LostReason> {
    const existing = await this.prisma.lostReason.findFirst({ where: { id, companyId } });
    if (!existing) throw new NotFoundError('Lost reason not found', { id });
    return this.prisma.$transaction(async (tx) => {
      const reason = await tx.lostReason.update({
        where: { id: existing.id },
        data: {
          nameFa: dto.nameFa,
          nameEn: dto.nameEn,
          sortOrder: dto.sortOrder,
          active: dto.active,
        },
      });
      await this.auditService.recordTx(tx, {
        entityType: 'lost_reason',
        entityId: reason.id,
        action: AuditAction.UPDATE,
        companyId,
        actor,
        oldValues: { nameFa: existing.nameFa, active: existing.active },
        newValues: { nameFa: reason.nameFa, active: reason.active },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return reason;
    });
  }

  async getById(companyId: string, id: string): Promise<LostReason> {
    const reason = await this.prisma.lostReason.findFirst({ where: { id, companyId } });
    if (!reason) throw new NotFoundError('Lost reason not found', { id });
    return reason;
  }

  async list(companyId: string, query: LostReasonQueryDto): Promise<Paginated<LostReason>> {
    const where: Prisma.LostReasonWhereInput = {
      companyId,
      ...(query.active === true ? { active: true } : query.active === false ? { active: false } : {}),
      ...(query.search ? { OR: [{ nameFa: { contains: query.search } }, { code: { contains: query.search } }] } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.lostReason.findMany({
        where,
        orderBy: [{ sortOrder: 'asc' }, { nameFa: 'asc' }],
        skip: query.skip,
        take: query.take,
      }),
      this.prisma.lostReason.count({ where }),
    ]);
    return { items, total, page: query.page, pageSize: query.pageSize };
  }
}
