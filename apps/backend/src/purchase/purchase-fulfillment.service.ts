import { Injectable } from '@nestjs/common';
import { Prisma, PurchaseDocumentStatus, PurchaseFulfillmentType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NormalizationService } from '../inventory/normalization.service';
import { D, roundMoney, roundQuantity, roundUnitCost } from '../common/utils/money';

type Client = Prisma.TransactionClient | PrismaService;

/**
 * Purchase line fulfillment ledger (final correction #1). GoodsReceipt
 * receipts and DIRECT-route loading allocations are SEPARATE contribution
 * rows on a purchase line — they never overwrite each other:
 *
 *   - GOODS_RECEIPT  — one row per (purchaseLine, goodsReceiptId); written by
 *     the receipt confirm with the converted quantity in the PO line's uom
 *     and amount = quantity × line.unitPrice;
 *   - DIRECT_LOADING — one row per (purchaseLine, loadingId) for
 *     DIRECT_SUPPLIER_TO_CUSTOMER loadings with a purchase-line allocation;
 *     same uom/amount convention.
 *
 * Reversals mark `reversedAt` (the row STAYS for history); only rows with
 * `reversedAt IS NULL` are operationally live. The purchase document's
 * `operationalLoadedAmount` and its PARTIALLY_LOADED/COMPLETED status are
 * RECOMPUTED from this ledger (absolute recompute, replacing the old
 * last-write-wins/delta approaches) — in BOTH the goods-receipt and the
 * loading confirm/reverse paths.
 *
 * The service also owns the per-inventory-UOM cost conversion used by the
 * movement cost snapshots (final correction #3): a PO line priced per its own
 * UOM becomes a per-inventory-UOM unit cost via
 * `unitPrice ÷ (1 purchaseUom → inventoryUom)`.
 */
@Injectable()
export class PurchaseFulfillmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly normalization: NormalizationService,
  ) {}

  // ───────────────────────── cost conversion (final #3) ─────────────────────────

  /**
   * PO line unit price expressed per ONE unit of the variant's inventory UOM:
   * `unitPrice ÷ factor(1 purchaseUom → inventoryUom)` (exact Decimal,
   * rounded to the unit-cost column scale). A PO priced per TON with an
   * inventory UOM of KG yields price/1000 per kg. The same value flows into
   * the GOODS_RECEIPT and the LOADING movement cost snapshots, so a received
   * quantity and the direct loading of the same goods carry the SAME cost.
   */
  async unitCostPerInventoryUom(
    companyId: string,
    variantId: string,
    line: { uomId: string; unitPrice: Prisma.Decimal | number | string },
  ): Promise<Prisma.Decimal> {
    const inventoryUomId = await this.normalization.resolveInventoryUom(companyId, variantId);
    const inventoryUnitsPerPurchaseUom = await this.normalization.convertBetween(
      companyId,
      variantId,
      1,
      line.uomId,
      inventoryUomId,
    );
    return roundUnitCost(D(line.unitPrice).div(inventoryUnitsPerPurchaseUom));
  }

  // ───────────────────────── ledger writes (final #1) ─────────────────────────

  /**
   * GOODS_RECEIPT fulfillment row for one receipt line: `quantity` in the PO
   * line's uom, `amount` = quantity × PO line unitPrice. Upsert on the
   * (purchaseLineId, type, sourceId) unique — a re-confirmed receipt refreshes
   * the values and clears a stale reversal mark instead of duplicating.
   */
  async upsertGoodsReceiptFulfillment(
    tx: Client,
    companyId: string,
    data: {
      purchaseLineId: string;
      goodsReceiptId: string;
      quantity: Prisma.Decimal | number | string;
      uomId: string;
      amount: Prisma.Decimal | number | string;
    },
  ): Promise<void> {
    await tx.purchaseLineFulfillment.upsert({
      where: {
        purchaseLineId_type_sourceId: {
          purchaseLineId: data.purchaseLineId,
          type: PurchaseFulfillmentType.GOODS_RECEIPT,
          sourceId: data.goodsReceiptId,
        },
      },
      create: {
        companyId,
        purchaseLineId: data.purchaseLineId,
        type: PurchaseFulfillmentType.GOODS_RECEIPT,
        sourceId: data.goodsReceiptId,
        quantity: roundQuantity(D(data.quantity)),
        uomId: data.uomId,
        amount: roundMoney(D(data.amount)),
      },
      update: {
        quantity: roundQuantity(D(data.quantity)),
        uomId: data.uomId,
        amount: roundMoney(D(data.amount)),
        reversedAt: null,
      },
    });
  }

  /**
   * DIRECT_LOADING fulfillment row for one purchase-line allocation of a
   * DIRECT_SUPPLIER_TO_CUSTOMER loading (same uom/amount convention as the
   * receipt rows). Written by the loading confirm.
   */
  async upsertDirectLoadingFulfillment(
    tx: Client,
    companyId: string,
    data: {
      purchaseLineId: string;
      loadingId: string;
      quantity: Prisma.Decimal | number | string;
      uomId: string;
      amount: Prisma.Decimal | number | string;
    },
  ): Promise<void> {
    await tx.purchaseLineFulfillment.upsert({
      where: {
        purchaseLineId_type_sourceId: {
          purchaseLineId: data.purchaseLineId,
          type: PurchaseFulfillmentType.DIRECT_LOADING,
          sourceId: data.loadingId,
        },
      },
      create: {
        companyId,
        purchaseLineId: data.purchaseLineId,
        type: PurchaseFulfillmentType.DIRECT_LOADING,
        sourceId: data.loadingId,
        quantity: roundQuantity(D(data.quantity)),
        uomId: data.uomId,
        amount: roundMoney(D(data.amount)),
      },
      update: {
        quantity: roundQuantity(D(data.quantity)),
        uomId: data.uomId,
        amount: roundMoney(D(data.amount)),
        reversedAt: null,
      },
    });
  }

  /**
   * Reversal: the fulfillment rows of ONE source document (a goods receipt or
   * a direct loading) are marked `reversedAt` — never deleted (the ledger is
   * history). Returns the number of rows flipped; already-reversed rows stay
   * untouched (idempotent).
   */
  async reverseBySource(
    tx: Client,
    type: PurchaseFulfillmentType,
    sourceId: string,
  ): Promise<number> {
    const flipped = await tx.purchaseLineFulfillment.updateMany({
      where: { type, sourceId, reversedAt: null },
      data: { reversedAt: new Date() },
    });
    return flipped.count;
  }

  // ───────────────────────── operational recompute (final #1) ─────────────────────────

  /**
   * Absolute recompute of `operationalLoadedAmount` + fulfillment status for
   * the given purchase documents, from the LEDGER (never from a delta):
   *
   *   amount = Σ fulfillments.amount           (reversedAt IS NULL, all lines)
   *   per line fulfilledQty = Σ fulfillments.quantity (reversedAt IS NULL)
   *
   * Status (only from the document's "active" statuses):
   *   confirm — upgrade-only: some line fulfilled → PARTIALLY_LOADED, every
   *             line fulfilled ≥ ordered → COMPLETED;
   *   reverse — outright recompute, may fall back to ORDER_PLACED.
   *
   * Shared by the goods-receipt AND loading confirm/reverse paths; the
   * purchase_documents row is locked FOR UPDATE so concurrent confirmations
   * serialize.
   */
  async recomputeDocuments(
    tx: Client,
    companyId: string,
    purchaseDocumentIds: string[] | Set<string>,
    mode: 'confirm' | 'reverse',
  ): Promise<void> {
    for (const docId of purchaseDocumentIds) {
      // Serialize concurrent ledger-driven updates on the same document (a
      // plain absolute SET without the lock would be lost-update prone).
      await tx.$queryRaw`SELECT id FROM purchase_documents WHERE id = ${docId}::uuid FOR UPDATE`;
      const doc = await tx.purchaseDocument.findFirst({
        where: { id: docId, companyId },
        select: {
          id: true,
          status: true,
          lines: { select: { id: true, orderedQuantity: true } },
        },
      });
      if (!doc) continue;

      const fulfillments = await tx.purchaseLineFulfillment.findMany({
        where: {
          purchaseLine: { purchaseDocumentId: doc.id },
          companyId,
          reversedAt: null,
        },
        select: { purchaseLineId: true, quantity: true, amount: true },
      });
      const fulfilledByLine = new Map<string, Prisma.Decimal>();
      let totalAmount = D(0);
      for (const row of fulfillments) {
        fulfilledByLine.set(
          row.purchaseLineId,
          D(fulfilledByLine.get(row.purchaseLineId) ?? 0).plus(row.quantity),
        );
        totalAmount = totalAmount.plus(D(row.amount));
      }

      let someFulfilled = false;
      let allFulfilled = doc.lines.length > 0;
      for (const line of doc.lines) {
        const fulfilled = fulfilledByLine.get(line.id) ?? D(0);
        if (fulfilled.gt(0)) someFulfilled = true;
        if (fulfilled.lt(D(line.orderedQuantity))) allFulfilled = false;
      }

      const status = this.statusAfter(doc.status, someFulfilled, allFulfilled, mode);
      await tx.purchaseDocument.update({
        where: { id: doc.id },
        data: {
          operationalLoadedAmount: roundMoney(totalAmount),
          ...(status ? { status: status as PurchaseDocumentStatus } : {}),
        },
      });
    }
  }

  /** Upgrade-only on confirm; outright recompute on reverse (may fall back). */
  private statusAfter(
    current: string,
    someFulfilled: boolean,
    allFulfilled: boolean,
    mode: 'confirm' | 'reverse',
  ): string | null {
    const applicable =
      mode === 'confirm'
        ? ['ORDER_PLACED', 'PARTIALLY_LOADED']
        : ['ORDER_PLACED', 'PARTIALLY_LOADED', 'COMPLETED'];
    if (!applicable.includes(current)) return null;
    if (mode === 'confirm') {
      if (!someFulfilled) return null;
      return allFulfilled ? 'COMPLETED' : 'PARTIALLY_LOADED';
    }
    if (!someFulfilled) return 'ORDER_PLACED';
    return allFulfilled ? 'COMPLETED' : 'PARTIALLY_LOADED';
  }
}
