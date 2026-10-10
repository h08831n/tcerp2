import { PrismaClient, UomCategory } from '@prisma/client';
import { INTEGRATION_COMPANY_ID } from '../testing/integration';
import { AuditService } from '../audit/audit.service';
import { mainWarehouse } from '../testing/p6-fixtures';
import {
  purchaseService,
  createParty,
  cleanupPurchaseDocument,
  VariantFixture,
} from '../testing/p4-fixtures';
import { goodsReceiptService, cleanupGoodsReceipt } from '../testing/p6-fixtures';
import { PurchaseDocumentsService } from '../purchase/purchase-documents.service';
import { GoodsReceiptService } from '../goods-receipt/goods-receipt.service';

export interface UomSet {
  categoryId: string;
  kgId: string;
  gId: string;
  tonId: string;
  pcsId: string;
}

/**
 * The seeded reference UOM set of the INTEGRATION company (WEIGHT kg/g/ton +
 * UNIT pcs — see prisma/seed.ts). Idempotent: re-reads the existing rows.
 */
export async function seededUoms(prisma: PrismaClient, companyId = INTEGRATION_COMPANY_ID): Promise<UomSet> {
  const category = await prisma.uomCategory.findFirstOrThrow({
    where: { companyId, code: 'WEIGHT' },
  });
  const symbols = ['kg', 'g', 'ton', 'pcs'];
  const uoms = await prisma.uom.findMany({ where: { companyId, symbol: { in: symbols } } });
  const bySymbol = new Map(uoms.map((u) => [u.symbol, u.id]));
  for (const symbol of symbols) {
    if (!bySymbol.has(symbol)) throw new Error(`seeded uom ${symbol} missing for company ${companyId}`);
  }
  return {
    categoryId: category.id,
    kgId: bySymbol.get('kg') as string,
    gId: bySymbol.get('g') as string,
    tonId: bySymbol.get('ton') as string,
    pcsId: bySymbol.get('pcs') as string,
  };
}

export interface FullVariantFixture extends VariantFixture {
  inventoryUomId: string | null;
}

/** Variant with explicit inventory UOM / weight pair (Integrity Gate #1/#2). */
export async function createVariantEx(
  prisma: PrismaClient,
  marker: string,
  options: {
    defaultUomId?: string;
    inventoryUomId?: string | null;
    weightPerUnit?: string;
    weightUomId?: string;
    companyId?: string;
  } = {},
): Promise<FullVariantFixture> {
  const companyId = options.companyId ?? INTEGRATION_COMPANY_ID;
  const base = await prisma.productCategory.create({
    data: { companyId, code: `G6-${marker}`, nameFa: `دسته گیت ۶ ${marker}` },
  });
  const uomId = options.defaultUomId ?? (await seededUoms(prisma, companyId)).kgId;
  const template = await prisma.productTemplate.create({
    data: {
      companyId,
      categoryId: base.id,
      nameFa: `گیت۶ تست ${marker}`,
      defaultSalesUomId: uomId,
      defaultSalesPrice: '0',
    },
  });
  const variant = await prisma.productVariant.create({
    data: {
      companyId,
      templateId: template.id,
      sku: `G6-${marker}`,
      nameFa: `وارینت گیت۶ ${marker}`,
      combinationKey: `g6=${marker}`,
      defaultUomId: uomId,
      ...(options.inventoryUomId !== undefined ? { inventoryUomId: options.inventoryUomId } : {}),
      ...(options.weightPerUnit !== undefined ? { weightPerUnit: options.weightPerUnit } : {}),
      ...(options.weightUomId !== undefined ? { weightUomId: options.weightUomId } : {}),
    },
  });
  return {
    variantId: variant.id,
    templateId: template.id,
    uomId,
    sku: variant.sku,
    templateNameFa: template.nameFa,
    inventoryUomId: variant.inventoryUomId,
  };
}

export interface PlacedPurchase {
  purchaseId: string;
  lineIds: string[];
}

/** Created + PLACED purchase order with the given (variant, quantity, uom, price) lines. */
export async function createPlacedPurchase(
  prisma: PrismaClient,
  supplierId: string,
  lines: { productVariantId: string; quantity: number; uomId: string; unitPrice?: number }[],
  marker: string,
  companyId = INTEGRATION_COMPANY_ID,
  purchase?: PurchaseDocumentsService,
): Promise<PlacedPurchase> {
  const actor = { id: await adminId(prisma), username: 'admin' };
  const service = purchase ?? purchaseService(prisma);
  const created = await service.create(
    companyId,
    {
      supplierPartyId: supplierId,
      lines: lines.map((l) => ({
        productVariantId: l.productVariantId,
        quantity: l.quantity,
        uomId: l.uomId,
        unitPrice: l.unitPrice ?? 0,
      })),
    },
    actor,
    {},
  );
  await service.place(companyId, created.id, actor, {});
  return { purchaseId: created.id, lineIds: created.lines.map((l: { id: string }) => l.id) };
}

/** Confirmed goods receipt against the given PO lines (actual per line). */
export async function receiveGoods(
  receipts: GoodsReceiptService,
  prisma: PrismaClient,
  purchaseId: string,
  lines: { purchaseLineId: string; actualQuantity: number; uomId: string }[],
  options: { warehouseId?: string; destinationLocationId?: string; marker?: string; companyId?: string } = {},
): Promise<{ receiptId: string; lineIds: string[]; receiptNumber: string }> {
  const actor = { id: await adminId(prisma), username: 'admin' };
  const companyId = options.companyId ?? INTEGRATION_COMPANY_ID;
  const draft = await receipts.create(
    companyId,
    {
      purchaseDocumentId: purchaseId,
      ...(options.warehouseId ? { warehouseId: options.warehouseId } : {}),
      ...(options.destinationLocationId ? { destinationLocationId: options.destinationLocationId } : {}),
      lines: lines.map((l) => ({
        purchaseLineId: l.purchaseLineId,
        actualQuantity: l.actualQuantity,
        uomId: l.uomId,
      })),
    },
    actor,
    {},
  );
  await receipts.confirm(companyId, draft.id, actor, {});
  return {
    receiptId: draft.id,
    lineIds: draft.lines.map((l: { id: string }) => l.id),
    receiptNumber: draft.receiptNumber,
  };
}

export async function adminId(prisma: PrismaClient): Promise<string> {
  const admin = await prisma.user.findFirstOrThrow({ where: { username: 'admin' }, select: { id: true } });
  return admin.id;
}

/** The INTERNAL location of a warehouse (created on demand). */
export async function internalLocationId(
  prisma: PrismaClient,
  companyId: string,
  warehouseId: string,
): Promise<string> {
  const warehouse = await prisma.warehouse.findFirstOrThrow({
    where: { id: warehouseId, companyId },
    select: { code: true },
  });
  const location = await prisma.stockLocation.findFirstOrThrow({
    where: { companyId, code: `LOC-${warehouse.code}` },
  });
  return location.id;
}

/** Supplier/Customer per-party location code (see resolveLocation). */
export const supplierLocationCode = (partyId: string) => `SUPPLIER-${partyId}`;
export const customerLocationCode = (partyId: string) => `CUSTOMER-${partyId}`;

/** Delete a company's per-party locations BEFORE the parties themselves (FK). */
export async function cleanupPartyLocations(
  prisma: PrismaClient,
  companyId: string,
  partyIds: string[],
): Promise<void> {
  if (partyIds.length === 0) return;
  const locations = await prisma.stockLocation.findMany({
    where: { companyId, partyId: { in: partyIds } },
    select: { id: true },
  });
  const locationIds = locations.map((l) => l.id);
  if (locationIds.length > 0) {
    // Movements reference the locations (FK) — clear this test's legs first.
    await prisma.stockMovement.deleteMany({
      where: { OR: [{ sourceLocationId: { in: locationIds } }, { destinationLocationId: { in: locationIds } }] },
    });
  }
  await prisma.stockLocation.deleteMany({
    where: { companyId, partyId: { in: partyIds } },
  });
  await prisma.party.deleteMany({ where: { companyId, id: { in: partyIds } } });
}

/** Marker-scoped party pair (supplier + customer) for a test. */
export async function createSupplierAndCustomer(
  prisma: PrismaClient,
  marker: string,
  companyId = INTEGRATION_COMPANY_ID,
): Promise<{ supplier: { id: string }; customer: { id: string } }> {
  const supplier = await createParty(prisma, ['SUPPLIER'], `${marker}-sup`, companyId);
  const customer = await createParty(prisma, ['CUSTOMER'], `${marker}-cust`, companyId);
  return { supplier, customer };
}

/** Company-scoped receipt + purchase cleanup for one test's rows. */
export async function cleanupReceiptAndPurchase(
  prisma: PrismaClient,
  receiptId: string,
  purchaseId: string,
): Promise<void> {
  if (receiptId) await cleanupGoodsReceipt(prisma, receiptId);
  if (purchaseId) await cleanupPurchaseDocument(prisma, purchaseId);
}

export async function ensureMainWarehouse(prisma: PrismaClient, companyId = INTEGRATION_COMPANY_ID) {
  return mainWarehouse(prisma, companyId);
}

export type { UomCategory };
