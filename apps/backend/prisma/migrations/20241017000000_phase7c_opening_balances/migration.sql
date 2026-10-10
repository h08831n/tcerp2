-- CreateEnum
CREATE TYPE "OpeningBalanceStatus" AS ENUM ('STAGED', 'GENERATED');

-- DropIndex

-- DropIndex

-- DropIndex

-- DropIndex

-- CreateTable
CREATE TABLE "opening_balance_entries" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "fiscal_year_id" UUID,
    "account_code" TEXT NOT NULL,
    "party_id" UUID,
    "party_name" TEXT,
    "product_variant_id" UUID,
    "quantity" DECIMAL(18,4),
    "unit_cost" DECIMAL(20,6),
    "debit" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "credit" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "status" "OpeningBalanceStatus" NOT NULL DEFAULT 'STAGED',
    "journal_entry_id" UUID,
    "note" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "opening_balance_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "opening_balance_entries_company_id_status_idx" ON "opening_balance_entries"("company_id", "status");

-- AddForeignKey
ALTER TABLE "opening_balance_entries" ADD CONSTRAINT "opening_balance_entries_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opening_balance_entries" ADD CONSTRAINT "opening_balance_entries_product_variant_id_fkey" FOREIGN KEY ("product_variant_id") REFERENCES "product_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

