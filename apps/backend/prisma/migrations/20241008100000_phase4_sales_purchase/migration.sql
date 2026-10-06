-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('NEW', 'CONTACTED', 'QUALIFIED', 'LOST');

-- CreateEnum
CREATE TYPE "OpportunityStatus" AS ENUM ('OPEN', 'QUALIFIED', 'QUOTED', 'WON', 'LOST');

-- CreateEnum
CREATE TYPE "SalesDocumentStatus" AS ENUM ('DRAFT', 'QUOTATION', 'SENT', 'CUSTOMER_CONFIRMED', 'SALES_ORDER', 'PARTIALLY_LOADED', 'COMPLETED', 'CANCELLED', 'LOST');

-- CreateEnum
CREATE TYPE "PurchaseDocumentStatus" AS ENUM ('DRAFT', 'ORDER_PLACED', 'PARTIALLY_LOADED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PriceRequestStatus" AS ENUM ('OPEN', 'OFFERED', 'CONVERTED', 'CLOSED');

-- CreateEnum
CREATE TYPE "DocumentRelationType" AS ENUM ('CREATED_FROM', 'GENERATED_FROM', 'RELATED', 'BASED_ON');

-- DropIndex

-- DropIndex

-- DropIndex

-- DropIndex

-- CreateTable
CREATE TABLE "leads" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "party_id" UUID,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "source" TEXT,
    "campaign" TEXT,
    "media" TEXT,
    "referrer" TEXT,
    "assigned_salesperson_id" UUID,
    "status" "LeadStatus" NOT NULL DEFAULT 'NEW',
    "notes" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "opportunities" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "customer_party_id" UUID NOT NULL,
    "salesperson_user_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "estimated_amount" DECIMAL(20,4),
    "estimated_tonnage" DECIMAL(18,4),
    "status" "OpportunityStatus" NOT NULL DEFAULT 'OPEN',
    "source" TEXT,
    "lost_reason_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "opportunities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lost_reasons" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name_fa" TEXT NOT NULL,
    "name_en" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lost_reasons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_terms" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name_fa" TEXT NOT NULL,
    "name_en" TEXT,
    "description" TEXT,
    "days_offset" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_terms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_documents" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "document_number" TEXT NOT NULL,
    "opportunity_id" UUID,
    "customer_party_id" UUID NOT NULL,
    "salesperson_user_id" UUID NOT NULL,
    "document_date" TIMESTAMPTZ(6) NOT NULL,
    "expiration_date" TIMESTAMPTZ(6),
    "currency" TEXT NOT NULL DEFAULT 'IRR',
    "payment_term_id" UUID,
    "shipping_address_id" UUID,
    "language" TEXT NOT NULL DEFAULT 'fa',
    "quotation_template_code" TEXT,
    "price_request_id" UUID,
    "status" "SalesDocumentStatus" NOT NULL DEFAULT 'DRAFT',
    "subtotal" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "discount_total" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "tax_total" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "total" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "operational_ordered_amount" DECIMAL(20,4),
    "operational_loaded_amount" DECIMAL(20,4),
    "lost_reason_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sales_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_lines" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "sales_document_id" UUID NOT NULL,
    "product_variant_id" UUID NOT NULL,
    "printable_description" TEXT,
    "ordered_quantity" DECIMAL(18,4) NOT NULL,
    "uom_id" UUID NOT NULL,
    "unit_price" DECIMAL(20,4) NOT NULL,
    "discount_amount" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "tax_definition_id" UUID,
    "tax_rate_snapshot" DECIMAL(9,4),
    "subtotal" DECIMAL(20,4) NOT NULL,
    "tax_amount" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "line_total" DECIMAL(20,4) NOT NULL,
    "notes" TEXT,
    "line_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sales_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_documents" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "document_number" TEXT NOT NULL,
    "supplier_party_id" UUID NOT NULL,
    "buyer_user_id" UUID NOT NULL,
    "document_date" TIMESTAMPTZ(6) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'IRR',
    "payment_term_id" UUID,
    "price_request_id" UUID,
    "status" "PurchaseDocumentStatus" NOT NULL DEFAULT 'DRAFT',
    "subtotal" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "discount_total" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "tax_total" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "total" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "operational_ordered_amount" DECIMAL(20,4),
    "operational_loaded_amount" DECIMAL(20,4),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "purchase_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_lines" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "purchase_document_id" UUID NOT NULL,
    "product_variant_id" UUID NOT NULL,
    "ordered_quantity" DECIMAL(18,4) NOT NULL,
    "uom_id" UUID NOT NULL,
    "unit_price" DECIMAL(20,4) NOT NULL,
    "line_total" DECIMAL(20,4) NOT NULL,
    "notes" TEXT,
    "line_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "purchase_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_purchase_allocations" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "sales_line_id" UUID NOT NULL,
    "purchase_line_id" UUID NOT NULL,
    "allocated_quantity" DECIMAL(18,4) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "sales_purchase_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_requests" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "request_number" TEXT NOT NULL,
    "requester_user_id" UUID NOT NULL,
    "customer_party_id" UUID,
    "opportunity_id" UUID,
    "request_date" TIMESTAMPTZ(6) NOT NULL,
    "status" "PriceRequestStatus" NOT NULL DEFAULT 'OPEN',
    "notes" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "price_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_request_lines" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "price_request_id" UUID NOT NULL,
    "product_variant_id" UUID NOT NULL,
    "requested_quantity" DECIMAL(18,4) NOT NULL,
    "uom_id" UUID NOT NULL,
    "notes" TEXT,
    "line_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_request_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_offers" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "price_request_line_id" UUID NOT NULL,
    "supplier_party_id" UUID NOT NULL,
    "offered_price" DECIMAL(20,4) NOT NULL,
    "uom_id" UUID NOT NULL,
    "paymentTerms" TEXT,
    "delivery_time" TEXT,
    "notes" TEXT,
    "offered_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_relations" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "from_type" TEXT NOT NULL,
    "from_id" UUID NOT NULL,
    "to_type" TEXT NOT NULL,
    "to_id" UUID NOT NULL,
    "relation_type" "DocumentRelationType" NOT NULL DEFAULT 'RELATED',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "document_relations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "leads_company_id_status_idx" ON "leads"("company_id", "status");

-- CreateIndex
CREATE INDEX "leads_company_id_assigned_salesperson_id_idx" ON "leads"("company_id", "assigned_salesperson_id");

-- CreateIndex
CREATE INDEX "opportunities_company_id_customer_party_id_status_idx" ON "opportunities"("company_id", "customer_party_id", "status");

-- CreateIndex
CREATE INDEX "opportunities_company_id_salesperson_user_id_status_idx" ON "opportunities"("company_id", "salesperson_user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "lost_reasons_company_id_code_key" ON "lost_reasons"("company_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "payment_terms_company_id_code_key" ON "payment_terms"("company_id", "code");

-- CreateIndex
CREATE INDEX "sales_documents_company_id_status_document_date_idx" ON "sales_documents"("company_id", "status", "document_date");

-- CreateIndex
CREATE INDEX "sales_documents_company_id_customer_party_id_idx" ON "sales_documents"("company_id", "customer_party_id");

-- CreateIndex
CREATE INDEX "sales_documents_company_id_salesperson_user_id_status_idx" ON "sales_documents"("company_id", "salesperson_user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "sales_documents_company_id_document_number_key" ON "sales_documents"("company_id", "document_number");

-- CreateIndex
CREATE INDEX "sales_lines_sales_document_id_idx" ON "sales_lines"("sales_document_id");

-- CreateIndex
CREATE INDEX "sales_lines_product_variant_id_idx" ON "sales_lines"("product_variant_id");

-- CreateIndex
CREATE INDEX "purchase_documents_company_id_status_document_date_idx" ON "purchase_documents"("company_id", "status", "document_date");

-- CreateIndex
CREATE INDEX "purchase_documents_company_id_supplier_party_id_idx" ON "purchase_documents"("company_id", "supplier_party_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_documents_company_id_document_number_key" ON "purchase_documents"("company_id", "document_number");

-- CreateIndex
CREATE INDEX "purchase_lines_purchase_document_id_idx" ON "purchase_lines"("purchase_document_id");

-- CreateIndex
CREATE INDEX "purchase_lines_product_variant_id_idx" ON "purchase_lines"("product_variant_id");

-- CreateIndex
CREATE INDEX "sales_purchase_allocations_sales_line_id_idx" ON "sales_purchase_allocations"("sales_line_id");

-- CreateIndex
CREATE INDEX "sales_purchase_allocations_purchase_line_id_idx" ON "sales_purchase_allocations"("purchase_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_purchase_allocations_sales_line_id_purchase_line_id_key" ON "sales_purchase_allocations"("sales_line_id", "purchase_line_id");

-- CreateIndex
CREATE INDEX "price_requests_company_id_status_request_date_idx" ON "price_requests"("company_id", "status", "request_date");

-- CreateIndex
CREATE UNIQUE INDEX "price_requests_company_id_request_number_key" ON "price_requests"("company_id", "request_number");

-- CreateIndex
CREATE INDEX "price_request_lines_price_request_id_idx" ON "price_request_lines"("price_request_id");

-- CreateIndex
CREATE INDEX "price_request_lines_product_variant_id_idx" ON "price_request_lines"("product_variant_id");

-- CreateIndex
CREATE INDEX "supplier_offers_price_request_line_id_idx" ON "supplier_offers"("price_request_line_id");

-- CreateIndex
CREATE INDEX "supplier_offers_company_id_supplier_party_id_offered_at_idx" ON "supplier_offers"("company_id", "supplier_party_id", "offered_at");

-- CreateIndex
CREATE INDEX "document_relations_from_type_from_id_idx" ON "document_relations"("from_type", "from_id");

-- CreateIndex
CREATE INDEX "document_relations_to_type_to_id_idx" ON "document_relations"("to_type", "to_id");

-- CreateIndex
CREATE UNIQUE INDEX "document_relations_from_type_from_id_to_type_to_id_relation_key" ON "document_relations"("from_type", "from_id", "to_type", "to_id", "relation_type");

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_assigned_salesperson_id_fkey" FOREIGN KEY ("assigned_salesperson_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_customer_party_id_fkey" FOREIGN KEY ("customer_party_id") REFERENCES "parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_salesperson_user_id_fkey" FOREIGN KEY ("salesperson_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_lost_reason_id_fkey" FOREIGN KEY ("lost_reason_id") REFERENCES "lost_reasons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lost_reasons" ADD CONSTRAINT "lost_reasons_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_terms" ADD CONSTRAINT "payment_terms_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_documents" ADD CONSTRAINT "sales_documents_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_documents" ADD CONSTRAINT "sales_documents_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "opportunities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_documents" ADD CONSTRAINT "sales_documents_customer_party_id_fkey" FOREIGN KEY ("customer_party_id") REFERENCES "parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_documents" ADD CONSTRAINT "sales_documents_salesperson_user_id_fkey" FOREIGN KEY ("salesperson_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_documents" ADD CONSTRAINT "sales_documents_payment_term_id_fkey" FOREIGN KEY ("payment_term_id") REFERENCES "payment_terms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_documents" ADD CONSTRAINT "sales_documents_shipping_address_id_fkey" FOREIGN KEY ("shipping_address_id") REFERENCES "addresses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_documents" ADD CONSTRAINT "sales_documents_lost_reason_id_fkey" FOREIGN KEY ("lost_reason_id") REFERENCES "lost_reasons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_documents" ADD CONSTRAINT "sales_documents_price_request_id_fkey" FOREIGN KEY ("price_request_id") REFERENCES "price_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_lines" ADD CONSTRAINT "sales_lines_sales_document_id_fkey" FOREIGN KEY ("sales_document_id") REFERENCES "sales_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_lines" ADD CONSTRAINT "sales_lines_product_variant_id_fkey" FOREIGN KEY ("product_variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_lines" ADD CONSTRAINT "sales_lines_uom_id_fkey" FOREIGN KEY ("uom_id") REFERENCES "uoms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_lines" ADD CONSTRAINT "sales_lines_tax_definition_id_fkey" FOREIGN KEY ("tax_definition_id") REFERENCES "tax_definitions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_documents" ADD CONSTRAINT "purchase_documents_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_documents" ADD CONSTRAINT "purchase_documents_supplier_party_id_fkey" FOREIGN KEY ("supplier_party_id") REFERENCES "parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_documents" ADD CONSTRAINT "purchase_documents_buyer_user_id_fkey" FOREIGN KEY ("buyer_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_documents" ADD CONSTRAINT "purchase_documents_payment_term_id_fkey" FOREIGN KEY ("payment_term_id") REFERENCES "payment_terms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_documents" ADD CONSTRAINT "purchase_documents_price_request_id_fkey" FOREIGN KEY ("price_request_id") REFERENCES "price_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_lines" ADD CONSTRAINT "purchase_lines_purchase_document_id_fkey" FOREIGN KEY ("purchase_document_id") REFERENCES "purchase_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_lines" ADD CONSTRAINT "purchase_lines_product_variant_id_fkey" FOREIGN KEY ("product_variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_lines" ADD CONSTRAINT "purchase_lines_uom_id_fkey" FOREIGN KEY ("uom_id") REFERENCES "uoms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_purchase_allocations" ADD CONSTRAINT "sales_purchase_allocations_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_purchase_allocations" ADD CONSTRAINT "sales_purchase_allocations_sales_line_id_fkey" FOREIGN KEY ("sales_line_id") REFERENCES "sales_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_purchase_allocations" ADD CONSTRAINT "sales_purchase_allocations_purchase_line_id_fkey" FOREIGN KEY ("purchase_line_id") REFERENCES "purchase_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_requests" ADD CONSTRAINT "price_requests_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_requests" ADD CONSTRAINT "price_requests_requester_user_id_fkey" FOREIGN KEY ("requester_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_requests" ADD CONSTRAINT "price_requests_customer_party_id_fkey" FOREIGN KEY ("customer_party_id") REFERENCES "parties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_requests" ADD CONSTRAINT "price_requests_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "opportunities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_request_lines" ADD CONSTRAINT "price_request_lines_price_request_id_fkey" FOREIGN KEY ("price_request_id") REFERENCES "price_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_request_lines" ADD CONSTRAINT "price_request_lines_product_variant_id_fkey" FOREIGN KEY ("product_variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_request_lines" ADD CONSTRAINT "price_request_lines_uom_id_fkey" FOREIGN KEY ("uom_id") REFERENCES "uoms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_offers" ADD CONSTRAINT "supplier_offers_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_offers" ADD CONSTRAINT "supplier_offers_price_request_line_id_fkey" FOREIGN KEY ("price_request_line_id") REFERENCES "price_request_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_offers" ADD CONSTRAINT "supplier_offers_supplier_party_id_fkey" FOREIGN KEY ("supplier_party_id") REFERENCES "parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_offers" ADD CONSTRAINT "supplier_offers_uom_id_fkey" FOREIGN KEY ("uom_id") REFERENCES "uoms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_relations" ADD CONSTRAINT "document_relations_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Phase 4: raw indexes to complement Prisma-generated ones (keep any raw
-- indexes the diff cannot see; nothing is dropped by this migration).
CREATE INDEX IF NOT EXISTS "sales_lines_sales_document_id_line_order_idx" ON "sales_lines" ("sales_document_id", "line_order");
CREATE INDEX IF NOT EXISTS "purchase_lines_purchase_document_id_line_order_idx" ON "purchase_lines" ("purchase_document_id", "line_order");
