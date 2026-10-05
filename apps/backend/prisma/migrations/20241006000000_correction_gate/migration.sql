-- CreateEnum
CREATE TYPE "CompanyStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "SequenceResetCycle" AS ENUM ('NEVER', 'FISCAL_YEAR', 'JALALI_YEAR', 'MONTHLY');

-- CreateEnum
CREATE TYPE "TimerStatus" AS ENUM ('SCHEDULED', 'EXECUTED', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "ClaimDirection" AS ENUM ('CUSTOMER_RECEIPT', 'SUPPLIER_PAYMENT');

-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('UNMATCHED', 'MATCHED', 'REJECTED');

-- CreateEnum
CREATE TYPE "SupplierMappingLevel" AS ENUM ('VARIANT', 'TEMPLATE', 'CATEGORY');

-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE');

-- CreateEnum
CREATE TYPE "JournalEntryStatus" AS ENUM ('DRAFT', 'POSTED', 'REVERSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BankLineDirection" AS ENUM ('DEPOSIT', 'WITHDRAWAL');

-- CreateEnum
CREATE TYPE "CheckDirection" AS ENUM ('INCOMING', 'OUTGOING');

-- CreateEnum
CREATE TYPE "CheckStatus" AS ENUM ('REGISTERED', 'PENDING', 'DEPOSITED', 'CLEARED', 'PAID', 'BOUNCED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PortalAccountStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED');

-- DropIndex
DROP INDEX "integration_configs_code_key";

-- DropIndex
DROP INDEX "notification_rules_code_key";

-- DropIndex
DROP INDEX "sequences_code_key";

-- DropIndex
DROP INDEX "settings_key_key";

-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "company_id" UUID;

-- AlterTable
ALTER TABLE "integration_configs" ADD COLUMN     "company_id" UUID;

-- AlterTable
ALTER TABLE "notification_rules" DROP COLUMN "delay_minutes",
DROP COLUMN "recipients",
ADD COLUMN     "company_id" UUID NOT NULL,
ADD COLUMN     "conditions" JSONB,
ADD COLUMN     "delay_config" JSONB,
ADD COLUMN     "recipient_config" JSONB NOT NULL;

-- AlterTable
ALTER TABLE "queue_jobs" ADD COLUMN     "company_id" UUID;

-- Sequences rows are pure configuration (no documents reference them yet in dev);
-- they are recreated company-scoped by the seed, so legacy rows are removed here.
DELETE FROM "sequences";

-- AlterTable
ALTER TABLE "sequences" DROP COLUMN "code",
DROP COLUMN "include_jalali_year",
DROP COLUMN "last_reset_year",
DROP COLUMN "reset_yearly",
ADD COLUMN     "company_id" UUID,
ADD COLUMN     "document_type" TEXT NOT NULL,
ADD COLUMN     "last_reset_marker" TEXT,
ADD COLUMN     "reset_cycle" "SequenceResetCycle" NOT NULL DEFAULT 'NEVER';

-- AlterTable
ALTER TABLE "settings" ADD COLUMN     "company_id" UUID;

-- AlterTable
ALTER TABLE "teams" ADD COLUMN     "company_id" UUID;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "default_company_id" UUID;

-- CreateTable
CREATE TABLE "companies" (
    "id" UUID NOT NULL,
    "name_fa" TEXT NOT NULL,
    "name_en" TEXT,
    "national_id" TEXT,
    "economic_code" TEXT,
    "status" "CompanyStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);
;

-- CreateTable
CREATE TABLE "user_companies" (
    "user_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_companies_pkey" PRIMARY KEY ("user_id","company_id")
);

-- CreateTable
CREATE TABLE "job_executions" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "attempt_no" INTEGER NOT NULL,
    "status" "QueueJobStatus" NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "finished_at" TIMESTAMPTZ(6),
    "error" TEXT,

    CONSTRAINT "job_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_definitions" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "workflow_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_states" (
    "id" UUID NOT NULL,
    "definition_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "workflow_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_instances" (
    "id" UUID NOT NULL,
    "definition_id" UUID NOT NULL,
    "current_state_id" UUID,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "workflow_instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_timers" (
    "id" UUID NOT NULL,
    "workflow_instance_id" UUID NOT NULL,
    "state_id" UUID NOT NULL,
    "timer_type" TEXT NOT NULL,
    "due_at" TIMESTAMPTZ(6) NOT NULL,
    "status" "TimerStatus" NOT NULL DEFAULT 'SCHEDULED',
    "action_config" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "executed_at" TIMESTAMPTZ(6),

    CONSTRAINT "workflow_timers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_definitions" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rate" DECIMAL(9,4) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tax_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operational_settlement_claims" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "direction" "ClaimDirection" NOT NULL,
    "party_id" UUID NOT NULL,
    "sales_document_id" UUID,
    "purchase_document_id" UUID,
    "amount" DECIMAL(20,4) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'IRR',
    "status" "ClaimStatus" NOT NULL DEFAULT 'UNMATCHED',
    "declared_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "declared_by" UUID,
    "matched_receipt_id" UUID,
    "matched_payment_id" UUID,
    "rejection_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "operational_settlement_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_tax_invoice_order_allocations" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "sales_tax_invoice_id" UUID NOT NULL,
    "sales_document_id" UUID NOT NULL,
    "allocated_amount" DECIMAL(20,4) NOT NULL,
    "allocated_quantity" DECIMAL(18,4),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_tax_invoice_order_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_tax_invoice_order_allocations" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "purchase_tax_invoice_id" UUID NOT NULL,
    "purchase_document_id" UUID NOT NULL,
    "allocated_amount" DECIMAL(20,4) NOT NULL,
    "allocated_quantity" DECIMAL(18,4),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_tax_invoice_order_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_products" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "supplier_party_id" UUID NOT NULL,
    "mapping_level" "SupplierMappingLevel" NOT NULL,
    "product_variant_id" UUID,
    "product_template_id" UUID,
    "category_id" UUID,
    "supplier_product_code" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "supplier_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loadings" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "loading_date" TIMESTAMPTZ(6) NOT NULL,
    "driver_party_id" UUID,
    "carrier_party_id" UUID,
    "notes" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "loadings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loading_lines" (
    "id" UUID NOT NULL,
    "loading_id" UUID NOT NULL,
    "product_variant_id" UUID NOT NULL,
    "actual_quantity" DECIMAL(18,4) NOT NULL,
    "uom_id" UUID,
    "notes" TEXT,

    CONSTRAINT "loading_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loading_allocations" (
    "id" UUID NOT NULL,
    "loading_line_id" UUID NOT NULL,
    "sales_line_id" UUID,
    "purchase_line_id" UUID,
    "allocated_quantity" DECIMAL(18,4) NOT NULL,

    CONSTRAINT "loading_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chart_of_accounts" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "AccountType" NOT NULL,
    "parent_id" UUID,

    CONSTRAINT "chart_of_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_entries" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "entry_number" TEXT NOT NULL,
    "entry_date" TIMESTAMPTZ(6) NOT NULL,
    "journal_code" TEXT NOT NULL DEFAULT 'GENERAL',
    "document_type" TEXT,
    "description" TEXT,
    "status" "JournalEntryStatus" NOT NULL DEFAULT 'DRAFT',
    "posted_at" TIMESTAMPTZ(6),
    "reversed_by_entry_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "journal_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_lines" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "journal_entry_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "party_id" UUID,
    "description" TEXT,
    "debit" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "credit" DECIMAL(20,4) NOT NULL DEFAULT 0,

    CONSTRAINT "journal_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_accounts" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "bank_name" TEXT NOT NULL,
    "account_number" TEXT,
    "iban" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'IRR',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "bank_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_statement_lines" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "bank_account_id" UUID NOT NULL,
    "entry_date" DATE NOT NULL,
    "sequence_no" INTEGER NOT NULL,
    "direction" "BankLineDirection" NOT NULL,
    "amount" DECIMAL(20,4) NOT NULL,
    "running_balance" DECIMAL(20,4) NOT NULL,
    "reference_number" TEXT,
    "description" TEXT,
    "source_entity_type" TEXT,
    "source_entity_id" UUID,
    "journal_entry_id" UUID,
    "is_reconciled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_statement_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipts" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "receipt_number" TEXT NOT NULL,
    "bank_account_id" UUID NOT NULL,
    "party_id" UUID,
    "amount" DECIMAL(20,4) NOT NULL,
    "receipt_date" TIMESTAMPTZ(6) NOT NULL,
    "description" TEXT,
    "journal_entry_id" UUID,
    "settlement_claim_id" UUID,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "payment_number" TEXT NOT NULL,
    "bank_account_id" UUID NOT NULL,
    "party_id" UUID,
    "amount" DECIMAL(20,4) NOT NULL,
    "payment_date" TIMESTAMPTZ(6) NOT NULL,
    "description" TEXT,
    "journal_entry_id" UUID,
    "settlement_claim_id" UUID,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_transfers" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "transfer_number" TEXT NOT NULL,
    "source_bank_account_id" UUID NOT NULL,
    "destination_bank_account_id" UUID NOT NULL,
    "amount" DECIMAL(20,4) NOT NULL,
    "fee" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "transfer_date" TIMESTAMPTZ(6) NOT NULL,
    "description" TEXT,
    "journal_entry_id" UUID,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "bank_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "checks" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "direction" "CheckDirection" NOT NULL,
    "check_number" TEXT NOT NULL,
    "bank_name" TEXT,
    "party_id" UUID,
    "amount" DECIMAL(20,4) NOT NULL,
    "issue_date" TIMESTAMPTZ(6),
    "due_date" TIMESTAMPTZ(6) NOT NULL,
    "status" "CheckStatus" NOT NULL DEFAULT 'REGISTERED',
    "bank_account_id" UUID,
    "journal_entry_id" UUID,
    "description" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "portal_accounts" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "party_id" UUID NOT NULL,
    "website_user_id" TEXT,
    "verified_mobile" TEXT NOT NULL,
    "status" "PortalAccountStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "portal_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_companies_company_id_idx" ON "user_companies"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "job_executions_job_id_attempt_no_key" ON "job_executions"("job_id", "attempt_no");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_definitions_company_id_code_key" ON "workflow_definitions"("company_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_states_definition_id_code_key" ON "workflow_states"("definition_id", "code");

-- CreateIndex
CREATE INDEX "workflow_instances_entity_type_entity_id_idx" ON "workflow_instances"("entity_type", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_instances_definition_id_entity_type_entity_id_key" ON "workflow_instances"("definition_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "workflow_timers_status_due_at_idx" ON "workflow_timers"("status", "due_at");

-- CreateIndex
CREATE UNIQUE INDEX "tax_definitions_company_id_code_key" ON "tax_definitions"("company_id", "code");

-- CreateIndex
CREATE INDEX "operational_settlement_claims_company_id_status_idx" ON "operational_settlement_claims"("company_id", "status");

-- CreateIndex
CREATE INDEX "operational_settlement_claims_party_id_status_idx" ON "operational_settlement_claims"("party_id", "status");

-- CreateIndex
CREATE INDEX "sales_tax_invoice_order_allocations_sales_document_id_idx" ON "sales_tax_invoice_order_allocations"("sales_document_id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_tax_invoice_order_allocations_sales_tax_invoice_id_sa_key" ON "sales_tax_invoice_order_allocations"("sales_tax_invoice_id", "sales_document_id");

-- CreateIndex
CREATE INDEX "purchase_tax_invoice_order_allocations_purchase_document_id_idx" ON "purchase_tax_invoice_order_allocations"("purchase_document_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_tax_invoice_order_allocations_purchase_tax_invoice_key" ON "purchase_tax_invoice_order_allocations"("purchase_tax_invoice_id", "purchase_document_id");

-- CreateIndex
CREATE INDEX "supplier_products_company_id_supplier_party_id_idx" ON "supplier_products"("company_id", "supplier_party_id");

-- CreateIndex
CREATE INDEX "loadings_company_id_loading_date_idx" ON "loadings"("company_id", "loading_date");

-- CreateIndex
CREATE INDEX "loading_lines_loading_id_idx" ON "loading_lines"("loading_id");

-- CreateIndex
CREATE INDEX "loading_allocations_loading_line_id_idx" ON "loading_allocations"("loading_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "chart_of_accounts_company_id_code_key" ON "chart_of_accounts"("company_id", "code");

-- CreateIndex
CREATE INDEX "journal_entries_company_id_entry_date_idx" ON "journal_entries"("company_id", "entry_date");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_company_id_entry_number_key" ON "journal_entries"("company_id", "entry_number");

-- CreateIndex
CREATE INDEX "journal_lines_journal_entry_id_idx" ON "journal_lines"("journal_entry_id");

-- CreateIndex
CREATE INDEX "journal_lines_account_id_idx" ON "journal_lines"("account_id");

-- CreateIndex
CREATE INDEX "bank_accounts_company_id_idx" ON "bank_accounts"("company_id");

-- CreateIndex
CREATE INDEX "bank_statement_lines_bank_account_id_entry_date_idx" ON "bank_statement_lines"("bank_account_id", "entry_date");

-- CreateIndex
CREATE UNIQUE INDEX "bank_statement_lines_company_id_bank_account_id_entry_date__key" ON "bank_statement_lines"("company_id", "bank_account_id", "entry_date", "sequence_no");

-- CreateIndex
CREATE UNIQUE INDEX "receipts_company_id_receipt_number_key" ON "receipts"("company_id", "receipt_number");

-- CreateIndex
CREATE UNIQUE INDEX "payments_company_id_payment_number_key" ON "payments"("company_id", "payment_number");

-- CreateIndex
CREATE UNIQUE INDEX "bank_transfers_company_id_transfer_number_key" ON "bank_transfers"("company_id", "transfer_number");

-- CreateIndex
CREATE INDEX "checks_company_id_status_due_date_idx" ON "checks"("company_id", "status", "due_date");

-- CreateIndex
CREATE INDEX "portal_accounts_party_id_idx" ON "portal_accounts"("party_id");

-- CreateIndex
CREATE UNIQUE INDEX "portal_accounts_company_id_verified_mobile_key" ON "portal_accounts"("company_id", "verified_mobile");

-- CreateIndex
CREATE INDEX "audit_logs_company_id_idx" ON "audit_logs"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "integration_configs_company_id_code_key" ON "integration_configs"("company_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "notification_rules_company_id_code_key" ON "notification_rules"("company_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "sequences_company_id_document_type_key" ON "sequences"("company_id", "document_type");

-- CreateIndex
CREATE UNIQUE INDEX "settings_company_id_key_key" ON "settings"("company_id", "key");

-- CreateIndex
CREATE INDEX "teams_company_id_idx" ON "teams"("company_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_default_company_id_fkey" FOREIGN KEY ("default_company_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_companies" ADD CONSTRAINT "user_companies_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_companies" ADD CONSTRAINT "user_companies_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settings" ADD CONSTRAINT "settings_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sequences" ADD CONSTRAINT "sequences_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queue_jobs" ADD CONSTRAINT "queue_jobs_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_executions" ADD CONSTRAINT "job_executions_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "queue_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_configs" ADD CONSTRAINT "integration_configs_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_rules" ADD CONSTRAINT "notification_rules_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_definitions" ADD CONSTRAINT "workflow_definitions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_states" ADD CONSTRAINT "workflow_states_definition_id_fkey" FOREIGN KEY ("definition_id") REFERENCES "workflow_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_instances" ADD CONSTRAINT "workflow_instances_definition_id_fkey" FOREIGN KEY ("definition_id") REFERENCES "workflow_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_instances" ADD CONSTRAINT "workflow_instances_current_state_id_fkey" FOREIGN KEY ("current_state_id") REFERENCES "workflow_states"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_timers" ADD CONSTRAINT "workflow_timers_workflow_instance_id_fkey" FOREIGN KEY ("workflow_instance_id") REFERENCES "workflow_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_timers" ADD CONSTRAINT "workflow_timers_state_id_fkey" FOREIGN KEY ("state_id") REFERENCES "workflow_states"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_definitions" ADD CONSTRAINT "tax_definitions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operational_settlement_claims" ADD CONSTRAINT "operational_settlement_claims_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loadings" ADD CONSTRAINT "loadings_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loading_lines" ADD CONSTRAINT "loading_lines_loading_id_fkey" FOREIGN KEY ("loading_id") REFERENCES "loadings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loading_allocations" ADD CONSTRAINT "loading_allocations_loading_line_id_fkey" FOREIGN KEY ("loading_line_id") REFERENCES "loading_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chart_of_accounts" ADD CONSTRAINT "chart_of_accounts_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chart_of_accounts" ADD CONSTRAINT "chart_of_accounts_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "chart_of_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "chart_of_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_bank_account_id_fkey" FOREIGN KEY ("bank_account_id") REFERENCES "bank_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_bank_account_id_fkey" FOREIGN KEY ("bank_account_id") REFERENCES "bank_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_bank_account_id_fkey" FOREIGN KEY ("bank_account_id") REFERENCES "bank_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_transfers" ADD CONSTRAINT "bank_transfers_source_bank_account_id_fkey" FOREIGN KEY ("source_bank_account_id") REFERENCES "bank_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_transfers" ADD CONSTRAINT "bank_transfers_destination_bank_account_id_fkey" FOREIGN KEY ("destination_bank_account_id") REFERENCES "bank_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_transfers" ADD CONSTRAINT "bank_transfers_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checks" ADD CONSTRAINT "checks_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checks" ADD CONSTRAINT "checks_bank_account_id_fkey" FOREIGN KEY ("bank_account_id") REFERENCES "bank_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portal_accounts" ADD CONSTRAINT "portal_accounts_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Correction Gate: backfill - default company for existing single-company data
INSERT INTO "companies" ("id", "name_fa", "name_en", "status", "created_at", "updated_at")
VALUES ('00000000-0000-4000-8000-000000000001', 'Default Company FA', 'Default Company', 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

UPDATE "integration_configs" SET "company_id" = '00000000-0000-4000-8000-000000000001' WHERE "company_id" IS NULL;
UPDATE "settings" SET "company_id" = '00000000-0000-4000-8000-000000000001' WHERE "company_id" IS NULL;
UPDATE "teams" SET "company_id" = '00000000-0000-4000-8000-000000000001' WHERE "company_id" IS NULL;
UPDATE "sequences" SET "company_id" = '00000000-0000-4000-8000-000000000001' WHERE "company_id" IS NULL;
UPDATE "users" SET "default_company_id" = '00000000-0000-4000-8000-000000000001' WHERE "default_company_id" IS NULL;

INSERT INTO "user_companies" ("user_id", "company_id", "is_default")
SELECT "id", '00000000-0000-4000-8000-000000000001', true FROM "users"
ON CONFLICT ("user_id", "company_id") DO NOTHING;

ALTER TABLE "integration_configs" ALTER COLUMN "company_id" SET NOT NULL;
ALTER TABLE "settings" ALTER COLUMN "company_id" SET NOT NULL;
ALTER TABLE "teams" ALTER COLUMN "company_id" SET NOT NULL;
ALTER TABLE "sequences" ALTER COLUMN "company_id" SET NOT NULL;

-- Correction Gate: business-rule CHECK constraints
ALTER TABLE "supplier_products" ADD CONSTRAINT "supplier_products_exactly_one_level_chk" CHECK (
  ("mapping_level" = 'VARIANT' AND "product_variant_id" IS NOT NULL AND "product_template_id" IS NULL AND "category_id" IS NULL) OR
  ("mapping_level" = 'TEMPLATE' AND "product_template_id" IS NOT NULL AND "product_variant_id" IS NULL AND "category_id" IS NULL) OR
  ("mapping_level" = 'CATEGORY' AND "category_id" IS NOT NULL AND "product_variant_id" IS NULL AND "product_template_id" IS NULL)
);
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_debit_credit_chk" CHECK (
  "debit" >= 0 AND "credit" >= 0 AND NOT ("debit" > 0 AND "credit" > 0)
);
ALTER TABLE "operational_settlement_claims" ADD CONSTRAINT "claims_direction_document_chk" CHECK (
  ("direction" = 'CUSTOMER_RECEIPT' AND "sales_document_id" IS NOT NULL AND "purchase_document_id" IS NULL) OR
  ("direction" = 'SUPPLIER_PAYMENT' AND "purchase_document_id" IS NOT NULL AND "sales_document_id" IS NULL)
);
ALTER TABLE "operational_settlement_claims" ADD CONSTRAINT "claims_amount_positive_chk" CHECK ("amount" > 0);
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_amount_positive_chk" CHECK ("amount" > 0);
ALTER TABLE "loading_allocations" ADD CONSTRAINT "loading_allocations_target_chk" CHECK (
  ("sales_line_id" IS NOT NULL OR "purchase_line_id" IS NOT NULL) AND "allocated_quantity" > 0
);
ALTER TABLE "bank_transfers" ADD CONSTRAINT "bank_transfers_amount_chk" CHECK (
  "amount" > 0 AND "fee" >= 0 AND "source_bank_account_id" <> "destination_bank_account_id"
);
