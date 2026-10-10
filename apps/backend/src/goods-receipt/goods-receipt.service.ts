import { Injectable } from '@nestjs/common';
import {
  GoodsReceiptStatus,
  Prisma,
  PurchaseDocumentStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { TimelineService } from '../parties/timeline.service';
import { DocumentRelationService } from '../document-flow/document-relation.service';
import { InventoryService } from '../inventory/inventory.service';
import { NormalizationService } from '../inventory/normalization.service';
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
 *       key is the only duplicate authority);
 *   (b) increments the purchase `operationalLoadedAmount` by the receipt
 *       amount — Σ convertedQty(line uom → PO line uom) × line.unitPrice,
 *       exact Decimal — and upgrades the purchase status
 *       (ORDER_PLACED/PARTIALLY_LOADED → PARTIALLY_LOADED/COMPLETED);
 *   (c) writes purchase_document ↔ goods_receipt RELATED relations and the
 *       audit + timeline rows — all atomic.
 * reverse() — ONE serializable transaction: reason REQUIRED, compensating
 *             movements (swapped endpoints, reversalOfMovementId linkage,
 *             key `grn-rev:{receiptId}:line:{lineId}`), the operational
 *             amount is rolled back and the purchase status recomputed; the
 *             original receipt is REVERSED forever.
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
          select: { id: true, productVariantId: true },
        });
        const variantByLine = new Map(purchaseLines.map((l) => [l.id, l.productVariantId]));

        for (const line of receipt.lines) {
          const productVariantId = variantByLine.get(line.purchaseLineId);
          if (!productVariantId) {
            throw new NotFoundError('Purchase line not found', { purchaseLineId: line.purchaseLineId });
          }
          await this.normalization.insertStockMovement(tx, {
            companyId,
            productVariantId,
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
          });
        }

        await tx.goodsReceipt.update({
          where: { id: receipt.id },
          data: { status: GoodsReceiptStatus.CONFIRMED },
        });

        // Purchase operational amount += converted actual × PO unitPrice,
        // status upgrade-only (receipt coverage drives it).
        await this.applyPurchaseOperationalState(tx, companyId, purchase.id, receipt.lines, 'confirm');

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
        // un-does exactly what was applied).
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
          });
        }

        await tx.goodsReceipt.update({
          where: { id: receipt.id },
          data: { status: GoodsReceiptStatus.REVERSED, reversalReason: reason },
        });

        // Operational rollback on the purchase (+ status may fall back).
        await this.applyPurchaseOperationalState(tx, companyId, receipt.purchaseDocumentId, receipt.lines, 'reverse');

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
   * Purchase operational amount + status, driven by receipt coverage.
   *   confirm: operationalLoadedAmount += Σ converted(actual) × unitPrice of
   *            THIS receipt's lines; status upgrade-only.
   *   reverse: the SAME amount is subtracted (exact rollback by
   *            construction); status recomputed from the remaining active
   *            (CONFIRMED) receipts, may fall back to ORDER_PLACED.
   */
  private async applyPurchaseOperationalState(
    tx: Client,
    companyId: string,
    purchaseDocumentId: string,
    receiptLines: { purchaseLineId: string; actualQuantity: Prisma.Decimal; uomId: string }[],
    mode: 'confirm' | 'reverse',
  ): Promise<void> {
    const doc = await tx.purchaseDocument.findFirst({
      where: { id: purchaseDocumentId, companyId },
      select: {
        id: true,
        status: true,
        operationalLoadedAmount: true,
        lines: {
          select: { id: true, orderedQuantity: true, uomId: true, unitPrice: true, productVariantId: true },
        },
      },
    });
    if (!doc) return;
    // Serialize concurrent amount/status updates on the same purchase
    // document (a plain `increment` would be lost-update prone AND a SQL
    // NULL + x stays NULL on the nullable column — absolute set instead).
    await tx.$queryRaw`SELECT id FROM purchase_documents WHERE id = ${doc.id}::uuid FOR UPDATE`;
    const lineById = new Map(doc.lines.map((l) => [l.id, l]));

    // This receipt's contribution (confirm and reverse use the SAME
    // conversion, so the pair cancels exactly).
    let delta = D(0);
    for (const line of receiptLines) {
      const target = lineById.get(line.purchaseLineId);
      if (!target) continue;
      const converted = await this.normalization.convertBetween(
        companyId,
        target.productVariantId,
        line.actualQuantity,
        line.uomId,
        target.uomId,
      );
      delta = delta.plus(converted.times(target.unitPrice));
    }

    // Receipt coverage over EVERY line of the document (the flipped receipt
    // status participates as of the update above).
    const activeReceiptLines = await tx.goodsReceiptLine.findMany({
      where: {
        receipt: { purchaseDocumentId, companyId, status: GoodsReceiptStatus.CONFIRMED },
      },
      select: { purchaseLineId: true, actualQuantity: true, uomId: true },
    });
    const receivedByLine = new Map<string, Prisma.Decimal>();
    for (const line of activeReceiptLines) {
      const target = lineById.get(line.purchaseLineId);
      if (!target) continue;
      const converted = await this.normalization.convertBetween(
        companyId,
        target.productVariantId,
        line.actualQuantity,
        line.uomId,
        target.uomId,
      );
      receivedByLine.set(
        line.purchaseLineId,
        D(receivedByLine.get(line.purchaseLineId) ?? 0).plus(converted),
      );
    }
    let someReceived = false;
    let allFullyReceived = doc.lines.length > 0;
    for (const line of doc.lines) {
      const received = receivedByLine.get(line.id) ?? D(0);
      if (received.gt(0)) someReceived = true;
      if (received.lt(D(line.orderedQuantity))) allFullyReceived = false;
    }

    const status = this.purchaseStatusAfter(doc.status, someReceived, allFullyReceived, mode);
    const currentAmount = doc.operationalLoadedAmount ? D(doc.operationalLoadedAmount) : D(0);
    const nextAmount =
      mode === 'confirm' ? currentAmount.plus(delta) : currentAmount.minus(delta);
    await tx.purchaseDocument.update({
      where: { id: doc.id },
      data: {
        operationalLoadedAmount: nextAmount,
        ...(status ? { status: status as PurchaseDocumentStatus } : {}),
      },
    });
  }

  /** Upgrade-only on confirm; outright recompute on reverse (may fall back). */
  private purchaseStatusAfter(
    current: string,
    someReceived: boolean,
    allFullyReceived: boolean,
    mode: 'confirm' | 'reverse',
  ): string | null {
    const applicable =
      mode === 'confirm'
        ? ['ORDER_PLACED', 'PARTIALLY_LOADED']
        : ['ORDER_PLACED', 'PARTIALLY_LOADED', 'COMPLETED'];
    if (!applicable.includes(current)) return null;
    if (mode === 'confirm') {
      if (!someReceived) return null;
      return allFullyReceived ? 'COMPLETED' : 'PARTIALLY_LOADED';
    }
    if (!someReceived) return 'ORDER_PLACED';
    return allFullyReceived ? 'COMPLETED' : 'PARTIALLY_LOADED';
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
