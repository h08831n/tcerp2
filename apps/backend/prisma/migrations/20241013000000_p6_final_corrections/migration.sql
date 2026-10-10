-- CreateEnum
CREATE TYPE "PurchaseFulfillmentType" AS ENUM ('GOODS_RECEIPT', 'DIRECT_LOADING');

-- DropIndex

-- DropIndex

-- DropIndex

-- DropIndex

-- DropIndex
DROP INDEX "stock_movements_warehouse_id_product_variant_id_idx";

-- AlterTable
ALTER TABLE "goods_receipt_lines" ADD COLUMN     "ordered_quantity_snapshot" DECIMAL(18,4),
ADD COLUMN     "over_received_snapshot" DECIMAL(18,4),
ADD COLUMN     "received_quantity_snapshot" DECIMAL(18,4);

-- AlterTable
ALTER TABLE "stock_movements" ADD COLUMN     "total_cost_snapshot" DECIMAL(20,4),
ADD COLUMN     "unit_cost_snapshot" DECIMAL(20,6);

-- CreateTable
CREATE TABLE "purchase_line_fulfillments" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "purchase_line_id" UUID NOT NULL,
    "type" "PurchaseFulfillmentType" NOT NULL,
    "source_id" UUID NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "uom_id" UUID NOT NULL,
    "amount" DECIMAL(20,4),
    "reversed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_line_fulfillments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "purchase_line_fulfillments_purchase_line_id_idx" ON "purchase_line_fulfillments"("purchase_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_line_fulfillments_purchase_line_id_type_source_id_key" ON "purchase_line_fulfillments"("purchase_line_id", "type", "source_id");

-- AddForeignKey
ALTER TABLE "purchase_line_fulfillments" ADD CONSTRAINT "purchase_line_fulfillments_purchase_line_id_fkey" FOREIGN KEY ("purchase_line_id") REFERENCES "purchase_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_line_fulfillments" ADD CONSTRAINT "purchase_line_fulfillments_uom_id_fkey" FOREIGN KEY ("uom_id") REFERENCES "uoms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

