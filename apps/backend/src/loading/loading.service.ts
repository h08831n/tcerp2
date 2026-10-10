import { Injectable } from '@nestjs/common';
import {
  LoadingRoute,
  LoadingStatus,
  PartyRoleType,
  Prisma,
  PurchaseDocumentStatus,
  SalesDocumentStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
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
import { NormalizationService } from '../inventory/normalization.service';
import { PurchaseFulfillmentService } from '../purchase/purchase-fulfillment.service';
import { PurchaseFulfillmentType } from '@prisma/client';
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
  allocationUomIncompatible: 'ALLOCATION_UOM_INCOMPATIBLE',
  allocationPositive: 'ALLOCATION_QUANTITY_POSITIVE',
  allocationTargetRequired: 'ALLOCATION_TARGET_REQUIRED',
  allocationSingleTarget: 'ALLOCATION_SINGLE_TARGET',
  lineQuantityPositive: 'LOADING_LINE_QUANTITY_POSITIVE',
  linesRequired: 'LOADING_LINES_REQUIRED',
  uomRequired: 'UOM_REQUIRED',
  uomNotInCompany: 'UOM_NOT_IN_COMPANY',
  confirmed: 'LOADING_CONFIRMED',
  notDraft: 'LOADING_NOT_DRAFT',
  notReversible: 'LOADING_NOT_REVERSIBLE',
  invalidTransition: 'INVALID_STATUS_TRANSITION',
  versionConflict: 'VERSION_CONFLICT',
  notRestricted: 'LOADING_NOT_RESTRICTED',
  noPendingApproval: 'NO_PENDING_APPROVAL',
  warehouseRequired: 'WAREHOUSE_REQUIRED',
  reversalReasonRequired: 'REVERSAL_REASON_REQUIRED',
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
  route?: LoadingRoute;
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
  uomId: string;
  documentId: string;
}

type MovementEndpoints = {
  sourceLocationId: string;
  destinationLocationId: string;
  warehouseId: string | null;
};

/**
 * Loading (bill of lading) — the SINGLE operational event of Phase 6 (domain
 * boundaries §2): registered ONCE (header + lines + allocations) and shown on
 * both the sale and the purchase side. Lifecycle DRAFT → CONFIRMED →
 * REVERSED (+DRAFT → CANCELLED); a REVERSED loading is immutable forever.
 *
 * The physical ROUTE is explicit (Integrity Gate #10 — never inferred):
 *   - DIRECT_SUPPLIER_TO_CUSTOMER: SUPPLIER → CUSTOMER, no internal impact;
 *   - WAREHOUSE_TO_CUSTOMER:       INTERNAL(warehouse) → CUSTOMER;
 *   - SUPPLIER_TO_WAREHOUSE:       SUPPLIER → INTERNAL(warehouse).
 * WAREHOUSE routes require an explicit warehouseId (WAREHOUSE_REQUIRED).
 *
 * confirm() is ONE serializable transaction that:
 *   (a) re-validates every allocation with FOR UPDATE row locks —
 *       allocatedQuantity is expressed in the LOADING LINE's uom and is
 *       converted to the TARGET document line's uom before every comparison
 *       (ALLOCATION_UOM_INCOMPATIBLE when no conversion exists);
 *   (b) generates one StockMovement per loading line ALONG THE ROUTE
 *       (idempotencyKey `loading:{loadingId}:line:{lineId}` — the unique key
 *       is the only duplicate authority, ON CONFLICT DO NOTHING), each with
 *       the COST SNAPSHOT of its purchase allocation when one exists (final
 *       correction #3 — PO unit price per inventory UOM, totalCost computed
 *       by the movement writer);
 *   (b2) upserts PurchaseLineFulfillment DIRECT_LOADING rows for purchase-line
 *       allocations of DIRECT_SUPPLIER_TO_CUSTOMER loadings (final correction
 *       #1 — quantity in the PO line's uom, amount = quantity × unitPrice;
 *       separate rows that never overwrite GOODS_RECEIPT rows);
 *   (c) recomputes `operationalLoadedAmount` + status on every touched
 *       document: PURCHASE documents from the fulfillment LEDGER (absolute
 *       recompute, shared with the goods-receipt flow), SALES documents from
 *       the TOTAL loaded quantities (converted to each document line's uom) ×
 *       line.unitPrice → PARTIALLY_LOADED / COMPLETED (only from the
 *       document's "active" statuses);
 *   (d) applies the DEBT GATE (REQUIREMENTS §20): a customer whose
 *       PartyOperationalBalance.balance > 0 gets a PENDING ApprovalRequest
 *       (RELEASE_DRIVER_INFO) and driverInfoRestricted = true — the debt
 *       never BLOCKS the loading, it only hides driver/carrier details;
 *   (e) writes loading ↔ sales_document RELATED DocumentRelations and the
 *       audit + party timeline rows — all atomic (audit failure rolls the
 *       whole confirmation back, p6-13).
 *
 * reverse() (Integrity Gate #11) is ONE serializable transaction: the
 * original flips to REVERSED + reason, one COMPENSATING movement per
 * original movement (swapped endpoints, reversalOfMovementId linkage, key
 * `loading-rev:{loadingId}:line:{lineId}`), the operational loaded amount is
 * recomputed (rollback by construction), PENDING driver-info approvals are
 * CANCELLED and the audit + timeline rows commit together. A reversed
 * loading can never be confirmed, updated, cancelled or deleted again.
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
    private readonly normalization: NormalizationService,
    private readonly fulfillments: PurchaseFulfillmentService,
  ) {}

  // ───────────────────────── create (DRAFT) ─────────────────────────

  async create(
    companyId: string,
    input: CreateLoadingInput,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    const lines = this.normalizeLineInputs(input.lines);
    this.assertRouteWarehouse(input.route, input.warehouseId ?? null);

    const loading = await this.prisma.$transaction(
      async (tx) => {
        await this.assertHeaderParties(tx, companyId, input);
        await this.assertWarehouse(tx, companyId, input.warehouseId ?? null);
        const effectiveUoms = await this.resolveEffectiveUoms(tx, companyId, lines);
        await this.validateAllocations(tx, companyId, lines, effectiveUoms, {});

        const created = await tx.loading.create({
          data: {
            companyId,
            loadingDate: input.loadingDate,
            status: LoadingStatus.DRAFT,
            route: input.route ?? LoadingRoute.DIRECT_SUPPLIER_TO_CUSTOMER,
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

        // Atomic audit + timeline (a failure rolls the WHOLE create back).
        await this.auditService.recordTx(tx, {
          entityType: 'loading',
          entityId: created.id,
          action: 'CREATE',
          companyId,
          actor,
          newValues: { loadingDate: created.loadingDate, route: created.route, lineCount: lines.length },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        const partyId = created.customerPartyId ?? created.driverPartyId ?? created.carrierPartyId;
        if (partyId) {
          await this.timeline.record(tx, {
            companyId,
            entityType: 'PARTY',
            entityId: partyId,
            type: 'LOADING_REGISTERED',
            title: 'بارگیری ثبت شد',
            description: 'بارگیری به صورت پیش‌نویس ثبت شد',
            data: { loadingId: created.id },
            actorUserId: actor.id,
          });
        }
        return created;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    return loading;
  }

  // ───────────────────────── update (DRAFT only) ─────────────────────────

  /**
   * Full-header update; lines (when provided) are REPLACED wholesale. DRAFT
   * only — a confirmed loading is immutable and a REVERSED one can never be
   * touched again. Optimistic concurrency without a version column (schema
   * frozen): the caller may pass `expectedUpdatedAt`; a mismatch is a 409
   * VERSION_CONFLICT.
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
    if (input.route !== undefined) {
      const effectiveWarehouse = input.warehouseId === undefined ? existing.warehouseId : input.warehouseId;
      this.assertRouteWarehouse(input.route, effectiveWarehouse);
    }

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
          const effectiveUoms = await this.resolveEffectiveUoms(tx, companyId, lines);
          await this.validateAllocations(tx, companyId, lines, effectiveUoms, {
            excludeLoadingId: existing.id,
          });
          await tx.loadingLine.deleteMany({ where: { loadingId: existing.id } });
        }

        const row = await tx.loading.update({
          where: { id: existing.id },
          data: {
            loadingDate: input.loadingDate ? new Date(input.loadingDate) : undefined,
            ...(input.route === undefined ? {} : { route: input.route }),
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
                }
              : {}),
          },
          include: { lines: { include: { allocations: true } } },
        });

        // Atomic audit + timeline (a failure rolls the WHOLE update back).
        await this.auditService.recordTx(tx, {
          entityType: 'loading',
          entityId: row.id,
          action: 'UPDATE',
          companyId,
          actor,
          oldValues: { status: existing.status, notes: existing.notes, route: existing.route },
          newValues: { lineCount: lines ? lines.length : undefined, notes: row.notes, route: row.route },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        const partyId = row.customerPartyId ?? row.driverPartyId ?? row.carrierPartyId;
        if (partyId) {
          await this.timeline.record(tx, {
            companyId,
            entityType: 'PARTY',
            entityId: partyId,
            type: 'LOADING_UPDATED',
            title: 'بارگیری ویرایش شد',
            description: 'پیش‌نویس بارگیری ویرایش شد',
            data: { loadingId: row.id },
            actorUserId: actor.id,
          });
        }
        return row;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    return updated;
  }

  // ───────────────────────── delete / cancel ─────────────────────────

  /** DRAFT → removed (lines + allocations cascade). CONFIRMED/REVERSED → 403. */
  async delete(
    companyId: string,
    id: string,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<void> {
    const existing = await this.prisma.loading.findFirst({ where: { id, companyId } });
    if (!existing) throw new NotFoundError('Loading not found', { id });
    if (existing.status === LoadingStatus.REVERSED) {
      throw new ForbiddenError('LOADING_REVERSED', { id });
    }
    if (existing.status === LoadingStatus.CONFIRMED) {
      throw new ForbiddenError(LOADING_MESSAGES.confirmed, { id });
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.loading.delete({ where: { id: existing.id } });
      await this.auditService.recordTx(tx, {
        entityType: 'loading',
        entityId: existing.id,
        action: 'DELETE',
        companyId,
        actor,
        oldValues: { status: existing.status, loadingDate: existing.loadingDate },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
    });
  }

  /**
   * DRAFT → CANCELLED (idempotent on an already-cancelled row).
   * CONFIRMED → 403 LOADING_CONFIRMED; REVERSED is immutable forever.
   */
  async cancel(
    companyId: string,
    id: string,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    const existing = await this.prisma.loading.findFirst({ where: { id, companyId } });
    if (!existing) throw new NotFoundError('Loading not found', { id });
    if (existing.status === LoadingStatus.REVERSED) {
      throw new ForbiddenError('LOADING_REVERSED', { id });
    }
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
      const partyId = row.customerPartyId ?? row.driverPartyId ?? row.carrierPartyId;
      if (partyId) {
        await this.timeline.record(tx, {
          companyId,
          entityType: 'PARTY',
          entityId: partyId,
          type: 'LOADING_CANCELLED',
          title: 'بارگیری لغو شد',
          description: 'پیش‌نویس بارگیری لغو شد',
          data: { loadingId: row.id },
          actorUserId: actor.id,
        });
      }
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
   * no-op. REVERSED loadings are immutable forever.
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
        if (loading.status !== LoadingStatus.DRAFT) {
          throw new ValidationError(LOADING_MESSAGES.invalidTransition, {
            from: loading.status,
            to: 'CONFIRMED',
          });
        }

        // (a) effective per-line uoms + allocation re-validation under FOR
        // UPDATE locks (converted quantities returned for the amount math).
        const effectiveUoms = await this.resolveEffectiveUoms(tx, companyId, loading.lines);
        const { salesLines, purchaseLines, converted } = await this.validateAllocations(
          tx,
          companyId,
          loading.lines,
          effectiveUoms,
          { excludeLoadingId: loading.id },
        );

        // (b) movements ALONG THE ROUTE (Integrity Gate #10). Cost snapshots
        // (final #3): a line allocated to a PURCHASE line carries that PO
        // line's per-inventory-UOM cost (same conversion as the receipt
        // movements); without a purchase allocation the movement has no cost.
        const unitCosts = await this.lineUnitCosts(companyId, loading.lines, purchaseLines);
        const { perLine, warehouseId } = await this.resolveRouteEndpoints(
          tx,
          companyId,
          loading,
          loading.lines,
          effectiveUoms,
          salesLines,
          purchaseLines,
        );
        await this.generateMovements(tx, loading, loading.lines, perLine, effectiveUoms, actor.id, unitCosts);

        // (b2) fulfillment ledger (final correction #1): DIRECT
        // supplier→customer loadings contribute DIRECT_LOADING rows to their
        // purchase lines — separate from (never overwriting) GOODS_RECEIPT
        // rows. Warehouse routes keep the allocation guard but do not touch
        // the purchase fulfillment ledger.
        if (loading.route === LoadingRoute.DIRECT_SUPPLIER_TO_CUSTOMER) {
          for (const line of loading.lines) {
            for (const allocation of line.allocations ?? []) {
              if (!allocation.purchaseLineId) continue;
              const target = purchaseLines.get(allocation.purchaseLineId);
              if (!target) continue;
              await this.fulfillments.upsertDirectLoadingFulfillment(tx, companyId, {
                purchaseLineId: allocation.purchaseLineId,
                loadingId: loading.id,
                quantity: converted.get(allocation) ?? D(0),
                uomId: target.uomId,
                amount: D(converted.get(allocation) ?? 0).times(target.unitPrice),
              });
            }
          }
        }

        // (c) operational loaded amounts + document status: SALES documents
        // recompute from the allocations (full recompute), PURCHASE documents
        // recompute from the fulfillment ledger (absolute — GRN + direct
        // loading rows; confirm and reverse share it).
        const docIds = {
          sales: new Set([...salesLines.values()].map((l) => l.documentId)),
          purchase: new Set([...purchaseLines.values()].map((l) => l.documentId)),
        };
        await this.recomputeOperationalState(tx, companyId, docIds);

        // (d) debt gate (REQUIREMENTS §20).
        const driverInfoRestricted = await this.applyDebtGate(tx, companyId, loading, actor);

        await tx.loading.update({
          where: { id: loading.id },
          data: { status: LoadingStatus.CONFIRMED, driverInfoRestricted },
        });

        // (e) loading ↔ sales_document RELATED relations (both directions).
        for (const docId of docIds.sales) {
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
            route: loading.route,
            driverInfoRestricted,
            warehouseId,
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
            description: 'بارگیری تایید و حرکت کالا ثبت شد',
            data: { loadingId: loading.id, route: loading.route },
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

  // ───────────────────────── reverse (Integrity Gate #11) ─────────────────────────

  /**
   * CONFIRMED → REVERSED with a REQUIRED reason. One atomic transaction —
   * see the class doc. The compensating movements swap the original
   * endpoints and reference the original via reversalOfMovementId (unitCost
   * copied, totalCost NEGATED — final correction #3); the DIRECT_LOADING
   * fulfillment rows flip reversedAt (kept for history) and the purchase
   * operational state recomputes from the live ledger; the idempotency key
   * `loading-rev:{loadingId}:line:{lineId}` makes a re-run a no-op (a
   * reversed loading is rejected before anything is written, so this only
   * protects against pathological races).
   */
  async reverse(
    companyId: string,
    id: string,
    dto: { reason: string },
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    const reason = dto.reason?.trim();
    if (!reason) {
      throw new ValidationError(LOADING_MESSAGES.reversalReasonRequired, { id });
    }

    return this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM loadings WHERE id = ${id}::uuid FOR UPDATE`;
        const loading = await tx.loading.findFirst({
          where: { id, companyId },
          include: { lines: { include: { allocations: true } } },
        });
        if (!loading) throw new NotFoundError('Loading not found', { id });
        if (loading.status !== LoadingStatus.CONFIRMED) {
          throw new ConflictError(LOADING_MESSAGES.notReversible, { status: loading.status });
        }

        // Compensating movements: one per original, endpoints swapped,
        // normalized values reused verbatim (the compensation un-does the
        // exact normalized quantity that was applied). Cost snapshots (final
        // #3): the compensating row copies the original's unitCost and
        // carries the NEGATED totalCost — the valuation is un-done without
        // ever touching the original row.
        const originals = await tx.stockMovement.findMany({
          where: {
            sourceEntityType: 'LOADING',
            sourceEntityId: loading.id,
            reversalOfMovementId: null,
          },
          orderBy: { createdAt: 'asc' },
        });
        let created = 0;
        for (const original of originals) {
          const lineId = original.idempotencyKey.split(':line:')[1] ?? original.id;
          const inserted = await NormalizationService.insertNormalizedMovement(tx, {
            companyId: loading.companyId,
            productVariantId: original.productVariantId,
            sourceQuantity: original.sourceQuantity,
            sourceUomId: original.sourceUomId,
            normalizedQuantity: original.normalizedQuantity,
            inventoryUomId: original.inventoryUomId,
            direction: original.direction === 'IN' ? 'OUT' : 'IN',
            sourceLocationId: original.destinationLocationId,
            destinationLocationId: original.sourceLocationId,
            warehouseId: original.warehouseId,
            movementDate: new Date(),
            sourceEntityType: 'LOADING_REVERSAL',
            sourceEntityId: loading.id,
            idempotencyKey: `loading-rev:${loading.id}:line:${lineId}`,
            reversalOfMovementId: original.id,
            createdBy: actor.id,
            unitCostSnapshot: original.unitCostSnapshot,
            totalCostSnapshot: original.totalCostSnapshot === null ? null : D(original.totalCostSnapshot).neg(),
          });
          if (inserted) created += 1;
        }

        // Operational rollback: the DIRECT_LOADING fulfillment rows flip
        // reversedAt (kept for history) and the purchase documents recompute
        // from the live ledger (this loading drops out once REVERSED); sales
        // documents recompute from the remaining active loadings' allocations.
        const docIds = await this.loadingDocumentIds(tx, companyId, loading.lines);
        await tx.loading.update({
          where: { id: loading.id },
          data: { status: LoadingStatus.REVERSED, reversalReason: reason },
        });
        await this.fulfillments.reverseBySource(tx, PurchaseFulfillmentType.DIRECT_LOADING, loading.id);
        await this.recomputeOperationalState(tx, companyId, docIds, 'reverse');

        // The debt-gate release request (if any) dies with the loading.
        await tx.approvalRequest.updateMany({
          where: {
            companyId,
            entityType: 'loading',
            entityId: loading.id,
            approvalType: 'RELEASE_DRIVER_INFO',
            status: 'PENDING',
          },
          data: { status: 'CANCELLED' },
        });

        await this.auditService.recordTx(tx, {
          entityType: 'loading',
          entityId: loading.id,
          action: 'LOADING_REVERSED',
          companyId,
          actor,
          oldValues: { status: LoadingStatus.CONFIRMED },
          newValues: { status: LoadingStatus.REVERSED, reversalReason: reason, compensatingMovements: created },
          reason,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });

        const partyId = loading.customerPartyId ?? loading.driverPartyId ?? loading.carrierPartyId;
        if (partyId) {
          await this.timeline.record(tx, {
            companyId,
            entityType: 'PARTY',
            entityId: partyId,
            type: 'LOADING_REVERSED',
            title: 'بارگیری برعکس شد',
            description: 'بارگیری با حرکات جبرانی لغو و موجودی اصلاح شد',
            data: { loadingId: loading.id, compensatingMovements: created },
            actorUserId: actor.id,
          });
        }

        return tx.loading.findUniqueOrThrow({
          where: { id: loading.id },
          include: {
            lines: { include: { allocations: true } },
            reversals: { select: { id: true, status: true } },
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
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
   * Full view (lines + allocations + reversal linkage). While
   * `driverInfoRestricted` is set, driver/carrier details are stripped
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
        // Reversal linkage (Integrity Gate #11).
        reversalOf: { select: { id: true, status: true, reversalReason: true } },
        reversals: { select: { id: true, status: true, reversalReason: true } },
        movements: {
          select: { id: true, idempotencyKey: true, reversalOfMovementId: true },
        },
      },
    });
    if (!loading || loading.companyId !== companyId) {
      throw new NotFoundError('Loading not found', { id });
    }
    // The generic approval reference has NO physical FK (Integrity Gate #13)
    // — pending release requests are queried on (entityType, entityId).
    const approvals = await this.prisma.approvalRequest.findMany({
      where: { companyId, entityType: 'loading', entityId: id, status: 'PENDING' },
      select: { id: true, approvalType: true, status: true, createdAt: true },
    });
    const restricted = loading.driverInfoRestricted && !viewer.canViewDriverInfo;
    return {
      ...loading,
      approvals,
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
        route: loading.route,
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

  // ───────────────────────── movement generation seam ─────────────────────────

  /**
   * Movement generation seam (also exercised directly by p6-02): one
   * StockMovement per line along the pre-resolved ROUTE endpoints, with the
   * `loading:{loadingId}:line:{lineId}` idempotency keys — the unique key is
   * the only duplicate authority (ON CONFLICT DO NOTHING), so a re-run can
   * never double-count stock (domain boundaries §4). The effective uom is
   * the line's own, else the variant (else template) default; the
   * normalizedQuantity/inventoryUom pair is computed by the normalization
   * service (Integrity Gate #1).
   *
   * `unitCosts` (final correction #3) carries the per-line cost snapshot (per
   * ONE inventory-UOM unit) — the writer multiplies it by the normalized
   * quantity into totalCostSnapshot. Absent/null → NULL cost columns.
   */
  async generateMovements(
    tx: Client,
    loading: { id: string; companyId: string; loadingDate: Date; route: LoadingRoute },
    lines: { productVariantId: string; actualQuantity: Prisma.Decimal | number | string }[],
    endpoints: Map<object, MovementEndpoints>,
    effectiveUoms: Map<object, string>,
    actorId: string,
    unitCosts?: Map<object, Prisma.Decimal | null>,
  ): Promise<number> {
    const direction = loading.route === LoadingRoute.SUPPLIER_TO_WAREHOUSE ? 'IN' : 'OUT';
    let created = 0;
    for (const line of lines) {
      const endpoint = endpoints.get(line);
      if (!endpoint) {
        throw new ValidationError('LOADING_ROUTE_ENDPOINTS_MISSING', { loadingId: loading.id });
      }
      const uomId = effectiveUoms.get(line);
      if (!uomId) throw new ValidationError(LOADING_MESSAGES.uomRequired, { loadingId: loading.id });
      const inserted = await this.normalization.insertStockMovement(tx, {
        companyId: loading.companyId,
        productVariantId: line.productVariantId,
        quantity: line.actualQuantity,
        uomId,
        direction,
        sourceLocationId: endpoint.sourceLocationId,
        destinationLocationId: endpoint.destinationLocationId,
        warehouseId: endpoint.warehouseId,
        movementDate: loading.loadingDate,
        sourceEntityType: 'LOADING',
        sourceEntityId: loading.id,
        idempotencyKey: `loading:${loading.id}:line:${(line as { id?: string }).id ?? ''}`,
        createdBy: actorId,
        unitCostSnapshot: unitCosts?.get(line) ?? null,
      });
      if (inserted) created += 1; // already moved — never duplicate
    }
    return created;
  }

  /**
   * Per-line movement cost snapshots (final correction #3): a loading line
   * allocated to a PURCHASE line is valued at that PO line's unit price,
   * converted to a per-inventory-UOM cost (unitPrice ÷ factor(purchaseUom →
   * inventoryUom) — the SAME conversion the goods-receipt movements use, so
   * received and directly-loaded goods carry the same cost). Lines without a
   * purchase allocation get no cost (null). When a line carries several
   * purchase allocations, the FIRST one (allocation order) sets the cost —
   * documented convention, one PO line per movement row.
   */
  private async lineUnitCosts(
    companyId: string,
    lines: { productVariantId: string; allocations?: LoadingAllocationInput[] }[],
    purchaseLines: Map<string, AllocationLineRow>,
  ): Promise<Map<object, Prisma.Decimal | null>> {
    const costs = new Map<object, Prisma.Decimal | null>();
    for (const line of lines) {
      const purchaseAllocation = (line.allocations ?? []).find((a) => a.purchaseLineId);
      const target = purchaseAllocation?.purchaseLineId
        ? purchaseLines.get(purchaseAllocation.purchaseLineId)
        : undefined;
      costs.set(
        line,
        target
          ? await this.fulfillments.unitCostPerInventoryUom(companyId, line.productVariantId, target)
          : null,
      );
    }
    return costs;
  }

  // ───────────────────────── route endpoint resolution ─────────────────────────

  /**
   * Resolve the physical endpoints per line from the ROUTE (Integrity Gate
   * #10) — never from the presence of a warehouse:
   *   DIRECT_SUPPLIER_TO_CUSTOMER: SUPPLIER(purchase supplier or default) →
   *     CUSTOMER(loading.customerPartyId or sale customer); warehouse null;
   *   WAREHOUSE_TO_CUSTOMER: INTERNAL(warehouse) → CUSTOMER(same rule);
   *   SUPPLIER_TO_WAREHOUSE: SUPPLIER(same rule) → INTERNAL(warehouse).
   * External endpoints are find-or-created per party (resolveLocation).
   */
  private async resolveRouteEndpoints(
    tx: Client,
    companyId: string,
    loading: { id: string; route: LoadingRoute; warehouseId: string | null; customerPartyId: string | null },
    lines: { allocations?: { salesLineId: string | null; purchaseLineId: string | null }[] }[],
    effectiveUoms: Map<object, string>,
    salesLines: Map<string, AllocationLineRow>,
    purchaseLines: Map<string, AllocationLineRow>,
  ): Promise<{ perLine: Map<object, MovementEndpoints>; warehouseId: string | null }> {
    // Purchase-supplier + sales-customer resolution (loading-level fallbacks).
    const purchaseDocIds = new Set<string>();
    const salesDocIds = new Set<string>();
    for (const line of lines) {
      for (const allocation of line.allocations ?? []) {
        if (allocation.purchaseLineId) {
          const row = purchaseLines.get(allocation.purchaseLineId);
          if (row) purchaseDocIds.add(row.documentId);
        }
        if (allocation.salesLineId) {
          const row = salesLines.get(allocation.salesLineId);
          if (row) salesDocIds.add(row.documentId);
        }
      }
    }
    const purchaseSuppliers = new Map<string, string>();
    if (purchaseDocIds.size > 0) {
      const docs = await tx.purchaseDocument.findMany({
        where: { id: { in: [...purchaseDocIds] }, companyId },
        select: { id: true, supplierPartyId: true },
      });
      for (const doc of docs) purchaseSuppliers.set(doc.id, doc.supplierPartyId);
    }
    const salesCustomers = new Map<string, string>();
    if (salesDocIds.size > 0) {
      const docs = await tx.salesDocument.findMany({
        where: { id: { in: [...salesDocIds] }, companyId },
        select: { id: true, customerPartyId: true },
      });
      for (const doc of docs) salesCustomers.set(doc.id, doc.customerPartyId);
    }
    const fallbackSupplier = [...new Set(purchaseSuppliers.values())][0] ?? null;
    const fallbackCustomer = loading.customerPartyId ?? ([...new Set(salesCustomers.values())][0] ?? null);

    // Warehouse routes need the INTERNAL location (explicit or default).
    let internalWarehouseId: string | null = null;
    let internalLocationId: string | null = null;
    if (loading.route !== LoadingRoute.DIRECT_SUPPLIER_TO_CUSTOMER) {
      const warehouse = loading.warehouseId
        ? await tx.warehouse.findFirst({
            where: { id: loading.warehouseId, companyId },
            select: { id: true },
          })
        : await this.inventory.ensureDefaultWarehouse(tx, companyId);
      if (!warehouse) throw new NotFoundError('Warehouse not found', { warehouseId: loading.warehouseId });
      internalWarehouseId = warehouse.id;
      const internal = await this.inventory.resolveLocation(tx, companyId, {
        type: 'INTERNAL',
        warehouseId: warehouse.id,
      });
      internalLocationId = internal.id;
    }

    const perLine = new Map<object, MovementEndpoints>();
    for (const line of lines) {
      if (!effectiveUoms.has(line)) {
        throw new ValidationError(LOADING_MESSAGES.uomRequired, { loadingId: loading.id });
      }
      const supplierPartyId =
        line.allocations?.map((a) => (a.purchaseLineId ? purchaseSuppliers.get(purchaseLines.get(a.purchaseLineId)?.documentId ?? '') : undefined)).find((id): id is string => !!id) ??
        fallbackSupplier;
      const customerPartyId =
        loading.customerPartyId ??
        line.allocations?.map((a) => (a.salesLineId ? salesCustomers.get(salesLines.get(a.salesLineId)?.documentId ?? '') : undefined)).find((id): id is string => !!id) ??
        fallbackCustomer;

      const supplierLocation = await this.inventory.resolveLocation(tx, companyId, {
        type: 'SUPPLIER',
        partyId: supplierPartyId,
      });
      const customerLocation = await this.inventory.resolveLocation(tx, companyId, {
        type: 'CUSTOMER',
        partyId: customerPartyId,
      });

      let endpoints: MovementEndpoints;
      switch (loading.route) {
        case LoadingRoute.DIRECT_SUPPLIER_TO_CUSTOMER:
          endpoints = {
            sourceLocationId: supplierLocation.id,
            destinationLocationId: customerLocation.id,
            warehouseId: null,
          };
          break;
        case LoadingRoute.WAREHOUSE_TO_CUSTOMER:
          endpoints = {
            sourceLocationId: internalLocationId as string,
            destinationLocationId: customerLocation.id,
            warehouseId: internalWarehouseId,
          };
          break;
        case LoadingRoute.SUPPLIER_TO_WAREHOUSE:
          endpoints = {
            sourceLocationId: supplierLocation.id,
            destinationLocationId: internalLocationId as string,
            warehouseId: internalWarehouseId,
          };
          break;
      }
      perLine.set(line, endpoints);
    }
    return { perLine, warehouseId: internalWarehouseId };
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

  /** WAREHOUSE routes demand an explicit warehouse (Integrity Gate #10). */
  private assertRouteWarehouse(route: LoadingRoute | undefined, warehouseId: string | null): void {
    if (
      (route === LoadingRoute.WAREHOUSE_TO_CUSTOMER || route === LoadingRoute.SUPPLIER_TO_WAREHOUSE) &&
      !warehouseId
    ) {
      throw new ValidationError(LOADING_MESSAGES.warehouseRequired, { route });
    }
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
   * Resolve variants (same company) + uoms for every line and compute each
   * line's EFFECTIVE uom (the line's own, else the variant default, else the
   * template's default sales uom — none resolvable is a 422 UOM_REQUIRED).
   * Returns the effective uom per line OBJECT (works for both API inputs and
   * DB-loaded rows).
   */
  private async resolveEffectiveUoms(
    tx: Client,
    companyId: string,
    lines: { productVariantId: string; uomId?: string | null }[],
  ): Promise<Map<object, string>> {
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

    const map = new Map<object, string>();
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
      map.set(line, effective);
    }
    return map;
  }

  /**
   * The over-allocation guard — the sales↔purchase allocation locking pattern
   * (SERIALIZABLE caller + FOR UPDATE row locks in consistent id order).
   * Loading allocations consume ordered quantity on BOTH sales and purchase
   * lines: Σ(loading allocations of every non-cancelled AND non-reversed
   * loading) + proposed ≤ orderedQuantity, per line — everything converted
   * into the TARGET document line's uom first (the allocation quantity is
   * expressed in the loading line's uom; Integrity Gate #3). Variant
   * mismatch, foreign-company lines and impossible conversions are rejected.
   *
   * Returns the locked target lines AND the converted quantity per
   * allocation OBJECT (used by the operational amount recompute).
   */
  private async validateAllocations(
    tx: Client,
    companyId: string,
    lines: { productVariantId: string; allocations?: LoadingAllocationInput[] }[],
    effectiveUoms: Map<object, string>,
    options: { excludeLoadingId?: string },
  ): Promise<{
    salesLines: Map<string, AllocationLineRow>;
    purchaseLines: Map<string, AllocationLineRow>;
    converted: Map<object, Prisma.Decimal>;
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
          uomId: true,
          salesDocumentId: true,
        },
      });
      for (const row of rows) {
        salesLines.set(row.id, {
          id: row.id,
          productVariantId: row.productVariantId,
          orderedQuantity: row.orderedQuantity,
          unitPrice: row.unitPrice,
          uomId: row.uomId,
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
          uomId: true,
          purchaseDocumentId: true,
        },
      });
      for (const row of rows) {
        purchaseLines.set(row.id, {
          id: row.id,
          productVariantId: row.productVariantId,
          orderedQuantity: row.orderedQuantity,
          unitPrice: row.unitPrice,
          uomId: row.uomId,
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

    // Consumed = loading allocations of every non-cancelled AND non-reversed
    // loading (DRAFT reservations count — fail fast; confirm re-validates
    // under lock), each converted into the TARGET line's uom (mixed source
    // uoms must never be raw-summed — Integrity Gate #1).
    const loadingFilter = {
      status: { notIn: [LoadingStatus.CANCELLED, LoadingStatus.REVERSED] },
      ...(options.excludeLoadingId ? { id: { not: options.excludeLoadingId } } : {}),
    };
    const consumed = new Map<string, Prisma.Decimal>();
    const accumulate = (lineId: string, quantity: Prisma.Decimal) => {
      consumed.set(lineId, D(consumed.get(lineId)).plus(quantity));
    };

    // Variant defaults for stored loading lines without an explicit uom.
    const storedVariantIds = new Set<string>();
    interface StoredAllocationRow {
      salesLineId: string | null;
      purchaseLineId: string | null;
      allocatedQuantity: Prisma.Decimal;
      loadingLine: { productVariantId: string; uomId: string | null };
    }
    const fetchStored = async (
      field: 'salesLineId' | 'purchaseLineId',
      ids: string[],
    ): Promise<StoredAllocationRow[]> =>
      ids.length === 0
        ? []
        : ((await tx.loadingAllocation.findMany({
            where: {
              companyId,
              [field]: { in: ids },
              loadingLine: { loading: loadingFilter },
            },
            select: {
              salesLineId: true,
              purchaseLineId: true,
              allocatedQuantity: true,
              loadingLine: { select: { productVariantId: true, uomId: true } },
            },
          })) as StoredAllocationRow[]);
    const [storedSales, storedPurchase] = await Promise.all([
      fetchStored('salesLineId', [...salesLineIds]),
      fetchStored('purchaseLineId', [...purchaseLineIds]),
    ]);
    for (const row of [...storedSales, ...storedPurchase]) {
      storedVariantIds.add(row.loadingLine.productVariantId);
    }
    const storedVariants =
      storedVariantIds.size > 0
        ? await tx.productVariant.findMany({
            where: { id: { in: [...storedVariantIds] }, companyId },
            select: { id: true, defaultUomId: true, template: { select: { defaultSalesUomId: true } } },
          })
        : [];
    const storedVariantMap = new Map(storedVariants.map((v) => [v.id, v]));

    const convertedConsumed = async (
      row: {
        allocatedQuantity: Prisma.Decimal;
        loadingLine: { productVariantId: string; uomId: string | null };
      },
      targetUomId: string,
    ): Promise<Prisma.Decimal> => {
      const variant = storedVariantMap.get(row.loadingLine.productVariantId);
      const sourceUom =
        row.loadingLine.uomId ?? variant?.defaultUomId ?? variant?.template.defaultSalesUomId;
      if (!sourceUom) throw new ValidationError(LOADING_MESSAGES.uomRequired);
      return this.normalization.convertBetween(
        companyId,
        row.loadingLine.productVariantId,
        row.allocatedQuantity,
        sourceUom,
        targetUomId,
      );
    };

    for (const row of storedSales) {
      const target = row.salesLineId ? salesLines.get(row.salesLineId) : undefined;
      if (target) accumulate(target.id, await convertedConsumed(row, target.uomId));
    }
    for (const row of storedPurchase) {
      const target = row.purchaseLineId ? purchaseLines.get(row.purchaseLineId) : undefined;
      if (target) accumulate(target.id, await convertedConsumed(row, target.uomId));
    }

    // Proposed allocations, converted to the target uom before comparison.
    const converted = new Map<object, Prisma.Decimal>();
    for (const line of lines) {
      const lineUom = effectiveUoms.get(line);
      if (!lineUom) throw new ValidationError(LOADING_MESSAGES.uomRequired);
      for (const allocation of line.allocations ?? []) {
        const lineId = (allocation.salesLineId ?? allocation.purchaseLineId) as string;
        const target = salesLines.get(lineId) ?? purchaseLines.get(lineId);
        if (!target) {
          throw new NotFoundError('Allocation target line not found', { lineId });
        }
        let allocatedInTargetUom: Prisma.Decimal;
        try {
          allocatedInTargetUom = await this.normalization.convertBetween(
            companyId,
            line.productVariantId,
            allocation.allocatedQuantity,
            lineUom,
            target.uomId,
          );
        } catch (error) {
          if (error instanceof ValidationError && error.message === 'UOM_CONVERSION_IMPOSSIBLE') {
            throw new ValidationError(LOADING_MESSAGES.allocationUomIncompatible, {
              lineId,
              loadingUomId: lineUom,
              targetUomId: target.uomId,
            });
          }
          throw error;
        }
        const proposed = D(consumed.get(lineId)).plus(allocatedInTargetUom);
        if (proposed.gt(target.orderedQuantity)) {
          throw new ConflictError(LOADING_MESSAGES.exceedsQuantity, {
            lineId,
            orderedQuantity: target.orderedQuantity.toString(),
            allocated: proposed.toString(),
          });
        }
        consumed.set(lineId, proposed);
        converted.set(allocation, allocatedInTargetUom);
      }
    }

    return { salesLines, purchaseLines, converted };
  }

  // ───────────────────────── operational amounts (full recompute) ─────────────────────────

  /** All document ids touched by a loading's allocations (sales + purchase). */
  private async loadingDocumentIds(
    tx: Client,
    companyId: string,
    lines: { allocations?: { salesLineId: string | null; purchaseLineId: string | null }[] }[],
  ): Promise<{ sales: Set<string>; purchase: Set<string> }> {
    const salesIds = new Set<string>();
    const purchaseIds = new Set<string>();
    const salesLineIds: string[] = [];
    const purchaseLineIds: string[] = [];
    for (const line of lines) {
      for (const allocation of line.allocations ?? []) {
        if (allocation.salesLineId) salesLineIds.push(allocation.salesLineId);
        if (allocation.purchaseLineId) purchaseLineIds.push(allocation.purchaseLineId);
      }
    }
    if (salesLineIds.length > 0) {
      const rows = await tx.salesLine.findMany({
        where: { id: { in: salesLineIds }, companyId },
        select: { salesDocumentId: true },
      });
      rows.forEach((r) => salesIds.add(r.salesDocumentId));
    }
    if (purchaseLineIds.length > 0) {
      const rows = await tx.purchaseLine.findMany({
        where: { id: { in: purchaseLineIds }, companyId },
        select: { purchaseDocumentId: true },
      });
      rows.forEach((r) => purchaseIds.add(r.purchaseDocumentId));
    }
    return { sales: salesIds, purchase: purchaseIds };
  }

  /**
   * (c) operational loaded amounts + status recompute.
   *
   * PURCHASE documents (final correction #1): absolute recompute from the
   * PurchaseLineFulfillment LEDGER (GOODS_RECEIPT + DIRECT_LOADING rows,
   * reversedAt IS NULL) — replacing the old last-write-wins allocation
   * recompute; a purchase document touched by ANY loading reflects the
   * receipts and direct loadings of ALL its lines.
   *
   * SALES documents keep the allocation-driven FULL recompute from the
   * allocations of every non-cancelled AND non-reversed loading: each
   * allocation is converted from its loading line's uom into the DOCUMENT
   * line's uom (Integrity Gate #3), the amount = Σ converted × line.unitPrice
   * (exact Decimal). Shared by confirm (upgrade-only status) and reverse
   * (status may fall back to the base active status).
   */
  private async recomputeOperationalState(
    tx: Client,
    companyId: string,
    docIds: { sales: Set<string>; purchase: Set<string> },
    mode: 'confirm' | 'reverse' = 'confirm',
  ): Promise<void> {
    const activeLoadingFilter = {
      status: { notIn: [LoadingStatus.CANCELLED, LoadingStatus.REVERSED] },
    };
    if (docIds.sales.size === 0 && docIds.purchase.size === 0) return;

    await this.fulfillments.recomputeDocuments(tx, companyId, docIds.purchase, mode);
    if (docIds.sales.size === 0) return;

    // Variant defaults for stored loading lines without an explicit uom
    // (one pre-pass over every sales allocation of the touched documents).
    const salesPre = await tx.salesLine.findMany({
      where: { salesDocumentId: { in: [...docIds.sales] }, companyId },
      select: {
        loadingAllocations: {
          where: { loadingLine: { loading: activeLoadingFilter } },
          select: { loadingLine: { select: { productVariantId: true } } },
        },
      },
    });

    const variantIds = new Set<string>();
    for (const row of salesPre) {
      for (const alloc of row.loadingAllocations) variantIds.add(alloc.loadingLine.productVariantId);
    }
    const variants =
      variantIds.size > 0
        ? await tx.productVariant.findMany({
            where: { id: { in: [...variantIds] }, companyId },
            select: { id: true, defaultUomId: true, template: { select: { defaultSalesUomId: true } } },
          })
        : [];
    const variantMap = new Map(
      variants.map((v) => [
        v.id,
        { defaultUomId: v.defaultUomId, template: { defaultSalesUomId: v.template.defaultSalesUomId } },
      ]),
    );

    // ── Per-sales-document aggregation (one update per document) ──
    for (const docId of docIds.sales) {
      const doc = await tx.salesDocument.findFirst({
        where: { id: docId, companyId },
        select: {
          id: true,
          status: true,
          lines: {
            select: {
              id: true,
              orderedQuantity: true,
              uomId: true,
              unitPrice: true,
              loadingAllocations: {
                where: { loadingLine: { loading: activeLoadingFilter } },
                select: {
                  allocatedQuantity: true,
                  loadingLine: { select: { productVariantId: true, uomId: true } },
                },
              },
            },
          },
        },
      });
      if (!doc) continue;
      let loadedAmount = D(0);
      let someLoaded = false;
      let allFullyLoaded = doc.lines.length > 0;
      for (const line of doc.lines) {
        const loaded = await this.lineLoadedQuantity(companyId, line, variantMap);
        loadedAmount = loadedAmount.plus(loaded.times(line.unitPrice));
        if (loaded.gt(0)) someLoaded = true;
        if (loaded.lt(D(line.orderedQuantity))) allFullyLoaded = false;
      }
      const status = this.documentStatusAfter('sales', doc.status, someLoaded, allFullyLoaded, mode);
      await tx.salesDocument.update({
        where: { id: doc.id },
        data: {
          operationalLoadedAmount: loadedAmount,
          ...(status ? { status: status as SalesDocumentStatus } : {}),
        },
      });
    }
  }

  /** Loaded quantity of ONE document line across all active loadings (converted). */
  private async lineLoadedQuantity(
    companyId: string,
    line: {
      uomId: string;
      orderedQuantity: Prisma.Decimal;
      loadingAllocations: {
        allocatedQuantity: Prisma.Decimal;
        loadingLine: { productVariantId: string; uomId: string | null };
      }[];
    },
    variantMap: Map<string, { defaultUomId: string | null; template: { defaultSalesUomId: string | null } }>,
  ): Promise<Prisma.Decimal> {
    let loaded = D(0);
    for (const alloc of line.loadingAllocations) {
      const variant = variantMap.get(alloc.loadingLine.productVariantId);
      const sourceUom =
        alloc.loadingLine.uomId ?? variant?.defaultUomId ?? variant?.template.defaultSalesUomId;
      if (!sourceUom) throw new ValidationError(LOADING_MESSAGES.uomRequired);
      loaded = loaded.plus(
        await this.normalization.convertBetween(
          companyId,
          alloc.loadingLine.productVariantId,
          alloc.allocatedQuantity,
          sourceUom,
          line.uomId,
        ),
      );
    }
    return loaded;
  }

  /**
   * Document status after a confirm (upgrade-only) or a reversal (may fall
   * back to the base active status). COMPLETED is never upgraded twice;
   * only the document's "active" statuses participate.
   */
  private documentStatusAfter(
    kind: 'sales' | 'purchase',
    current: string,
    someLoaded: boolean,
    allFullyLoaded: boolean,
    mode: 'confirm' | 'reverse',
  ): string | null {
    const base = kind === 'sales' ? 'SALES_ORDER' : 'ORDER_PLACED';
    const applicable =
      mode === 'confirm'
        ? kind === 'sales'
          ? ['SALES_ORDER', 'PARTIALLY_LOADED']
          : ['ORDER_PLACED', 'PARTIALLY_LOADED']
        : kind === 'sales'
          ? ['SALES_ORDER', 'PARTIALLY_LOADED', 'COMPLETED']
          : ['ORDER_PLACED', 'PARTIALLY_LOADED', 'COMPLETED'];
    if (!applicable.includes(current)) return null;
    if (mode === 'confirm') {
      if (current === 'COMPLETED') return null;
      if (!someLoaded) return null;
      return allFullyLoaded ? 'COMPLETED' : 'PARTIALLY_LOADED';
    }
    // reverse: recompute outright (a reversal can strip a document back).
    if (!someLoaded) return base;
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
