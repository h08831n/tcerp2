import { Injectable, Inject, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DailyPrice, Prisma, SalesDocumentStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SequencesService } from '../sequences/sequences.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit.dto';
import { TimelineService } from '../parties/timeline.service';
import { DocumentRelationService } from '../document-flow/document-relation.service';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../common/errors';
import { assertActiveCompanyMember } from '../common/utils/company-member';
import { assertCustomer } from '../common/utils/party-roles';
import { D, calcLineTotals, moneyString, roundMoney, roundQuantity, sumDocumentTotals } from '../common/utils/money';
import { RequestContext } from '../auth/auth.service';
import { Paginated } from '../common/dto/pagination.dto';
import {
  AddSalesLineDto,
  CreateLinesFromMatrixDto,
  CreateSaleFromPurchaseDto,
  CreateSalesDocumentDto,
  LostDocumentDto,
  SalesDocumentQueryDto,
  UpdateSalesDocumentDto,
  UpdateSalesLineDto,
} from './sales.dto';
import { ActorScope, assertSalesInScope, salesScopeWhere } from './sales-scope';
import { buildPrintableDescriptions } from './printable-description';
import { DailyPriceService } from '../pricing/daily-price.service';

/**
 * Sales documents (REQUIREMENTS §9-10): ONE entity for quotation → sales
 * order — the document keeps its id and documentNumber for its whole life
 * (SD-1405-00001); only the status changes. Totals are server-authoritative
 * (Prisma.Decimal math, `common/utils/money`). Confirmed-order lock +
 * manager override are enforced here (p4-10..p4-13).
 *
 * p5c pricing-integrity review — line price snapshots: every SalesLine
 * records WHERE its unitPrice came from:
 *   - `MANUAL`           — the caller sent an explicit non-zero unitPrice;
 *   - `DAILY_PRICE`      — no explicit price: TODAY's DailyPrice row for
 *                          (variant, uom) was snapshotted (priceDate = that
 *                          row's day; later price edits never touch it);
 *   - `TEMPLATE_DEFAULT` — no explicit price and no DailyPrice row: the
 *                          template's defaultSalesPrice (legacy behavior).
 */

type Client = Prisma.TransactionClient;

export const SALES_EXPIRATION_SETTING = 'sales.quotation_expiration_days';
export const SALES_EXPIRATION_DEFAULT_DAYS = 14;
export const SALES_LOST_REASON_REQUIRED_SETTING = 'sales.lost_reason_required';
export const OVERRIDE_ACTION = 'OVERRIDE_CONFIRMED_ORDER';

/** After customer confirmation the committed line fields are locked. */
export const LOCKED_STATUSES: SalesDocumentStatus[] = [
  SalesDocumentStatus.CUSTOMER_CONFIRMED,
  SalesDocumentStatus.SALES_ORDER,
  SalesDocumentStatus.PARTIALLY_LOADED,
  SalesDocumentStatus.COMPLETED,
];

/** Header fields that stay editable on a confirmed order without override. */
const CONFIRMED_EDITABLE_HEADER_FIELDS = [
  'expirationDate',
  'paymentTermId',
  'shippingAddressId',
  'notes',
] as const;

export interface SalesActorContext {
  actorScope: ActorScope;
  teamUserIds: string[];
  canOverrideConfirmedOrder: boolean;
}

interface LineInput {
  productVariantId: string;
  quantity: number | string | Prisma.Decimal;
  uomId?: string | null;
  unitPrice?: number | string | Prisma.Decimal | null;
  discountAmount?: number | string | Prisma.Decimal | null;
  taxDefinitionId?: string | null;
  printableDescription?: string | null;
  notes?: string | null;
}

function isLocked(status: SalesDocumentStatus): boolean {
  return LOCKED_STATUSES.includes(status);
}

function assertLineMutationAllowed(status: SalesDocumentStatus, canOverride: boolean, reason?: string | null): void {
  if (!isLocked(status)) return;
  if (!canOverride) throw new ForbiddenError('ORDER_LOCKED');
  if (!reason || reason.trim().length === 0) throw new ValidationError('OVERRIDE_REASON_REQUIRED');
}

@Injectable()
export class SalesDocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sequences: SequencesService,
    private readonly auditService: AuditService,
    private readonly timeline: TimelineService,
    private readonly relations: DocumentRelationService,
    // Optional so hand-built test instances keep working; SalesModule provides
    // DailyPriceService directly (importing PricingModule would be circular:
    // PricingModule → PriceRequestModule → SalesModule).
    @Optional() @Inject(DailyPriceService)
    private readonly dailyPrices?: DailyPriceService,
  ) {}

  // ───────────────────── scope helpers (party-scope precedent) ─────────────────────

  /** Team member user ids of the teams the user belongs to/manages. */
  async teamUserIds(userId: string, companyId: string): Promise<string[]> {
    const teams = await this.prisma.team.findMany({
      where: { companyId, OR: [{ members: { some: { userId } } }, { managerId: userId }] },
      select: { id: true },
    });
    if (teams.length === 0) return [];
    const rows = await this.prisma.teamMember.findMany({
      where: { teamId: { in: teams.map((t) => t.id) } },
      select: { userId: true },
    });
    return [...new Set(rows.map((r) => r.userId))];
  }

  private async resolveTeamIds(actorScope: ActorScope, companyId: string): Promise<string[]> {
    return actorScope.scope === 'TEAM' ? this.teamUserIds(actorScope.userId, companyId) : [];
  }

  private assertScope(actorScope: ActorScope, teamIds: string[], doc: { id: string; salespersonUserId: string }): void {
    assertSalesInScope(actorScope.scope, actorScope.userId, teamIds, doc);
  }

  // ───────────────────── line normalization (server-authoritative totals) ─────────────────────

  private async normalizeLines(
    tx: Client,
    companyId: string,
    salesDocumentId: string,
    inputs: LineInput[],
    printableOverrides: (string | null | undefined)[] = [],
  ): Promise<Prisma.SalesLineUncheckedCreateInput[]> {
    // printableOverrides[i]: string | null = use verbatim; undefined = compute
    // the default «template nameFa + attribute values fa ' / '».
    const variantIds = [...new Set(inputs.map((i) => i.productVariantId))];
    const variants = await tx.productVariant.findMany({
      where: { id: { in: variantIds }, companyId },
      select: {
        id: true,
        defaultUomId: true,
        template: {
          select: { nameFa: true, defaultSalesPrice: true, defaultSalesUomId: true, defaultTaxDefinitionId: true },
        },
      },
    });
    const variantMap = new Map(variants.map((v) => [v.id, v]));

    const printable = await buildPrintableDescriptions(tx, variantIds);

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

    const taxIds = new Set<string>();
    for (const input of inputs) if (input.taxDefinitionId) taxIds.add(input.taxDefinitionId);
    const taxDefs = await tx.taxDefinition.findMany({
      where: { id: { in: [...taxIds] }, companyId, isActive: true },
      select: { id: true, rate: true },
    });
    const taxMap = new Map(taxDefs.map((t) => [t.id, t]));

    // Today's DailyPrice per (variant, uom) — memoized per normalizeLines call
    // so a matrix batch resolves each pair with ONE query (no N×M). Absent
    // DailyPriceService (hand-built test instances) → template fallback.
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
        const uomId = input.uomId ?? variant.defaultUomId ?? variant.template.defaultSalesUomId;
        if (!uomId || !uomSet.has(uomId)) {
          throw new ValidationError('UOM_REQUIRED', { productVariantId: input.productVariantId });
        }

        const taxDefinitionId = input.taxDefinitionId ?? variant.template.defaultTaxDefinitionId ?? null;
        let taxRateSnapshot: Prisma.Decimal | null = null;
        if (taxDefinitionId) {
          const def = taxMap.get(taxDefinitionId);
          if (!def) throw new NotFoundError('Tax definition not found', { taxDefinitionId });
          taxRateSnapshot = def.rate;
        }

        // Price snapshot (see class doc): explicit non-zero price → MANUAL;
        // absent/null/0 → today's DailyPrice for (variant, uom), else the
        // template default. Kept on the line forever after — later DailyPrice
        // changes never touch stored documents (pricing integrity).
        const explicitPrice =
          input.unitPrice !== undefined && input.unitPrice !== null && !D(input.unitPrice).isZero();
        let unitPrice: Prisma.Decimal;
        let priceSource: 'MANUAL' | 'DAILY_PRICE' | 'TEMPLATE_DEFAULT';
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
            unitPrice = variant.template.defaultSalesPrice;
            priceSource = 'TEMPLATE_DEFAULT';
            priceDate = null;
          }
        }

        const { subtotal, taxAmount, lineTotal } = calcLineTotals({
          quantity: input.quantity,
          unitPrice,
          discountAmount: input.discountAmount ?? 0,
          taxRate: taxRateSnapshot,
        });

        return {
          companyId,
          salesDocumentId,
          productVariantId: input.productVariantId,
          printableDescription:
            printableOverrides[idx] !== undefined
              ? (printableOverrides[idx] as string | null)
              : printable.get(input.productVariantId) ?? null,
          orderedQuantity: roundQuantity(D(input.quantity)),
          uomId,
          unitPrice,
          priceSource,
          priceDate,
          discountAmount: roundMoney(D(input.discountAmount ?? 0)),
          taxDefinitionId,
          taxRateSnapshot,
          subtotal,
          taxAmount,
          lineTotal,
          notes: input.notes ?? null,
          lineOrder: idx,
        } satisfies Prisma.SalesLineUncheckedCreateInput;
      }),
    );
  }

  private async recomputeDocumentTotals(tx: Client, salesDocumentId: string): Promise<void> {
    const agg = await tx.salesLine.aggregate({
      where: { salesDocumentId },
      _sum: { subtotal: true, discountAmount: true, taxAmount: true, lineTotal: true },
    });
    await tx.salesDocument.update({
      where: { id: salesDocumentId },
      data: {
        subtotal: agg._sum.subtotal ?? 0,
        discountTotal: agg._sum.discountAmount ?? 0,
        taxTotal: agg._sum.taxAmount ?? 0,
        total: agg._sum.lineTotal ?? 0,
      },
    });
  }

  // ───────────────────── settings ─────────────────────

  private async readExpirationDays(tx: Client, companyId: string): Promise<number> {
    const setting = await tx.setting.findUnique({
      where: { companyId_key: { companyId, key: SALES_EXPIRATION_SETTING } },
      select: { value: true },
    });
    const value = setting?.value;
    if (typeof value === 'number' && value > 0) return Math.floor(value);
    if (typeof value === 'string' && /^\d+$/.test(value)) return parseInt(value, 10);
    if (value && typeof value === 'object' && 'days' in (value as object)) {
      const days = (value as { days?: unknown }).days;
      if (typeof days === 'number' && days > 0) return Math.floor(days);
    }
    return SALES_EXPIRATION_DEFAULT_DAYS;
  }

  private async readLostReasonRequired(companyId: string): Promise<boolean> {
    const setting = await this.prisma.setting.findUnique({
      where: { companyId_key: { companyId, key: SALES_LOST_REASON_REQUIRED_SETTING } },
      select: { value: true },
    });
    return setting?.value !== false; // default true
  }

  // ───────────────────── create / shared document writer ─────────────────────

  private async createDocumentTx(
    tx: Client,
    companyId: string,
    params: {
      customerPartyId: string;
      salespersonUserId: string;
      status: 'DRAFT' | 'QUOTATION';
      documentDate?: Date;
      expirationDate?: Date;
      paymentTermId?: string | null;
      shippingAddressId?: string | null;
      opportunityId?: string | null;
      priceRequestId?: string | null;
      currency?: string;
      language?: string;
      quotationTemplateCode?: string;
      lines: LineInput[];
      printableOverrides?: (string | null | undefined)[];
    },
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    await assertCustomer(tx, companyId, params.customerPartyId);
    await assertActiveCompanyMember(tx, companyId, params.salespersonUserId, 'SALESPERSON_NOT_COMPANY_MEMBER');

    const documentDate = params.documentDate ?? new Date();
    const expirationDate =
      params.expirationDate ??
      new Date(documentDate.getTime() + (await this.readExpirationDays(tx, companyId)) * 24 * 60 * 60 * 1000);

    const { number: documentNumber } = await this.sequences.allocate(companyId, 'SALES_DOCUMENT', tx, documentDate);

    // Lines need the parent id; allocate the uuid up front (schema default
    // is uuid() — passing it explicitly is equivalent).
    const salesDocumentId = randomUUID();
    const lineData = await this.normalizeLines(tx, companyId, salesDocumentId, params.lines, params.printableOverrides);
    const totals = sumDocumentTotals(lineData);

    const document = await tx.salesDocument.create({
      data: {
        id: salesDocumentId,
        companyId,
        documentNumber,
        customerPartyId: params.customerPartyId,
        salespersonUserId: params.salespersonUserId,
        documentDate,
        expirationDate,
        currency: params.currency ?? 'IRR',
        paymentTermId: params.paymentTermId ?? null,
        shippingAddressId: params.shippingAddressId ?? null,
        language: params.language ?? 'fa',
        quotationTemplateCode: params.quotationTemplateCode ?? null,
        opportunityId: params.opportunityId ?? null,
        priceRequestId: params.priceRequestId ?? null,
        status: params.status,
        subtotal: totals.subtotal,
        discountTotal: totals.discountTotal,
        taxTotal: totals.taxTotal,
        total: totals.total,
        createdBy: actor.id,
        // Nested create: the parent sets salesDocumentId itself.
        lines: { create: lineData.map(({ salesDocumentId: _sid, ...line }) => line) },
      },
      include: { lines: true },
    });

    await this.auditService.recordTx(tx, {
      entityType: 'sales_document',
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
      entityId: params.customerPartyId,
      type: 'QUOTATION_CREATED',
      title: 'صدور پیش‌فاکتور',
      description: `پیش‌فاکتور ${documentNumber} صادر شد`,
      data: { salesDocumentId: document.id, documentNumber },
      actorUserId: actor.id,
    });

    return document;
  }

  async create(
    companyId: string,
    actorScope: ActorScope,
    dto: CreateSalesDocumentDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    const document = await this.prisma.$transaction((tx) =>
      this.createDocumentTx(
        tx,
        companyId,
        {
          customerPartyId: dto.customerPartyId,
          salespersonUserId: dto.salespersonUserId ?? actor.id,
          status: dto.status ?? 'QUOTATION',
          documentDate: dto.documentDate ? new Date(dto.documentDate) : undefined,
          expirationDate: dto.expirationDate ? new Date(dto.expirationDate) : undefined,
          paymentTermId: dto.paymentTermId,
          shippingAddressId: dto.shippingAddressId,
          opportunityId: dto.opportunityId,
          priceRequestId: dto.priceRequestId,
          currency: dto.currency,
          language: dto.language,
          quotationTemplateCode: dto.quotationTemplateCode,
          lines: dto.lines ?? [],
          // Per-line printable overrides at create (same semantics as addLine:
          // undefined → compute the «template + attribute values» default).
          printableOverrides: dto.lines?.map((l) => l.printableDescription),
        },
        actor,
        ctx,
      ),
    );
    return this.getById(companyId, actorScope, document.id);
  }

  // ───────────────────── matrix (Phase 4 grid) ─────────────────────

  /** POST /api/sales/:id/lines/matrix — ONE line per NON-EMPTY cell. */
  async createFromMatrix(
    companyId: string,
    actorContext: SalesActorContext,
    id: string,
    dto: CreateLinesFromMatrixDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    const teamIds = await this.resolveTeamIds(actorContext.actorScope, companyId);
    const doc = await this.prisma.salesDocument.findFirst({ where: { id, companyId } });
    if (!doc) throw new NotFoundError('Sales document not found', { id });
    this.assertScope(actorContext.actorScope, teamIds, doc);

    // Never create lines for empty cells.
    const filled = dto.cells.filter((c) => c.quantity !== undefined && c.quantity !== null && c.quantity > 0);
    if (filled.length === 0) {
      throw new ValidationError('MATRIX_EMPTY', { cells: dto.cells.length });
    }

    assertLineMutationAllowed(doc.status, actorContext.canOverrideConfirmedOrder, dto.reason);

    await this.prisma.$transaction(async (tx) => {
      const maxOrder = await tx.salesLine.aggregate({
        where: { salesDocumentId: doc.id },
        _max: { lineOrder: true },
      });
      const start = (maxOrder._max.lineOrder ?? -1) + 1;
      const lineData = await this.normalizeLines(
        tx,
        companyId,
        doc.id,
        filled.map((c) => ({
          productVariantId: c.productVariantId,
          quantity: c.quantity as number,
          uomId: c.uomId,
          unitPrice: c.unitPrice,
          discountAmount: c.discountAmount,
          taxDefinitionId: c.taxDefinitionId,
          notes: c.notes,
          printableDescription: c.printableDescription,
        })),
      );
      await tx.salesLine.createMany({
        data: lineData.map((l, idx) => ({ ...l, lineOrder: start + idx })),
      });
      await this.recomputeDocumentTotals(tx, doc.id);

      await this.auditService.recordTx(tx, {
        entityType: 'sales_document',
        entityId: doc.id,
        action: AuditAction.UPDATE,
        companyId,
        actor,
        newValues: { linesAdded: lineData.length, source: 'matrix' },
        reason: dto.reason,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      if (isLocked(doc.status)) {
        await this.auditService.recordTx(tx, {
          entityType: 'sales_document',
          entityId: doc.id,
          action: OVERRIDE_ACTION,
          companyId,
          actor,
          oldValues: { lineCount: null },
          newValues: { linesAdded: lineData.length },
          reason: dto.reason,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        await this.timeline.record(tx, {
          companyId,
          entityType: 'PARTY',
          entityId: doc.customerPartyId,
          type: 'ORDER_OVERRIDDEN',
          title: 'بازکردن قفل سفارش تأییدشده',
          description: dto.reason,
          data: { salesDocumentId: doc.id, linesAdded: lineData.length },
          actorUserId: actor.id,
        });
      }
    });
    return this.getById(companyId, actorContext.actorScope, id);
  }

  // ───────────────────── line CRUD ─────────────────────

  async addLine(
    companyId: string,
    actorContext: SalesActorContext,
    id: string,
    dto: AddSalesLineDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    const teamIds = await this.resolveTeamIds(actorContext.actorScope, companyId);
    const doc = await this.prisma.salesDocument.findFirst({ where: { id, companyId } });
    if (!doc) throw new NotFoundError('Sales document not found', { id });
    this.assertScope(actorContext.actorScope, teamIds, doc);
    assertLineMutationAllowed(doc.status, actorContext.canOverrideConfirmedOrder, dto.overrideReason);

    await this.prisma.$transaction(async (tx) => {
      const maxOrder = await tx.salesLine.aggregate({
        where: { salesDocumentId: doc.id },
        _max: { lineOrder: true },
      });
      const lineData = await this.normalizeLines(tx, companyId, doc.id, [dto], [dto.printableDescription]);
      await tx.salesLine.create({
        data: { ...lineData[0], lineOrder: (maxOrder._max.lineOrder ?? -1) + 1 },
      });
      await this.recomputeDocumentTotals(tx, doc.id);
      await this.auditService.recordTx(tx, {
        entityType: 'sales_line',
        entityId: doc.id,
        action: AuditAction.CREATE,
        companyId,
        actor,
        newValues: lineData[0] as unknown as Record<string, unknown>,
        reason: dto.overrideReason,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      if (isLocked(doc.status)) {
        await this.auditService.recordTx(tx, {
          entityType: 'sales_document',
          entityId: doc.id,
          action: OVERRIDE_ACTION,
          companyId,
          actor,
          newValues: { lineAdded: lineData[0] } as unknown as Record<string, unknown>,
          reason: dto.overrideReason,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
      }
    });
    return this.getById(companyId, actorContext.actorScope, id);
  }

  async updateLine(
    companyId: string,
    actorContext: SalesActorContext,
    id: string,
    lineId: string,
    dto: UpdateSalesLineDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    const teamIds = await this.resolveTeamIds(actorContext.actorScope, companyId);
    const doc = await this.prisma.salesDocument.findFirst({ where: { id, companyId } });
    if (!doc) throw new NotFoundError('Sales document not found', { id });
    this.assertScope(actorContext.actorScope, teamIds, doc);

    const line = await this.prisma.salesLine.findFirst({
      where: { id: lineId, salesDocumentId: doc.id, companyId },
    });
    if (!line) throw new NotFoundError('Sales line not found', { lineId });

    // printableDescription/notes stay editable on confirmed orders? No — the
    // locked set is exactly productVariantId/orderedQuantity/uomId/unitPrice/
    // discountAmount (REQUIREMENTS §9). Any edit to those needs override.
    const touchesLockedFields =
      dto.productVariantId !== undefined ||
      dto.quantity !== undefined ||
      dto.uomId !== undefined ||
      dto.unitPrice !== undefined ||
      dto.discountAmount !== undefined;
    if (isLocked(doc.status)) {
      if (touchesLockedFields) {
        assertLineMutationAllowed(doc.status, actorContext.canOverrideConfirmedOrder, dto.overrideReason);
      } else if (dto.printableDescription === undefined && dto.notes === undefined && dto.taxDefinitionId === undefined) {
        throw new ValidationError('NOTHING_TO_UPDATE');
      }
    }

    const variantChanged = dto.productVariantId !== undefined && dto.productVariantId !== line.productVariantId;
    const effective: LineInput = {
      productVariantId: dto.productVariantId ?? line.productVariantId,
      quantity: dto.quantity ?? line.orderedQuantity,
      uomId: dto.uomId ?? line.uomId,
      unitPrice: dto.unitPrice ?? line.unitPrice,
      discountAmount: dto.discountAmount ?? line.discountAmount,
      taxDefinitionId: dto.taxDefinitionId !== undefined ? dto.taxDefinitionId : line.taxDefinitionId,
      printableDescription: undefined,
      notes: dto.notes ?? line.notes,
    };
    // Keep the stored printable text unless the variant changed (then recompute
    // the default) or the caller sent an explicit override.
    const printableOverride = dto.printableDescription ?? (variantChanged ? undefined : line.printableDescription);

    await this.prisma.$transaction(async (tx) => {
      const lineData = await this.normalizeLines(tx, companyId, doc.id, [effective], [printableOverride]);
      // Never touch lineOrder/salesDocumentId on edit. p5c snapshot semantics
      // on PATCH:
      //   - unitPrice PATCHed to a non-zero value that CHANGES the line
      //     (confirmed-order override) → snapshot becomes MANUAL, priceDate
      //     null (the daily reference no longer applies);
      //   - unitPrice PATCHed as 0/null → "re-resolve the default": adopt the
      //     freshly resolved snapshot (DAILY_PRICE/TEMPLATE_DEFAULT);
      //   - unitPrice untouched → keep the stored snapshot (quantity/notes/…
      //     edits never rewrite the price provenance).
      const explicitPatch =
        dto.unitPrice !== undefined && dto.unitPrice !== null && !D(dto.unitPrice).isZero();
      const priceChanged = explicitPatch && !D(dto.unitPrice).equals(line.unitPrice);
      const reResolve = dto.unitPrice !== undefined && dto.unitPrice !== null && !explicitPatch;
      const {
        lineOrder: _lo,
        salesDocumentId: _sid,
        priceSource: _ps,
        priceDate: _pd,
        ...updateData
      } = lineData[0];
      await tx.salesLine.update({
        where: { id: line.id },
        data: {
          ...updateData,
          ...(reResolve ? { priceSource: lineData[0].priceSource, priceDate: lineData[0].priceDate } : {}),
          ...(priceChanged ? { priceSource: 'MANUAL', priceDate: null } : {}),
        },
      });
      await this.recomputeDocumentTotals(tx, doc.id);
      await this.auditService.recordTx(tx, {
        entityType: 'sales_line',
        entityId: line.id,
        action: AuditAction.UPDATE,
        companyId,
        actor,
        oldValues: {
          productVariantId: line.productVariantId,
          orderedQuantity: line.orderedQuantity,
          uomId: line.uomId,
          unitPrice: line.unitPrice,
          discountAmount: line.discountAmount,
        },
        newValues: {
          productVariantId: effective.productVariantId,
          orderedQuantity: lineData[0].orderedQuantity,
          uomId: effective.uomId,
          unitPrice: lineData[0].unitPrice,
          discountAmount: lineData[0].discountAmount,
        },
        reason: dto.overrideReason,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      if (isLocked(doc.status) && touchesLockedFields) {
        // p4-13: old/new values + reason + timestamp, ATOMIC in the same tx.
        await this.auditService.recordTx(tx, {
          entityType: 'sales_document',
          entityId: doc.id,
          action: OVERRIDE_ACTION,
          companyId,
          actor,
          oldValues: {
            lineId: line.id,
            productVariantId: line.productVariantId,
            orderedQuantity: line.orderedQuantity,
            uomId: line.uomId,
            unitPrice: line.unitPrice,
            discountAmount: line.discountAmount,
          },
          newValues: {
            lineId: line.id,
            productVariantId: effective.productVariantId,
            orderedQuantity: lineData[0].orderedQuantity,
            uomId: effective.uomId,
            unitPrice: lineData[0].unitPrice,
            discountAmount: lineData[0].discountAmount,
          },
          reason: dto.overrideReason,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        await this.timeline.record(tx, {
          companyId,
          entityType: 'PARTY',
          entityId: doc.customerPartyId,
          type: 'ORDER_OVERRIDDEN',
          title: 'بازکردن قفل سفارش تأییدشده',
          description: dto.overrideReason,
          data: { salesDocumentId: doc.id, salesLineId: line.id },
          actorUserId: actor.id,
        });
      }
    });
    return this.getById(companyId, actorContext.actorScope, id);
  }

  async deleteLine(
    companyId: string,
    actorContext: SalesActorContext,
    id: string,
    lineId: string,
    actor: { id: string; username: string },
    ctx: RequestContext,
    overrideReason?: string,
  ) {
    const teamIds = await this.resolveTeamIds(actorContext.actorScope, companyId);
    const doc = await this.prisma.salesDocument.findFirst({ where: { id, companyId } });
    if (!doc) throw new NotFoundError('Sales document not found', { id });
    this.assertScope(actorContext.actorScope, teamIds, doc);
    assertLineMutationAllowed(doc.status, actorContext.canOverrideConfirmedOrder, overrideReason);

    const line = await this.prisma.salesLine.findFirst({
      where: { id: lineId, salesDocumentId: doc.id, companyId },
    });
    if (!line) throw new NotFoundError('Sales line not found', { lineId });

    await this.prisma.$transaction(async (tx) => {
      await tx.salesLine.delete({ where: { id: line.id } });
      await this.recomputeDocumentTotals(tx, doc.id);
      await this.auditService.recordTx(tx, {
        entityType: 'sales_line',
        entityId: line.id,
        action: AuditAction.DELETE,
        companyId,
        actor,
        oldValues: {
          productVariantId: line.productVariantId,
          orderedQuantity: line.orderedQuantity,
          unitPrice: line.unitPrice,
        },
        reason: overrideReason,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      if (isLocked(doc.status)) {
        await this.auditService.recordTx(tx, {
          entityType: 'sales_document',
          entityId: doc.id,
          action: OVERRIDE_ACTION,
          companyId,
          actor,
          oldValues: { lineId: line.id, productVariantId: line.productVariantId, orderedQuantity: line.orderedQuantity },
          newValues: { lineDeleted: true },
          reason: overrideReason,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
      }
    });
    return this.getById(companyId, actorContext.actorScope, id);
  }

  // ───────────────────── header PATCH (optimistic) ─────────────────────

  async update(
    companyId: string,
    actorContext: SalesActorContext,
    id: string,
    dto: UpdateSalesDocumentDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    const teamIds = await this.resolveTeamIds(actorContext.actorScope, companyId);
    const doc = await this.prisma.salesDocument.findFirst({ where: { id, companyId } });
    if (!doc) throw new NotFoundError('Sales document not found', { id });
    this.assertScope(actorContext.actorScope, teamIds, doc);

    if (isLocked(doc.status)) {
      const otherFields = Object.keys(dto).filter(
        (k) => k !== 'version' && !(CONFIRMED_EDITABLE_HEADER_FIELDS as readonly string[]).includes(k),
      );
      const touchesNonEditable = otherFields.some(
        (k) => (dto as unknown as Record<string, unknown>)[k] !== undefined,
      );
      if (touchesNonEditable) {
        throw new ForbiddenError('ORDER_LOCKED', { fields: otherFields });
      }
    }

    if (dto.shippingAddressId) {
      const address = await this.prisma.address.findFirst({
        where: { id: dto.shippingAddressId, companyId },
        select: { id: true },
      });
      if (!address) throw new NotFoundError('Address not found', { addressId: dto.shippingAddressId });
    }
    if (dto.paymentTermId) {
      const term = await this.prisma.paymentTerm.findFirst({
        where: { id: dto.paymentTermId, companyId },
        select: { id: true },
      });
      if (!term) throw new NotFoundError('Payment term not found', { paymentTermId: dto.paymentTermId });
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.salesDocument.update({
        where: { id: doc.id, version: dto.version },
        data: {
          documentDate: dto.documentDate ? new Date(dto.documentDate) : undefined,
          expirationDate: dto.expirationDate ? new Date(dto.expirationDate) : undefined,
          paymentTermId: dto.paymentTermId,
          shippingAddressId: dto.shippingAddressId,
          language: dto.language,
          quotationTemplateCode: dto.quotationTemplateCode,
          notes: dto.notes,
          version: { increment: 1 },
        },
      });
      await this.auditService.recordTx(tx, {
        entityType: 'sales_document',
        entityId: row.id,
        action: AuditAction.UPDATE,
        companyId,
        actor,
        oldValues: {
          expirationDate: doc.expirationDate,
          paymentTermId: doc.paymentTermId,
          notes: doc.notes,
          shippingAddressId: doc.shippingAddressId,
        },
        newValues: {
          expirationDate: row.expirationDate,
          paymentTermId: row.paymentTermId,
          notes: row.notes,
          shippingAddressId: row.shippingAddressId,
        },
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
    return this.getById(companyId, actorContext.actorScope, updated.id);
  }

  // ───────────────────── reads ─────────────────────

  async getById(companyId: string, actorScope: ActorScope, id: string) {
    const teamIds = await this.resolveTeamIds(actorScope, companyId);
    const doc = await this.prisma.salesDocument.findFirst({
      where: { id, companyId },
      include: {
        customer: { select: { id: true, nameFa: true } },
        salesperson: { select: { id: true, username: true, firstName: true, lastName: true } },
        paymentTerm: { select: { id: true, code: true, nameFa: true } },
        lostReason: { select: { id: true, code: true, nameFa: true } },
        priceRequest: { select: { id: true, requestNumber: true } },
        lines: {
          orderBy: { lineOrder: 'asc' },
          include: {
            productVariant: {
              select: { id: true, sku: true, nameFa: true, template: { select: { id: true, nameFa: true } } },
            },
            uom: { select: { id: true, symbol: true, nameFa: true } },
            taxDefinition: { select: { id: true, code: true, name: true, rate: true } },
          },
        },
      },
    });
    if (!doc) throw new NotFoundError('Sales document not found', { id });
    this.assertScope(actorScope, teamIds, doc);
    return doc;
  }

  /**
   * Lightweight grid projection — exactly 3 queries per page: findMany,
   * count, grouped line count (p4-34).
   */
  async list(companyId: string, actorScope: ActorScope, query: SalesDocumentQueryDto): Promise<Paginated<unknown>> {
    const teamIds = await this.resolveTeamIds(actorScope, companyId);
    const now = new Date();
    const where: Prisma.SalesDocumentWhereInput = {
      companyId,
      status: query.status,
      customerPartyId: query.customerPartyId,
      salespersonUserId: query.salespersonUserId,
      opportunityId: query.opportunityId,
      ...(query.expired === true
        ? { expirationDate: { lt: now }, status: { in: [SalesDocumentStatus.QUOTATION, SalesDocumentStatus.SENT] } }
        : {}),
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
              { customer: { nameFa: { contains: query.search } } },
            ],
          }
        : {}),
      // Record scope is a hard ceiling: AND-ed in so no query filter can
      // widen it (p4-30).
      AND: [salesScopeWhere(actorScope.scope, actorScope.userId, teamIds)],
    };

    const [items, total] = await Promise.all([
      this.prisma.salesDocument.findMany({
        where,
        orderBy: { documentDate: query.sortDir },
        skip: query.skip,
        take: query.take,
        select: {
          id: true,
          documentNumber: true,
          status: true,
          documentDate: true,
          expirationDate: true,
          subtotal: true,
          discountTotal: true,
          taxTotal: true,
          total: true,
          version: true,
          customer: { select: { id: true, nameFa: true } },
          salesperson: { select: { id: true, username: true, firstName: true, lastName: true } },
        },
      }),
      this.prisma.salesDocument.count({ where }),
    ]);

    // 3rd query: grouped line counts for the whole page (no N+1).
    const ids = items.map((i) => i.id);
    const lineCounts = ids.length
      ? await this.prisma.salesLine.groupBy({
          by: ['salesDocumentId'],
          where: { salesDocumentId: { in: ids } },
          _count: { _all: true },
        })
      : [];
    const countMap = new Map(lineCounts.map((c) => [c.salesDocumentId, c._count._all]));

    return {
      items: items.map((doc) => ({
        id: doc.id,
        documentNumber: doc.documentNumber,
        status: doc.status,
        documentDate: doc.documentDate,
        expirationDate: doc.expirationDate,
        customer: doc.customer,
        salesperson: {
          id: doc.salesperson.id,
          name: [doc.salesperson.firstName, doc.salesperson.lastName].filter(Boolean).join(' ') || doc.salesperson.username,
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

  // ───────────────────── transitions ─────────────────────

  private async loadForTransition(companyId: string, actorScope: ActorScope, id: string) {
    const teamIds = await this.resolveTeamIds(actorScope, companyId);
    const doc = await this.prisma.salesDocument.findFirst({ where: { id, companyId } });
    if (!doc) throw new NotFoundError('Sales document not found', { id });
    this.assertScope(actorScope, teamIds, doc);
    return doc;
  }

  /** QUOTATION (or DRAFT) → SENT. Same id, same number — never re-allocated. */
  async send(companyId: string, actorScope: ActorScope, id: string, actor: { id: string; username: string }, ctx: RequestContext) {
    const doc = await this.loadForTransition(companyId, actorScope, id);
    if (doc.status !== SalesDocumentStatus.QUOTATION && doc.status !== SalesDocumentStatus.DRAFT) {
      throw new ValidationError('INVALID_STATUS_TRANSITION', { from: doc.status, to: 'SENT' });
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.salesDocument.update({ where: { id: doc.id }, data: { status: SalesDocumentStatus.SENT } });
      await this.auditService.recordTx(tx, {
        entityType: 'sales_document',
        entityId: doc.id,
        action: AuditAction.UPDATE,
        companyId,
        actor,
        oldValues: { status: doc.status },
        newValues: { status: SalesDocumentStatus.SENT },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      await this.timeline.record(tx, {
        companyId,
        entityType: 'PARTY',
        entityId: doc.customerPartyId,
        type: 'QUOTATION_SENT',
        title: 'ارسال پیش‌فاکتور',
        description: `پیش‌فاکتور ${doc.documentNumber} برای مشتری ارسال شد`,
        data: { salesDocumentId: doc.id, documentNumber: doc.documentNumber },
        actorUserId: actor.id,
      });
    });
    return this.getById(companyId, actorScope, id);
  }

  /** SENT|QUOTATION → CUSTOMER_CONFIRMED (sales.confirm). */
  async confirm(companyId: string, actorScope: ActorScope, id: string, actor: { id: string; username: string }, ctx: RequestContext) {
    const doc = await this.loadForTransition(companyId, actorScope, id);
    if (doc.status !== SalesDocumentStatus.SENT && doc.status !== SalesDocumentStatus.QUOTATION) {
      throw new ValidationError('INVALID_STATUS_TRANSITION', { from: doc.status, to: 'CUSTOMER_CONFIRMED' });
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.salesDocument.update({
        where: { id: doc.id },
        data: { status: SalesDocumentStatus.CUSTOMER_CONFIRMED },
      });
      await this.auditService.recordTx(tx, {
        entityType: 'sales_document',
        entityId: doc.id,
        action: AuditAction.UPDATE,
        companyId,
        actor,
        oldValues: { status: doc.status },
        newValues: { status: SalesDocumentStatus.CUSTOMER_CONFIRMED },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      await this.timeline.record(tx, {
        companyId,
        entityType: 'PARTY',
        entityId: doc.customerPartyId,
        type: 'SALE_CONFIRMED',
        title: 'تأیید مشتری',
        description: `سفارش ${doc.documentNumber} توسط مشتری تأیید شد`,
        data: { salesDocumentId: doc.id, documentNumber: doc.documentNumber },
        actorUserId: actor.id,
      });
    });
    return this.getById(companyId, actorScope, id);
  }

  /** CUSTOMER_CONFIRMED → SALES_ORDER (sales.confirm). Same document, same number. */
  async activate(companyId: string, actorScope: ActorScope, id: string, actor: { id: string; username: string }, ctx: RequestContext) {
    const doc = await this.loadForTransition(companyId, actorScope, id);
    if (doc.status !== SalesDocumentStatus.CUSTOMER_CONFIRMED) {
      throw new ValidationError('INVALID_STATUS_TRANSITION', { from: doc.status, to: 'SALES_ORDER' });
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.salesDocument.update({
        where: { id: doc.id },
        data: { status: SalesDocumentStatus.SALES_ORDER },
      });
      await this.auditService.recordTx(tx, {
        entityType: 'sales_document',
        entityId: doc.id,
        action: AuditAction.UPDATE,
        companyId,
        actor,
        oldValues: { status: doc.status },
        newValues: { status: SalesDocumentStatus.SALES_ORDER },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      await this.timeline.record(tx, {
        companyId,
        entityType: 'PARTY',
        entityId: doc.customerPartyId,
        type: 'SALE_CONFIRMED',
        title: 'تبدیل به سفارش فروش',
        description: `سفارش ${doc.documentNumber} قطعی شد`,
        data: { salesDocumentId: doc.id, documentNumber: doc.documentNumber },
        actorUserId: actor.id,
      });
    });
    return this.getById(companyId, actorScope, id);
  }

  /** QUOTATION|SENT → LOST; reason required (configurable via Setting). */
  async lost(
    companyId: string,
    actorScope: ActorScope,
    id: string,
    dto: LostDocumentDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    const doc = await this.loadForTransition(companyId, actorScope, id);
    if (doc.status !== SalesDocumentStatus.QUOTATION && doc.status !== SalesDocumentStatus.SENT) {
      throw new ValidationError('INVALID_STATUS_TRANSITION', { from: doc.status, to: 'LOST' });
    }
    const reasonRequired = await this.readLostReasonRequired(companyId);
    if (reasonRequired && !dto.lostReasonId) {
      throw new ValidationError('LOST_REASON_REQUIRED');
    }
    if (dto.lostReasonId) {
      const reason = await this.prisma.lostReason.findFirst({
        where: { id: dto.lostReasonId, companyId, active: true },
        select: { id: true },
      });
      if (!reason) throw new NotFoundError('Lost reason not found', { lostReasonId: dto.lostReasonId });
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.salesDocument.update({
        where: { id: doc.id },
        data: { status: SalesDocumentStatus.LOST, lostReasonId: dto.lostReasonId ?? null },
      });
      await this.auditService.recordTx(tx, {
        entityType: 'sales_document',
        entityId: doc.id,
        action: AuditAction.UPDATE,
        companyId,
        actor,
        oldValues: { status: doc.status },
        newValues: { status: SalesDocumentStatus.LOST, lostReasonId: dto.lostReasonId ?? null },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      await this.timeline.record(tx, {
        companyId,
        entityType: 'PARTY',
        entityId: doc.customerPartyId,
        type: 'SALE_LOST',
        title: 'باختن پیش‌فاکتور',
        description: `پیش‌فاکتور ${doc.documentNumber} باخت`,
        data: { salesDocumentId: doc.id, documentNumber: doc.documentNumber, lostReasonId: dto.lostReasonId ?? null },
        actorUserId: actor.id,
      });
    });
    return this.getById(companyId, actorScope, id);
  }

  /** Any active status → CANCELLED (sales.cancel). */
  async cancel(companyId: string, actorScope: ActorScope, id: string, actor: { id: string; username: string }, ctx: RequestContext) {
    const doc = await this.loadForTransition(companyId, actorScope, id);
    if (
      doc.status === SalesDocumentStatus.COMPLETED ||
      doc.status === SalesDocumentStatus.CANCELLED ||
      doc.status === SalesDocumentStatus.LOST
    ) {
      throw new ValidationError('INVALID_STATUS_TRANSITION', { from: doc.status, to: 'CANCELLED' });
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.salesDocument.update({ where: { id: doc.id }, data: { status: SalesDocumentStatus.CANCELLED } });
      await this.auditService.recordTx(tx, {
        entityType: 'sales_document',
        entityId: doc.id,
        action: AuditAction.UPDATE,
        companyId,
        actor,
        oldValues: { status: doc.status },
        newValues: { status: SalesDocumentStatus.CANCELLED },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
    });
    return this.getById(companyId, actorScope, id);
  }

  // ───────────────────── create sale from purchase (REQUIREMENTS §11) ─────────────────────

  async createSaleFromPurchase(
    companyId: string,
    actorScope: ActorScope,
    purchaseId: string,
    dto: CreateSaleFromPurchaseDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    const purchase = await this.prisma.purchaseDocument.findFirst({
      where: { id: purchaseId, companyId },
      include: { lines: { orderBy: { lineOrder: 'asc' } } },
    });
    if (!purchase) throw new NotFoundError('Purchase document not found', { purchaseId });

    const document = await this.prisma.$transaction(async (tx) => {
      const doc = await this.createDocumentTx(
        tx,
        companyId,
        {
          customerPartyId: dto.customerPartyId,
          salespersonUserId: dto.salespersonUserId ?? actor.id,
          status: 'QUOTATION',
          documentDate: dto.documentDate ? new Date(dto.documentDate) : undefined,
          paymentTermId: dto.paymentTermId ?? purchase.paymentTermId,
          lines: purchase.lines.map((line) => ({
            productVariantId: line.productVariantId,
            quantity: line.orderedQuantity,
            uomId: line.uomId,
            // No explicit price → the line snapshots TODAY's DailyPrice for
            // (variant, uom), else the template default (p5c pricing
            // integrity); the salesperson can still override per line.
            unitPrice: 0,
          })),
        },
        actor,
        ctx,
      );

      // DocumentRelation both directions (CREATED_FROM).
      await this.relations.createRelation(
        companyId,
        {
          fromType: 'sales_document',
          fromId: doc.id,
          toType: 'purchase_document',
          toId: purchase.id,
          relationType: 'CREATED_FROM',
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
          toType: 'sales_document',
          toId: doc.id,
          relationType: 'CREATED_FROM',
        },
        actor,
        ctx,
        tx,
      );
      return doc;
    });
    return this.getById(companyId, actorScope, document.id);
  }
}
