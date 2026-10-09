import { Injectable } from '@nestjs/common';
import { LoadingStatus, PartyRoleType, Prisma, PurchaseDocumentStatus, SalesDocumentStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit.dto';
import { TimelineService } from '../parties/timeline.service';
import { DocumentRelationService } from '../document-flow/document-relation.service';
import { InventoryService } from '../inventory/inventory.service';
import { ApprovalRequestService } from '../approvals/approvals.service';
import { assertPartyHasRole } from '../common/utils/party-roles';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../common/errors';
import { D, roundQuantity } from '../common/utils/money';
import { insertStockMovementIfAbsent } from '../common/utils/stock-movement';
import { RequestContext } from '../auth/auth.service';
import { Paginated } from '../common/dto/pagination.dto';
import {
  CreateLoadingDto,
  LoadingQueryDto,
  ReleaseDriverInfoDto,
  UpdateLoadingDto,
} from './loading.dto';

type Client = Prisma.TransactionClient;

export const LOADING_MESSAGES = {
  notADriver: 'NOT_A_DRIVER',
  notACarrier: 'NOT_A_CARRIER',
  notACustomer: 'NOT_A_CUSTOMER',
  variantMismatch: 'ALLOCATION_VARIANT_MISMATCH',
  exceedsQuantity: 'ALLOCATION_EXCEEDS_QUANTITY',
  allocationPositive: 'ALLOCATION_QUANTITY_POSITIVE',
  allocationTargetRequired: 'ALLOCATION_TARGET_REQUIRED',
  allocationSingleTarget: 'ALLOCATION_SINGLE_TARGET',
  lineQuantityPositive: 'LOADING_LINE_QUANTITY_POSITIVE',
  linesRequired: 'LOADING_LINES_REQUIRED',
  uomRequired: 'UOM_REQUIRED',
  uomNotInCompany: 'UOM_NOT_IN_COMPANY',
  confirmed: 'LOADING_CONFIRMED',
  notDraft: 'LOADING_NOT_DRAFT',
  invalidTransition: 'INVALID_STATUS_TRANSITION',
  versionConflict: 'VERSION_CONFLICT',
  notRestricted: 'LOADING_NOT_RESTRICTED',
  noPendingApproval: 'NO_PENDING_APPROVAL',
} as const;

export interface LoadingAllocationInput {
  salesLineId?: string | null;
  purchaseLineId?: string | null;
  allocatedQuantity: number | string | Prisma.Decimal;
}

export interface LoadingLineInput {
  productVariantId: string;
  actualQuantity: number | string | Prisma.Decimal;
  uomId?: string | null;
  notes?: string | null;
  allocations?: LoadingAllocationInput[];
}

export interface CreateLoadingInput {
  loadingDate: Date;
  warehouseId?: string | null;
  customerPartyId?: string | null;
  driverPartyId?: string | null;
  carrierPartyId?: string | null;
  notes?: string | null;
  lines: LoadingLineInput[];
}

/** Caller capability for the driver-info visibility rule (REQUIREMENTS §20). */
export interface LoadingViewer {
  canViewDriverInfo: boolean;
}

interface AllocationLineRow {
  id: string;
  productVariantId: string;
  orderedQuantity: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
  documentId: string;
}

/**
 * Loading (bill of lading) — the SINGLE operational event of Phase 6 (domain
 * boundaries §2): registered ONCE (header + lines + allocations) and shown on
 * both the sale and the purchase side. Lifecycle DRAFT → CONFIRMED (+DRAFT →
 * CANCELLED).
 *
 * confirm() is ONE serializable transaction that:
 *   (a) re-validates every allocation with FOR UPDATE row locks (same
 *       consistent-id-order locking pattern as the sales↔purchase allocations;
 *       loading allocations consume ordered quantity on BOTH line kinds);
 *   (b) generates one OUT StockMovement per loading line (idempotencyKey
 *       `loading:{loadingId}:line:{lineId}` — P2002 means "already moved",
 *       never a duplicate);
 *   (c) updates `operationalLoadedAmount` on every allocated sales/purchase
 *       document (Decimal math: Σ allocatedQuantity × line.unitPrice) and
 *       recomputes the document status → PARTIALLY_LOADED / COMPLETED (only
 *       from SALES_ORDER/ORDER_PLACED+ — a document still earlier in its own
 *       lifecycle keeps its status, amounts still move);
 *   (d) applies the DEBT GATE (REQUIREMENTS §20): a customer whose
 *       PartyOperationalBalance.balance > 0 gets a PENDING ApprovalRequest
 *       (RELEASE_DRIVER_INFO) and driverInfoRestricted = true — the debt
 *       never BLOCKS the loading, it only hides driver/carrier details;
 *   (e) writes loading ↔ sales_document RELATED DocumentRelations and the
 *       audit + party timeline rows — all atomic (audit failure rolls the
 *       whole confirmation back, p6-13).
 *
 * Driver-info visibility (p6-08): responses strip driver/carrier details
 * while driverInfoRestricted = true UNLESS the caller holds
 * `loading.driver_info.release` OR `approvals.decide`.
 */
@Injectable()
export class LoadingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly timeline: TimelineService,
    private readonly relations: DocumentRelationService,
    private readonly inventory: InventoryService,
    private readonly approvals: ApprovalRequestService,
  ) {}

  // ───────────────────────── create (DRAFT) ─────────────────────────

  async create(
    companyId: string,
    input: CreateLoadingInput,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    const lines = this.normalizeLineInputs(input.lines);

    const loading = await this.prisma.$transaction(
      async (tx) => {
        await this.assertHeaderParties(tx, companyId, input);
        await this.assertWarehouse(tx, companyId, input.warehouseId ?? null);
        await this.resolveLines(tx, companyId, lines);
        await this.validateAllocations(tx, companyId, lines, {});

        return tx.loading.create({
          data: {
            companyId,
            loadingDate: input.loadingDate,
            status: LoadingStatus.DRAFT,
            warehouseId: input.warehouseId ?? null,
            customerPartyId: input.customerPartyId ?? null,
            driverPartyId: input.driverPartyId ?? null,
            carrierPartyId: input.carrierPartyId ?? null,
            notes: input.notes ?? null,
            createdBy: actor.id,
            lines: {
              create: lines.map((line) => ({
                productVariantId: line.productVariantId,
                actualQuantity: roundQuantity(D(line.actualQuantity)),
                uomId: line.uomId ?? null,
                notes: line.notes ?? null,
                allocations: {
                  create: (line.allocations ?? []).map((allocation) => ({
                    companyId,
                    salesLineId: allocation.salesLineId ?? null,
                    purchaseLineId: allocation.purchaseLineId ?? null,
                    allocatedQuantity: roundQuantity(D(allocation.allocatedQuantity)),
                  })),
                },
              })),
            },
          },
          include: { lines: { include: { allocations: true } } },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    await this.auditService.record({
      entityType: 'loading',
      entityId: loading.id,
      action: AuditAction.CREATE,
      companyId,
      actor,
      newValues: { loadingDate: loading.loadingDate, lineCount: lines.length },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return loading;
  }

  // ───────────────────────── update (DRAFT only) ─────────────────────────

  /**
   * Full-header update; lines (when provided) are REPLACED wholesale. DRAFT
   * only — a confirmed loading is immutable. Optimistic concurrency without a
   * version column (schema frozen): the caller may pass `expectedUpdatedAt`;
   * a mismatch is a 409 VERSION_CONFLICT.
   */
  async update(
    companyId: string,
    id: string,
    input: UpdateLoadingDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    const existing = await this.prisma.loading.findFirst({ where: { id, companyId } });
    if (!existing) throw new NotFoundError('Loading not found', { id });
    if (existing.status !== LoadingStatus.DRAFT) {
      throw new ValidationError(LOADING_MESSAGES.notDraft, { status: existing.status });
    }
    if (
      input.expectedUpdatedAt &&
      new Date(input.expectedUpdatedAt).getTime() !== existing.updatedAt.getTime()
    ) {
      throw new ConflictError(LOADING_MESSAGES.versionConflict, { id });
    }

    const lines = input.lines ? this.normalizeLineInputs(input.lines) : null;

    const updated = await this.prisma.$transaction(
      async (tx) => {
        // Re-check under the transaction (serialize vs a concurrent confirm).
        const locked = await tx.loading.findFirst({ where: { id: existing.id }, select: { status: true } });
        if (!locked || locked.status !== LoadingStatus.DRAFT) {
          throw new ValidationError(LOADING_MESSAGES.notDraft, { status: locked?.status });
        }

        await this.assertHeaderParties(tx, companyId, input);
        if (input.warehouseId !== undefined) {
          await this.assertWarehouse(tx, companyId, input.warehouseId);
        }

        if (lines) {
          await this.resolveLines(tx, companyId, lines);
          await this.validateAllocations(tx, companyId, lines, {
            excludeLoadingId: existing.id,
          });
          await tx.loadingLine.deleteMany({ where: { loadingId: existing.id } });
        }

        return tx.loading.update({
          where: { id: existing.id },
          data: {
            loadingDate: input.loadingDate ? new Date(input.loadingDate) : undefined,
            ...(input.warehouseId === undefined ? {} : { warehouseId: input.warehouseId }),
            ...(input.customerPartyId === undefined ? {} : { customerPartyId: input.customerPartyId }),
            ...(input.driverPartyId === undefined ? {} : { driverPartyId: input.driverPartyId }),
            ...(input.carrierPartyId === undefined ? {} : { carrierPartyId: input.carrierPartyId }),
            ...(input.notes === undefined ? {} : { notes: input.notes }),
            ...(lines
              ? {
                  lines: {
                    create: lines.map((line) => ({
                      productVariantId: line.productVariantId,
                      actualQuantity: line.actualQuantity,
                      uomId: line.uomId,
                      notes: line.notes,
                      allocations: {
                        create: (line.allocations ?? []).map((allocation) => ({
                          companyId,
                          salesLineId: allocation.salesLineId ?? null,
                          purchaseLineId: allocation.purchaseLineId ?? null,
                          allocatedQuantity: roundQuantity(D(allocation.allocatedQuantity)),
                        })),
                      },
                    })),
                  },
                }
              : {}),
          },
          include: { lines: { include: { allocations: true } } },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    await this.auditService.record({
      entityType: 'loading',
      entityId: updated.id,
      action: AuditAction.UPDATE,
      companyId,
      actor,
      oldValues: { status: existing.status, notes: existing.notes },
      newValues: { lineCount: lines ? lines.length : undefined, notes: updated.notes },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return updated;
  }

  // ───────────────────────── delete / cancel ─────────────────────────

  /** DRAFT → removed (lines + allocations cascade). CONFIRMED → 403. */
  async delete(
    companyId: string,
    id: string,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<void> {
    const existing = await this.prisma.loading.findFirst({ where: { id, companyId } });
    if (!existing) throw new NotFoundError('Loading not found', { id });
    if (existing.status === LoadingStatus.CONFIRMED) {
      throw new ForbiddenError(LOADING_MESSAGES.confirmed, { id });
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.loading.delete({ where: { id: existing.id } });
      await this.auditService.recordTx(tx, {
        entityType: 'loading',
        entityId: existing.id,
        action: AuditAction.DELETE,
        companyId,
        actor,
        oldValues: { status: existing.status, loadingDate: existing.loadingDate },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
    });
  }

  /** DRAFT → CANCELLED (idempotent on an already-cancelled row). CONFIRMED → 403 LOADING_CONFIRMED. */
  async cancel(
    companyId: string,
    id: string,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    const existing = await this.prisma.loading.findFirst({ where: { id, companyId } });
    if (!existing) throw new NotFoundError('Loading not found', { id });
    if (existing.status === LoadingStatus.CONFIRMED) {
      throw new ForbiddenError(LOADING_MESSAGES.confirmed, { id });
    }
    if (existing.status === LoadingStatus.CANCELLED) {
      return existing;
    }
    const cancelled = await this.prisma.$transaction(async (tx) => {
      const row = await tx.loading.update({
        where: { id: existing.id },
        data: { status: LoadingStatus.CANCELLED },
      });
      await this.auditService.recordTx(tx, {
        entityType: 'loading',
        entityId: row.id,
        action: 'CANCEL',
        companyId,
        actor,
        oldValues: { status: existing.status },
        newValues: { status: row.status },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return row;
    });
    return cancelled;
  }

  // ───────────────────────── confirm (the operational event) ─────────────────────────

  /**
   * DRAFT → CONFIRMED. Everything below commits together or not at all —
   * see the class doc for the (a)…(e) breakdown. Idempotent double-confirm
   * protection: a locked status re-check throws 403 LOADING_CONFIRMED, and the
   * movement idempotency keys make even a forced re-run of the generation a
   * no-op (P2002 swallowed).
   */
  async confirm(
    companyId: string,
    id: string,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    return this.prisma.$transaction(
      async (tx) => {
        // Serialize concurrent confirms on the loading row itself.
        await tx.$queryRaw`SELECT id FROM loadings WHERE id = ${id}::uuid FOR UPDATE`;
        const loading = await tx.loading.findFirst({
          where: { id, companyId },
          include: { lines: { include: { allocations: true } } },
        });
        if (!loading) throw new NotFoundError('Loading not found', { id });
        if (loading.status === LoadingStatus.CONFIRMED) {
          throw new ForbiddenError(LOADING_MESSAGES.confirmed, { id });
        }
        if (loading.status === LoadingStatus.CANCELLED) {
          throw new ValidationError(LOADING_MESSAGES.invalidTransition, {
            from: loading.status,
            to: 'CONFIRMED',
          });
        }

        // (a) re-validate allocations under FOR UPDATE locks (proposed = the
        // stored allocations; existing sums exclude this loading → net effect
        // equals "sum of all non-cancelled loading allocations ≤ ordered").
        await this.resolveLines(tx, companyId, loading.lines);
        const { salesLines, purchaseLines } = await this.validateAllocations(
          tx,
          companyId,
          loading.lines,
          { excludeLoadingId: loading.id },
        );

        // Warehouse: explicit (already validated) or the company default.
        const warehouse = loading.warehouseId
          ? { id: loading.warehouseId }
          : await this.inventory.ensureDefaultWarehouse(tx, companyId);

        // (b) OUT movements — one per line, idempotent on the unique key.
        await this.generateOutMovements(tx, loading, loading.lines, warehouse.id, actor.id);

        // (c) operational loaded amounts + document status recompute.
        await this.applyOperationalAmounts(tx, companyId, salesLines, purchaseLines, loading.lines);

        // (d) debt gate (REQUIREMENTS §20).
        const driverInfoRestricted = await this.applyDebtGate(tx, companyId, loading, actor);

        await tx.loading.update({
          where: { id: loading.id },
          data: { status: LoadingStatus.CONFIRMED, driverInfoRestricted },
        });

        // (e) loading ↔ sales_document RELATED relations (both directions).
        const salesDocIds = [...new Set([...salesLines.values()].map((l) => l.documentId))];
        for (const docId of salesDocIds) {
          await this.relations.createRelation(
            companyId,
            { fromType: 'loading', fromId: loading.id, toType: 'sales_document', toId: docId, relationType: 'RELATED' },
            actor,
            ctx,
            tx,
          );
          await this.relations.createRelation(
            companyId,
            { fromType: 'sales_document', fromId: docId, toType: 'loading', toId: loading.id, relationType: 'RELATED' },
            actor,
            ctx,
            tx,
          );
        }

        await this.auditService.recordTx(tx, {
          entityType: 'loading',
          entityId: loading.id,
          action: 'CONFIRM',
          companyId,
          actor,
          oldValues: { status: loading.status },
          newValues: {
            status: LoadingStatus.CONFIRMED,
            driverInfoRestricted,
            warehouseId: warehouse.id,
            movementCount: loading.lines.length,
          },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });

        const partyId = loading.customerPartyId ?? loading.driverPartyId ?? loading.carrierPartyId;
        if (partyId) {
          await this.timeline.record(tx, {
            companyId,
            entityType: 'PARTY',
            entityId: partyId,
            type: 'LOADING_CONFIRMED',
            title: 'بارگیری تایید شد',
            description: 'بارگیری تایید و خروج از انبار ثبت شد',
            data: { loadingId: loading.id },
            actorUserId: actor.id,
          });
        }

        return tx.loading.findUniqueOrThrow({
          where: { id: loading.id },
          include: { lines: { include: { allocations: true } } },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  /**
   * Movement generation seam (also exercised directly by p6-02): OUT rows per
   * line with `loading:{loadingId}:line:{lineId}` idempotency keys — the
   * unique key is the only duplicate authority (inserted via ON CONFLICT DO
   * NOTHING, see insertStockMovementIfAbsent: a mid-transaction P2002 would
   * poison the transaction), so a re-run can never double-count stock
   * (domain boundaries §4). The effective uom is the line's own, else the
   * variant (else template) default.
   */
  async generateOutMovements(
    tx: Client,
    loading: { id: string; companyId: string; loadingDate: Date },
    lines: { id: string; productVariantId: string; actualQuantity: Prisma.Decimal; uomId: string | null }[],
    warehouseId: string,
    actorId: string,
  ): Promise<number> {
    const withUom = new Map<string, string>();
    const missing = lines.filter((l) => !l.uomId).map((l) => l.productVariantId);
    if (missing.length > 0) {
      const variants = await tx.productVariant.findMany({
        where: { id: { in: [...new Set(missing)] } },
        select: { id: true, defaultUomId: true, template: { select: { defaultSalesUomId: true } } },
      });
      for (const variant of variants) {
        const fallback = variant.defaultUomId ?? variant.template.defaultSalesUomId;
        if (fallback) withUom.set(variant.id, fallback);
      }
    }

    let created = 0;
    for (const line of lines) {
      const uomId = line.uomId ?? withUom.get(line.productVariantId);
      if (!uomId) throw new ValidationError(LOADING_MESSAGES.uomRequired, { productVariantId: line.productVariantId });
      const inserted = await insertStockMovementIfAbsent(tx, {
        companyId: loading.companyId,
        warehouseId,
        productVariantId: line.productVariantId,
        direction: 'OUT',
        quantity: line.actualQuantity,
        uomId,
        movementDate: loading.loadingDate,
        sourceEntityType: 'LOADING',
        sourceEntityId: loading.id,
        idempotencyKey: `loading:${loading.id}:line:${line.id}`,
        createdBy: actorId,
      });
      if (inserted) created += 1; // already moved — never duplicate
    }
    return created;
  }

  // ───────────────────────── driver-info release (debt gate) ─────────────────────────

  /**
   * Manager action on a restricted loading: APPROVED releases the driver /
   * carrier info, REJECTED keeps it hidden. Both delegate to the approval
   * engine (decision + audit + notification + loading flip in one tx).
   */
  async releaseDriverInfo(
    companyId: string,
    loadingId: string,
    dto: ReleaseDriverInfoDto & { decision: 'APPROVED' | 'REJECTED' },
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    const loading = await this.prisma.loading.findFirst({ where: { id: loadingId, companyId } });
    if (!loading) throw new NotFoundError('Loading not found', { id: loadingId });
    if (!loading.driverInfoRestricted) {
      throw new ConflictError(LOADING_MESSAGES.notRestricted, { id: loadingId });
    }
    const pending = await this.approvals.findPendingLoadingRelease(companyId, loadingId);
    if (!pending) {
      throw new ConflictError(LOADING_MESSAGES.noPendingApproval, { loadingId });
    }
    return this.approvals.decide(
      companyId,
      pending.id,
      { decision: dto.decision, note: dto.note },
      actor,
      ctx,
    );
  }

  // ───────────────────────── reads ─────────────────────────

  /**
   * Full view (lines + allocations) — shared by the sale & purchase sides.
   * While `driverInfoRestricted` is set, driver/carrier details are stripped
   * unless the viewer may see them (`restricted: true` marks a stripped
   * payload).
   */
  async getById(companyId: string, id: string, viewer: LoadingViewer = { canViewDriverInfo: true }) {
    const loading = await this.prisma.loading.findUnique({
      where: { id },
      include: {
        lines: { include: { allocations: true } },
        customer: { select: { id: true, nameFa: true } },
        driver: {
          select: {
            id: true,
            nameFa: true,
            nameEn: true,
            phones: { select: { kind: true, rawValue: true, normalizedValue: true } },
          },
        },
        carrier: {
          select: {
            id: true,
            nameFa: true,
            nameEn: true,
            phones: { select: { kind: true, rawValue: true, normalizedValue: true } },
          },
        },
        warehouse: { select: { id: true, code: true, nameFa: true } },
        approvals: {
          where: { status: 'PENDING' },
          select: { id: true, approvalType: true, status: true, createdAt: true },
        },
      },
    });
    if (!loading || loading.companyId !== companyId) {
      throw new NotFoundError('Loading not found', { id });
    }
    const restricted = loading.driverInfoRestricted && !viewer.canViewDriverInfo;
    return {
      ...loading,
      driver: restricted ? null : loading.driver,
      carrier: restricted ? null : loading.carrier,
      restricted,
    };
  }

  /**
   * Paginated list (status / date / customer filters). List scope: ALL with
   * `loading.view_all`, otherwise OWN (createdBy). Lists NEVER carry driver /
   * carrier details — restricted info cannot leak through the grid.
   */
  async list(
    companyId: string,
    opts: { userId: string; scopeAll: boolean },
    query: LoadingQueryDto,
  ): Promise<Paginated<unknown>> {
    const where: Prisma.LoadingWhereInput = {
      companyId,
      status: query.status,
      customerPartyId: query.customerPartyId,
      ...(query.from || query.to
        ? {
            loadingDate: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
      ...(opts.scopeAll ? {} : { createdBy: opts.userId }),
    };
    const [items, total] = await Promise.all([
      this.prisma.loading.findMany({
        where,
        orderBy: { loadingDate: 'desc' },
        skip: query.skip,
        take: query.take,
        include: {
          customer: { select: { id: true, nameFa: true } },
          warehouse: { select: { id: true, code: true, nameFa: true } },
          lines: { select: { id: true, actualQuantity: true } },
        },
      }),
      this.prisma.loading.count({ where }),
    ]);
    return {
      items: items.map((loading) => ({
        id: loading.id,
        loadingDate: loading.loadingDate,
        status: loading.status,
        driverInfoRestricted: loading.driverInfoRestricted,
        warehouse: loading.warehouse,
        customer: loading.customer,
        lineCount: loading.lines.length,
        totalQuantity: loading.lines.reduce((acc, line) => acc.plus(D(line.actualQuantity)), D(0)).toString(),
        notes: loading.notes,
        createdAt: loading.createdAt,
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  // ───────────────────────── validation internals ─────────────────────────

  private normalizeLineInputs(lines: LoadingLineInput[] | undefined): LoadingLineInput[] {
    if (!Array.isArray(lines) || lines.length === 0) {
      throw new ValidationError(LOADING_MESSAGES.linesRequired);
    }
    for (const line of lines) {
      if (!(D(line.actualQuantity).gt(0))) {
        throw new ValidationError(LOADING_MESSAGES.lineQuantityPositive);
      }
      for (const allocation of line.allocations ?? []) {
        if (!(D(allocation.allocatedQuantity).gt(0))) {
          throw new ValidationError(LOADING_MESSAGES.allocationPositive);
        }
        if (!allocation.salesLineId && !allocation.purchaseLineId) {
          throw new ValidationError(LOADING_MESSAGES.allocationTargetRequired);
        }
        if (allocation.salesLineId && allocation.purchaseLineId) {
          throw new ValidationError(LOADING_MESSAGES.allocationSingleTarget);
        }
      }
    }
    return lines;
  }

  /** Driver/carrier/customer must hold the role IN THIS company. */
  private async assertHeaderParties(
    tx: Client,
    companyId: string,
    input: {
      driverPartyId?: string | null;
      carrierPartyId?: string | null;
      customerPartyId?: string | null;
    },
  ): Promise<void> {
    if (input.driverPartyId) {
      await assertPartyHasRole(tx, companyId, input.driverPartyId, PartyRoleType.DRIVER, LOADING_MESSAGES.notADriver);
    }
    if (input.carrierPartyId) {
      await assertPartyHasRole(tx, companyId, input.carrierPartyId, PartyRoleType.CARRIER, LOADING_MESSAGES.notACarrier);
    }
    if (input.customerPartyId) {
      await assertPartyHasRole(tx, companyId, input.customerPartyId, PartyRoleType.CUSTOMER, LOADING_MESSAGES.notACustomer);
    }
  }

  private async assertWarehouse(tx: Client, companyId: string, warehouseId: string | null | undefined) {
    if (!warehouseId) return;
    const warehouse = await tx.warehouse.findFirst({
      where: { id: warehouseId, companyId },
      select: { id: true },
    });
    if (!warehouse) throw new NotFoundError('Warehouse not found', { warehouseId });
  }

  /**
   * Resolve variants (same company) + uoms for every line — validation only.
   * The effective uom is the line's own, else the variant default, else the
   * template's default sales uom — none resolvable is a 422 UOM_REQUIRED.
   */
  private async resolveLines(
    tx: Client,
    companyId: string,
    lines: LoadingLineInput[],
  ): Promise<void> {
    const variantIds = [...new Set(lines.map((l) => l.productVariantId))];
    const variants = await tx.productVariant.findMany({
      where: { id: { in: variantIds }, companyId },
      select: {
        id: true,
        defaultUomId: true,
        template: { select: { defaultSalesUomId: true } },
      },
    });
    const variantMap = new Map(variants.map((v) => [v.id, v]));

    const uomIds = new Set<string>();
    for (const line of lines) {
      if (line.uomId) uomIds.add(line.uomId);
      const variant = variantMap.get(line.productVariantId);
      const fallback = variant?.defaultUomId ?? variant?.template.defaultSalesUomId;
      if (fallback) uomIds.add(fallback);
    }
    const uoms = await tx.uom.findMany({
      where: { id: { in: [...uomIds] }, companyId, active: true },
      select: { id: true },
    });
    const uomSet = new Set(uoms.map((u) => u.id));

    for (const line of lines) {
      const variant = variantMap.get(line.productVariantId);
      if (!variant) {
        throw new NotFoundError('Product variant not found', { productVariantId: line.productVariantId });
      }
      const effective = line.uomId ?? variant.defaultUomId ?? variant.template.defaultSalesUomId;
      if (!effective || !uomSet.has(effective)) {
        throw new ValidationError(LOADING_MESSAGES.uomRequired, {
          productVariantId: line.productVariantId,
        });
      }
      if (line.uomId && !uomSet.has(line.uomId)) {
        throw new ValidationError(LOADING_MESSAGES.uomNotInCompany, { uomId: line.uomId });
      }
    }
  }

  /**
   * The over-allocation guard — the sales↔purchase allocation locking pattern
   * (SERIALIZABLE caller + FOR UPDATE row locks in consistent id order).
   * Loading allocations consume ordered quantity on BOTH sales and purchase
   * lines: Σ(loading allocations of every non-cancelled loading) + proposed
   * ≤ orderedQuantity, per line. Variant mismatch and foreign-company lines
   * are rejected here too.
   *
   * Returns the locked target lines (used by confirm for the operational
   * amount math) so confirm never needs a second unlocked read.
   */
  private async validateAllocations(
    tx: Client,
    companyId: string,
    lines: LoadingLineInput[],
    options: { excludeLoadingId?: string },
  ): Promise<{
    salesLines: Map<string, AllocationLineRow>;
    purchaseLines: Map<string, AllocationLineRow>;
  }> {
    const salesLineIds = new Set<string>();
    const purchaseLineIds = new Set<string>();
    for (const line of lines) {
      for (const allocation of line.allocations ?? []) {
        if (allocation.salesLineId) salesLineIds.add(allocation.salesLineId);
        if (allocation.purchaseLineId) purchaseLineIds.add(allocation.purchaseLineId);
      }
    }

    // Consistent global lock order (sorted ids) prevents deadlocks between
    // concurrent loading creates/confirms and allocations.
    const lock = async (table: 'sales_lines' | 'purchase_lines', ids: string[]) => {
      for (const id of [...ids].sort()) {
        await tx.$queryRaw`SELECT id FROM ${Prisma.raw(table)} WHERE id = ${id}::uuid FOR UPDATE`;
      }
    };
    await lock('sales_lines', [...salesLineIds]);
    await lock('purchase_lines', [...purchaseLineIds]);

    const salesLines = new Map<string, AllocationLineRow>();
    const purchaseLines = new Map<string, AllocationLineRow>();
    if (salesLineIds.size > 0) {
      const rows = await tx.salesLine.findMany({
        where: { id: { in: [...salesLineIds] }, companyId },
        select: {
          id: true,
          productVariantId: true,
          orderedQuantity: true,
          unitPrice: true,
          salesDocumentId: true,
        },
      });
      for (const row of rows) {
        salesLines.set(row.id, {
          id: row.id,
          productVariantId: row.productVariantId,
          orderedQuantity: row.orderedQuantity,
          unitPrice: row.unitPrice,
          documentId: row.salesDocumentId,
        });
      }
    }
    if (purchaseLineIds.size > 0) {
      const rows = await tx.purchaseLine.findMany({
        where: { id: { in: [...purchaseLineIds] }, companyId },
        select: {
          id: true,
          productVariantId: true,
          orderedQuantity: true,
          unitPrice: true,
          purchaseDocumentId: true,
        },
      });
      for (const row of rows) {
        purchaseLines.set(row.id, {
          id: row.id,
          productVariantId: row.productVariantId,
          orderedQuantity: row.orderedQuantity,
          unitPrice: row.unitPrice,
          documentId: row.purchaseDocumentId,
        });
      }
    }

    for (const line of lines) {
      for (const allocation of line.allocations ?? []) {
        const target = allocation.salesLineId
          ? salesLines.get(allocation.salesLineId)
          : purchaseLines.get(allocation.purchaseLineId as string);
        if (!target) {
          throw new NotFoundError('Allocation target line not found', {
            salesLineId: allocation.salesLineId,
            purchaseLineId: allocation.purchaseLineId,
          });
        }
        if (target.productVariantId !== line.productVariantId) {
          throw new ValidationError(LOADING_MESSAGES.variantMismatch, {
            loadingVariantId: line.productVariantId,
            lineVariantId: target.productVariantId,
          });
        }
      }
    }

    // Consumed = loading allocations of every non-cancelled loading (DRAFT
    // reservations count — fail fast; confirm re-validates under lock).
    const loadingFilter = {
      status: { not: LoadingStatus.CANCELLED },
      ...(options.excludeLoadingId ? { id: { not: options.excludeLoadingId } } : {}),
    };
    const consumed = new Map<string, Prisma.Decimal>();
    const accumulate = (lineId: string, quantity: Prisma.Decimal | null | undefined) => {
      consumed.set(lineId, D(consumed.get(lineId)).plus(D(quantity ?? 0)));
    };
    if (salesLineIds.size > 0) {
      const sums = await tx.loadingAllocation.groupBy({
        by: ['salesLineId'],
        where: {
          companyId,
          salesLineId: { in: [...salesLineIds] },
          loadingLine: { loading: loadingFilter },
        },
        _sum: { allocatedQuantity: true },
      });
      for (const sum of sums) if (sum.salesLineId) accumulate(sum.salesLineId, sum._sum.allocatedQuantity);
    }
    if (purchaseLineIds.size > 0) {
      const sums = await tx.loadingAllocation.groupBy({
        by: ['purchaseLineId'],
        where: {
          companyId,
          purchaseLineId: { in: [...purchaseLineIds] },
          loadingLine: { loading: loadingFilter },
        },
        _sum: { allocatedQuantity: true },
      });
      for (const sum of sums) if (sum.purchaseLineId) accumulate(sum.purchaseLineId, sum._sum.allocatedQuantity);
    }

    for (const line of lines) {
      for (const allocation of line.allocations ?? []) {
        const lineId = (allocation.salesLineId ?? allocation.purchaseLineId) as string;
        const target = salesLines.get(lineId) ?? purchaseLines.get(lineId);
        if (!target) {
          throw new NotFoundError('Allocation target line not found', { lineId });
        }
        const proposed = D(consumed.get(lineId)).plus(roundQuantity(D(allocation.allocatedQuantity)));
        if (proposed.gt(target.orderedQuantity)) {
          throw new ConflictError(LOADING_MESSAGES.exceedsQuantity, {
            lineId,
            orderedQuantity: target.orderedQuantity.toString(),
            allocated: proposed.toString(),
          });
        }
        consumed.set(lineId, proposed);
      }
    }

    return { salesLines, purchaseLines };
  }

  /**
   * (c) operational loaded amounts + status recompute. Amount delta per
   * document = Σ(allocatedQuantity × line.unitPrice) of THIS loading's
   * allocations (exact Decimal); status recomputes from the TOTAL loaded
   * quantity across ALL non-cancelled loading allocations per line.
   */
  private async applyOperationalAmounts(
    tx: Client,
    companyId: string,
    salesLines: Map<string, AllocationLineRow>,
    purchaseLines: Map<string, AllocationLineRow>,
    loadingLines: { allocations: { salesLineId: string | null; purchaseLineId: string | null; allocatedQuantity: Prisma.Decimal }[] }[],
  ): Promise<void> {
    // This loading's contribution per document (exact Decimal math).
    const salesDelta = new Map<string, Prisma.Decimal>();
    const purchaseDelta = new Map<string, Prisma.Decimal>();
    for (const line of loadingLines) {
      for (const allocation of line.allocations) {
        if (allocation.salesLineId) {
          const target = salesLines.get(allocation.salesLineId);
          if (target) {
            salesDelta.set(
              target.documentId,
              D(salesDelta.get(target.documentId)).plus(D(allocation.allocatedQuantity).times(target.unitPrice)),
            );
          }
        } else if (allocation.purchaseLineId) {
          const target = purchaseLines.get(allocation.purchaseLineId);
          if (target) {
            purchaseDelta.set(
              target.documentId,
              D(purchaseDelta.get(target.documentId)).plus(D(allocation.allocatedQuantity).times(target.unitPrice)),
            );
          }
        }
      }
    }

    for (const [docId, delta] of salesDelta) {
      const doc = await tx.salesDocument.findFirst({
        where: { id: docId, companyId },
        select: {
          id: true,
          status: true,
          operationalLoadedAmount: true,
          lines: {
            select: {
              id: true,
              orderedQuantity: true,
              loadingAllocations: {
                where: { loadingLine: { loading: { status: { not: LoadingStatus.CANCELLED } } } },
                select: { allocatedQuantity: true },
              },
            },
          },
        },
      });
      if (!doc) continue;
      const loadedAmount = D(doc.operationalLoadedAmount).plus(delta);
      const status = this.recomputeStatus(
        doc.status,
        doc.lines.map((line) => ({ orderedQuantity: line.orderedQuantity, allocations: line.loadingAllocations })),
        ['SALES_ORDER', 'PARTIALLY_LOADED'],
      );
      await tx.salesDocument.update({
        where: { id: doc.id },
        data: {
          operationalLoadedAmount: loadedAmount,
          ...(status ? { status: status as SalesDocumentStatus } : {}),
        },
      });
    }

    for (const [docId, delta] of purchaseDelta) {
      const doc = await tx.purchaseDocument.findFirst({
        where: { id: docId, companyId },
        select: {
          id: true,
          status: true,
          operationalLoadedAmount: true,
          lines: {
            select: {
              id: true,
              orderedQuantity: true,
              loadingAllocations: {
                where: { loadingLine: { loading: { status: { not: LoadingStatus.CANCELLED } } } },
                select: { allocatedQuantity: true },
              },
            },
          },
        },
      });
      if (!doc) continue;
      const loadedAmount = D(doc.operationalLoadedAmount).plus(delta);
      const status = this.recomputeStatus(
        doc.status,
        doc.lines.map((line) => ({ orderedQuantity: line.orderedQuantity, allocations: line.loadingAllocations })),
        ['ORDER_PLACED', 'PARTIALLY_LOADED'],
      );
      await tx.purchaseDocument.update({
        where: { id: doc.id },
        data: {
          operationalLoadedAmount: loadedAmount,
          ...(status ? { status: status as PurchaseDocumentStatus } : {}),
        },
      });
    }
  }

  /**
   * COMPLETED when every line's loaded quantity (across all non-cancelled
   * loading allocations) ≥ ordered; PARTIALLY_LOADED when something is
   * loaded. Only applied from the document's "active" statuses — earlier
   * lifecycle stages (quotation, draft purchase) keep their status while the
   * amounts still move; COMPLETED is never downgraded.
   */
  private recomputeStatus(
    current: string,
    lines: { orderedQuantity: Prisma.Decimal; allocations: { allocatedQuantity: Prisma.Decimal }[] }[],
    applicableFrom: string[],
  ): string | null {
    if (!applicableFrom.includes(current) || current === 'COMPLETED') return null;

    let someLoaded = false;
    let allFullyLoaded = lines.length > 0;
    for (const line of lines) {
      const loaded = line.allocations.reduce((acc, a) => acc.plus(D(a.allocatedQuantity)), D(0));
      if (loaded.gt(0)) someLoaded = true;
      if (loaded.lt(D(line.orderedQuantity))) allFullyLoaded = false;
    }
    if (!someLoaded) return null;
    return allFullyLoaded ? 'COMPLETED' : 'PARTIALLY_LOADED';
  }

  /**
   * (d) DEBT GATE: a customer with PartyOperationalBalance.balance > 0 (no
   * row = no debt) gets a PENDING RELEASE_DRIVER_INFO approval and restricted
   * driver info; anyone else loads unrestricted. Debt never blocks loading.
   */
  private async applyDebtGate(
    tx: Client,
    companyId: string,
    loading: { id: string; customerPartyId: string | null },
    actor: { id: string },
  ): Promise<boolean> {
    if (!loading.customerPartyId) return false;
    const balance = await tx.partyOperationalBalance.findUnique({
      where: { companyId_partyId: { companyId, partyId: loading.customerPartyId } },
      select: { balance: true },
    });
    if (!balance || !D(balance.balance).gt(0)) return false;

    await tx.approvalRequest.create({
      data: {
        companyId,
        entityType: 'loading',
        entityId: loading.id,
        approvalType: 'RELEASE_DRIVER_INFO',
        requestedBy: actor.id,
        reason: 'مانده عملیاتی مشتری بزرگ‌تر از صفر است — نیاز به تایید مدیر',
      },
    });
    return true;
  }
}
