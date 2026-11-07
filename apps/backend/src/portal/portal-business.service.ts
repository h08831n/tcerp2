import { Injectable } from '@nestjs/common';
import { Prisma, SalesDocumentStatus, LoadingStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { FilesService } from '../files/files.service';
import { NotFoundError } from '../common/errors';

/**
 * Portal Business API (Gate D-2 Phase 2): safe read models over the EXISTING
 * ERP data. Every query is company + party scoped from the verified session.
 * No parallel tables, no duplicated data — the portal is a read-only view.
 *
 * DTO fields are explicitly whitelisted — no raw Prisma model is returned.
 */

const PORTAL_ORDER_STATUSES: SalesDocumentStatus[] = [
  'QUOTATION',
  'SENT',
  'CUSTOMER_CONFIRMED',
  'SALES_ORDER',
  'PARTIALLY_LOADED',
  'COMPLETED',
] as const;

const PORTAL_LOADING_STATUSES: LoadingStatus[] = ['CONFIRMED'];

const MAX_LIMIT = 50;

export interface PortalSessionContext {
  companyId: string;
  partyId: string;
}

@Injectable()
export class PortalBusinessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
  ) {}

  /**
   * Phase 3 (final) — files attached to the CUSTOMER'S OWN orders and
   * loadings, with THREE independent gates (all must pass):
   *   1. PARENT SCOPE: the target document belongs to the session's
   *      (company, party).
   *   2. PARENT STATUS: the document is in the portal-visible status
   *      allowlist (same lists the orders/loadings endpoints serve).
   *   3. CUSTOMER VISIBILITY (DEFAULT DENY): the attachment carries
   *      customer_visible = TRUE — internal attachments on the same
   *      documents stay invisible.
   * List and Download share the EXACT same policy (the where clause below).
   */
  private async visibleFileWhere(ctx: PortalSessionContext): Promise<Prisma.FileAttachmentWhereInput> {
    // FileAttachment's target is POLYMORPHIC (entityType + entityId, no FK
    // relation) — the parent allowlist is resolved via ID sets first: the
    // customer's own orders/loadings restricted to the portal-visible
    // status lists (a CANCELLED order or DRAFT loading is not file-visible).
    const [docIds, loadingIds] = await Promise.all([
      this.prisma.salesDocument.findMany({
        where: { companyId: ctx.companyId, customerPartyId: ctx.partyId, status: { in: PORTAL_ORDER_STATUSES } },
        select: { id: true },
      }),
      this.prisma.loading.findMany({
        where: { companyId: ctx.companyId, customerPartyId: ctx.partyId, status: { in: PORTAL_LOADING_STATUSES } },
        select: { id: true },
      }),
    ]);
    return {
      companyId: ctx.companyId,
      customerVisible: true,
      OR: [
        { entityType: 'sales_document', entityId: { in: docIds.map((d) => d.id) } },
        { entityType: 'loading', entityId: { in: loadingIds.map((l) => l.id) } },
      ],
    };
  }

  async listFiles(ctx: PortalSessionContext) {
    const items = await this.prisma.fileAttachment.findMany({
      where: await this.visibleFileWhere(ctx),
      orderBy: { createdAt: 'desc' },
      include: { fileBlob: { select: { mimeType: true, size: true } } },
    });
    return {
      items: items.map((a) => ({
        id: a.id,
        entityType: a.entityType,
        entityId: a.entityId,
        filename: a.displayName ?? a.originalFilename,
        mimeType: a.fileBlob.mimeType,
        size: Number(a.fileBlob.size),
        createdAt: a.createdAt,
      })),
      total: items.length,
    };
  }

  /** Stream one attachment — the SAME policy as listFiles (findFirst with
   *  the identical where + id). No separate authorization path. */
  async downloadFile(ctx: PortalSessionContext, attachmentId: string) {
    const attachment = await this.prisma.fileAttachment.findFirst({
      where: { ...(await this.visibleFileWhere(ctx)), id: attachmentId },
      select: { id: true },
    });
    if (!attachment) throw new NotFoundError('Attachment not found', { id: attachmentId });

    // company-scoped S3 download (target-validity asserted inside).
    return this.files.downloadAttachment(attachmentId, ctx.companyId);
  }


  async getProfile(ctx: PortalSessionContext) {
    const party = await this.prisma.party.findFirstOrThrow({
      where: { id: ctx.partyId, companyId: ctx.companyId, archivedAt: null },
      select: {
        id: true,
        nameFa: true,
        nameEn: true,
        internalCode: true,
        roles: { select: { role: true } },
      },
    });
    const company = await this.prisma.company.findUniqueOrThrow({
      where: { id: ctx.companyId },
      select: { nameFa: true },
    });
    return {
      partyId: party.id,
      partyName: party.nameFa,
      partyNameEn: party.nameEn,
      internalCode: party.internalCode,
      companyName: company.nameFa,
      roles: party.roles.map((r) => r.role),
    };
  }

  async listOrders(ctx: PortalSessionContext, opts: { page?: number; limit?: number; status?: string }) {
    const page = Math.max(1, opts.page ?? 1);
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), MAX_LIMIT);
    const statusFilter = opts.status && (PORTAL_ORDER_STATUSES as readonly string[]).includes(opts.status)
      ? opts.status : undefined;

    const where: Prisma.SalesDocumentWhereInput = {
      companyId: ctx.companyId,
      customerPartyId: ctx.partyId,
      status: { in: PORTAL_ORDER_STATUSES },
      ...(statusFilter ? { status: statusFilter as SalesDocumentStatus } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.salesDocument.findMany({
        where,
        orderBy: { documentDate: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          documentNumber: true,
          documentDate: true,
          status: true,
          currency: true,
          total: true,
          subtotal: true,
          notes: true,
          lines: {
            orderBy: { lineOrder: 'asc' },
            select: {
              id: true,
              productVariant: { select: { sku: true, nameFa: true } },
              orderedQuantity: true,
              uom: { select: { symbol: true } },
              unitPrice: true,
            },
          },
        },
      }),
      this.prisma.salesDocument.count({ where }),
    ]);

    return {
      items: items.map((d) => ({
        id: d.id,
        documentNumber: d.documentNumber,
        documentDate: d.documentDate,
        status: d.status,
        currency: d.currency,
        total: d.total.toNumber(),
        subtotal: d.subtotal.toNumber(),
        notes: d.notes,
        lines: d.lines.map((l) => ({
          productSku: l.productVariant.sku,
          productName: l.productVariant.nameFa,
          orderedQuantity: l.orderedQuantity.toNumber(),
          uom: l.uom.symbol,
          unitPrice: l.unitPrice.toNumber(),
        })),
      })),
      page,
      limit,
      total,
    };
  }

  async getOrder(ctx: PortalSessionContext, orderId: string) {
    const doc = await this.prisma.salesDocument.findFirst({
      where: {
        id: orderId,
        companyId: ctx.companyId,
        customerPartyId: ctx.partyId,
        status: { in: PORTAL_ORDER_STATUSES },
      },
      select: {
        id: true,
        documentNumber: true,
        documentDate: true,
        expirationDate: true,
        status: true,
        currency: true,
        subtotal: true,
        discountTotal: true,
        taxTotal: true,
        total: true,
        notes: true,
        lines: {
          orderBy: { lineOrder: 'asc' },
          select: {
            id: true,
            productVariant: { select: { sku: true, nameFa: true } },
            printableDescription: true,
            orderedQuantity: true,
            uom: { select: { symbol: true } },
            unitPrice: true,
          },
        },
      },
    });
    if (!doc) throw new NotFoundError('Order not found', { orderId });

    return {
      id: doc.id,
      documentNumber: doc.documentNumber,
      documentDate: doc.documentDate,
      expirationDate: doc.expirationDate,
      status: doc.status,
      currency: doc.currency,
      subtotal: doc.subtotal.toNumber(),
      discountTotal: doc.discountTotal.toNumber(),
      taxTotal: doc.taxTotal.toNumber(),
      total: doc.total.toNumber(),
      notes: doc.notes,
      lines: doc.lines.map((l) => ({
        productSku: l.productVariant.sku,
        productName: l.productVariant.nameFa,
        description: l.printableDescription,
        orderedQuantity: l.orderedQuantity.toNumber(),
        uom: l.uom.symbol,
        unitPrice: l.unitPrice.toNumber(),
      })),
    };
  }

  async listLoadings(ctx: PortalSessionContext, opts: { page?: number; limit?: number }) {
    const page = Math.max(1, opts.page ?? 1);
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), MAX_LIMIT);

    const where: Prisma.LoadingWhereInput = {
      companyId: ctx.companyId,
      customerPartyId: ctx.partyId,
      status: { in: PORTAL_LOADING_STATUSES },
    };

    const [items, total] = await Promise.all([
      this.prisma.loading.findMany({
        where,
        orderBy: { loadingDate: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      select: {
        id: true,
        loadingDate: true,
        status: true,
        route: true,
      },
    }),
    this.prisma.loading.count({ where }),
    ]);

    // Fetch loading lines separately (LoadingLine has no Prisma relation on Loading model)
    const loadingIds = items.map((l) => l.id);
    const rawLines = loadingIds.length
      ? await this.prisma.loadingLine.findMany({
          where: { loadingId: { in: loadingIds } },
          select: { loadingId: true, productVariantId: true, actualQuantity: true, uomId: true },
        })
      : [];
    // Resolve product names and uom symbols via batch lookups
    const variantIds = [...new Set(rawLines.map((l) => l.productVariantId))];
    const variants = variantIds.length
      ? await this.prisma.productVariant.findMany({
          where: { id: { in: variantIds } },
          select: { id: true, sku: true, nameFa: true },
        })
      : [];
    const variantMap = new Map(variants.map((v) => [v.id, v]));
    const uomIds = [...new Set(rawLines.map((l) => l.uomId).filter((v): v is string => Boolean(v)))];
    const uoms = uomIds.length
      ? await this.prisma.uom.findMany({ where: { id: { in: uomIds } }, select: { id: true, symbol: true } })
      : [];
    const uomMap = new Map(uoms.map((u) => [u.id, u.symbol]));
    const linesByLoading = new Map<string, Array<{ sku: string; name: string; qty: number; uom: string }>>();
    for (const line of rawLines) {
      const v = variantMap.get(line.productVariantId);
      const list = linesByLoading.get(line.loadingId) ?? [];
      list.push({
        sku: v?.sku ?? '',
        name: v?.nameFa ?? '',
        qty: line.actualQuantity.toNumber(),
        uom: line.uomId ? (uomMap.get(line.uomId) ?? '') : '',
      });
      linesByLoading.set(line.loadingId, list);
    }

    return {
      items: items.map((l) => ({
        id: l.id,
        loadingDate: l.loadingDate,
        status: l.status,
        route: l.route,
        lines: linesByLoading.get(l.id) ?? [],
      })),
      page,
      limit,
      total,
    };
  }

  async getLoading(ctx: PortalSessionContext, loadingId: string) {
    const loading = await this.prisma.loading.findFirst({
      where: {
        id: loadingId,
        companyId: ctx.companyId,
        customerPartyId: ctx.partyId,
        status: { in: PORTAL_LOADING_STATUSES },
      },
      select: {
        id: true,
        loadingDate: true,
        status: true,
        route: true,
        notes: true,
      },
    });
    if (!loading) throw new NotFoundError('Loading not found', { loadingId });

    const loadingLines = await this.prisma.loadingLine.findMany({
      where: { loadingId: loading.id },
      select: { productVariantId: true, actualQuantity: true, uomId: true },
    });
    const lineVariantIds = [...new Set(loadingLines.map((l) => l.productVariantId))];
    const lineVariants = lineVariantIds.length
      ? await this.prisma.productVariant.findMany({ where: { id: { in: lineVariantIds } }, select: { id: true, sku: true, nameFa: true } })
      : [];
    const lineVariantMap = new Map(lineVariants.map((v) => [v.id, v]));
    const lineUomIds = [...new Set(loadingLines.map((l) => l.uomId).filter((v): v is string => Boolean(v)))];
    const lineUoms = lineUomIds.length
      ? await this.prisma.uom.findMany({ where: { id: { in: lineUomIds } }, select: { id: true, symbol: true } })
      : [];
    const lineUomMap = new Map(lineUoms.map((u) => [u.id, u.symbol]));

    return {
      id: loading.id,
      loadingDate: loading.loadingDate,
      status: loading.status,
      route: loading.route,
      notes: loading.notes,
      lines: loadingLines.map((line) => ({
        productSku: lineVariantMap.get(line.productVariantId)?.sku ?? '',
        productName: lineVariantMap.get(line.productVariantId)?.nameFa ?? '',
        actualQuantity: line.actualQuantity.toNumber(),
        uom: line.uomId ? (lineUomMap.get(line.uomId) ?? '') : '',
      })),
    };
  }

  async getDebt(ctx: PortalSessionContext) {
    const row = await this.prisma.partyOperationalBalance.findUnique({
      where: { companyId_partyId: { companyId: ctx.companyId, partyId: ctx.partyId } },
      select: { balance: true, updatedAt: true },
    });
    const raw = row?.balance ?? new Prisma.Decimal(0);
    return {
      balance: raw.toString(),
      direction: raw.gte(0) ? 'DEBT' : 'CREDIT',
      currency: null,
      computed: row !== null,
      lastComputedAt: row?.updatedAt ?? null,
    };
  }
}
