import { Injectable } from '@nestjs/common';
import { Loading, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit.dto';
import { NotFoundError, ValidationError } from '../common/errors';
import { RequestContext } from '../auth/auth.service';

export interface LoadingAllocationInput {
  salesLineId?: string | null;
  purchaseLineId?: string | null;
  allocatedQuantity: number;
}

export interface LoadingLineInput {
  productVariantId: string;
  actualQuantity: number;
  uomId?: string | null;
  notes?: string;
  allocations?: LoadingAllocationInput[];
}

export interface CreateLoadingInput {
  loadingDate: Date;
  driverPartyId?: string | null;
  carrierPartyId?: string | null;
  notes?: string;
  lines: LoadingLineInput[];
}

/**
 * Loading (bill of lading) — header + lines + allocations. Registered ONCE
 * and shown on both the sale and purchase sides via getById.
 * Each allocation requires exactly one target line (DB CHECK mirrors this).
 */
@Injectable()
export class LoadingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async create(
    companyId: string,
    input: CreateLoadingInput,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<Loading & { lines: unknown[] }> {
    if (!Array.isArray(input.lines) || input.lines.length === 0) {
      throw new ValidationError('A loading requires at least one line');
    }
    for (const line of input.lines) {
      if (!(Number(line.actualQuantity) > 0)) {
        throw new ValidationError('Loading line quantity must be positive');
      }
      for (const allocation of line.allocations ?? []) {
        if (!(Number(allocation.allocatedQuantity) > 0)) {
          throw new ValidationError('Allocation quantity must be positive');
        }
        if (!allocation.salesLineId && !allocation.purchaseLineId) {
          throw new ValidationError('Each allocation requires a sales or purchase line');
        }
        if (allocation.salesLineId && allocation.purchaseLineId) {
          throw new ValidationError('An allocation may reference only one of sales/purchase line');
        }
      }
    }

    const loading = await this.prisma.$transaction(async (trx) =>
      trx.loading.create({
        data: {
          companyId,
          loadingDate: input.loadingDate,
          driverPartyId: input.driverPartyId ?? null,
          carrierPartyId: input.carrierPartyId ?? null,
          notes: input.notes,
          createdBy: actor.id,
          lines: {
            create: input.lines.map((line) => ({
              productVariantId: line.productVariantId,
              actualQuantity: line.actualQuantity,
              uomId: line.uomId ?? null,
              notes: line.notes,
              allocations: {
                create: (line.allocations ?? []).map((allocation) => ({
                  salesLineId: allocation.salesLineId ?? null,
                  purchaseLineId: allocation.purchaseLineId ?? null,
                  allocatedQuantity: allocation.allocatedQuantity,
                })),
              },
            })),
          },
        },
        include: { lines: { include: { allocations: true } } },
      }),
    );

    await this.auditService.record({
      entityType: 'loading',
      entityId: loading.id,
      action: AuditAction.CREATE,
      actor,
      companyId,
      newValues: { loadingDate: loading.loadingDate, lineCount: input.lines.length },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return loading as Loading & { lines: unknown[] };
  }

  /** Full view (lines + allocations) — shared by sale & purchase sides. */
  async getById(companyId: string, id: string) {
    const loading = await this.prisma.loading.findUnique({
      where: { id },
      include: { lines: { include: { allocations: true } } },
    });
    if (!loading || loading.companyId !== companyId) {
      throw new NotFoundError('Loading not found', { id });
    }
    return loading;
  }

  async list(companyId: string, from?: Date, to?: Date) {
    return this.prisma.loading.findMany({
      where: { companyId, loadingDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } },
      orderBy: { loadingDate: 'desc' },
      include: { lines: { select: { id: true } } },
    });
  }
}
