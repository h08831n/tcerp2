import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit.dto';
import { RequestContext } from '../auth/auth.service';
import { ConflictError, NotFoundError, ValidationError } from '../common/errors';
import { Paginated } from '../common/dto/pagination.dto';
import {
  CreateAttributeDto,
  CreateAttributeValueDto,
  UpdateAttributeDto,
  UpdateAttributeValueDto,
} from './products.dto';

/**
 * Dynamic product attributes (REQUIREMENTS §5): attributes and their values
 * are plain rows — nothing hard-coded. p3b-05.
 */
@Injectable()
export class AttributesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private static wrapUnique(error: unknown, perAttribute: boolean): never {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      throw new ConflictError(
        perAttribute
          ? 'Value code already exists for this attribute'
          : 'Attribute code already exists in this company',
      );
    }
    throw error as Error;
  }

  // ───────────────────────── attributes ─────────────────────────

  async createAttribute(
    companyId: string,
    dto: CreateAttributeDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const row = await tx.attribute.create({
          data: {
            companyId,
            code: dto.code,
            nameFa: dto.nameFa,
            nameEn: dto.nameEn,
            displayOrder: dto.displayOrder ?? 0,
            active: dto.active ?? true,
          },
        });
        await this.audit.recordTx(tx, {
          entityType: 'attribute',
          entityId: row.id,
          action: AuditAction.CREATE,
          companyId,
          actor,
          newValues: { code: row.code, nameFa: row.nameFa },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return row;
      });
    } catch (error) {
      AttributesService.wrapUnique(error, false);
    }
  }

  async listAttributes(
    companyId: string,
    filters: { active?: boolean },
  ): Promise<Paginated<unknown>> {
    const where: Prisma.AttributeWhereInput = {
      companyId,
      ...(filters.active !== undefined ? { active: filters.active } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.attribute.findMany({
        where,
        select: {
          id: true,
          code: true,
          nameFa: true,
          nameEn: true,
          displayOrder: true,
          active: true,
          values: {
            where: { active: true },
            orderBy: [{ displayOrder: 'asc' }, { valueFa: 'asc' }],
          },
        },
        orderBy: [{ displayOrder: 'asc' }, { nameFa: 'asc' }],
      }),
      this.prisma.attribute.count({ where }),
    ]);
    return { items, total, page: 1, pageSize: Math.max(total, 1) };
  }

  async updateAttribute(
    companyId: string,
    id: string,
    dto: UpdateAttributeDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    const existing = await this.prisma.attribute.findUnique({ where: { id } });
    if (!existing || existing.companyId !== companyId) {
      throw new NotFoundError('Attribute not found', { id });
    }
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.attribute.update({
        where: { id },
        data: {
          ...(dto.nameFa !== undefined ? { nameFa: dto.nameFa } : {}),
          ...(dto.nameEn !== undefined ? { nameEn: dto.nameEn } : {}),
          ...(dto.displayOrder !== undefined ? { displayOrder: dto.displayOrder } : {}),
          ...(dto.active !== undefined ? { active: dto.active } : {}),
        },
      });
      await this.audit.recordTx(tx, {
        entityType: 'attribute',
        entityId: id,
        action: AuditAction.UPDATE,
        companyId,
        actor,
        oldValues: { nameFa: existing.nameFa, active: existing.active },
        newValues: { nameFa: updated.nameFa, active: updated.active },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return updated;
    });
  }

  // ───────────────────────── attribute values ─────────────────────────

  private async assertAttribute(companyId: string, attributeId: string) {
    const attribute = await this.prisma.attribute.findUnique({
      where: { id: attributeId },
      select: { id: true, companyId: true },
    });
    if (!attribute || attribute.companyId !== companyId) {
      throw new ValidationError('Attribute not found in this company', { attributeId });
    }
    return attribute;
  }

  async createValue(
    companyId: string,
    attributeId: string,
    dto: CreateAttributeValueDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    await this.assertAttribute(companyId, attributeId);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const row = await tx.attributeValue.create({
          data: {
            attributeId,
            code: dto.code,
            valueFa: dto.valueFa,
            valueEn: dto.valueEn,
            numericValue:
              dto.numericValue !== undefined ? new Prisma.Decimal(dto.numericValue) : undefined,
            displayOrder: dto.displayOrder ?? 0,
            active: dto.active ?? true,
          },
        });
        await this.audit.recordTx(tx, {
          entityType: 'attribute_value',
          entityId: row.id,
          action: AuditAction.CREATE,
          companyId,
          actor,
          newValues: { attributeId, code: row.code, valueFa: row.valueFa },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return row;
      });
    } catch (error) {
      AttributesService.wrapUnique(error, true);
    }
  }

  async listValues(companyId: string, attributeId: string) {
    await this.assertAttribute(companyId, attributeId);
    return this.prisma.attributeValue.findMany({
      where: { attributeId },
      orderBy: [{ displayOrder: 'asc' }, { valueFa: 'asc' }],
    });
  }

  async updateValue(
    companyId: string,
    valueId: string,
    dto: UpdateAttributeValueDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    const existing = await this.prisma.attributeValue.findUnique({
      where: { id: valueId },
      include: { attribute: { select: { companyId: true } } },
    });
    if (!existing || existing.attribute.companyId !== companyId) {
      throw new NotFoundError('Attribute value not found', { valueId });
    }
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.attributeValue.update({
        where: { id: valueId },
        data: {
          ...(dto.valueFa !== undefined ? { valueFa: dto.valueFa } : {}),
          ...(dto.valueEn !== undefined ? { valueEn: dto.valueEn } : {}),
          ...(dto.numericValue !== undefined
            ? { numericValue: new Prisma.Decimal(dto.numericValue) }
            : {}),
          ...(dto.displayOrder !== undefined ? { displayOrder: dto.displayOrder } : {}),
          ...(dto.active !== undefined ? { active: dto.active } : {}),
        },
      });
      await this.audit.recordTx(tx, {
        entityType: 'attribute_value',
        entityId: valueId,
        action: AuditAction.UPDATE,
        companyId,
        actor,
        oldValues: { valueFa: existing.valueFa, active: existing.active },
        newValues: { valueFa: updated.valueFa, active: updated.active },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return updated;
    });
  }
}
