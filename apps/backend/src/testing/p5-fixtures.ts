import { PrismaClient, PartyRoleType, ProductCategory, Uom } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { SequencesService } from '../sequences/sequences.service';
import { QueueService } from '../queue/queue.service';
import { QueueHandlerRegistry } from '../queue/queue.handlers';
import { NotificationService } from '../notifications/notifications.service';
import { DailyPriceService } from '../pricing/daily-price.service';
import { PublishingService, PublishBatchItemHandler } from '../publishing/publishing.service';
import { PublishingTemplateService } from '../publishing/publishing-template.service';
import { AutomationService } from '../automation/automation.service';
import { AutomationRunHandler, DailyScanHandler } from '../automation/automation.handlers';
import { PublicApiService } from '../public-api/public-api.service';
import {
  defaultPublishingAdapters,
  MockPublishingAdapter,
} from '../publishing/adapters/mock-publishing.adapter';
import { PublishingAdapter } from '../publishing/publishing-adapter';
import { INTEGRATION_COMPANY_ID } from './integration';
import { PriceRequestsService } from '../price-request/price-requests.service';
import { DailyPriceTodayPriceProvider } from '../pricing/daily-price-today.provider';
import { TimelineService } from '../parties/timeline.service';
import { DocumentRelationService } from '../document-flow/document-relation.service';
import { SalesDocumentsService } from '../sales/sales-documents.service';
import { PurchaseDocumentsService } from '../purchase/purchase-documents.service';

/**
 * Phase 5 integration fixtures: real services wired over the shared
 * integration PrismaClient. The queue is DB-ONLY here (BullMQ producer
 * stubbed to a no-op) — tests drive handlers DIRECTLY, keeping execution
 * deterministic (mocks only, no Redis, no network).
 */

let actorIdCache: string | null = null;

export async function adminUserId(prisma: PrismaClient): Promise<string> {
  if (!actorIdCache) {
    const admin = await prisma.user.findFirstOrThrow({ where: { username: 'admin' }, select: { id: true } });
    actorIdCache = admin.id;
  }
  return actorIdCache;
}

/** DB-only QueueService: enqueue persists the row; BullMQ is a no-op. */
export function makeQueueService(prisma: PrismaClient): QueueService {
  const bullmqStub = {
    add: async () => false,
    removeJob: async () => undefined,
  };
  return new QueueService(prisma as never, new QueueHandlerRegistry(), bullmqStub as never);
}

export function makeAudit(prisma: PrismaClient): AuditService {
  return new AuditService(prisma as never);
}

export function makeSequences(prisma: PrismaClient): SequencesService {
  return new SequencesService(prisma as never, makeAudit(prisma));
}

/** Fresh mock adapter set — tests hold the instances to assert sends. */
export function makeAdapters(): PublishingAdapter[] {
  return defaultPublishingAdapters();
}

export function publishingService(
  prisma: PrismaClient,
  adapters: PublishingAdapter[],
  queue?: QueueService,
): PublishingService {
  return new PublishingService(
    prisma as never,
    makeAudit(prisma),
    makeSequences(prisma),
    queue ?? makeQueueService(prisma),
    adapters,
  );
}

export function publishItemHandler(
  prisma: PrismaClient,
  adapters: PublishingAdapter[],
): PublishBatchItemHandler {
  return new PublishBatchItemHandler(prisma as never, adapters);
}

export function publishingTemplateService(prisma: PrismaClient): PublishingTemplateService {
  return new PublishingTemplateService(prisma as never, makeAudit(prisma));
}

export function dailyPriceService(
  prisma: PrismaClient,
  automation?: AutomationService,
): DailyPriceService {
  return new DailyPriceService(prisma as never, makeAudit(prisma), automation);
}

export function automationService(
  prisma: PrismaClient,
  publishing: PublishingService,
  queue?: QueueService,
): AutomationService {
  const resolvedQueue = queue ?? makeQueueService(prisma);
  const notifications = new NotificationService(prisma as never, resolvedQueue);
  return new AutomationService(
    prisma as never,
    makeAudit(prisma),
    resolvedQueue,
    publishing,
    notifications,
  );
}

export function automationRunHandler(automation: AutomationService): AutomationRunHandler {
  return new AutomationRunHandler(automation);
}

export function dailyScanHandler(automation: AutomationService): DailyScanHandler {
  return new DailyScanHandler(automation);
}

export function publicApiService(prisma: PrismaClient): PublicApiService {
  return new PublicApiService(prisma as never);
}

/** PriceRequestsService with the REAL Phase 5 today-price provider. */
export function priceRequestServiceWithPricing(prisma: PrismaClient): PriceRequestsService {
  const audit = makeAudit(prisma);
  const timeline = new TimelineService(prisma as never);
  const relations = new DocumentRelationService(prisma as never, audit);
  const sales = new SalesDocumentsService(
    prisma as never,
    new SequencesService(prisma as never, audit),
    audit,
    timeline,
    relations,
  );
  const purchase = new PurchaseDocumentsService(
    prisma as never,
    new SequencesService(prisma as never, audit),
    audit,
    timeline,
    relations,
  );
  return new PriceRequestsService(
    prisma as never,
    new SequencesService(prisma as never, audit),
    audit,
    timeline,
    relations,
    sales,
    purchase,
    new DailyPriceTodayPriceProvider(prisma as never),
  );
}

// ───────────────────────────── factories ─────────────────────────────

export async function createCompany(prisma: PrismaClient, marker: string): Promise<{ id: string }> {
  const company = await prisma.company.create({ data: { nameFa: `شرکت تست ${marker}` } });
  return { id: company.id };
}

export async function createParty(
  prisma: PrismaClient,
  roles: PartyRoleType[],
  marker: string,
  companyId: string = INTEGRATION_COMPANY_ID,
): Promise<{ id: string; nameFa: string }> {
  const nameFa = `طرف قرارداد ${marker}`;
  const party = await prisma.party.create({
    data: {
      companyId,
      type: 'COMPANY',
      nameFa,
      roles: { create: roles.map((role) => ({ role })) },
    },
  });
  return { id: party.id, nameFa };
}

export interface P5VariantFixture {
  variantId: string;
  templateId: string;
  categoryId: string;
  uomId: string;
  sku: string;
}

/**
 * Category + uom + template + variant fully inside the given company
 * (unlike the p4 fixture, this does NOT rely on the seeded shared uom, so
 * company-isolation tests can build independent companies).
 */
export async function createVariantInCompany(
  prisma: PrismaClient,
  companyId: string,
  marker: string,
  options: { categoryName?: string; withAttributes?: { code: string; value: string }[] } = {},
): Promise<P5VariantFixture> {
  const category = await prisma.productCategory.create({
    data: { companyId, code: `P5-${marker}`, nameFa: options.categoryName ?? `دسته تست ${marker}` },
  });
  const uom = await prisma.uom.create({
    data: {
      companyId,
      categoryId: (
        await prisma.uomCategory.create({
          data: { companyId, code: `P5W-${marker}`, nameFa: 'وزن تست' },
        })
      ).id,
      symbol: `kg-${marker}`,
      nameFa: 'کیلوگرم تست',
      conversionRatio: '1',
      isBaseUnit: true,
    },
  });
  const template = await prisma.productTemplate.create({
    data: {
      companyId,
      categoryId: category.id,
      nameFa: `میلگرد تست ${marker}`,
      defaultSalesUomId: uom.id,
      defaultSalesPrice: '0',
    },
  });
  const variant = await prisma.productVariant.create({
    data: {
      companyId,
      templateId: template.id,
      sku: `P5-${marker}`,
      nameFa: `وارینت تست ${marker}`,
      combinationKey: `p5=${marker}`,
      defaultUomId: uom.id,
    },
  });

  if (options.withAttributes) {
    for (const attr of options.withAttributes) {
      // Attributes are unique per (company, code) — size/grade are SHARED
      // across fixtures, so reuse when they already exist.
      const attribute = await prisma.attribute.upsert({
        where: { companyId_code: { companyId, code: attr.code } },
        create: { companyId, code: attr.code, nameFa: attr.code },
        update: {},
      });
      const value = await prisma.attributeValue.upsert({
        where: { attributeId_code: { attributeId: attribute.id, code: `${attr.code}-${attr.value}` } },
        create: { attributeId: attribute.id, code: `${attr.code}-${attr.value}`, valueFa: attr.value },
        update: {},
      });
      await prisma.variantAttributeValue.upsert({
        where: {
          variantId_attributeId: { variantId: variant.id, attributeId: attribute.id },
        },
        create: { variantId: variant.id, attributeId: attribute.id, attributeValueId: value.id },
        update: {},
      });
    }
  }

  return { variantId: variant.id, templateId: template.id, categoryId: category.id, uomId: uom.id, sku: variant.sku };
}

export async function findKgUom(prisma: PrismaClient, companyId = INTEGRATION_COMPANY_ID): Promise<Uom> {
  return prisma.uom.findFirstOrThrow({ where: { companyId, symbol: 'kg' } });
}

/** Direct sales document row (for automation scans; avoids heavy service setup). */
export async function createSalesDocumentRow(
  prisma: PrismaClient,
  companyId: string,
  input: {
    marker: string;
    customerPartyId: string;
    salespersonUserId: string;
    status: 'QUOTATION' | 'SENT' | 'SALES_ORDER' | 'COMPLETED';
    documentDate: Date;
  },
) {
  return prisma.salesDocument.create({
    data: {
      companyId,
      documentNumber: `P5SD-${input.marker}`,
      customerPartyId: input.customerPartyId,
      salespersonUserId: input.salespersonUserId,
      documentDate: input.documentDate,
      status: input.status,
      createdBy: input.salespersonUserId,
    },
  });
}

/** Cleanup helper: delete everything the p5 fixtures created (audit rows stay). */
export async function cleanupCompany(prisma: PrismaClient, companyId: string): Promise<void> {
  await prisma.notification.deleteMany({ where: { companyId } });
  await prisma.queueJob.deleteMany({ where: { companyId } });
  await prisma.setting.deleteMany({ where: { companyId } });
  await prisma.automationRule.deleteMany({ where: { companyId } });
  await prisma.publishBatchItem.deleteMany({ where: { companyId } });
  await prisma.publishBatch.deleteMany({ where: { companyId } });
  await prisma.publishingTemplate.deleteMany({ where: { companyId } });
  await prisma.integrationConfig.deleteMany({ where: { companyId } });
  await prisma.dailyPrice.deleteMany({ where: { companyId } });
  await prisma.salesDocument.deleteMany({ where: { companyId } });
  await prisma.variantAttributeValue.deleteMany({ where: { variant: { companyId } } });
  await prisma.productVariant.deleteMany({ where: { companyId } });
  await prisma.productTemplate.deleteMany({ where: { companyId } });
  await prisma.attributeValue.deleteMany({ where: { attribute: { companyId } } });
  await prisma.attribute.deleteMany({ where: { companyId } });
  await prisma.productCategory.deleteMany({ where: { companyId } });
  await prisma.uom.deleteMany({ where: { companyId } });
  await prisma.uomCategory.deleteMany({ where: { companyId } });
  await prisma.party.deleteMany({ where: { companyId } });
  await prisma.sequence.deleteMany({ where: { companyId } });
  await prisma.company.deleteMany({ where: { id: companyId } }).catch(() => undefined);
}

export type { ProductCategory };
