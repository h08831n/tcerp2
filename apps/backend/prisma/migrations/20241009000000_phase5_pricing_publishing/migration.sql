-- CreateEnum
CREATE TYPE "DailyPriceSource" AS ENUM ('MANUAL', 'SUPPLIER_OFFER', 'IMPORTED', 'API');

-- CreateEnum
CREATE TYPE "PublishChannel" AS ENUM ('WEBSITE', 'TELEGRAM', 'WHATSAPP', 'EITAA', 'BALE', 'RUBIKA', 'SMS');

-- CreateEnum
CREATE TYPE "PublishBatchStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PublishItemStatus" AS ENUM ('PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AutomationTriggerType" AS ENUM ('PRICE_UPDATED', 'CUSTOMER_INACTIVE_DAYS', 'QUOTATION_PENDING_DAYS', 'MANUAL');

-- CreateEnum
CREATE TYPE "AutomationActionType" AS ENUM ('PUBLISH_PRICE', 'SEND_SMS', 'CREATE_ACTIVITY', 'CREATE_NOTIFICATION');

-- DropIndex

-- DropIndex

-- DropIndex

-- DropIndex

-- CreateTable
CREATE TABLE "daily_prices" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "product_variant_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "price" DECIMAL(20,4) NOT NULL,
    "uom_id" UUID NOT NULL,
    "supplier_party_id" UUID,
    "source" "DailyPriceSource" NOT NULL DEFAULT 'MANUAL',
    "notes" TEXT,
    "entered_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "daily_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publish_batches" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "batch_number" TEXT NOT NULL,
    "price_date" DATE NOT NULL,
    "status" "PublishBatchStatus" NOT NULL DEFAULT 'PENDING',
    "notes" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "publish_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publish_batch_items" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "channel" "PublishChannel" NOT NULL,
    "destination" TEXT,
    "template_id" UUID,
    "rendered_payload" JSONB,
    "status" "PublishItemStatus" NOT NULL DEFAULT 'PENDING',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "last_error" TEXT,
    "provider_response" JSONB,
    "queued_job_id" UUID,
    "price_date" DATE NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "publish_batch_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publishing_templates" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "channel" "PublishChannel" NOT NULL,
    "code" TEXT NOT NULL,
    "name_fa" TEXT NOT NULL,
    "body_template" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "publishing_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_rules" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name_fa" TEXT NOT NULL,
    "trigger_type" "AutomationTriggerType" NOT NULL,
    "trigger_config" JSONB NOT NULL,
    "condition_config" JSONB,
    "action_type" "AutomationActionType" NOT NULL,
    "action_config" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "automation_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_runs" (
    "id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "rule_version" INTEGER NOT NULL,
    "trigger_payload" JSONB,
    "status" TEXT NOT NULL,
    "conditions_result" JSONB,
    "error" TEXT,
    "idempotency_key" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "automation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "daily_prices_company_id_date_idx" ON "daily_prices"("company_id", "date");

-- CreateIndex
CREATE INDEX "daily_prices_product_variant_id_date_idx" ON "daily_prices"("product_variant_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "daily_prices_company_id_product_variant_id_date_uom_id_key" ON "daily_prices"("company_id", "product_variant_id", "date", "uom_id");

-- CreateIndex
CREATE INDEX "publish_batches_company_id_status_created_at_idx" ON "publish_batches"("company_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "publish_batches_company_id_batch_number_key" ON "publish_batches"("company_id", "batch_number");

-- CreateIndex
CREATE INDEX "publish_batch_items_company_id_status_idx" ON "publish_batch_items"("company_id", "status");

-- CreateIndex
CREATE INDEX "publish_batch_items_queued_job_id_idx" ON "publish_batch_items"("queued_job_id");

-- CreateIndex
CREATE UNIQUE INDEX "publish_batch_items_batch_id_channel_destination_key" ON "publish_batch_items"("batch_id", "channel", "destination");

-- CreateIndex
CREATE UNIQUE INDEX "publishing_templates_company_id_channel_code_key" ON "publishing_templates"("company_id", "channel", "code");

-- CreateIndex
CREATE INDEX "automation_rules_trigger_type_enabled_idx" ON "automation_rules"("trigger_type", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "automation_rules_company_id_code_key" ON "automation_rules"("company_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "automation_runs_idempotency_key_key" ON "automation_runs"("idempotency_key");

-- CreateIndex
CREATE INDEX "automation_runs_rule_id_created_at_idx" ON "automation_runs"("rule_id", "created_at");

-- AddForeignKey
ALTER TABLE "daily_prices" ADD CONSTRAINT "daily_prices_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_prices" ADD CONSTRAINT "daily_prices_product_variant_id_fkey" FOREIGN KEY ("product_variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_prices" ADD CONSTRAINT "daily_prices_uom_id_fkey" FOREIGN KEY ("uom_id") REFERENCES "uoms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_prices" ADD CONSTRAINT "daily_prices_supplier_party_id_fkey" FOREIGN KEY ("supplier_party_id") REFERENCES "parties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publish_batches" ADD CONSTRAINT "publish_batches_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publish_batch_items" ADD CONSTRAINT "publish_batch_items_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "publish_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publish_batch_items" ADD CONSTRAINT "publish_batch_items_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "publishing_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publishing_templates" ADD CONSTRAINT "publishing_templates_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "automation_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

