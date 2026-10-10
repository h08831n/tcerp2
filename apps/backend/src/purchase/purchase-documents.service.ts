import { Inject, Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DailyPrice, Prisma, PurchaseDocumentStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SequencesService } from '../sequences/sequences.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit.dto';
import { TimelineService } from '../parties/timeline.service';
import { DocumentRelationService } from '../document-flow/document-relation.service';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../common/errors';
import { assertActiveCompanyMember } from '../common/utils/company-member';
import { assertSupplier } from '../common/utils/party-roles';
import { D, calcPurchaseLineTotal, roundMoney, roundQuantity, sumDocumentTotals } from '../common/utils/money';
import { RequestContext } from '../auth/auth.service';
import { Paginated } from '../common/dto/pagination.dto';
import {
  AddPurchaseLineDto,
  CreatePurchaseDocumentDto,
  PurchaseDocumentQueryDto,
  UpdatePurchaseDocumentDto,
  UpdatePurchaseLineDto,
} from './purchase.dto';
import { CreatePurchaseFromSaleDto } from '../sales/sales.dto';
import { DailyPriceService } from '../pricing/daily-price.service';
import { InventoryService } from '../inventory/inventory.service';

/**
 * Purchase documents (REQUIREMENTS §11): fully INDEPENDENT — no price
 * request is ever required. Numbering via the `PURCHASE` sequence
 * (PO-1405-00001). Buyers see the whole company's documents (no record
 * scope). Purchase lines carry quantity × unitPrice totals only
 * (server-authoritative Prisma.Decimal math).
 *
 * p5c pricing-integrity review — line price-source wiring: PurchaseLine
 * records WHERE its unitPrice came from:
 *   - `MANUAL`      — the buyer sent an explicit non-zero unitPrice
 *                     (purchase pricing is typically manual);
 *   - `DAILY_PRICE` — no explicit price (absent/null/0) and a DailyPrice row
 *                     exists for (variant, uom) today: its price is used as
 *                     the REFERENCE prefill for the buyer. DailyPrice rows
 *                     carry whatever price was entered (a sales-side row) —
 *                     treat it as a hint, the committed purchase price stays
 *                     freely editable;
 *   - `null`        — no explicit price and no DailyPrice row: the line
 *                     stays at 0 for the buyer to fill (no provenance yet).
 */

type Client = Prisma.TransactionClient;

interface PurchaseLineInput {
  productVariantId: string;
  quantity: number | string | Prisma.Decimal;
  uomId?: string | null;
  unitPrice?: number | string | Prisma.Decimal | null;
  notes?: string | null;
}

@Injectable()
export class PurchaseDocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sequences: SequencesService,
    private readonly auditService: AuditService,
    private readonly timeline: TimelineService,
    private readonly relations: DocumentRelationService,
    private readonly inventory: InventoryService,
    // Optional so hand-built test instances keep working; PurchaseModule
    // provides DailyPriceService directly (importing PricingModule would be
    // circular: PricingModule → PriceRequestModule → PurchaseModule).
    @Optional() @Inject(DailyPriceService)
    private readonly dailyPrices?: DailyPriceService,
  ) {}

  private async normalizeLines(
    tx: Client,
    companyId: string,
    purchaseDocumentId: string,
    inputs: PurchaseLineInput[],
  ): Promise<Prisma.PurchaseLineUncheckedCreateInput[]> {
    const variantIds = [...new Set(inputs.map((i) => i.productVariantId))];
    const variants = await tx.productVariant.findMany({
      where: { id: { in: variantIds }, companyId },
      select: { id: true, defaultUomId: true, template: { select: { defaultPurchaseUomId: true } } },
    });
    const variantMap = new Map(variants.map((v) => [v.id, v]));

    const uomIds = new Set<string>();
    for (const input of inputs) if (input.uomId) uomIds.add(input.uomId);
    for (const v of variants) {
      if (v.defaultUomId) uomIds.add(v.defaultUomId);
      if (v.template.defaultPurchaseUomId) uomIds.add(v.template.defaultPurchaseUomId);
    }
    const uoms = await tx.uom.findMany({
      where: { id: { in: [...uomIds] }, companyId, active: true },
      select: { id: true },
    });
    const uomSet = new Set(uoms.map((u) => u.id));

    // Today's DailyPrice per (variant, uom) — memoized per call (see class
    // doc: purchase treats it as a REFERENCE prefill, pricing stays manual).
    const todayPriceCache = new Map<string, Promise<DailyPrice | null>>();
    const todayPriceFor = (variantId: string, uomId: string): Promise<DailyPrice | null> => {
      const key = `${variantId}::${uomId}`;
      let cached = todayPriceCache.get(key);
      if (!cached) {
        cached = this.dailyPrices
          ? this.dailyPrices.getToday(companyId, variantId, uomId)
          : Promise.resolve(null);
        todayPriceCache.set(key, cached);
      }
      return cached;
    };

    return Promise.all(
      inputs.map(async (input, idx) => {
        const variant = variantMap.get(input.productVariantId);
        if (!variant) {
          throw new NotFoundError('Product variant not found', { productVariantId: input.productVariantId });
        }
        const uomId = input.uomId ?? variant.defaultUomId ?? variant.template.defaultPurchaseUomId;
        if (!uomId || !uomSet.has(uomId)) {
          throw new ValidationError('UOM_REQUIRED', { productVariantId: input.productVariantId });
        }

        const explicitPrice =
          input.unitPrice !== undefined && input.unitPrice !== null && !D(input.unitPrice).isZero();
        let unitPrice: Prisma.Decimal;
        let priceSource: string | null;
        let priceDate: Date | null;
        if (explicitPrice) {
          unitPrice = roundMoney(D(input.unitPrice));
          priceSource = 'MANUAL';
          priceDate = null;
        } else {
          const daily = await todayPriceFor(variant.id, uomId);
          if (daily) {
            unitPrice = roundMoney(daily.price);
            priceSource = 'DAILY_PRICE';
            priceDate = daily.date;
          } else {
            unitPrice = roundMoney(D(0));
            priceSource = null;
            priceDate = null;
          }
        }

        const lineTotal = calcPurchaseLineTotal({ quantity: input.quantity, unitPrice });
        return {
          companyId,
          purchaseDocumentId,
          productVariantId: input.productVariantId,
          orderedQuantity: roundQuantity(D(input.quantity)),
          uomId,
          unitPrice,
          priceSource,
          priceDate,
          lineTotal,
          notes: input.notes ?? null,
          lineOrder: idx,
        } satisfies Prisma.PurchaseLineUncheckedCreateInput;
      }),
    );
  }

  private async recomputeDocumentTotals(tx: Client, purchaseDocumentId: string): Promise<void> {
    const agg = await tx.purchaseLine.aggregate({
      where: { purchaseDocumentId },
      _sum: { lineTotal: true },
    });
    const lineTotal = agg._sum.lineTotal ?? 0;
    await tx.purchaseDocument.update({
      where: { id: purchaseDocumentId },
      data: {
        subtotal: lineTotal,
        discountTotal: 0,
        taxTotal: 0,
        total: lineTotal,
      },
    });
  }

  private async createDocumentTx(
    tx: Client,
    companyId: string,
    params: {
      supplierPartyId: string;
      buyerUserId: string;
      status?: PurchaseDocumentStatus;
      documentDate?: Date;
      paymentTermId?: string | null;
      priceRequestId?: string | null;
      currency?: string;
      lines: PurchaseLineInput[];
    },
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    await assertSupplier(tx, companyId, params.supplierPartyId);
    await assertActiveCompanyMember(tx, companyId, params.buyerUserId, 'BUYER_NOT_COMPANY_MEMBER');

    const documentDate = params.documentDate ?? new Date();
    const { number: documentNumber } = await this.sequences.allocate(companyId, 'PURCHASE', tx, documentDate);

    // Lines need the parent id; allocate the uuid up front (schema default).
    const purchaseDocumentId = randomUUID();
    const lineData = await this.normalizeLines(tx, companyId, purchaseDocumentId, params.lines);
    // Purchase lines have no discount/tax columns — subtotal = total = Σ lineTotal.
    const totals = sumDocumentTotals(
      lineData.map((l) => ({ subtotal: l.lineTotal, discountAmount: 0, taxAmount: 0, lineTotal: l.lineTotal })),
    );

    const document = await tx.purchaseDocument.create({
      data: {
        id: purchaseDocumentId,
        companyId,
        documentNumber,
        supplierPartyId: params.supplierPartyId,
        buyerUserId: params.buyerUserId,
        documentDate,
        currency: params.currency ?? 'IRR',
        paymentTermId: params.paymentTermId ?? null,
        priceRequestId: params.priceRequestId ?? null,
        status: params.status ?? PurchaseDocumentStatus.DRAFT,
        subtotal: totals.subtotal,
        discountTotal: totals.discountTotal,
        taxTotal: totals.taxTotal,
        total: totals.total,
        createdBy: actor.id,
        // Nested create: the parent sets purchaseDocumentId itself.
        lines: { create: lineData.map(({ purchaseDocumentId: _pid, ...line }) => line) },
      },
      include: { lines: true },
    });

    await this.auditService.recordTx(tx, {
      entityType: 'purchase_document',
      entityId: document.id,
      action: AuditAction.CREATE,
      companyId,
      actor,
      newValues: { documentNumber, status: document.status, total: document.total, lines: lineData.length },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    await this.timeline.record(tx, {
      companyId,
      entityType: 'PARTY',
      entityId: params.supplierPartyId,
      type: 'PURCHASE_CREATED',
      title: 'ثبت خرید',
      description: `سند خرید ${documentNumber} ثبت شد`,
      data: { purchaseDocumentId: document.id, documentNumber },
      actorUserId: actor.id,
    });

    return document;
  }

  async create(
    companyId: string,
    dto: CreatePurchaseDocumentDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    const document = await this.prisma.$transaction((tx) =>
      this.createDocumentTx(
        tx,
        companyId,
        {
          supplierPartyId: dto.supplierPartyId,
          buyerUserId: dto.buyerUserId ?? actor.id,
          documentDate: dto.documentDate ? new Date(dto.documentDate) : undefined,
          paymentTermId: dto.paymentTermId,
          priceRequestId: dto.priceRequestId,
          currency: dto.currency,
          lines: dto.lines ?? [],
        },
        actor,
        ctx,
      ),
    );
    return this.getById(companyId, document.id);
  }

  async getById(companyId: string, id: string) {
    const doc = await this.prisma.purchaseDocument.findFirst({
      where: { id, companyId },
      include: {
        supplier: { select: { id: true, nameFa: true } },
        buyer: { select: { id: true, username: true, firstName: true, lastName: true } },
        paymentTerm: { select: { id: true, code: true, nameFa: true } },
        priceRequest: { select: { id: true, requestNumber: true } },
        lines: {
          orderBy: { lineOrder: 'asc' },
          include: {
            productVariant: {
              select: { id: true, sku: true, nameFa: true, template: { select: { id: true, nameFa: true } } },
            },
            uom: { select: { id: true, symbol: true, nameFa: true } },
          },
        },
      },
    });
    if (!doc) throw new NotFoundError('Purchase document not found', { id });
    return doc;
  }

  /**
   * Fulfillment report (final corrections #1 + #2) — per purchase line:
   *   - orderedQuantity, unitPrice (with the line's uom/variant labels);
   *   - receivedQty        = Σ GOODS_RECEIPT fulfillments (reversedAt IS NULL);
   *   - directLoadedQty    = Σ DIRECT_LOADING fulfillments (reversedAt IS NULL);
   *   - fulfilledQty       = receivedQty + directLoadedQty;
   *   - remainingQuantity  = orderedQuantity − receivedQty (over-receipt
   *                          headroom; negative once over-received) and
   *   - overReceivedQuantity = max(0, receivedQty − orderedQuantity);
   *   - amount split: receivedAmount / directLoadedAmount / fulfilledAmount.
   * The raw fulfillment rows (INCLUDING reversed ones) are returned per line
   * for history; the operational sums above always exclude them. The GRN
   * over-receipt snapshots live on the goods-receipt lines themselves (see
   * GET /api/goods-receipts/:id).
   */
  async fulfillment(companyId: string, id: string) {
    const doc = await this.prisma.purchaseDocument.findFirst({
      where: { id, companyId },
      select: {
        id: true,
        documentNumber: true,
        status: true,
        operationalLoadedAmount: true,
        lines: {
          orderBy: { lineOrder: 'asc' },
          select: {
            id: true,
            orderedQuantity: true,
            unitPrice: true,
            productVariant: { select: { id: true, sku: true, nameFa: true } },
            uom: { select: { id: true, symbol: true, nameFa: true } },
            fulfillments: { orderBy: { createdAt: 'asc' } },
          },
        },
      },
    });
    if (!doc) throw new NotFoundError('Purchase document not found', { id });

    let totalReceivedAmount = new Prisma.Decimal(0);
    let totalDirectLoadedAmount = new Prisma.Decimal(0);
    const lines = doc.lines.map((line) => {
      const live = line.fulfillments.filter((f) => f.reversedAt === null);
      let receivedQty = new Prisma.Decimal(0);
      let directLoadedQty = new Prisma.Decimal(0);
      let receivedAmount = new Prisma.Decimal(0);
      let directLoadedAmount = new Prisma.Decimal(0);
      for (const row of live) {
        if (row.type === 'GOODS_RECEIPT') {
          receivedQty = receivedQty.plus(row.quantity);
          receivedAmount = receivedAmount.plus(D(row.amount));
        } else {
          directLoadedQty = directLoadedQty.plus(row.quantity);
          directLoadedAmount = directLoadedAmount.plus(D(row.amount));
        }
      }
      totalReceivedAmount = totalReceivedAmount.plus(receivedAmount);
      totalDirectLoadedAmount = totalDirectLoadedAmount.plus(directLoadedAmount);

      const ordered = D(line.orderedQuantity);
      const fulfilledQty = receivedQty.plus(directLoadedQty);
      return {
        purchaseLineId: line.id,
        productVariant: line.productVariant,
        uom: line.uom,
        orderedQuantity: line.orderedQuantity,
        unitPrice: line.unitPrice,
        receivedQty,
        directLoadedQty,
        fulfilledQty,
        remainingQuantity: ordered.minus(receivedQty),
        overReceivedQuantity: Prisma.Decimal.max(receivedQty.minus(ordered), new Prisma.Decimal(0)),
        receivedAmount,
        directLoadedAmount,
        fulfilledAmount: receivedAmount.plus(directLoadedAmount),
        fulfillments: line.fulfillments,
      };
    });

    return {
      purchaseDocumentId: doc.id,
      documentNumber: doc.documentNumber,
      status: doc.status,
      operationalLoadedAmount: doc.operationalLoadedAmount,
      lines,
      totals: {
        receivedAmount: totalReceivedAmount,
        directLoadedAmount: totalDirectLoadedAmount,
        fulfilledAmount: totalReceivedAmount.plus(totalDirectLoadedAmount),
      },
    };
  }

  /** Lightweight grid projection — 3 queries per page (findMany, count, groupBy). */
  async list(companyId: string, query: PurchaseDocumentQueryDto): Promise<Paginated<unknown>> {
    const where: Prisma.PurchaseDocumentWhereInput = {
      companyId,
      status: query.status,
      supplierPartyId: query.supplierPartyId,
      buyerUserId: query.buyerUserId,
      ...(query.dateFrom || query.dateTo
        ? {
            documentDate: {
              ...(query.dateFrom ? { gte: new Date(query.dateFrom) } : {}),
              ...(query.dateTo ? { lte: new Date(query.dateTo) } : {}),
            },
          }
        : {}),
      ...(query.search
        ? {
            OR: [
              { documentNumber: { contains: query.search, mode: 'insensitive' } },
              { supplier: { nameFa: { contains: query.search } } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.purchaseDocument.findMany({
        where,
        orderBy: { documentDate: query.sortDir },
        skip: query.skip,
        take: query.take,
        select: {
          id: true,
          documentNumber: true,
          status: true,
          documentDate: true,
          subtotal: true,
          discountTotal: true,
          taxTotal: true,
          total: true,
          version: true,
          supplier: { select: { id: true, nameFa: true } },
          buyer: { select: { id: true, username: true, firstName: true, lastName: true } },
        },
      }),
      this.prisma.purchaseDocument.count({ where }),
    ]);

    const ids = items.map((i) => i.id);
    const lineCounts = ids.length
      ? await this.prisma.purchaseLine.groupBy({
          by: ['purchaseDocumentId'],
          where: { purchaseDocumentId: { in: ids } },
          _count: { _all: true },
        })
      : [];
    const countMap = new Map(lineCounts.map((c) => [c.purchaseDocumentId, c._count._all]));

    return {
      items: items.map((doc) => ({
        id: doc.id,
        documentNumber: doc.documentNumber,
        status: doc.status,
        documentDate: doc.documentDate,
        supplier: doc.supplier,
        buyer: {
          id: doc.buyer.id,
          name: [doc.buyer.firstName, doc.buyer.lastName].filter(Boolean).join(' ') || doc.buyer.username,
        },
        totals: {
          subtotal: doc.subtotal,
          discountTotal: doc.discountTotal,
          taxTotal: doc.taxTotal,
          total: doc.total,
        },
        lineCount: countMap.get(doc.id) ?? 0,
        version: doc.version,
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  // ───────────────────── header + lines ─────────────────────

  async update(
    companyId: string,
    id: string,
    dto: UpdatePurchaseDocumentDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    const doc = await this.prisma.purchaseDocument.findFirst({ where: { id, companyId } });
    if (!doc) throw new NotFoundError('Purchase document not found', { id });
    if (doc.status === PurchaseDocumentStatus.COMPLETED || doc.status === PurchaseDocumentStatus.CANCELLED) {
      throw new ValidationError('DOCUMENT_CLOSED', { status: doc.status });
    }
    if (dto.paymentTermId) {
      const term = await this.prisma.paymentTerm.findFirst({
        where: { id: dto.paymentTermId, companyId },
        select: { id: true },
      });
      if (!term) throw new NotFoundError('Payment term not found', { paymentTermId: dto.paymentTermId });
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.purchaseDocument.update({
        where: { id: doc.id, version: dto.version },
        data: {
          documentDate: dto.documentDate ? new Date(dto.documentDate) : undefined,
          paymentTermId: dto.paymentTermId,
          notes: dto.notes,
          version: { increment: 1 },
        },
      });
      await this.auditService.recordTx(tx, {
        entityType: 'purchase_document',
        entityId: row.id,
        action: AuditAction.UPDATE,
        companyId,
        actor,
        oldValues: { paymentTermId: doc.paymentTermId, notes: doc.notes },
        newValues: { paymentTermId: row.paymentTermId, notes: row.notes },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return row;
    }).catch((error) => {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw new ConflictError('VERSION_CONFLICT', { id });
      }
      throw error;
    });
    return this.getById(companyId, updated.id);
  }

  async addLine(
    companyId: string,
    id: string,
    dto: AddPurchaseLineDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    const doc = await this.prisma.purchaseDocument.findFirst({ where: { id, companyId } });
    if (!doc) throw new NotFoundError('Purchase document not found', { id });
    if (doc.status === PurchaseDocumentStatus.COMPLETED || doc.status === PurchaseDocumentStatus.CANCELLED) {
      throw new ValidationError('DOCUMENT_CLOSED', { status: doc.status });
    }
    await this.prisma.$transaction(async (tx) => {
      const maxOrder = await tx.purchaseLine.aggregate({
        where: { purchaseDocumentId: doc.id },
        _max: { lineOrder: true },
      });
      const lineData = await this.normalizeLines(tx, companyId, doc.id, [dto]);
      await tx.purchaseLine.create({
        data: { ...lineData[0], lineOrder: (maxOrder._max.lineOrder ?? -1) + 1 },
      });
      await this.recomputeDocumentTotals(tx, doc.id);
      await this.auditService.recordTx(tx, {
        entityType: 'purchase_line',
        entityId: doc.id,
        action: AuditAction.CREATE,
        companyId,
        actor,
        newValues: lineData[0] as unknown as Record<string, unknown>,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
    });
    return this.getById(companyId, id);
  }

  async updateLine(
    companyId: string,
    id: string,
    lineId: string,
    dto: UpdatePurchaseLineDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    const doc = await this.prisma.purchaseDocument.findFirst({ where: { id, companyId } });
    if (!doc) throw new NotFoundError('Purchase document not found', { id });
    const line = await this.prisma.purchaseLine.findFirst({
      where: { id: lineId, purchaseDocumentId: doc.id, companyId },
    });
    if (!line) throw new NotFoundError('Purchase line not found', { lineId });

    const effective: PurchaseLineInput = {
      productVariantId: dto.productVariantId ?? line.productVariantId,
      quantity: dto.quantity ?? line.orderedQuantity,
      uomId: dto.uomId ?? line.uomId,
      unitPrice: dto.unitPrice ?? line.unitPrice,
      notes: dto.notes ?? line.notes,
    };
    await this.prisma.$transaction(async (tx) => {
      const lineData = await this.normalizeLines(tx, companyId, doc.id, [effective]);
      // p5c: unitPrice PATCHed non-zero + changed → MANUAL; PATCHed 0/null →
      // re-resolve the default (adopt the fresh snapshot); untouched → keep
      // the stored source/date.
      const explicitPatch =
        dto.unitPrice !== undefined && dto.unitPrice !== null && !D(dto.unitPrice).isZero();
      const priceChanged = explicitPatch && !D(dto.unitPrice).equals(line.unitPrice);
      const reResolve = dto.unitPrice !== undefined && dto.unitPrice !== null && !explicitPatch;
      const {
        lineOrder: _ignored,
        purchaseDocumentId: _pid,
        priceSource: _ps,
        priceDate: _pd,
        ...updateData
      } = lineData[0];
      await tx.purchaseLine.update({
        where: { id: line.id },
        data: {
          ...updateData,
          ...(reResolve ? { priceSource: lineData[0].priceSource, priceDate: lineData[0].priceDate } : {}),
          ...(priceChanged ? { priceSource: 'MANUAL', priceDate: null } : {}),
        },
      });
      await this.recomputeDocumentTotals(tx, doc.id);
      await this.auditService.recordTx(tx, {
        entityType: 'purchase_line',
        entityId: line.id,
        action: AuditAction.UPDATE,
        companyId,
        actor,
        oldValues: {
          productVariantId: line.productVariantId,
          orderedQuantity: line.orderedQuantity,
          uomId: line.uomId,
          unitPrice: line.unitPrice,
        },
        newValues: {
          productVariantId: effective.productVariantId,
          orderedQuantity: lineData[0].orderedQuantity,
          uomId: effective.uomId,
          unitPrice: lineData[0].unitPrice,
        },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
    });
    return this.getById(companyId, id);
  }

  async deleteLine(
    companyId: string,
    id: string,
    lineId: string,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    const doc = await this.prisma.purchaseDocument.findFirst({ where: { id, companyId } });
    if (!doc) throw new NotFoundError('Purchase document not found', { id });
    const line = await this.prisma.purchaseLine.findFirst({
      where: { id: lineId, purchaseDocumentId: doc.id, companyId },
    });
    if (!line) throw new NotFoundError('Purchase line not found', { lineId });
    await this.prisma.$transaction(async (tx) => {
      await tx.purchaseLine.delete({ where: { id: line.id } });
      await this.recomputeDocumentTotals(tx, doc.id);
      await this.auditService.recordTx(tx, {
        entityType: 'purchase_line',
        entityId: line.id,
        action: AuditAction.DELETE,
        companyId,
        actor,
        oldValues: {
          productVariantId: line.productVariantId,
          orderedQuantity: line.orderedQuantity,
          unitPrice: line.unitPrice,
        },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
    });
    return this.getById(companyId, id);
  }

  // ───────────────────── transitions ─────────────────────

  private async loadForTransition(companyId: string, id: string) {
    const doc = await this.prisma.purchaseDocument.findFirst({ where: { id, companyId } });
    if (!doc) throw new NotFoundError('Purchase document not found', { id });
    return doc;
  }

  /** DRAFT → ORDER_PLACED. */
  async place(companyId: string, id: string, actor: { id: string; username: string }, ctx: RequestContext) {
    const doc = await this.loadForTransition(companyId, id);
    if (doc.status !== PurchaseDocumentStatus.DRAFT) {
      throw new ValidationError('INVALID_STATUS_TRANSITION', { from: doc.status, to: 'ORDER_PLACED' });
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.purchaseDocument.update({
        where: { id: doc.id },
        data: { status: PurchaseDocumentStatus.ORDER_PLACED },
      });
      await this.auditService.recordTx(tx, {
        entityType: 'purchase_document',
        entityId: doc.id,
        action: AuditAction.UPDATE,
        companyId,
        actor,
        oldValues: { status: doc.status },
        newValues: { status: PurchaseDocumentStatus.ORDER_PLACED },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
    });
    return this.getById(companyId, id);
  }

  /**
   * DEPRECATED (Integrity Gate #9): blind PO-receipt is gone — physical stock
   * comes ONLY from real GoodsReceipts (per-line ACTUAL quantities, over/
   * under receipt, reversals). The endpoint stays as a tombstone so old
   * clients get a stable machine-readable 403 instead of a 404.
   */
  async receive(companyId: string, id: string): Promise<never> {
    const doc = await this.loadForTransition(companyId, id);
    throw new ForbiddenError('RECEIVE_DEPRECATED', {
      purchaseDocumentId: doc.id,
      hint: 'Use POST /api/goods-receipts (real partial receipts drive stock).',
    });
  }

  /** ORDER_PLACED|PARTIALLY_LOADED → COMPLETED. */
  async complete(companyId: string, id: string, actor: { id: string; username: string }, ctx: RequestContext) {    const doc = await this.loadForTransition(companyId, id);
    if (
      doc.status !== PurchaseDocumentStatus.ORDER_PLACED &&
      doc.status !== PurchaseDocumentStatus.PARTIALLY_LOADED
    ) {
      throw new ValidationError('INVALID_STATUS_TRANSITION', { from: doc.status, to: 'COMPLETED' });
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.purchaseDocument.update({
        where: { id: doc.id },
        data: { status: PurchaseDocumentStatus.COMPLETED },
      });
      await this.auditService.recordTx(tx, {
        entityType: 'purchase_document',
        entityId: doc.id,
        action: AuditAction.UPDATE,
        companyId,
        actor,
        oldValues: { status: doc.status },
        newValues: { status: PurchaseDocumentStatus.COMPLETED },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
    });
    return this.getById(companyId, id);
  }

  async cancel(companyId: string, id: string, actor: { id: string; username: string }, ctx: RequestContext) {
    const doc = await this.loadForTransition(companyId, id);
    if (doc.status === PurchaseDocumentStatus.COMPLETED || doc.status === PurchaseDocumentStatus.CANCELLED) {
      throw new ValidationError('INVALID_STATUS_TRANSITION', { from: doc.status, to: 'CANCELLED' });
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.purchaseDocument.update({
        where: { id: doc.id },
        data: { status: PurchaseDocumentStatus.CANCELLED },
      });
      await this.auditService.recordTx(tx, {
        entityType: 'purchase_document',
        entityId: doc.id,
        action: AuditAction.UPDATE,
        companyId,
        actor,
        oldValues: { status: doc.status },
        newValues: { status: PurchaseDocumentStatus.CANCELLED },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
    });
    return this.getById(companyId, id);
  }

  // ───────────────────── create purchase from sale (REQUIREMENTS §11) ─────────────────────

  /**
   * Copies the sale's lines 1:1 (same variant / uom / quantity) into a new
   * ORDER_PLACED purchase; unit prices start at 0 for the buyer to fill.
   * DocumentRelations (CREATED_FROM) are written in BOTH directions.
   */
  async createPurchaseFromSale(
    companyId: string,
    salesDocumentId: string,
    dto: CreatePurchaseFromSaleDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    const sale = await this.prisma.salesDocument.findFirst({
      where: { id: salesDocumentId, companyId },
      include: { lines: { orderBy: { lineOrder: 'asc' } } },
    });
    if (!sale) throw new NotFoundError('Sales document not found', { salesDocumentId });

    const document = await this.prisma.$transaction(async (tx) => {
      const doc = await this.createDocumentTx(
        tx,
        companyId,
        {
          supplierPartyId: dto.supplierPartyId,
          buyerUserId: dto.buyerUserId ?? actor.id,
          status: PurchaseDocumentStatus.ORDER_PLACED,
          documentDate: dto.documentDate ? new Date(dto.documentDate) : undefined,
          paymentTermId: dto.paymentTermId,
          lines: sale.lines.map((line) => ({
            productVariantId: line.productVariantId,
            quantity: line.orderedQuantity,
            uomId: line.uomId,
            unitPrice: 0, // no explicit price → DAILY_PRICE reference prefill if a daily row exists, else 0 (p5c)
          })),
        },
        actor,
        ctx,
      );

      await this.relations.createRelation(
        companyId,
        { fromType: 'purchase_document', fromId: doc.id, toType: 'sales_document', toId: sale.id, relationType: 'CREATED_FROM' },
        actor,
        ctx,
        tx,
      );
      await this.relations.createRelation(
        companyId,
        { fromType: 'sales_document', fromId: sale.id, toType: 'purchase_document', toId: doc.id, relationType: 'CREATED_FROM' },
        actor,
        ctx,
        tx,
      );
      return doc;
    });
    return this.getById(companyId, document.id);
  }
}
