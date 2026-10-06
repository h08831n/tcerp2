import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit.dto';
import { RequestContext } from '../auth/auth.service';
import { ConflictError, NotFoundError, ValidationError } from '../common/errors';
import { assertSameCompany } from '../common/utils/entity-company';
import { Paginated } from '../common/dto/pagination.dto';
import {
  CategoryQueryDto,
  CreateCategoryDto,
  UpdateCategoryDto,
} from './products.dto';

type Client = PrismaService | Prisma.TransactionClient;

/**
 * p3b-02 — pure cycle check: would moving `categoryId` under `newParentId`
 * create a cycle? Walk the ancestor chain of `newParentId`; if the category
 * itself (or, transitively, one of its descendants) is on that chain the
 * answer is yes. Pure so it is unit-testable without a DB.
 */
export function wouldCreateCycle(
  parentIdOf: (id: string) => string | null | undefined,
  categoryId: string,
  newParentId: string,
): boolean {
  let cursor: string | null | undefined = newParentId;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    if (cursor === categoryId) return true;
    seen.add(cursor);
    cursor = parentIdOf(cursor);
  }
  return false;
}

@Injectable()
export class CategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private static wrapUnique(error: unknown): never {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      throw new ConflictError('Category code already exists in this company');
    }
    throw error as Error;
  }

  async create(
    companyId: string,
    dto: CreateCategoryDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    if (dto.parentId) {
      const parent = await this.prisma.productCategory.findUnique({
        where: { id: dto.parentId },
        select: { id: true, companyId: true, active: true },
      });
      // 3B correction #5 — Category.parent must be same-company.
      assertSameCompany(companyId, parent, 'Parent category not found in this company');
    }
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const row = await tx.productCategory.create({
          data: {
            companyId,
            code: dto.code,
            nameFa: dto.nameFa,
            nameEn: dto.nameEn,
            parentId: dto.parentId,
            description: dto.description,
            sortOrder: dto.sortOrder ?? 0,
            active: dto.active ?? true,
          },
        });
        await this.audit.recordTx(tx, {
          entityType: 'product_category',
          entityId: row.id,
          action: AuditAction.CREATE,
          companyId,
          actor,
          newValues: { code: row.code, nameFa: row.nameFa, parentId: row.parentId },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return row;
      });
      return created;
    } catch (error) {
      CategoriesService.wrapUnique(error);
    }
  }

  async list(companyId: string, query: CategoryQueryDto): Promise<Paginated<unknown>> {
    const active =
      query.active === 'any'
        ? undefined
        : query.active === 'false'
          ? false
          : true;
    const where: Prisma.ProductCategoryWhereInput = {
      companyId,
      ...(active !== undefined ? { active } : {}),
      ...(query.parentId ? { parentId: query.parentId } : {}),
      ...(query.search
        ? {
            OR: [
              { nameFa: { contains: query.search.trim(), mode: 'insensitive' as const } },
              { nameEn: { contains: query.search.trim(), mode: 'insensitive' as const } },
              { code: { contains: query.search.trim(), mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.productCategory.findMany({
        where,
        select: {
          id: true,
          parentId: true,
          code: true,
          nameFa: true,
          nameEn: true,
          description: true,
          active: true,
          sortOrder: true,
          version: true,
          createdAt: true,
          updatedAt: true,
          parent: { select: { id: true, nameFa: true, code: true } },
          _count: { select: { children: true, templates: true } },
        },
        orderBy: [{ sortOrder: 'asc' }, { nameFa: 'asc' }],
        skip: query.skip,
        take: query.take,
      }),
      this.prisma.productCategory.count({ where }),
    ]);
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  async getById(companyId: string, id: string) {
    const row = await this.prisma.productCategory.findUnique({
      where: { id },
      include: {
        parent: { select: { id: true, nameFa: true, code: true } },
        children: {
          where: { active: true },
          select: { id: true, nameFa: true, nameEn: true, code: true, sortOrder: true },
          orderBy: [{ sortOrder: 'asc' }, { nameFa: 'asc' }],
        },
        _count: { select: { templates: true } },
      },
    });
    if (!row || row.companyId !== companyId) {
      throw new NotFoundError('Category not found', { id });
    }
    return row;
  }

  async update(
    companyId: string,
    id: string,
    dto: UpdateCategoryDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    const existing = await this.prisma.productCategory.findUnique({ where: { id } });
    if (!existing || existing.companyId !== companyId) {
      throw new NotFoundError('Category not found', { id });
    }

    if (dto.parentId !== undefined && dto.parentId !== null) {
      if (dto.parentId === id) {
        throw new ValidationError('CATEGORY_CYCLE', { parentId: dto.parentId });
      }
      const parent = await this.prisma.productCategory.findUnique({
        where: { id: dto.parentId },
        select: { id: true, companyId: true },
      });
      // 3B correction #5 — Category.parent must be same-company.
      assertSameCompany(companyId, parent, 'Parent category not found in this company');
      // Walk the ancestor chain of the new parent; if we reach the category
      // itself it is one of its own descendants → CATEGORY_CYCLE.
      const ancestors = await this.prisma.productCategory.findMany({
        where: { companyId },
        select: { id: true, parentId: true },
      });
      const parentIdOf = new Map(ancestors.map((a) => [a.id, a.parentId]));
      if (wouldCreateCycle((k) => parentIdOf.get(k), id, dto.parentId)) {
        throw new ValidationError('CATEGORY_CYCLE', { parentId: dto.parentId });
      }
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const updated = await tx.productCategory.update({
          where: { id },
          data: {
            ...(dto.parentId !== undefined ? { parentId: dto.parentId } : {}),
            ...(dto.nameFa !== undefined ? { nameFa: dto.nameFa } : {}),
            ...(dto.nameEn !== undefined ? { nameEn: dto.nameEn } : {}),
            ...(dto.description !== undefined ? { description: dto.description } : {}),
            ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
            ...(dto.active !== undefined ? { active: dto.active } : {}),
          },
        });
        await this.audit.recordTx(tx, {
          entityType: 'product_category',
          entityId: id,
          action: AuditAction.UPDATE,
          companyId,
          actor,
          oldValues: {
            parentId: existing.parentId,
            nameFa: existing.nameFa,
            active: existing.active,
          },
          newValues: {
            parentId: updated.parentId,
            nameFa: updated.nameFa,
            active: updated.active,
          },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return updated;
      });
    } catch (error) {
      CategoriesService.wrapUnique(error);
    }
  }

  /**
   * Hard delete, blocked while the category has children or templates
   * (archive via PATCH active:false instead).
   */
  async remove(
    companyId: string,
    id: string,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    const existing = await this.prisma.productCategory.findUnique({
      where: { id },
      include: { _count: { select: { children: true, templates: true, supplierMappings: true } } },
    });
    if (!existing || existing.companyId !== companyId) {
      throw new NotFoundError('Category not found', { id });
    }
    if (existing._count.children > 0 || existing._count.templates > 0) {
      throw new ConflictError('Category has children or products; archive it instead', {
        children: existing._count.children,
        templates: existing._count.templates,
      });
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.productCategory.delete({ where: { id } });
      await this.audit.recordTx(tx, {
        entityType: 'product_category',
        entityId: id,
        action: AuditAction.DELETE,
        companyId,
        actor,
        oldValues: { code: existing.code, nameFa: existing.nameFa },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
    });
    return { id, deleted: true };
  }
}
