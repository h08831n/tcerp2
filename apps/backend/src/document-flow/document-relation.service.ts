import { Injectable } from '@nestjs/common';
import { DocumentRelationType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit.dto';
import { NotFoundError, ValidationError } from '../common/errors';
import { RequestContext } from '../auth/auth.service';

/**
 * Document Flow (REQUIREMENTS §13): a generic, company-scoped navigation
 * layer that complements the explicit FKs (sales_documents.price_request_id,
 * etc.). Relation types: CREATED_FROM, GENERATED_FROM, RELATED, BASED_ON.
 */

export const DOCUMENT_TYPES = [
  'sales_document',
  'purchase_document',
  'price_request',
  'lead',
  'opportunity',
  // Phase 6: loadings join the navigation layer (loading ↔ sales_document
  // RELATED relations are written when a loading with sale allocations is
  // confirmed). A loading has no document number — it is labelled
  // `بارگیری {date}` (see resolveLabels).
  'loading',
  // Integrity Gate #9: goods receipts are first-class navigation endpoints —
  // purchase_document ↔ goods_receipt RELATED relations are written at GRN
  // confirm; receipts are labelled with their GRN number.
  'goods_receipt',
] as const;

export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export interface CreateRelationInput {
  fromType: DocumentType;
  fromId: string;
  toType: DocumentType;
  toId: string;
  relationType: DocumentRelationType;
}

export interface RelatedGroup {
  type: string;
  relationType: string;
  count: number;
  items: { id: string; label: string; relationType: string; createdAt: Date }[];
}

const RELATION_TYPES = ['CREATED_FROM', 'GENERATED_FROM', 'RELATED', 'BASED_ON'] as const;

@Injectable()
export class DocumentRelationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  private assertTypes(input: Omit<CreateRelationInput, 'fromId' | 'toId'>): void {
    for (const t of [input.fromType, input.toType]) {
      if (!DOCUMENT_TYPES.includes(t as DocumentType)) {
        throw new ValidationError('INVALID_DOCUMENT_TYPE', { documentType: t });
      }
    }
    if (!RELATION_TYPES.includes(input.relationType as (typeof RELATION_TYPES)[number])) {
      throw new ValidationError('INVALID_RELATION_TYPE', { relationType: input.relationType });
    }
  }

  /** Both endpoints must exist and belong to the same company. */
  private async assertEndpoints(
    client: Prisma.TransactionClient | PrismaService,
    companyId: string,
    type: DocumentType,
    id: string,
  ): Promise<void> {
    const delegates = {
      sales_document: () => client.salesDocument.findFirst({ where: { id, companyId }, select: { id: true } }),
      purchase_document: () => client.purchaseDocument.findFirst({ where: { id, companyId }, select: { id: true } }),
      price_request: () => client.priceRequest.findFirst({ where: { id, companyId }, select: { id: true } }),
      lead: () => client.lead.findFirst({ where: { id, companyId }, select: { id: true } }),
      opportunity: () => client.opportunity.findFirst({ where: { id, companyId }, select: { id: true } }),
      loading: () => client.loading.findFirst({ where: { id, companyId }, select: { id: true } }),
      goods_receipt: () => client.goodsReceipt.findFirst({ where: { id, companyId }, select: { id: true } }),
    } as const;
    const row = await delegates[type]();
    if (!row) {
      throw new NotFoundError('Document endpoint not found', { type, id });
    }
  }

  /**
   * Create a relation (audited). Idempotent by the DB unique key
   * (fromType, fromId, toType, toId, relationType) — a duplicate is a no-op.
   * Usable inside a caller's transaction via `tx` (existence checks then run
   * against the SAME client, so rows created inside that tx are visible).
   */
  async createRelation(
    companyId: string,
    input: CreateRelationInput,
    actor: { id: string; username: string },
    ctx: RequestContext,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    this.assertTypes(input);
    const db = tx ?? this.prisma;
    await this.assertEndpoints(db, companyId, input.fromType, input.fromId);
    await this.assertEndpoints(db, companyId, input.toType, input.toId);

    const run = async (client: Prisma.TransactionClient) => {
      await client.documentRelation.upsert({
        where: {
          fromType_fromId_toType_toId_relationType: {
            fromType: input.fromType,
            fromId: input.fromId,
            toType: input.toType,
            toId: input.toId,
            relationType: input.relationType,
          },
        },
        create: {
          companyId,
          fromType: input.fromType,
          fromId: input.fromId,
          toType: input.toType,
          toId: input.toId,
          relationType: input.relationType,
          createdBy: actor.id,
        },
        update: {},
      });
      await this.auditService.recordTx(client, {
        entityType: 'document_relation',
        entityId: `${input.fromType}:${input.fromId}->${input.toType}:${input.toId}`,
        action: AuditAction.CREATE,
        companyId,
        actor,
        newValues: input as unknown as Record<string, unknown>,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
    };
    if (tx) await run(tx);
    else await this.prisma.$transaction(run);
  }

  /**
   * Reciprocal navigation: both outgoing (entity → other) and incoming
   * (other → entity) relations, grouped by (target type, relation type)
   * with counts + lightweight labelled items.
   */
  async listRelations(
    companyId: string,
    type: string,
    id: string,
  ): Promise<{ relations: RelatedGroup[]; totals: Record<string, number> }> {
    if (!DOCUMENT_TYPES.includes(type as DocumentType)) {
      throw new ValidationError('INVALID_DOCUMENT_TYPE', { documentType: type });
    }

    const rows = await this.prisma.documentRelation.findMany({
      where: {
        companyId,
        OR: [
          { fromType: type, fromId: id },
          { toType: type, toId: id },
        ],
      },
      orderBy: { createdAt: 'desc' },
    });

    // Resolve labels for the OPPOSITE endpoint of each relation.
    const labelTargets = rows.map((r) =>
      r.fromType === type && r.fromId === id
        ? { type: r.toType, id: r.toId }
        : { type: r.fromType, id: r.fromId },
    );
    const labels = await this.resolveLabels(companyId, labelTargets);

    const groups = new Map<string, RelatedGroup>();
    // Relations are stored in BOTH directions (REQUIREMENTS §13); from one
    // entity's view both rows of a pair collapse onto the same related
    // document — dedupe by (other endpoint, relation) so a reciprocal pair
    // is shown once, not twice.
    const seen = new Set<string>();
    for (const row of rows) {
      const outgoing = row.fromType === type && row.fromId === id;
      const other = outgoing
        ? { type: row.toType, id: row.toId }
        : { type: row.fromType, id: row.fromId };
      const pairKey = `${other.type}:${other.id}:${row.relationType}`;
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);

      const key = `${other.type}:${row.relationType}`;
      let group = groups.get(key);
      if (!group) {
        group = { type: other.type, relationType: row.relationType, count: 0, items: [] };
        groups.set(key, group);
      }
      group.count += 1;
      group.items.push({
        id: other.id,
        label: labels.get(`${other.type}:${other.id}`) ?? other.id,
        relationType: row.relationType,
        createdAt: row.createdAt,
      });
    }

    // Derived relations (explicit FKs, not DocumentRelation rows):
    // sales/purchase documents know their originating price request via
    // price_request_id — expose it for navigation (Phase 4 correction #3).
    if (type === 'sales_document' || type === 'purchase_document') {
      const doc =
        type === 'sales_document'
          ? await this.prisma.salesDocument.findFirst({
              where: { id, companyId },
              select: { priceRequestId: true },
            })
          : await this.prisma.purchaseDocument.findFirst({
              where: { id, companyId },
              select: { priceRequestId: true },
            });
      const pairKey = `price_request:${doc?.priceRequestId ?? ''}:GENERATED_FROM`;
      if (doc?.priceRequestId && !seen.has(pairKey)) {
        const prLabel = await this.resolveLabels(companyId, [
          { type: 'price_request', id: doc.priceRequestId },
        ]);
        groups.set(`price_request:GENERATED_FROM`, {
          type: 'price_request',
          relationType: 'GENERATED_FROM',
          count: 1,
          items: [
            {
              id: doc.priceRequestId,
              label: prLabel.get(`price_request:${doc.priceRequestId}`) ?? doc.priceRequestId,
              relationType: 'GENERATED_FROM',
              createdAt: new Date(0),
            },
          ],
        });
        seen.add(pairKey);
      }
      // Phase 6: loadings are REAL navigation endpoints now — keep the
      // placeholder group only for sales/purchase documents that have no
      // loading relations yet, so the UI slot stays stable either way.
      const hasLoadingGroup = [...groups.keys()].some((key) => key.startsWith('loading:'));
      if (!hasLoadingGroup) {
        groups.set('loading:PLANNED', {
          type: 'loading',
          relationType: 'RELATED',
          count: 0,
          items: [],
        });
      }

      // Integrity Gate #9: a purchase document KNOWS its goods receipts via
      // the purchase_document_id FK — expose them as a derived group (the
      // explicit RELATED rows created at confirm are deduped by `seen`).
      if (type === 'purchase_document') {
        const receipts = await this.prisma.goodsReceipt.findMany({
          where: { purchaseDocumentId: id, companyId },
          orderBy: { receiptDate: 'desc' },
          select: { id: true, receiptNumber: true, createdAt: true },
        });
        const grLabels = await this.resolveLabels(
          companyId,
          receipts.map((r) => ({ type: 'goods_receipt', id: r.id })),
        );
        for (const receipt of receipts) {
          const pairKey = `goods_receipt:${receipt.id}:RELATED`;
          if (seen.has(pairKey)) continue;
          seen.add(pairKey);
          const group = groups.get('goods_receipt:RELATED') ?? {
            type: 'goods_receipt',
            relationType: 'RELATED',
            count: 0,
            items: [],
          };
          group.count += 1;
          group.items.push({
            id: receipt.id,
            label: grLabels.get(`goods_receipt:${receipt.id}`) ?? receipt.receiptNumber,
            relationType: 'RELATED',
            createdAt: receipt.createdAt,
          });
          groups.set('goods_receipt:RELATED', group);
        }
      }
    }

    const relations = [...groups.values()];
    const totals: Record<string, number> = {};
    for (const group of relations) {
      totals[group.type] = (totals[group.type] ?? 0) + group.count;
    }
    return { relations, totals };
  }

  private async resolveLabels(
    companyId: string,
    targets: { type: string; id: string }[],
  ): Promise<Map<string, string>> {
    const labels = new Map<string, string>();
    const byType = new Map<string, string[]>();
    for (const t of targets) {
      const list = byType.get(t.type) ?? [];
      if (!list.includes(t.id)) list.push(t.id);
      byType.set(t.type, list);
    }

    // Per-model label fields (numbers for documents, names for CRM rows).
    if (byType.has('sales_document')) {
      const rows = await this.prisma.salesDocument.findMany({
        where: { companyId, id: { in: byType.get('sales_document') } },
        select: { id: true, documentNumber: true },
      });
      rows.forEach((r) => labels.set(`sales_document:${r.id}`, r.documentNumber));
    }
    if (byType.has('purchase_document')) {
      const rows = await this.prisma.purchaseDocument.findMany({
        where: { companyId, id: { in: byType.get('purchase_document') } },
        select: { id: true, documentNumber: true },
      });
      rows.forEach((r) => labels.set(`purchase_document:${r.id}`, r.documentNumber));
    }
    if (byType.has('price_request')) {
      const rows = await this.prisma.priceRequest.findMany({
        where: { companyId, id: { in: byType.get('price_request') } },
        select: { id: true, requestNumber: true },
      });
      rows.forEach((r) => labels.set(`price_request:${r.id}`, r.requestNumber));
    }
    if (byType.has('lead')) {
      const rows = await this.prisma.lead.findMany({
        where: { companyId, id: { in: byType.get('lead') } },
        select: { id: true, name: true },
      });
      rows.forEach((r) => labels.set(`lead:${r.id}`, r.name));
    }
    if (byType.has('opportunity')) {
      const rows = await this.prisma.opportunity.findMany({
        where: { companyId, id: { in: byType.get('opportunity') } },
        select: { id: true, title: true },
      });
      rows.forEach((r) => labels.set(`opportunity:${r.id}`, r.title));
    }
    if (byType.has('loading')) {
      // Loadings have no document number — label as `بارگیری {date}`.
      const rows = await this.prisma.loading.findMany({
        where: { companyId, id: { in: byType.get('loading') } },
        select: { id: true, loadingDate: true },
      });
      rows.forEach((r) =>
        labels.set(`loading:${r.id}`, `بارگیری ${r.loadingDate.toISOString().slice(0, 10)}`),
      );
    }
    if (byType.has('goods_receipt')) {
      // Goods receipts carry their GRN number.
      const rows = await this.prisma.goodsReceipt.findMany({
        where: { companyId, id: { in: byType.get('goods_receipt') } },
        select: { id: true, receiptNumber: true },
      });
      rows.forEach((r) => labels.set(`goods_receipt:${r.id}`, r.receiptNumber));
    }
    return labels;
  }
}
