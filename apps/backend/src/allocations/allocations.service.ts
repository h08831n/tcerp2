import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit.dto';
import { ConflictError, NotFoundError, ValidationError } from '../common/errors';
import { D, roundQuantity } from '../common/utils/money';
import { RequestContext } from '../auth/auth.service';
import { Paginated } from '../common/dto/pagination.dto';
import { AllocationQueryDto, CreateAllocationDto, UpdateAllocationDto } from './allocations.dto';

/**
 * Line-level M:N supply allocation (REQUIREMENTS §12): one sale may be
 * supplied by several purchases and vice versa (20/30 tons of a 50-ton
 * purchase line). Concurrency-safe: create/update run in a SERIALIZABLE
 * transaction and take `SELECT … FOR UPDATE` row locks on BOTH lines
 * (consistent order: sales line first, then purchase line), so two parallel
 * allocations that would over-allocate can never both commit (p4-16).
 */

export const ALLOCATION_MESSAGES = {
  variantMismatch: 'ALLOCATION_VARIANT_MISMATCH',
  exceedsQuantity: 'ALLOCATION_EXCEEDS_QUANTITY',
  duplicate: 'ALLOCATION_DUPLICATE',
  notPositive: 'ALLOCATION_QUANTITY_POSITIVE',
} as const;

@Injectable()
export class AllocationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Lock both lines (ordered by id to avoid deadlocks) and return them.
   * Must be called inside the serializable transaction.
   */
  private async lockBothLines(
    tx: Prisma.TransactionClient,
    salesLineId: string,
    purchaseLineId: string,
  ): Promise<{ salesLine: { id: string; companyId: string; productVariantId: string; orderedQuantity: Prisma.Decimal }; purchaseLine: { id: string; companyId: string; productVariantId: string; orderedQuantity: Prisma.Decimal } }> {
    // Consistent global lock order (by id) prevents deadlocks between
    // concurrent allocation pairs.
    const salesFirst = salesLineId <= purchaseLineId;
    const salesLock = tx.$queryRaw`SELECT id FROM sales_lines WHERE id = ${salesLineId}::uuid FOR UPDATE`;
    const purchaseLock = tx.$queryRaw`SELECT id FROM purchase_lines WHERE id = ${purchaseLineId}::uuid FOR UPDATE`;
    await (salesFirst ? salesLock : purchaseLock);
    await (salesFirst ? purchaseLock : salesLock);

    const salesLine = await tx.salesLine.findUnique({
      where: { id: salesLineId },
      select: { id: true, companyId: true, productVariantId: true, orderedQuantity: true },
    });
    const purchaseLine = await tx.purchaseLine.findUnique({
      where: { id: purchaseLineId },
      select: { id: true, companyId: true, productVariantId: true, orderedQuantity: true },
    });
    if (!salesLine) throw new NotFoundError('Sales line not found', { salesLineId });
    if (!purchaseLine) throw new NotFoundError('Purchase line not found', { purchaseLineId });
    return { salesLine, purchaseLine };
  }

  /** sum(existing allocations) + new ≤ orderedQuantity for BOTH lines. */
  private async assertNoOverAllocation(
    tx: Prisma.TransactionClient,
    salesLineId: string,
    purchaseLineId: string,
    salesOrdered: Prisma.Decimal,
    purchaseOrdered: Prisma.Decimal,
    newQuantity: Prisma.Decimal,
    excludeAllocationId?: string,
  ): Promise<void> {
    const salesSum = await tx.salesPurchaseAllocation.aggregate({
      where: { salesLineId, ...(excludeAllocationId ? { id: { not: excludeAllocationId } } : {}) },
      _sum: { allocatedQuantity: true },
    });
    const purchaseSum = await tx.salesPurchaseAllocation.aggregate({
      where: { purchaseLineId, ...(excludeAllocationId ? { id: { not: excludeAllocationId } } : {}) },
      _sum: { allocatedQuantity: true },
    });

    const salesAllocated = D(salesSum._sum.allocatedQuantity).plus(newQuantity);
    const purchaseAllocated = D(purchaseSum._sum.allocatedQuantity).plus(newQuantity);

    if (salesAllocated.gt(salesOrdered) || purchaseAllocated.gt(purchaseOrdered)) {
      throw new ConflictError(ALLOCATION_MESSAGES.exceedsQuantity, {
        salesLineId,
        purchaseLineId,
        salesOrdered: salesOrdered.toString(),
        salesAllocated: salesAllocated.toString(),
        purchaseOrdered: purchaseOrdered.toString(),
        purchaseAllocated: purchaseAllocated.toString(),
      });
    }
  }

  async create(
    companyId: string,
    dto: CreateAllocationDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    const quantity = roundQuantity(D(dto.allocatedQuantity));
    if (quantity.lte(0)) throw new ValidationError(ALLOCATION_MESSAGES.notPositive);

    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const { salesLine, purchaseLine } = await this.lockBothLines(tx, dto.salesLineId, dto.purchaseLineId);

          if (salesLine.companyId !== companyId || purchaseLine.companyId !== companyId) {
            throw new NotFoundError('Allocation lines not found', { salesLineId: dto.salesLineId });
          }
          if (salesLine.productVariantId !== purchaseLine.productVariantId) {
            throw new ValidationError(ALLOCATION_MESSAGES.variantMismatch, {
              salesVariantId: salesLine.productVariantId,
              purchaseVariantId: purchaseLine.productVariantId,
            });
          }
          await this.assertNoOverAllocation(
            tx,
            salesLine.id,
            purchaseLine.id,
            salesLine.orderedQuantity,
            purchaseLine.orderedQuantity,
            quantity,
          );

          const allocation = await tx.salesPurchaseAllocation.create({
            data: {
              companyId,
              salesLineId: salesLine.id,
              purchaseLineId: purchaseLine.id,
              allocatedQuantity: quantity,
              createdBy: actor.id,
            },
          });
          await this.auditService.recordTx(tx, {
            entityType: 'sales_purchase_allocation',
            entityId: allocation.id,
            action: AuditAction.CREATE,
            companyId,
            actor,
            newValues: {
              salesLineId: allocation.salesLineId,
              purchaseLineId: allocation.purchaseLineId,
              allocatedQuantity: allocation.allocatedQuantity,
            },
            ip: ctx.ip,
            userAgent: ctx.userAgent,
          });
          return allocation;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictError(ALLOCATION_MESSAGES.duplicate, {
          salesLineId: dto.salesLineId,
          purchaseLineId: dto.purchaseLineId,
        });
      }
      throw error;
    }
  }

  async update(
    companyId: string,
    id: string,
    dto: UpdateAllocationDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    const quantity = roundQuantity(D(dto.allocatedQuantity));
    if (quantity.lte(0)) throw new ValidationError(ALLOCATION_MESSAGES.notPositive);

    return this.prisma.$transaction(
      async (tx) => {
        const existing = await tx.salesPurchaseAllocation.findFirst({ where: { id, companyId } });
        if (!existing) throw new NotFoundError('Allocation not found', { id });

        const { salesLine, purchaseLine } = await this.lockBothLines(tx, existing.salesLineId, existing.purchaseLineId);
        await this.assertNoOverAllocation(
          tx,
          salesLine.id,
          purchaseLine.id,
          salesLine.orderedQuantity,
          purchaseLine.orderedQuantity,
          quantity,
          existing.id,
        );

        const allocation = await tx.salesPurchaseAllocation.update({
          where: { id: existing.id },
          data: { allocatedQuantity: quantity },
        });
        await this.auditService.recordTx(tx, {
          entityType: 'sales_purchase_allocation',
          entityId: allocation.id,
          action: AuditAction.UPDATE,
          companyId,
          actor,
          oldValues: { allocatedQuantity: existing.allocatedQuantity },
          newValues: { allocatedQuantity: allocation.allocatedQuantity },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return allocation;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  async delete(
    companyId: string,
    id: string,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.salesPurchaseAllocation.findFirst({ where: { id, companyId } });
      if (!existing) throw new NotFoundError('Allocation not found', { id });
      await tx.salesPurchaseAllocation.delete({ where: { id: existing.id } });
      await this.auditService.recordTx(tx, {
        entityType: 'sales_purchase_allocation',
        entityId: id,
        action: AuditAction.DELETE,
        companyId,
        actor,
        oldValues: {
          salesLineId: existing.salesLineId,
          purchaseLineId: existing.purchaseLineId,
          allocatedQuantity: existing.allocatedQuantity,
        },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
    });
  }

  /** List allocations by sales/purchase document (join through the lines). */
  async list(companyId: string, query: AllocationQueryDto): Promise<Paginated<unknown>> {
    if (!query.salesDocumentId && !query.purchaseDocumentId && !query.salesLineId && !query.purchaseLineId) {
      throw new ValidationError('ALLOCATION_FILTER_REQUIRED', {
        oneOf: ['salesDocumentId', 'purchaseDocumentId', 'salesLineId', 'purchaseLineId'],
      });
    }

    const where: Prisma.SalesPurchaseAllocationWhereInput = {
      companyId,
      ...(query.salesLineId ? { salesLineId: query.salesLineId } : {}),
      ...(query.purchaseLineId ? { purchaseLineId: query.purchaseLineId } : {}),
      ...(query.salesDocumentId ? { salesLine: { salesDocumentId: query.salesDocumentId } } : {}),
      ...(query.purchaseDocumentId ? { purchaseLine: { purchaseDocumentId: query.purchaseDocumentId } } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.salesPurchaseAllocation.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.take,
        include: {
          salesLine: {
            select: {
              id: true,
              salesDocumentId: true,
              orderedQuantity: true,
              document: { select: { id: true, documentNumber: true, status: true } },
              productVariant: { select: { id: true, sku: true, nameFa: true } },
            },
          },
          purchaseLine: {
            select: {
              id: true,
              purchaseDocumentId: true,
              orderedQuantity: true,
              document: { select: { id: true, documentNumber: true, status: true } },
              productVariant: { select: { id: true, sku: true, nameFa: true } },
            },
          },
        },
      }),
      this.prisma.salesPurchaseAllocation.count({ where }),
    ]);

    return {
      items: rows.map((a) => ({
        id: a.id,
        allocatedQuantity: a.allocatedQuantity,
        createdAt: a.createdAt,
        sales: {
          lineId: a.salesLine.id,
          documentId: a.salesLine.salesDocumentId,
          documentNumber: a.salesLine.document.documentNumber,
          orderedQuantity: a.salesLine.orderedQuantity,
          variant: a.salesLine.productVariant,
        },
        purchase: {
          lineId: a.purchaseLine.id,
          documentId: a.purchaseLine.purchaseDocumentId,
          documentNumber: a.purchaseLine.document.documentNumber,
          orderedQuantity: a.purchaseLine.orderedQuantity,
          variant: a.purchaseLine.productVariant,
        },
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }
}
