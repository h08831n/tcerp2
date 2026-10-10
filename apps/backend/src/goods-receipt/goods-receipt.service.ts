import { Injectable } from '@nestjs/common';
import {
  GoodsReceiptStatus,
  Prisma,
  PurchaseFulfillmentType,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { TimelineService } from '../parties/timeline.service';
import { DocumentRelationService } from '../document-flow/document-relation.service';
import { InventoryService } from '../inventory/inventory.service';
import { NormalizationService } from '../inventory/normalization.service';
import { PurchaseFulfillmentService } from '../purchase/purchase-fulfillment.service';
import { SequencesService } from '../sequences/sequences.service';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../common/errors';
import { D, roundQuantity } from '../common/utils/money';
import { RequestContext } from '../auth/auth.service';
import { Paginated } from '../common/dto/pagination.dto';
import {
  CreateGoodsReceiptDto,
  GoodsReceiptQueryDto,
} from './goods-receipt.dto';

type Client = Prisma.TransactionClient | PrismaService;

export const GOODS_RECEIPT_MESSAGES = {
  linesRequired: 'GOODS_RECEIPT_LINES_REQUIRED',
  lineQuantityPositive: 'GOODS_RECEIPT_LINE_QUANTITY_POSITIVE',
  purchaseLineMismatch: 'PURCHASE_LINE_MISMATCH',
  destinationInvalid: 'DESTINATION_LOCATION_INVALID',
  uomNotInCompany: 'UOM_NOT_IN_COMPANY',
  confirmed: 'GOODS_RECEIPT_CONFIRMED',
  notReversible: 'GOODS_RECEIPT_NOT_REVERSIBLE',
  invalidTransition: 'INVALID_STATUS_TRANSITION',
  reversalReasonRequired: 'REVERSAL_REASON_REQUIRED',
} as const;

export interface GoodsReceiptLineInput {
  purchaseLineId: string;
  actualQuantity: number | string | Prisma.Decimal;
  uomId: string;
  notes?: string | null;
}

/**
 * Goods receipts (Integrity Gate #9, REQUIREMENTS §11): REAL partial
 * warehouse receipts. The ACTUAL physical quantity received — never the PO
 * ordered quantity — drives stock. Lifecycle DRAFT → CONFIRMED → REVERSED
 * (+ DRAFT → CANCELLED); a CONFIRMED receipt is immutable and corrected via
 * REVERSED + compensating movements.
 *
 * create()  — DRAFT receipt: GRN number from the `GOODS_RECEIPT` sequence,
 *             destination resolves to an INTERNAL location (explicit
 *             destinationLocationId, a warehouseId, or the company default
 *             warehouse). Over-receipt is ALLOWED (flagged per line, never
 *             blocked).
 * confirm() — ONE serializable transaction that:
 *   (a) inserts one IN StockMovement per line SUPPLIER(po supplier) →
 *       INTERNAL(destination) with idempotencyKey
 *       `grn:{receiptId}:line:{lineId}` (ON CONFLICT DO NOTHING — the unique
 *       key is the only duplicate authority), each carrying the COST
 *       SNAPSHOT (final correction #3): unitCost = PO line unitPrice
 *       converted to a per-inventory-UOM cost via the normalization service,
 *       totalCost = normalizedQuantity × unitCost computed by the writer;
 *   (b) upserts one PurchaseLineFulfillment GOODS_RECEIPT row per line
 *       (final correction #1) — quantity converted to the PO line's uom,
 *       amount = convertedQty × PO line unitPrice — and RECOMPUTES the
 *       purchase `operationalLoadedAmount` + status from the fulfillment
 *       ledger (absolute recompute, shared with the loading flow);
 *   (c) persists the per-line OVER-RECEIPT SNAPSHOTS (final correction #2):
 *       orderedQuantitySnapshot (PO ordered quantity in the receipt line's
 *       uom), receivedQuantitySnapshot (all CONFIRMED receipt quantities of
 *       that purchase line in the receipt line's uom, INCLUDING this one)
 *       and overReceivedSnapshot = max(0, received − ordered) — immutable
 *       history, never recomputed afterwards;
 *   (d) writes purchase_document ↔ goods_receipt RELATED relations and the
 *       audit + timeline rows — all atomic.
 * reverse() — ONE serializable transaction: reason REQUIRED, compensating
 *             movements (swapped endpoints, reversalOfMovementId linkage,
 *             key `grn-rev:{receiptId}:line:{lineId}`, unitCost copied and
 *             totalCost NEGATED), the GOODS_RECEIPT fulfillment rows are
 *             marked reversedAt (kept for history) and the purchase
 *             operational amount + status are recomputed from the ledger;
 *             the original receipt is REVERSED forever and its snapshots
 *             stay untouched (immutable).
 *
 * The `overReceipt` flag is DERIVED (no column): cumulative received across
 * CONFIRMED receipts of the purchase line (converted into the PO line's uom)
 * > orderedQuantity.
 */
@Injectable()
export class GoodsReceiptService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sequences: SequencesService,
    private readonly auditService: AuditService,
    private readonly timeline: TimelineService,
    private readonly relations: DocumentRelationService,
    private readonly inventory: InventoryService,
    private readonly normalization: NormalizationService,
    private readonly fulfillments: PurchaseFulfillmentService,
  ) {}

  // ───────────────────────── create (DRAFT) ─────────────────────────

  async create(
    companyId: string,
    dto: CreateGoodsReceiptDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    const lines = this.normalizeLineInputs(dto.lines);

    const created = await this.prisma.$transaction(
      async (tx) => {
        const purchase = await tx.purchaseDocument.findFirst({
          where: { id: dto.purchaseDocumentId, companyId },
          include: { lines: { select: { id: true } } },
        });
        if (!purchase) {
          throw new NotFoundError('Purchase document not found', { id: dto.purchaseDocumentId });
        }
        await this.assertLinesBelongToPurchase(dto.lines, purchase.lines.map((l) => l.id));
        await this.assertUomsInCompany(tx, companyId, lines);

        const destination = await this.resolveDestination(tx, companyId, dto);
        const receiptDate = dto.receiptDate ? new Date(dto.receiptDate) : new Date();
        const { number: receiptNumber } = await this.sequences.allocate(
          companyId,
          'GOODS_RECEIPT',
          tx,
          receiptDate,
        );

        const row = await tx.goodsReceipt.create({
          data: {
            companyId,
            receiptNumber,
            purchaseDocumentId: purchase.id,
            destinationLocationId: destination.id,
            receiptDate,
            status: GoodsReceiptStatus.DRAFT,
            notes: dto.notes ?? null,
            createdBy: actor.id,
            lines: {
              create: lines.map((line) => ({
                purchaseLineId: line.purchaseLineId,
                actualQuantity: roundQuantity(D(line.actualQuantity)),
                uomId: line.uomId,
                notes: line.notes ?? null,
              })),
            },
          },
          include: { lines: true },
        });

        await this.auditService.recordTx(tx, {
          entityType: 'goods_receipt',
          entityId: row.id,
          action: 'CREATE',
          companyId,
          actor,
          newValues: {
            receiptNumber,
            purchaseDocumentId: purchase.id,
            destinationLocationId: destination.id,
            lineCount: lines.length,
          },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return row;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    return this.getById(companyId, created.id);
  }

  // ───────────────────────── confirm (the physical event) ─────────────────────────

  async confirm(
    companyId: string,
    id: string,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    await this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM goods_receipts WHERE id = ${id}::uuid FOR UPDATE`;
        const receipt = await tx.goodsReceipt.findFirst({
          where: { id, companyId },
          include: { lines: true },
        });
        if (!receipt) throw new NotFoundError('Goods receipt not found', { id });
        if (receipt.status === GoodsReceiptStatus.CONFIRMED) {
          throw new ForbiddenError(GOODS_RECEIPT_MESSAGES.confirmed, { id });
        }
        if (receipt.status !== GoodsReceiptStatus.DRAFT) {
          throw new ValidationError(GOODS_RECEIPT_MESSAGES.invalidTransition, {
            from: receipt.status,
            to: 'CONFIRMED',
          });
        }

        const purchase = await tx.purchaseDocument.findFirstOrThrow({
          where: { id: receipt.purchaseDocumentId, companyId },
          select: { id: true, supplierPartyId: true },
        });
        const destination = await tx.stockLocation.findFirstOrThrow({
          where: { id: receipt.destinationLocationId },
        });

        // SUPPLIER(po supplier) → INTERNAL(destination) per line.
        const supplierLocation = await this.inventory.resolveLocation(tx, companyId, {
          type: 'SUPPLIER',
          partyId: purchase.supplierPartyId,
        });

        const purchaseLineIds = receipt.lines.map((l) => l.purchaseLineId);
        const purchaseLines = await tx.purchaseLine.findMany({
          where: { id: { in: purchaseLineIds }, companyId },
          select: {
            id: true,
            productVariantId: true,
            orderedQuantity: true,
            uomId: true,
            unitPrice: true,
          },
        });
        const poLineByLine = new Map(purchaseLines.map((l) => [l.id, l]));

        for (const line of receipt.lines) {
          const poLine = poLineByLine.get(line.purchaseLineId);
          if (!poLine) {
            throw new NotFoundError('Purchase line not found', { purchaseLineId: line.purchaseLineId });
          }
          // Cost snapshot (final #3): PO unit price per ONE inventory-UOM unit
          // (unitPrice ÷ factor(purchaseUom → inventoryUom)); the writer
          // multiplies it by the normalized quantity into totalCost.
          const unitCost = await this.fulfillments.unitCostPerInventoryUom(
            companyId,
            poLine.productVariantId,
            poLine,
          );
          await this.normalization.insertStockMovement(tx, {
            companyId,
            productVariantId: poLine.productVariantId,
            quantity: line.actualQuantity,
            uomId: line.uomId,
            direction: 'IN',
            sourceLocationId: supplierLocation.id,
            destinationLocationId: destination.id,
            warehouseId: destination.warehouseId,
            movementDate: receipt.receiptDate,
            sourceEntityType: 'PURCHASE_RECEIPT',
            sourceEntityId: receipt.id,
            idempotencyKey: `grn:${receipt.id}:line:${line.id}`,
            createdBy: actor.id,
            unitCostSnapshot: unitCost,
          });
          // Fulfillment ledger row (final #1): THIS receipt's contribution to
          // the purchase line, in the PO line's uom.
          const converted = await this.normalization.convertBetween(
            companyId,
            poLine.productVariantId,
            line.actualQuantity,
            line.uomId,
            poLine.uomId,
          );
          await this.fulfillments.upsertGoodsReceiptFulfillment(tx, companyId, {
            purchaseLineId: line.purchaseLineId,
            goodsReceiptId: receipt.id,
            quantity: converted,
            uomId: poLine.uomId,
            amount: converted.times(poLine.unitPrice),
          });
        }

        await tx.goodsReceipt.update({
          where: { id: receipt.id },
          data: { status: GoodsReceiptStatus.CONFIRMED },
        });

        // Over-receipt snapshots (final #2) — after the status flip above, so
        // "all CONFIRMED receipt quantities" naturally includes THIS receipt.
        await this.persistOverReceiptSnapshots(tx, companyId, receipt);

        // Purchase operational amount + status recomputed from the fulfillment
        // ledger (GRN + direct-loading rows; absolute recompute, shared with
        // the loading flow).
        await this.fulfillments.recomputeDocuments(tx, companyId, [purchase.id], 'confirm');

        // purchase_document ↔ goods_receipt RELATED relations (both ways).
        await this.relations.createRelation(
          companyId,
          {
            fromType: 'goods_receipt',
            fromId: receipt.id,
            toType: 'purchase_document',
            toId: purchase.id,
            relationType: 'RELATED',
          },
          actor,
          ctx,
          tx,
        );
        await this.relations.createRelation(
          companyId,
          {
            fromType: 'purchase_document',
            fromId: purchase.id,
            toType: 'goods_receipt',
            toId: receipt.id,
            relationType: 'RELATED',
          },
          actor,
          ctx,
          tx,
        );

        await this.auditService.recordTx(tx, {
          entityType: 'goods_receipt',
          entityId: receipt.id,
          action: 'CONFIRM',
          companyId,
          actor,
          oldValues: { status: receipt.status },
          newValues: {
            status: GoodsReceiptStatus.CONFIRMED,
            movementCount: receipt.lines.length,
            destinationLocationId: destination.id,
          },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        if (purchase.supplierPartyId) {
          await this.timeline.record(tx, {
            companyId,
            entityType: 'PARTY',
            entityId: purchase.supplierPartyId,
            type: 'RECEIPT_CONFIRMED',
            title: 'رسید انبار تایید شد',
            description: 'وارد کردن کالا به انبار با رسید خرید ثبت شد',
            data: { goodsReceiptId: receipt.id, receiptNumber: receipt.receiptNumber },
            actorUserId: actor.id,
          });
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    return this.getById(companyId, id);
  }

  // ───────────────────────── reverse ─────────────────────────

  async reverse(
    companyId: string,
    id: string,
    dto: { reason: string },
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    const reason = dto.reason?.trim();
    if (!reason) {
      throw new ValidationError(GOODS_RECEIPT_MESSAGES.reversalReasonRequired, { id });
    }

    await this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM goods_receipts WHERE id = ${id}::uuid FOR UPDATE`;
        const receipt = await tx.goodsReceipt.findFirst({
          where: { id, companyId },
          include: { lines: true },
        });
        if (!receipt) throw new NotFoundError('Goods receipt not found', { id });
        if (receipt.status !== GoodsReceiptStatus.CONFIRMED) {
          throw new ConflictError(GOODS_RECEIPT_MESSAGES.notReversible, { status: receipt.status });
        }

        // Compensating movements: one per original, endpoints swapped, the
        // original's normalized values reused verbatim (the compensation
        // un-does exactly what was applied). Cost snapshots (final #3): the
        // compensating row copies the original's unitCost and carries the
        // NEGATED totalCost — the valuation is un-done without ever touching
        // the original row.
        const originals = await tx.stockMovement.findMany({
          where: {
            sourceEntityType: 'PURCHASE_RECEIPT',
            sourceEntityId: receipt.id,
            reversalOfMovementId: null,
          },
          orderBy: { createdAt: 'asc' },
        });
        for (const original of originals) {
          const lineId = original.idempotencyKey.split(':line:')[1] ?? original.id;
          await NormalizationService.insertNormalizedMovement(tx, {
            companyId: receipt.companyId,
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
            sourceEntityType: 'RECEIPT_REVERSAL',
            sourceEntityId: receipt.id,
            idempotencyKey: `grn-rev:${receipt.id}:line:${lineId}`,
            reversalOfMovementId: original.id,
            createdBy: actor.id,
            unitCostSnapshot: original.unitCostSnapshot,
            totalCostSnapshot: original.totalCostSnapshot === null ? null : D(original.totalCostSnapshot).neg(),
          });
        }

        await tx.goodsReceipt.update({
          where: { id: receipt.id },
          data: { status: GoodsReceiptStatus.REVERSED, reversalReason: reason },
        });

        // The receipt's fulfillment rows stay (history) but flip reversedAt;
        // the purchase operational amount + status are then recomputed from
        // the live ledger rows only (absolute recompute — may fall back).
        await this.fulfillments.reverseBySource(tx, PurchaseFulfillmentType.GOODS_RECEIPT, receipt.id);
        await this.fulfillments.recomputeDocuments(
          tx,
          companyId,
          [receipt.purchaseDocumentId],
          'reverse',
        );

        await this.auditService.recordTx(tx, {
          entityType: 'goods_receipt',
          entityId: receipt.id,
          action: 'RECEIPT_REVERSED',
          companyId,
          actor,
          oldValues: { status: GoodsReceiptStatus.CONFIRMED },
          newValues: {
            status: GoodsReceiptStatus.REVERSED,
            reversalReason: reason,
            compensatingMovements: originals.length,
          },
          reason,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        const purchase = await tx.purchaseDocument.findFirst({
          where: { id: receipt.purchaseDocumentId, companyId },
          select: { supplierPartyId: true },
        });
        if (purchase?.supplierPartyId) {
          await this.timeline.record(tx, {
            companyId,
            entityType: 'PARTY',
            entityId: purchase.supplierPartyId,
            type: 'RECEIPT_REVERSED',
            title: 'رسید انبار برعکس شد',
            description: 'رسید خرید با حرکات جبرانی لغو و موجودی اصلاح شد',
            data: { goodsReceiptId: receipt.id, compensatingMovements: originals.length },
            actorUserId: actor.id,
          });
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    return this.getById(companyId, id);
  }

  // ───────────────────────── cancel (DRAFT only) ─────────────────────────

  async cancel(
    companyId: string,
    id: string,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    const receipt = await this.prisma.goodsReceipt.findFirst({ where: { id, companyId } });
    if (!receipt) throw new NotFoundError('Goods receipt not found', { id });
    if (receipt.status === GoodsReceiptStatus.DRAFT) {
      await this.prisma.$transaction(async (tx) => {
        await tx.goodsReceipt.update({
          where: { id: receipt.id },
          data: { status: GoodsReceiptStatus.CANCELLED },
        });
        await this.auditService.recordTx(tx, {
          entityType: 'goods_receipt',
          entityId: receipt.id,
          action: 'CANCEL',
          companyId,
          actor,
          oldValues: { status: receipt.status },
          newValues: { status: GoodsReceiptStatus.CANCELLED },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
      });
    } else if (receipt.status !== GoodsReceiptStatus.CANCELLED) {
      // CONFIRMED receipts are corrected via reverse; REVERSED is immutable.
      throw new ValidationError(GOODS_RECEIPT_MESSAGES.invalidTransition, {
        from: receipt.status,
        to: 'CANCELLED',
      });
    }
    return this.getById(companyId, id);
  }

  // ───────────────────────── reads ─────────────────────────

  async getById(companyId: string, id: string) {
    const receipt = await this.prisma.goodsReceipt.findFirst({
      where: { id, companyId },
      include: {
        destinationLocation: {
          select: { id: true, code: true, type: true, nameFa: true, warehouseId: true },
        },
        purchaseDocument: {
          select: { id: true, documentNumber: true, status: true, supplierPartyId: true },
        },
        lines: {
          orderBy: { createdAt: 'asc' },
          include: {
            purchaseLine: {
              select: {
                id: true,
                orderedQuantity: true,
                uomId: true,
                unitPrice: true,
                productVariantId: true,
                productVariant: { select: { id: true, sku: true, nameFa: true } },
                uom: { select: { id: true, symbol: true } },
              },
            },
            uom: { select: { id: true, symbol: true } },
          },
        },
      },
    });
    if (!receipt) throw new NotFoundError('Goods receipt not found', { id });

    // Reversal linkage (no schema relation — queried on the reversalOfId FK).
    const [reversalOf, reversals] = await Promise.all([
      receipt.reversalOfId
        ? this.prisma.goodsReceipt.findFirst({
            where: { id: receipt.reversalOfId, companyId },
            select: { id: true, receiptNumber: true, status: true, reversalReason: true },
          })
        : Promise.resolve(null),
      receipt.status === GoodsReceiptStatus.REVERSED
        ? this.prisma.goodsReceipt.findMany({
            where: { reversalOfId: receipt.id, companyId },
            select: { id: true, receiptNumber: true, status: true, reversalReason: true },
          })
        : Promise.resolve([]),
    ]);
    const movements = await this.prisma.stockMovement.findMany({
      where: { sourceEntityType: 'PURCHASE_RECEIPT', sourceEntityId: receipt.id },
      select: { id: true, idempotencyKey: true, reversalOfMovementId: true },
    });

    const overReceipts = await this.overReceiptFlags(
      companyId,
      receipt.purchaseDocumentId,
      { id: receipt.id, createdAt: receipt.createdAt },
      receipt.lines.map((line) => ({
        purchaseLineId: line.purchaseLineId,
        actualQuantity: line.actualQuantity,
        uomId: line.uomId,
      })),
    );
    return {
      ...receipt,
      destinationLocation: receipt.destinationLocation,
      lines: receipt.lines.map((line) => ({
        ...line,
        overReceipt: overReceipts.get(line.purchaseLineId) ?? false,
      })),
      reversalOf,
      reversals,
      movements,
    };
  }

  async list(companyId: string, query: GoodsReceiptQueryDto): Promise<Paginated<unknown>> {
    const where: Prisma.GoodsReceiptWhereInput = {
      companyId,
      status: query.status,
      purchaseDocumentId: query.purchaseDocumentId,
      ...(query.from || query.to
        ? {
            receiptDate: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.goodsReceipt.findMany({
        where,
        orderBy: { receiptDate: 'desc' },
        skip: query.skip,
        take: query.take,
        include: {
          purchaseDocument: { select: { id: true, documentNumber: true } },
          destinationLocation: { select: { id: true, code: true, nameFa: true } },
          lines: { select: { id: true, actualQuantity: true } },
        },
      }),
      this.prisma.goodsReceipt.count({ where }),
    ]);
    return {
      items: items.map((receipt) => ({
        id: receipt.id,
        receiptNumber: receipt.receiptNumber,
        status: receipt.status,
        receiptDate: receipt.receiptDate,
        purchaseDocument: receipt.purchaseDocument,
        destinationLocation: receipt.destinationLocation,
        lineCount: receipt.lines.length,
        totalQuantity: receipt.lines
          .reduce((acc, line) => acc.plus(D(line.actualQuantity)), D(0))
          .toString(),
        reversalReason: receipt.reversalReason,
        createdAt: receipt.createdAt,
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  // ───────────────────────── internals ─────────────────────────

  private normalizeLineInputs(lines: GoodsReceiptLineInput[]): GoodsReceiptLineInput[] {
    if (!Array.isArray(lines) || lines.length === 0) {
      throw new ValidationError(GOODS_RECEIPT_MESSAGES.linesRequired);
    }
    const seen = new Set<string>();
    for (const line of lines) {
      if (!(D(line.actualQuantity).gt(0))) {
        throw new ValidationError(GOODS_RECEIPT_MESSAGES.lineQuantityPositive);
      }
      if (seen.has(line.purchaseLineId)) {
        throw new ValidationError(GOODS_RECEIPT_MESSAGES.linesRequired, {
          duplicatePurchaseLineId: line.purchaseLineId,
        });
      }
      seen.add(line.purchaseLineId);
    }
    return lines;
  }

  private assertLinesBelongToPurchase(
    lines: { purchaseLineId: string }[],
    purchaseLineIds: string[],
  ): void {
    const known = new Set(purchaseLineIds);
    for (const line of lines) {
      if (!known.has(line.purchaseLineId)) {
        throw new ValidationError(GOODS_RECEIPT_MESSAGES.purchaseLineMismatch, {
          purchaseLineId: line.purchaseLineId,
        });
      }
    }
  }

  private async assertUomsInCompany(tx: Client, companyId: string, lines: { uomId: string }[]) {
    const uomIds = [...new Set(lines.map((l) => l.uomId))];
    const uoms = await tx.uom.findMany({
      where: { id: { in: uomIds }, companyId, active: true },
      select: { id: true },
    });
    const known = new Set(uoms.map((u) => u.id));
    for (const line of lines) {
      if (!known.has(line.uomId)) {
        throw new ValidationError(GOODS_RECEIPT_MESSAGES.uomNotInCompany, { uomId: line.uomId });
      }
    }
  }

  /** Destination: explicit INTERNAL location → warehouse location → default. */
  private async resolveDestination(
    tx: Client,
    companyId: string,
    dto: { destinationLocationId?: string; warehouseId?: string },
  ) {
    if (dto.destinationLocationId) {
      const location = await tx.stockLocation.findFirst({
        where: { id: dto.destinationLocationId, companyId },
      });
      if (!location || location.type !== 'INTERNAL') {
        throw new ValidationError(GOODS_RECEIPT_MESSAGES.destinationInvalid, {
          destinationLocationId: dto.destinationLocationId,
        });
      }
      return location;
    }
    const warehouseId =
      dto.warehouseId ?? (await this.inventory.ensureDefaultWarehouse(tx, companyId)).id;
    return this.inventory.resolveLocation(tx, companyId, { type: 'INTERNAL', warehouseId });
  }

  /**
   * Over-receipt snapshots (final correction #2) — persisted ONCE, at confirm
   * time, and NEVER recomputed (immutable reporting history):
   *   - orderedQuantitySnapshot:  the PO line's ordered quantity expressed in
   *     THIS receipt line's uom (converted only when the uoms differ);
   *   - receivedQuantitySnapshot: every CONFIRMED receipt quantity of the
   *     purchase line converted into THIS receipt line's uom, INCLUDING this
   *     receipt itself (the status flip above makes the "all CONFIRMED"
   *     query see it);
   *   - overReceivedSnapshot:     max(0, received − ordered).
   * A later reversal (or any other recalculation) never rewrites them.
   */
  private async persistOverReceiptSnapshots(
    tx: Client,
    companyId: string,
    receipt: { id: string; purchaseDocumentId: string; lines: { id: string; purchaseLineId: string; actualQuantity: Prisma.Decimal; uomId: string }[] },
  ): Promise<void> {
    if (receipt.lines.length === 0) return;
    const purchaseLineIds = [...new Set(receipt.lines.map((l) => l.purchaseLineId))];
    const [purchaseLines, confirmedLines] = await Promise.all([
      tx.purchaseLine.findMany({
        where: { id: { in: purchaseLineIds }, purchaseDocumentId: receipt.purchaseDocumentId, companyId },
        select: { id: true, orderedQuantity: true, uomId: true, productVariantId: true },
      }),
      tx.goodsReceiptLine.findMany({
        where: {
          purchaseLineId: { in: purchaseLineIds },
          receipt: { companyId, status: GoodsReceiptStatus.CONFIRMED },
        },
        select: { purchaseLineId: true, actualQuantity: true, uomId: true },
      }),
    ]);
    const poByLine = new Map(purchaseLines.map((l) => [l.id, l]));

    for (const line of receipt.lines) {
      const poLine = poByLine.get(line.purchaseLineId);
      if (!poLine) continue;
      const toLineUom = (quantity: Prisma.Decimal, fromUomId: string): Promise<Prisma.Decimal> =>
        fromUomId === line.uomId
          ? Promise.resolve(D(quantity))
          : this.normalization.convertBetween(companyId, poLine.productVariantId, quantity, fromUomId, line.uomId);

      const ordered = await toLineUom(poLine.orderedQuantity, poLine.uomId);
      let received = D(0);
      for (const confirmed of confirmedLines.filter((c) => c.purchaseLineId === line.purchaseLineId)) {
        received = received.plus(await toLineUom(confirmed.actualQuantity, confirmed.uomId));
      }
      const over = received.gt(ordered) ? received.minus(ordered) : D(0);
      await tx.goodsReceiptLine.update({
        where: { id: line.id },
        data: {
          orderedQuantitySnapshot: roundQuantity(ordered),
          receivedQuantitySnapshot: roundQuantity(received),
          overReceivedSnapshot: roundQuantity(over),
        },
      });
    }
  }

  /**
   * Derived per-GRN-line over-receipt flags: the receipt that pushed (or
   * stayed) ABOVE the ordered quantity is the flagged one — cumulative
   * received INCLUDING this receipt (its own converted quantity + every
   * CONFIRMED receipt confirmed strictly before it) > orderedQuantity. The
   * receipt that is flagged is determined as of ITS OWN confirm, so earlier
   * under-receipt receipts are never retro-flagged by later ones.
   */
  private async overReceiptFlags(
    companyId: string,
    purchaseDocumentId: string,
    receipt: { id: string; createdAt: Date },
    receiptLines: { purchaseLineId: string; actualQuantity: Prisma.Decimal; uomId: string }[],
  ): Promise<Map<string, boolean>> {
    const flags = new Map<string, boolean>();
    const purchaseLineIds = [...new Set(receiptLines.map((l) => l.purchaseLineId))];
    if (purchaseLineIds.length === 0) return flags;

    const [purchaseLines, earlierLines] = await Promise.all([
      this.prisma.purchaseLine.findMany({
        where: { id: { in: purchaseLineIds }, purchaseDocumentId, companyId },
        select: { id: true, orderedQuantity: true, uomId: true, productVariantId: true },
      }),
      // Receipts confirmed STRICTLY before THIS one — never later ones.
      this.prisma.goodsReceiptLine.findMany({
        where: {
          purchaseLineId: { in: purchaseLineIds },
          receipt: {
            companyId,
            status: GoodsReceiptStatus.CONFIRMED,
            createdAt: { lt: receipt.createdAt },
          },
        },
        select: { purchaseLineId: true, actualQuantity: true, uomId: true },
      }),
    ]);
    const lineById = new Map(purchaseLines.map((l) => [l.id, l]));
    for (const purchaseLineId of purchaseLineIds) {
      const target = lineById.get(purchaseLineId);
      if (!target) continue;
      let received = D(0);
      // THIS receipt's own lines (DRAFT view included — the flag is
      // evaluated as of this receipt, so a later over-receipt never
      // retro-flags an earlier under-receipt receipt).
      for (const line of receiptLines.filter((l) => l.purchaseLineId === purchaseLineId)) {
        received = received.plus(
          await this.normalization.convertBetween(
            companyId,
            target.productVariantId,
            line.actualQuantity,
            line.uomId,
            target.uomId,
          ),
        );
      }
      for (const line of earlierLines.filter((l) => l.purchaseLineId === purchaseLineId)) {
        received = received.plus(
          await this.normalization.convertBetween(
            companyId,
            target.productVariantId,
            line.actualQuantity,
            line.uomId,
            target.uomId,
          ),
        );
      }
      flags.set(purchaseLineId, received.gt(D(target.orderedQuantity)));
    }
    return flags;
  }
}
