-- CreateEnum
CREATE TYPE "AccountingEventType" AS ENUM ('SALES_COMPLETED_LOADING', 'PURCHASE_FULFILLED', 'GOODS_RECEIPT_CONFIRMED', 'INVENTORY_REVERSAL', 'PAYMENT_RECEIVED', 'PAYMENT_MADE');

-- CreateEnum
CREATE TYPE "AccountingEventStatus" AS ENUM ('POSTED', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "PostingMeasure" AS ENUM ('RECEIVABLE', 'PAYABLE', 'REVENUE', 'COGS', 'INVENTORY');

-- CreateEnum
CREATE TYPE "JournalSide" AS ENUM ('DEBIT', 'CREDIT');

-- DropIndex

-- DropIndex

-- DropIndex

-- DropIndex

-- CreateTable
CREATE TABLE "posting_rules" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name_fa" TEXT NOT NULL,
    "event_type" "AccountingEventType" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "posting_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "posting_rule_lines" (
    "id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "side" "JournalSide" NOT NULL,
    "account_code" TEXT NOT NULL,
    "measure" "PostingMeasure" NOT NULL,
    "memo" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "posting_rule_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounting_events" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "event_type" "AccountingEventType" NOT NULL,
    "source_entity_type" TEXT NOT NULL,
    "source_entity_id" UUID NOT NULL,
    "payload" JSONB,
    "status" "AccountingEventStatus" NOT NULL DEFAULT 'FAILED',
    "journal_entry_id" UUID,
    "error" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "posted_at" TIMESTAMPTZ(6),

    CONSTRAINT "accounting_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "posting_rules_event_type_enabled_idx" ON "posting_rules"("event_type", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "posting_rules_company_id_code_key" ON "posting_rules"("company_id", "code");

-- CreateIndex
CREATE INDEX "posting_rule_lines_rule_id_order_idx" ON "posting_rule_lines"("rule_id", "order");

-- CreateIndex
CREATE UNIQUE INDEX "accounting_events_idempotency_key_key" ON "accounting_events"("idempotency_key");

-- CreateIndex
CREATE INDEX "accounting_events_company_id_status_created_at_idx" ON "accounting_events"("company_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "accounting_events_event_type_source_entity_id_idx" ON "accounting_events"("event_type", "source_entity_id");

-- AddForeignKey
ALTER TABLE "posting_rules" ADD CONSTRAINT "posting_rules_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posting_rule_lines" ADD CONSTRAINT "posting_rule_lines_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "posting_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounting_events" ADD CONSTRAINT "accounting_events_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

