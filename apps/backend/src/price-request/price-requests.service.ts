import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma, PriceRequestStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SequencesService } from '../sequences/sequences.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit.dto';
import { TimelineService } from '../parties/timeline.service';
import { DocumentRelationService } from '../document-flow/document-relation.service';
import { SalesDocumentsService } from '../sales/sales-documents.service';
import { PurchaseDocumentsService } from '../purchase/purchase-documents.service';
import { ConflictError, NotFoundError, ValidationError } from '../common/errors';
import { assertCustomer } from '../common/utils/party-roles';
import { roundQuantity, D } from '../common/utils/money';
import { RequestContext } from '../auth/auth.service';
import { Paginated } from '../common/dto/pagination.dto';
import {
  AddPriceRequestLineDto,
  CreatePurchaseFromRequestDto,
  CreatePriceRequestDto,
  CreateSaleFromRequestDto,
  PriceRequestQueryDto,
  UpdatePriceRequestDto,
  UpdatePriceRequestLineDto,
} from './price-request.dto';
import { TodayPriceProvider, TODAY_PRICE_PROVIDER } from './today-price.provider';

/**
 * Price Requests (REQUIREMENTS §14, §16): an INDEPENDENT document —
 * customer is optional, and creating sales/purchases never requires one
 * (priceRequestId on the target document is a nullable reference only).
 * Previous-day requests are NEVER copied or deleted: the worklist returns
 * the SAME record under `previousDays` (p4-19).
 */

type Client = Prisma.TransactionClient;

interface RequestLineInput {
  productVariantId: string;
  requestedQuantity: number | string | Prisma.Decimal;
  uomId?: string | null;
  notes?: string | null;
}

function dayStart(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Parse a `date` query param into LOCAL day start. A bare YYYY-MM-DD is
 * interpreted in the server's local timezone (NOT shifted through
 * `new Date('…')` UTC parsing), keeping worklist windows consistent with
 * locally created requestDate values.
 */
function parseDayStart(dateIso?: string): Date {
  if (dateIso && /^\d{4}-\d{2}-\d{2}$/.test(dateIso)) {
    const [y, m, d] = dateIso.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  return dayStart(dateIso ? new Date(dateIso) : new Date());
}

@Injectable()
export class PriceRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sequences: SequencesService,
    private readonly auditService: AuditService,
    private readonly timeline: TimelineService,
    private readonly relations: DocumentRelationService,
    private readonly salesService: SalesDocumentsService,
    private readonly purchaseService: PurchaseDocumentsService,
    @Inject(TODAY_PRICE_PROVIDER) private readonly todayPriceProvider: TodayPriceProvider,
  ) {}

  private async normalizeLines(
    tx: Client,
    companyId: string,
    priceRequestId: string,
    inputs: RequestLineInput[],
  ): Promise<Prisma.PriceRequestLineUncheckedCreateInput[]> {
    const variantIds = [...new Set(inputs.map((i) => i.productVariantId))];
    const variants = await tx.productVariant.findMany({
      where: { id: { in: variantIds }, companyId },
      select: { id: true, defaultUomId: true, template: { select: { defaultSalesUomId: true } } },
    });
    const variantMap = new Map(variants.map((v) => [v.id, v]));

    const uomIds = new Set<string>();
    for (const input of inputs) if (input.uomId) uomIds.add(input.uomId);
    for (const v of variants) {
      if (v.defaultUomId) uomIds.add(v.defaultUomId);
      if (v.template.defaultSalesUomId) uomIds.add(v.template.defaultSalesUomId);
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
      const uomId = input.uomId ?? variant.defaultUomId ?? variant.template.defaultSalesUomId;
      if (!uomId || !uomSet.has(uomId)) {
        throw new ValidationError('UOM_REQUIRED', { productVariantId: input.productVariantId });
      }
      return {
        companyId,
        priceRequestId,
        productVariantId: input.productVariantId,
        requestedQuantity: roundQuantity(D(input.requestedQuantity)),
        uomId,
        notes: input.notes ?? null,
        lineOrder: idx,
      } satisfies Prisma.PriceRequestLineUncheckedCreateInput;
    });
  }

  async create(
    companyId: string,
    dto: CreatePriceRequestDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    const request = await this.prisma.$transaction(async (tx) => {
      if (dto.customerPartyId) {
        await assertCustomer(tx, companyId, dto.customerPartyId);
      }
      const requestDate = dto.requestDate ? new Date(dto.requestDate) : new Date();
      const { number: requestNumber } = await this.sequences.allocate(companyId, 'PRICE_REQUEST', tx, requestDate);
      // Lines need the parent id; the id would normally come from the DB
      // default, so allocate it up front (uuid(), schema-conformant).
      const requestId = randomUUID();
      const lineData = await this.normalizeLines(tx, companyId, requestId, dto.lines ?? []);

      const row = await tx.priceRequest.create({
        data: {
          id: requestId,
          companyId,
          requestNumber,
          requesterUserId: actor.id,
          customerPartyId: dto.customerPartyId ?? null,
          opportunityId: dto.opportunityId ?? null,
          requestDate,
          notes: dto.notes,
          status: PriceRequestStatus.OPEN,
          // Nested create: the parent sets priceRequestId itself.
          lines: { create: lineData.map(({ priceRequestId: _pid, ...line }) => line) },
        },
        include: { lines: true },
      });

      await this.auditService.recordTx(tx, {
        entityType: 'price_request',
        entityId: row.id,
        action: AuditAction.CREATE,
        companyId,
        actor,
        newValues: { requestNumber, status: row.status, lines: lineData.length },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      await this.timeline.record(tx, {
        companyId,
        entityType: dto.customerPartyId ? 'PARTY' : 'PRICE_REQUEST',
        entityId: dto.customerPartyId ?? row.id,
        type: 'PRICE_REQUEST_CREATED',
        title: 'ثبت استعلام قیمت',
        description: `استعلام ${requestNumber} ثبت شد`,
        data: { priceRequestId: row.id, requestNumber },
        actorUserId: actor.id,
      });
      return row;
    });
    return this.getById(companyId, request.id);
  }

  async getById(companyId: string, id: string) {    const request = await this.prisma.priceRequest.findFirst({
      where: { id, companyId },
      include: {
        customer: { select: { id: true, nameFa: true } },
        requester: { select: { id: true, username: true, firstName: true, lastName: true } },
        lines: {
          orderBy: { lineOrder: 'asc' },
          include: {
            productVariant: {
              select: { id: true, sku: true, nameFa: true, template: { select: { id: true, nameFa: true } } },
            },
            uom: { select: { id: true, symbol: true, nameFa: true } },
            offers: {
              include: { supplier: { select: { id: true, nameFa: true } } },
              orderBy: { offeredPrice: 'asc' },
            },
          },
        },
        // Conversion history stays navigable (Phase 4 correction #2):
        // PriceRequest → SalesDocuments → PurchaseDocuments → SupplierOffers.
        salesDocuments: {
          select: { id: true, documentNumber: true, status: true, documentDate: true },
          orderBy: { createdAt: 'desc' as const },
        },
        purchaseDocuments: {
          select: { id: true, documentNumber: true, status: true, documentDate: true },
          orderBy: { createdAt: 'desc' as const },
        },
      },
    });
    if (!request) throw new NotFoundError('Price request not found', { id });

    // Today's-price hook (REQUIREMENTS §14): null in Phase 4 — the daily
    // pricing engine binds to TODAY_PRICE_PROVIDER in Phase 5.
    const lines = await Promise.all(
      request.lines.map(async (line) => ({
        ...line,
        todayPrice: await this.todayPriceProvider.getTodayPrice(companyId, line.productVariantId, line.uomId),
      })),
    );
    return { ...request, lines };
  }

  async update(
    companyId: string,
    id: string,
    dto: UpdatePriceRequestDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    const request = await this.prisma.priceRequest.findFirst({ where: { id, companyId } });
    if (!request) throw new NotFoundError('Price request not found', { id });
    if (dto.customerPartyId) {
      await assertCustomer(this.prisma as unknown as Client, companyId, dto.customerPartyId);
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.priceRequest.update({
        where: { id: request.id, version: dto.version },
        data: {
          customerPartyId: dto.customerPartyId,
          notes: dto.notes,
          version: { increment: 1 },
        },
      });
      await this.auditService.recordTx(tx, {
        entityType: 'price_request',
        entityId: row.id,
        action: AuditAction.UPDATE,
        companyId,
        actor,
        oldValues: { customerPartyId: request.customerPartyId, notes: request.notes },
        newValues: { customerPartyId: row.customerPartyId, notes: row.notes },
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

  async list(companyId: string, query: PriceRequestQueryDto): Promise<Paginated<unknown>> {
    const where: Prisma.PriceRequestWhereInput = {
      companyId,
      status: query.status,
      customerPartyId: query.customerPartyId,
      requesterUserId: query.requesterUserId,
      ...(query.search
        ? {
            OR: [
              { requestNumber: { contains: query.search, mode: 'insensitive' } },
              { customer: { nameFa: { contains: query.search } } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.priceRequest.findMany({
        where,
        orderBy: { requestDate: 'desc' },
        skip: query.skip,
        take: query.take,
        select: {
          id: true,
          requestNumber: true,
          status: true,
          requestDate: true,
          notes: true,
          customer: { select: { id: true, nameFa: true } },
          requester: { select: { id: true, username: true, firstName: true, lastName: true } },
          _count: { select: { lines: true } },
        },
      }),
      this.prisma.priceRequest.count({ where }),
    ]);
    return {
      items: items.map(({ _count, ...row }) => ({ ...row, lineCount: _count.lines })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  // ───────────────────── worklist (§14 Previous Day Requests) ─────────────────────

  /**
   * {today: […], previousDays: […]} — a previous-day request that is still
   * OPEN appears under previousDays as the SAME record (never duplicated,
   * never deleted). Today: requestDate inside the requested day and status
   * OPEN|OFFERED. previousDays: requestDate before the day AND status OPEN
   * (still awaiting an answer).
   */
  async worklist(companyId: string, dateIso?: string) {
    const date = parseDayStart(dateIso);
    const dayEnd = new Date(date.getTime() + 24 * 60 * 60 * 1000);

    const baseInclude = {
      customer: { select: { id: true, nameFa: true } },
      requester: { select: { id: true, username: true, firstName: true, lastName: true } },
      lines: {
        orderBy: { lineOrder: 'asc' as const },
        include: {
          productVariant: {
            select: { id: true, sku: true, nameFa: true, template: { select: { id: true, nameFa: true } } },
          },
          uom: { select: { id: true, symbol: true } },
        },
      },
    };

    const [today, previousDays] = await Promise.all([
      this.prisma.priceRequest.findMany({
        where: {
          companyId,
          requestDate: { gte: date, lt: dayEnd },
          status: { in: [PriceRequestStatus.OPEN, PriceRequestStatus.OFFERED] },
        },
        include: baseInclude,
        orderBy: { requestDate: 'asc' },
      }),
      this.prisma.priceRequest.findMany({
        where: {
          companyId,
          requestDate: { lt: date },
          status: PriceRequestStatus.OPEN,
        },
        include: baseInclude,
        orderBy: { requestDate: 'asc' },
      }),
    ]);

    return { date, today, previousDays };
  }

  // ───────────────────── lines ─────────────────────

  private async loadRequest(companyId: string, id: string) {
    const request = await this.prisma.priceRequest.findFirst({ where: { id, companyId } });
    if (!request) throw new NotFoundError('Price request not found', { id });
    if (request.status === PriceRequestStatus.CONVERTED || request.status === PriceRequestStatus.CLOSED) {
      throw new ConflictError('PRICE_REQUEST_CLOSED', { status: request.status });
    }
    return request;
  }

  async addLine(
    companyId: string,
    id: string,
    dto: AddPriceRequestLineDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    const request = await this.loadRequest(companyId, id);
    await this.prisma.$transaction(async (tx) => {
      const maxOrder = await tx.priceRequestLine.aggregate({
        where: { priceRequestId: request.id },
        _max: { lineOrder: true },
      });
      const lineData = await this.normalizeLines(tx, companyId, request.id, [dto]);
      await tx.priceRequestLine.create({
        data: { ...lineData[0], lineOrder: (maxOrder._max.lineOrder ?? -1) + 1 },
      });
      await this.auditService.recordTx(tx, {
        entityType: 'price_request',
        entityId: request.id,
        action: AuditAction.UPDATE,
        companyId,
        actor,
        newValues: { lineAdded: lineData[0] } as unknown as Record<string, unknown>,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
    });
    return this.getById(companyId, request.id);
  }

  async updateLine(
    companyId: string,
    id: string,
    lineId: string,
    dto: UpdatePriceRequestLineDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    const request = await this.loadRequest(companyId, id);
    const line = await this.prisma.priceRequestLine.findFirst({
      where: { id: lineId, priceRequestId: request.id, companyId },
    });
    if (!line) throw new NotFoundError('Price request line not found', { lineId });

    await this.prisma.$transaction(async (tx) => {
      const lineData = await this.normalizeLines(tx, companyId, request.id, [
        {
          productVariantId: dto.productVariantId ?? line.productVariantId,
          requestedQuantity: dto.requestedQuantity ?? line.requestedQuantity,
          uomId: dto.uomId ?? line.uomId,
          notes: dto.notes ?? line.notes,
        },
      ]);
      const { lineOrder: _ignored, ...updateData } = lineData[0];
      await tx.priceRequestLine.update({ where: { id: line.id }, data: updateData });
      await this.auditService.recordTx(tx, {
        entityType: 'price_request_line',
        entityId: line.id,
        action: AuditAction.UPDATE,
        companyId,
        actor,
        oldValues: {
          productVariantId: line.productVariantId,
          requestedQuantity: line.requestedQuantity,
          uomId: line.uomId,
        },
        newValues: {
          productVariantId: updateData.productVariantId,
          requestedQuantity: updateData.requestedQuantity,
          uomId: updateData.uomId,
        },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
    });
    return this.getById(companyId, request.id);
  }

  async deleteLine(
    companyId: string,
    id: string,
    lineId: string,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    const request = await this.loadRequest(companyId, id);
    const line = await this.prisma.priceRequestLine.findFirst({
      where: { id: lineId, priceRequestId: request.id, companyId },
    });
    if (!line) throw new NotFoundError('Price request line not found', { lineId });
    await this.prisma.$transaction(async (tx) => {
      await tx.priceRequestLine.delete({ where: { id: line.id } });
      await this.auditService.recordTx(tx, {
        entityType: 'price_request_line',
        entityId: line.id,
        action: AuditAction.DELETE,
        companyId,
        actor,
        oldValues: { productVariantId: line.productVariantId, requestedQuantity: line.requestedQuantity },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
    });
    return this.getById(companyId, request.id);
  }

  // ───────────────────── status transitions ─────────────────────

  /** OPEN|OFFERED → CONVERTED (set by the create-sale/purchase flows). */
  private async markConverted(tx: Client, companyId: string, id: string): Promise<void> {
    await tx.priceRequest.updateMany({
      where: { id, companyId, status: { in: [PriceRequestStatus.OPEN, PriceRequestStatus.OFFERED] } },
      data: { status: PriceRequestStatus.CONVERTED },
    });
  }

  async convert(companyId: string, id: string, actor: { id: string; username: string }, ctx: RequestContext) {
    const request = await this.prisma.priceRequest.findFirst({ where: { id, companyId } });
    if (!request) throw new NotFoundError('Price request not found', { id });
    if (request.status !== PriceRequestStatus.OPEN && request.status !== PriceRequestStatus.OFFERED) {
      throw new ValidationError('INVALID_STATUS_TRANSITION', { from: request.status, to: 'CONVERTED' });
    }
    await this.prisma.$transaction(async (tx) => {
      await this.markConverted(tx, companyId, request.id);
      await this.auditService.recordTx(tx, {
        entityType: 'price_request',
        entityId: request.id,
        action: AuditAction.UPDATE,
        companyId,
        actor,
        oldValues: { status: request.status },
        newValues: { status: PriceRequestStatus.CONVERTED },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
    });
    return this.getById(companyId, request.id);
  }

  async close(companyId: string, id: string, actor: { id: string; username: string }, ctx: RequestContext) {
    const request = await this.prisma.priceRequest.findFirst({ where: { id, companyId } });
    if (!request) throw new NotFoundError('Price request not found', { id });
    if (request.status !== PriceRequestStatus.OPEN && request.status !== PriceRequestStatus.OFFERED) {
      throw new ValidationError('INVALID_STATUS_TRANSITION', { from: request.status, to: 'CLOSED' });
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.priceRequest.update({
        where: { id: request.id },
        data: { status: PriceRequestStatus.CLOSED },
      });
      await this.auditService.recordTx(tx, {
        entityType: 'price_request',
        entityId: request.id,
        action: AuditAction.UPDATE,
        companyId,
        actor,
        oldValues: { status: request.status },
        newValues: { status: PriceRequestStatus.CLOSED },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
    });
    return this.getById(companyId, request.id);
  }

  // ───────────────────── §16 create sale / purchase from request ─────────────────────

  /** POST /api/price-requests/:id/create-sale — SalesDocument(QUOTATION) + GENERATED_FROM. */
  async createSaleFromRequest(
    companyId: string,
    id: string,
    dto: CreateSaleFromRequestDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    const request = await this.prisma.priceRequest.findFirst({
      where: { id, companyId },
      include: { lines: { orderBy: { lineOrder: 'asc' } } },
    });
    if (!request) throw new NotFoundError('Price request not found', { id });
    if (request.status === PriceRequestStatus.CLOSED) {
      throw new ConflictError('PRICE_REQUEST_CLOSED', { status: request.status });
    }

    const customerPartyId = dto.customerPartyId ?? request.customerPartyId;
    if (!customerPartyId) {
      throw new ValidationError('CUSTOMER_REQUIRED', { priceRequestId: request.id });
    }

    const selected = dto.lineSelections
      ? request.lines.filter((l) => dto.lineSelections!.some((s) => s.lineId === l.id))
      : request.lines;

    // Internal detail read uses ALL scope — the caller passed permission
    // checks and owns the created document.
    const sale = await this.salesService.create(
      companyId,
      { userId: actor.id, scope: 'ALL' },
      {
        customerPartyId,
        salespersonUserId: dto.salespersonUserId ?? actor.id,
        status: 'QUOTATION',
        documentDate: dto.documentDate,
        paymentTermId: dto.paymentTermId,
        priceRequestId: request.id,
        lines: selected.map((line) => {
          const selection = dto.lineSelections?.find((s) => s.lineId === line.id);
          return {
            productVariantId: line.productVariantId,
            quantity: selection?.quantity ?? Number(line.requestedQuantity),
            uomId: selection?.uomId ?? line.uomId,
            unitPrice: selection?.unitPrice ?? 0, // salesperson fills the price
          };
        }),
      },
      actor,
      ctx,
    );

    // GENERATED_FROM relations (both directions) + CONVERTED — one tx.
    await this.prisma.$transaction(async (tx) => {
      await this.relations.createRelation(
        companyId,
        { fromType: 'sales_document', fromId: sale.id, toType: 'price_request', toId: request.id, relationType: 'GENERATED_FROM' },
        actor,
        ctx,
        tx,
      );
      await this.relations.createRelation(
        companyId,
        { fromType: 'price_request', fromId: request.id, toType: 'sales_document', toId: sale.id, relationType: 'GENERATED_FROM' },
        actor,
        ctx,
        tx,
      );
      await this.markConverted(tx, companyId, request.id);
    });
    return this.getById(companyId, request.id);
  }

  /** POST /api/price-requests/:id/create-purchase — PurchaseDocument + GENERATED_FROM. */
  async createPurchaseFromRequest(
    companyId: string,
    id: string,
    dto: CreatePurchaseFromRequestDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    const request = await this.prisma.priceRequest.findFirst({
      where: { id, companyId },
      include: { lines: { orderBy: { lineOrder: 'asc' } } },
    });
    if (!request) throw new NotFoundError('Price request not found', { id });
    if (request.status === PriceRequestStatus.CLOSED) {
      throw new ConflictError('PRICE_REQUEST_CLOSED', { status: request.status });
    }

    // When an offer is selected, its price is copied onto the purchase line.
    const offerIds = (dto.lineSelections ?? [])
      .map((s) => s.offerId)
      .filter((v): v is string => !!v);
    const offers = offerIds.length
      ? await this.prisma.supplierOffer.findMany({
          where: { id: { in: offerIds }, companyId },
          select: { id: true, offeredPrice: true, uomId: true },
        })
      : [];
    const offerMap = new Map(offers.map((o) => [o.id, o]));

    const selected = dto.lineSelections
      ? request.lines.filter((l) => dto.lineSelections!.some((s) => s.lineId === l.id))
      : request.lines;

    const purchase = await this.purchaseService.create(
      companyId,
      {
        supplierPartyId: dto.supplierPartyId,
        buyerUserId: dto.buyerUserId ?? actor.id,
        documentDate: dto.documentDate,
        paymentTermId: dto.paymentTermId,
        priceRequestId: request.id,
        lines: selected.map((line) => {
          const selection = dto.lineSelections?.find((s) => s.lineId === line.id);
          const offer = selection?.offerId ? offerMap.get(selection.offerId) : undefined;
          return {
            productVariantId: line.productVariantId,
            quantity: selection?.quantity ?? Number(line.requestedQuantity),
            uomId: offer?.uomId ?? line.uomId,
            unitPrice: selection?.unitPrice ?? (offer ? Number(offer.offeredPrice) : 0),
          };
        }),
      },
      actor,
      ctx,
    );

    await this.prisma.$transaction(async (tx) => {
      await this.relations.createRelation(
        companyId,
        { fromType: 'purchase_document', fromId: purchase.id, toType: 'price_request', toId: request.id, relationType: 'GENERATED_FROM' },
        actor,
        ctx,
        tx,
      );
      await this.relations.createRelation(
        companyId,
        { fromType: 'price_request', fromId: request.id, toType: 'purchase_document', toId: purchase.id, relationType: 'GENERATED_FROM' },
        actor,
        ctx,
        tx,
      );
      await this.markConverted(tx, companyId, request.id);
    });

    const sale2 = await this.getById(companyId, request.id);
    return { ...sale2, createdPurchaseId: purchase.id };
  }
}
