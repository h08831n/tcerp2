import { PrismaClient, PartyRoleType } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { TimelineService } from '../parties/timeline.service';
import { SequencesService } from '../sequences/sequences.service';
import { DocumentRelationService } from '../document-flow/document-relation.service';
import { SalesDocumentsService } from '../sales/sales-documents.service';
import { PurchaseDocumentsService } from '../purchase/purchase-documents.service';
import { PriceRequestsService } from '../price-request/price-requests.service';
import { SupplierOffersService } from '../price-request/supplier-offers.service';
import { AllocationsService } from '../allocations/allocations.service';
import { NullTodayPriceProvider } from '../price-request/today-price.provider';
import { DailyPriceService } from '../pricing/daily-price.service';
import { INTEGRATION_COMPANY_ID } from './integration';

/**
 * Phase 4 integration fixtures: real services over the shared integration
 * PrismaClient, plus small factories for parties/variants/etc. Everything
 * carries a unique marker so parallel spec files never collide.
 */

export const ACTOR = { id: '00000000-0000-4000-8000-0000000000a1', username: 'admin' };

let adminIdCache: string | null = null;

export async function adminUserId(prisma: PrismaClient): Promise<string> {
  if (!adminIdCache) {
    const admin = await prisma.user.findFirstOrThrow({ where: { username: 'admin' }, select: { id: true } });
    adminIdCache = admin.id;
  }
  return adminIdCache;
}

export function salesService(prisma: PrismaClient): SalesDocumentsService {
  const audit = new AuditService(prisma as never);
  const timeline = new TimelineService(prisma as never);
  return new SalesDocumentsService(
    prisma as never,
    new SequencesService(prisma as never, audit),
    audit,
    timeline,
    new DocumentRelationService(prisma as never, audit),
    new DailyPriceService(prisma as never, audit), // p5c line price snapshot
  );
}

export function purchaseService(prisma: PrismaClient): PurchaseDocumentsService {
  const audit = new AuditService(prisma as never);
  const timeline = new TimelineService(prisma as never);
  return new PurchaseDocumentsService(
    prisma as never,
    new SequencesService(prisma as never, audit),
    audit,
    timeline,
    new DocumentRelationService(prisma as never, audit),
    new DailyPriceService(prisma as never, audit), // p5c price-source wiring
  );
}

export function priceRequestService(prisma: PrismaClient): PriceRequestsService {
  const audit = new AuditService(prisma as never);
  const timeline = new TimelineService(prisma as never);
  const relations = new DocumentRelationService(prisma as never, audit);
  return new PriceRequestsService(
    prisma as never,
    new SequencesService(prisma as never, audit),
    audit,
    timeline,
    relations,
    salesService(prisma),
    purchaseService(prisma),
    new NullTodayPriceProvider(),
  );
}

export function supplierOffersService(prisma: PrismaClient): SupplierOffersService {
  return new SupplierOffersService(prisma as never, new AuditService(prisma as never));
}

export function allocationsService(prisma: PrismaClient): AllocationsService {
  return new AllocationsService(prisma as never, new AuditService(prisma as never));
}

export function relationService(prisma: PrismaClient): DocumentRelationService {
  return new DocumentRelationService(prisma as never, new AuditService(prisma as never));
}

// ───────────────────────────── factories ─────────────────────────────

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

export interface VariantFixture {
  variantId: string;
  templateId: string;
  uomId: string;
  sku: string;
  templateNameFa: string;
}

/** Category + template + variant wired to the seeded `kg` uom. */
export async function createVariant(
  prisma: PrismaClient,
  marker: string,
  options: { defaultSalesPrice?: string; companyId?: string } = {},
): Promise<VariantFixture> {
  const companyId = options.companyId ?? INTEGRATION_COMPANY_ID;
  const category = await prisma.productCategory.upsert({
    where: { companyId_code: { companyId, code: 'P4TEST' } },
    create: { companyId, code: 'P4TEST', nameFa: 'تست فاز ۴' },
    update: {},
  });
  const uom = await prisma.uom.findFirstOrThrow({ where: { companyId, symbol: 'kg' }, select: { id: true } });

  const template = await prisma.productTemplate.create({
    data: {
      companyId,
      categoryId: category.id,
      nameFa: `میلگرد تست ${marker}`,
      defaultSalesUomId: uom.id,
      defaultSalesPrice: options.defaultSalesPrice ?? '0',
    },
  });
  const variant = await prisma.productVariant.create({
    data: {
      companyId,
      templateId: template.id,
      sku: `P4-${marker}`,
      nameFa: `وارینت تست ${marker}`,
      combinationKey: `p4=${marker}`,
      defaultUomId: uom.id,
    },
  });
  return {
    variantId: variant.id,
    templateId: template.id,
    uomId: uom.id,
    sku: variant.sku,
    templateNameFa: template.nameFa,
  };
}

/** Attach attribute values to a variant (for printable-description tests). */
export async function addVariantValues(
  prisma: PrismaClient,
  companyId: string,
  variantId: string,
  values: { attributeName: string; valueFa: string; displayOrder?: number }[],
): Promise<void> {
  let order = 0;
  for (const v of values) {
    const attribute = await prisma.attribute.upsert({
      where: { companyId_code: { companyId, code: `P4A-${v.attributeName}` } },
      create: {
        companyId,
        code: `P4A-${v.attributeName}`,
        nameFa: v.attributeName,
        displayOrder: v.displayOrder ?? order,
      },
      update: {},
    });
    const value = await prisma.attributeValue.upsert({
      where: { attributeId_code: { attributeId: attribute.id, code: `P4V-${v.valueFa}` } },
      create: { attributeId: attribute.id, code: `P4V-${v.valueFa}`, valueFa: v.valueFa },
      update: {},
    });
    await prisma.variantAttributeValue.upsert({
      where: { variantId_attributeId: { variantId, attributeId: attribute.id } },
      create: { variantId, attributeId: attribute.id, attributeValueId: value.id },
      update: {},
    });
    order += 1;
  }
}

export async function createTaxDefinition(
  prisma: PrismaClient,
  marker: string,
  companyId: string = INTEGRATION_COMPANY_ID,
): Promise<{ id: string; rate: string }> {
  const def = await prisma.taxDefinition.create({
    data: { companyId, code: `P4TAX-${marker}`, name: `مالیات تست ${marker}`, rate: '9' },
  });
  return { id: def.id, rate: def.rate.toString() };
}

export async function createLostReason(
  prisma: PrismaClient,
  marker: string,
  companyId: string = INTEGRATION_COMPANY_ID,
): Promise<string> {
  const reason = await prisma.lostReason.create({
    data: { companyId, code: `P4LR-${marker}`, nameFa: `دلیل تست ${marker}` },
  });
  return reason.id;
}

/** Business-row cleanup (audit/timeline rows are append-only history). */
export async function cleanupSalesDocument(prisma: PrismaClient, id: string): Promise<void> {
  await prisma.salesPurchaseAllocation.deleteMany({ where: { salesLine: { salesDocumentId: id } } });
  await prisma.salesDocument.deleteMany({ where: { id } }).catch(() => undefined);
}

export async function cleanupPurchaseDocument(prisma: PrismaClient, id: string): Promise<void> {
  await prisma.salesPurchaseAllocation.deleteMany({ where: { purchaseLine: { purchaseDocumentId: id } } });
  await prisma.purchaseDocument.deleteMany({ where: { id } }).catch(() => undefined);
}
