import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma, PurchaseDocumentStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SequencesService } from '../sequences/sequences.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit.dto';
import { TimelineService } from '../parties/timeline.service';
import { DocumentRelationService } from '../document-flow/document-relation.service';
import { ConflictError, NotFoundError, ValidationError } from '../common/errors';
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

/**
 * Purchase documents (REQUIREMENTS §11): fully INDEPENDENT — no price
 * request is ever required. Numbering via the `PURCHASE` sequence
 * (PO-1405-00001). Buyers see the whole company's documents (no record
 * scope). Purchase lines carry quantity × unitPrice totals only
 * (server-authoritative Prisma.Decimal math).
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

    return inputs.map((input, idx) => {
      const variant = variantMap.get(input.productVariantId);
      if (!variant) {
        throw new NotFoundError('Product variant not found', { productVariantId: input.productVariantId });
      }
      const uomId = input.uomId ?? variant.defaultUomId ?? variant.template.defaultPurchaseUomId;
      if (!uomId || !uomSet.has(uomId)) {
        throw new ValidationError('UOM_REQUIRED', { productVariantId: input.productVariantId });
      }
      const lineTotal = calcPurchaseLineTotal({ quantity: input.quantity, unitPrice: input.unitPrice ?? 0 });
      return {
        companyId,
        purchaseDocumentId,
        productVariantId: input.productVariantId,
        orderedQuantity: roundQuantity(D(input.quantity)),
        uomId,
        unitPrice: roundMoney(D(input.unitPrice ?? 0)),
        lineTotal,
        notes: input.notes ?? null,
        lineOrder: idx,
      } satisfies Prisma.PurchaseLineUncheckedCreateInput;
    });
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
      const { lineOrder: _ignored, purchaseDocumentId: _pid, ...updateData } = lineData[0];
      await tx.purchaseLine.update({ where: { id: line.id }, data: updateData });
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

  /** ORDER_PLACED|PARTIALLY_LOADED → COMPLETED. */
  async complete(companyId: string, id: string, actor: { id: string; username: string }, ctx: RequestContext) {
    const doc = await this.loadForTransition(companyId, id);
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
            unitPrice: 0, // buyer fills prices
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
