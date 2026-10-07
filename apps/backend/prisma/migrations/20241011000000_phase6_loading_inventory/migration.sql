-- CreateEnum
CREATE TYPE "StockDirection" AS ENUM ('IN', 'OUT');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "LoadingStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'CANCELLED');

-- DropIndex

-- DropIndex

-- DropIndex

-- DropIndex

-- AlterTable
ALTER TABLE "loading_allocations" ADD COLUMN     "company_id" UUID NOT NULL;

-- AlterTable
ALTER TABLE "loadings" ADD COLUMN     "customer_party_id" UUID,
ADD COLUMN     "driver_info_restricted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "status" "LoadingStatus" NOT NULL DEFAULT 'DRAFT',
ADD COLUMN     "warehouse_id" UUID;

-- CreateTable
CREATE TABLE "warehouses" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name_fa" TEXT NOT NULL,
    "name_en" TEXT,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "warehouses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "product_variant_id" UUID NOT NULL,
    "direction" "StockDirection" NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "uom_id" UUID NOT NULL,
    "movement_date" TIMESTAMPTZ(6) NOT NULL,
    "source_entity_type" TEXT NOT NULL,
    "source_entity_id" UUID NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_requests" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "approval_type" TEXT NOT NULL,
    "requested_by" UUID,
    "approver_id" UUID,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "decision_note" TEXT,
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "warehouses_company_id_code_key" ON "warehouses"("company_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "stock_movements_idempotency_key_key" ON "stock_movements"("idempotency_key");

-- CreateIndex
CREATE INDEX "stock_movements_company_id_product_variant_id_movement_date_idx" ON "stock_movements"("company_id", "product_variant_id", "movement_date");

-- CreateIndex
CREATE INDEX "stock_movements_warehouse_id_product_variant_id_idx" ON "stock_movements"("warehouse_id", "product_variant_id");

-- CreateIndex
CREATE INDEX "stock_movements_source_entity_type_source_entity_id_idx" ON "stock_movements"("source_entity_type", "source_entity_id");

-- CreateIndex
CREATE INDEX "approval_requests_company_id_status_created_at_idx" ON "approval_requests"("company_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "approval_requests_entity_type_entity_id_idx" ON "approval_requests"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "loading_allocations_sales_line_id_idx" ON "loading_allocations"("sales_line_id");

-- CreateIndex
CREATE INDEX "loading_allocations_purchase_line_id_idx" ON "loading_allocations"("purchase_line_id");

-- CreateIndex
CREATE INDEX "loadings_company_id_status_idx" ON "loadings"("company_id", "status");

-- CreateIndex
CREATE INDEX "loadings_customer_party_id_idx" ON "loadings"("customer_party_id");

-- AddForeignKey
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_product_variant_id_fkey" FOREIGN KEY ("product_variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_uom_id_fkey" FOREIGN KEY ("uom_id") REFERENCES "uoms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_source_entity_id_fkey" FOREIGN KEY ("source_entity_id") REFERENCES "loadings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "loadings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loadings" ADD CONSTRAINT "loadings_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loadings" ADD CONSTRAINT "loadings_customer_party_id_fkey" FOREIGN KEY ("customer_party_id") REFERENCES "parties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loadings" ADD CONSTRAINT "loadings_driver_party_id_fkey" FOREIGN KEY ("driver_party_id") REFERENCES "parties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loadings" ADD CONSTRAINT "loadings_carrier_party_id_fkey" FOREIGN KEY ("carrier_party_id") REFERENCES "parties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loading_allocations" ADD CONSTRAINT "loading_allocations_sales_line_id_fkey" FOREIGN KEY ("sales_line_id") REFERENCES "sales_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loading_allocations" ADD CONSTRAINT "loading_allocations_purchase_line_id_fkey" FOREIGN KEY ("purchase_line_id") REFERENCES "purchase_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Phase 6: wire FKs for previously-bare UUID columns (boundaries doc #2/#4)
ALTER TABLE "loadings" ADD CONSTRAINT "loadings_driver_party_fkey" FOREIGN KEY ("driver_party_id") REFERENCES "parties"("id") ON DELETE SET NULL;
ALTER TABLE "loadings" ADD CONSTRAINT "loadings_carrier_party_fkey" FOREIGN KEY ("carrier_party_id") REFERENCES "parties"("id") ON DELETE SET NULL;
ALTER TABLE "loading_lines" ADD CONSTRAINT "loading_lines_product_variant_fkey" FOREIGN KEY ("product_variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT;
ALTER TABLE "loading_lines" ADD CONSTRAINT "loading_lines_uom_fkey" FOREIGN KEY ("uom_id") REFERENCES "uoms"("id") ON DELETE RESTRICT;
ALTER TABLE "loading_allocations" ADD CONSTRAINT "loading_allocations_sales_line_fkey" FOREIGN KEY ("sales_line_id") REFERENCES "sales_lines"("id") ON DELETE CASCADE;
ALTER TABLE "loading_allocations" ADD CONSTRAINT "loading_allocations_purchase_line_fkey" FOREIGN KEY ("purchase_line_id") REFERENCES "purchase_lines"("id") ON DELETE CASCADE;
ALTER TABLE "supplier_offers" ADD CONSTRAINT "supplier_offers_uom_fkey" FOREIGN KEY ("uom_id") REFERENCES "uoms"("id") ON DELETE RESTRICT;
