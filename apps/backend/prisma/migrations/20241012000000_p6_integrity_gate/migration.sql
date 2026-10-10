-- CreateEnum
CREATE TYPE "StockLocationType" AS ENUM ('SUPPLIER', 'INTERNAL', 'CUSTOMER', 'TRANSIT');

-- CreateEnum
CREATE TYPE "GoodsReceiptStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'REVERSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "LoadingRoute" AS ENUM ('DIRECT_SUPPLIER_TO_CUSTOMER', 'WAREHOUSE_TO_CUSTOMER', 'SUPPLIER_TO_WAREHOUSE');

-- AlterEnum
ALTER TYPE "LoadingStatus" ADD VALUE 'REVERSED';

-- DropForeignKey
ALTER TABLE "approval_requests" DROP CONSTRAINT "approval_requests_entity_id_fkey";

-- DropForeignKey
ALTER TABLE "loading_allocations" DROP CONSTRAINT "loading_allocations_purchase_line_fkey";

-- DropForeignKey
ALTER TABLE "loading_allocations" DROP CONSTRAINT "loading_allocations_sales_line_fkey";

-- DropForeignKey
ALTER TABLE "loading_lines" DROP CONSTRAINT "loading_lines_product_variant_fkey";

-- DropForeignKey
ALTER TABLE "loading_lines" DROP CONSTRAINT "loading_lines_uom_fkey";

-- DropForeignKey
ALTER TABLE "loadings" DROP CONSTRAINT "loadings_carrier_party_fkey";

-- DropForeignKey
ALTER TABLE "loadings" DROP CONSTRAINT "loadings_driver_party_fkey";

-- DropForeignKey
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_uom_id_fkey";

-- DropForeignKey (replaced by SET NULL version below)
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_warehouse_id_fkey";

-- DropForeignKey

-- DropForeignKey
ALTER TABLE "supplier_offers" DROP CONSTRAINT "supplier_offers_uom_fkey";

-- DropIndex

-- DropIndex

-- DropIndex

-- DropIndex

-- DropIndex

-- AlterTable
ALTER TABLE "loadings" ADD COLUMN     "reversal_of_id" UUID,
ADD COLUMN     "reversal_reason" TEXT,
ADD COLUMN     "route" "LoadingRoute" NOT NULL DEFAULT 'DIRECT_SUPPLIER_TO_CUSTOMER';

-- AlterTable
ALTER TABLE "product_variants" ADD COLUMN     "inventory_uom_id" UUID;

-- AlterTable (nullable first — backfill below fills, then NOT NULL)
ALTER TABLE "stock_movements" ADD COLUMN     "destination_location_id" UUID,
ADD COLUMN     "inventory_uom_id" UUID,
ADD COLUMN     "normalized_quantity" DECIMAL(18,4),
ADD COLUMN     "reversal_of_movement_id" UUID,
ADD COLUMN     "source_location_id" UUID,
ADD COLUMN     "source_quantity" DECIMAL(18,4),
ADD COLUMN     "source_uom_id" UUID,
ALTER COLUMN "warehouse_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "stock_locations" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "type" "StockLocationType" NOT NULL,
    "warehouse_id" UUID,
    "party_id" UUID,
    "code" TEXT NOT NULL,
    "name_fa" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goods_receipts" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "receipt_number" TEXT NOT NULL,
    "purchase_document_id" UUID NOT NULL,
    "destination_location_id" UUID NOT NULL,
    "receipt_date" TIMESTAMPTZ(6) NOT NULL,
    "status" "GoodsReceiptStatus" NOT NULL DEFAULT 'DRAFT',
    "notes" TEXT,
    "reversal_of_id" UUID,
    "reversal_reason" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "goods_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goods_receipt_lines" (
    "id" UUID NOT NULL,
    "goods_receipt_id" UUID NOT NULL,
    "purchase_line_id" UUID NOT NULL,
    "actual_quantity" DECIMAL(18,4) NOT NULL,
    "uom_id" UUID NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "goods_receipt_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stock_locations_company_id_type_idx" ON "stock_locations"("company_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "stock_locations_company_id_code_key" ON "stock_locations"("company_id", "code");

-- CreateIndex
CREATE INDEX "goods_receipts_company_id_status_receipt_date_idx" ON "goods_receipts"("company_id", "status", "receipt_date");

-- CreateIndex
CREATE UNIQUE INDEX "goods_receipts_company_id_receipt_number_key" ON "goods_receipts"("company_id", "receipt_number");

-- CreateIndex
CREATE INDEX "goods_receipt_lines_purchase_line_id_idx" ON "goods_receipt_lines"("purchase_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "goods_receipt_lines_goods_receipt_id_purchase_line_id_key" ON "goods_receipt_lines"("goods_receipt_id", "purchase_line_id");

-- CreateIndex
CREATE INDEX "stock_movements_destination_location_id_product_variant_id_idx" ON "stock_movements"("destination_location_id", "product_variant_id");

-- CreateIndex
CREATE INDEX "stock_movements_source_location_id_product_variant_id_idx" ON "stock_movements"("source_location_id", "product_variant_id");

-- AddForeignKey
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_inventory_uom_id_fkey" FOREIGN KEY ("inventory_uom_id") REFERENCES "uoms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_locations" ADD CONSTRAINT "stock_locations_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_locations" ADD CONSTRAINT "stock_locations_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_locations" ADD CONSTRAINT "stock_locations_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_source_uom_id_fkey" FOREIGN KEY ("source_uom_id") REFERENCES "uoms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_inventory_uom_id_fkey" FOREIGN KEY ("inventory_uom_id") REFERENCES "uoms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_source_location_id_fkey" FOREIGN KEY ("source_location_id") REFERENCES "stock_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_destination_location_id_fkey" FOREIGN KEY ("destination_location_id") REFERENCES "stock_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_purchase_document_id_fkey" FOREIGN KEY ("purchase_document_id") REFERENCES "purchase_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_destination_location_id_fkey" FOREIGN KEY ("destination_location_id") REFERENCES "stock_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_goods_receipt_id_fkey" FOREIGN KEY ("goods_receipt_id") REFERENCES "goods_receipts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_purchase_line_id_fkey" FOREIGN KEY ("purchase_line_id") REFERENCES "purchase_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_uom_id_fkey" FOREIGN KEY ("uom_id") REFERENCES "uoms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loadings" ADD CONSTRAINT "loadings_reversal_of_id_fkey" FOREIGN KEY ("reversal_of_id") REFERENCES "loadings"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ── Integrity Gate backfill: locations, normalized quantities, loading routes ──
-- Assumptions (documented per review item 18):
--  * existing MAIN warehouses become INTERNAL locations
--  * existing movements keep sourceQuantity/sourceUom verbatim
--  * normalizedQuantity computed with the CURRENT UOM ratios (kg/ton engine);
--    a variant without inventoryUom gets its defaultUom as inventory UOM
--  * legacy movements were company-internal (MAIN warehouse) → both
--    locations = the warehouse's INTERNAL location; direction keeps meaning

-- 1) INTERNAL location per existing warehouse
INSERT INTO stock_locations (id, company_id, type, warehouse_id, code, name_fa, active, created_at)
SELECT gen_random_uuid(), w.company_id, 'INTERNAL', w.id, 'LOC-' || w.code, w.name_fa, true, now()
FROM warehouses w
WHERE NOT EXISTS (SELECT 1 FROM stock_locations l WHERE l.warehouse_id = w.id AND l.type = 'INTERNAL');

-- 2) default SUPPLIER + CUSTOMER locations per company
INSERT INTO stock_locations (id, company_id, type, code, name_fa, active, created_at)
SELECT gen_random_uuid(), c.id, 'SUPPLIER', 'SUPPLIER-DEFAULT', 'تامین‌کننده (مقصد مستقیم)', true, now()
FROM companies c
WHERE NOT EXISTS (SELECT 1 FROM stock_locations l WHERE l.company_id = c.id AND l.type = 'SUPPLIER');
INSERT INTO stock_locations (id, company_id, type, code, name_fa, active, created_at)
SELECT gen_random_uuid(), c.id, 'CUSTOMER', 'CUSTOMER-DEFAULT', 'مشتری (مقصد مستقیم)', true, now()
FROM companies c
WHERE NOT EXISTS (SELECT 1 FROM stock_locations l WHERE l.company_id = c.id AND l.type = 'CUSTOMER');

-- 3) variant inventory UOM = defaultUom when null
UPDATE product_variants SET inventory_uom_id = default_uom_id WHERE inventory_uom_id IS NULL;

-- 4) normalize existing movements
--    Any variant without resolvable inventory UOM aborts the migration
--    (fail loudly rather than guess) — checked up front:
DO $$
DECLARE missing int;
BEGIN
  SELECT count(*) INTO missing FROM stock_movements sm
  JOIN product_variants pv ON pv.id = sm.product_variant_id
  WHERE pv.inventory_uom_id IS NULL;
  IF missing > 0 THEN
    RAISE EXCEPTION 'INTEGRITY GATE: % stock movements reference variants without an inventory UOM — cannot normalize safely', missing;
  END IF;
END $$;

-- keep original quantity/uom verbatim
UPDATE stock_movements SET source_quantity = quantity, source_uom_id = uom_id;

-- normalize via UOM engine ratios (same category; ratio vs category base)
UPDATE stock_movements m
SET normalized_quantity = m.source_quantity * fu.conversion_ratio / tu.conversion_ratio,
    inventory_uom_id = pv.inventory_uom_id
FROM product_variants pv,
     uoms fu,
     uoms tu
WHERE pv.id = m.product_variant_id
  AND fu.id = m.source_uom_id
  AND tu.id = pv.inventory_uom_id
  AND m.normalized_quantity IS NULL
  AND fu.category_id = tu.category_id;

-- any still-null normalized row = impossible conversion → fail loudly
DO $$
DECLARE bad int;
BEGIN
  SELECT count(*) INTO bad FROM stock_movements WHERE normalized_quantity IS NULL;
  IF bad > 0 THEN
    RAISE EXCEPTION 'INTEGRITY GATE: % movements could not be normalized (cross-category without product conversion) — refusing to guess', bad;
  END IF;
END $$;

-- locations: legacy movements were MAIN-warehouse internal moves
UPDATE stock_movements m
SET source_location_id = l.id,
    destination_location_id = l.id,
    warehouse_id = l.warehouse_id
FROM stock_locations l
WHERE l.type = 'INTERNAL'
  AND (m.source_location_id IS NULL OR m.destination_location_id IS NULL);

ALTER TABLE "stock_movements" ALTER COLUMN "source_quantity" SET NOT NULL;
ALTER TABLE "stock_movements" ALTER COLUMN "source_uom_id" SET NOT NULL;
ALTER TABLE "stock_movements" ALTER COLUMN "normalized_quantity" SET NOT NULL;
ALTER TABLE "stock_movements" ALTER COLUMN "inventory_uom_id" SET NOT NULL;
ALTER TABLE "stock_movements" ALTER COLUMN "source_location_id" SET NOT NULL;
ALTER TABLE "stock_movements" ALTER COLUMN "destination_location_id" SET NOT NULL;
-- old source-of-truth columns retire only AFTER normalization is verified
ALTER TABLE "stock_movements" DROP COLUMN "quantity";
ALTER TABLE "stock_movements" DROP COLUMN "uom_id";

-- loading routes: existing confirmed loadings were direct supplier→customer trade
UPDATE loadings SET route = 'DIRECT_SUPPLIER_TO_CUSTOMER' WHERE route IS NULL;
ALTER TABLE "loadings" ALTER COLUMN "route" SET NOT NULL;
