-- Phase 8: Tax invoices & Moadian submission
CREATE TYPE "SalesTaxInvoiceStatus" AS ENUM ('DRAFT', 'READY', 'SENDING', 'SUBMITTED', 'SUCCESS', 'FAILED', 'CANCELLED');
CREATE TYPE "TaxInvoiceSubject" AS ENUM ('MAIN', 'CORRECTIVE', 'CANCEL', 'RETURN');
CREATE TYPE "MoadianSubmissionStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED');
CREATE TYPE "PurchaseTaxInvoiceStatus" AS ENUM ('REGISTERED', 'CANCELLED');

CREATE TABLE "sales_tax_invoices" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "status" "SalesTaxInvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "subject" "TaxInvoiceSubject" NOT NULL DEFAULT 'MAIN',
    "customer_party_id" UUID NOT NULL,
    "issue_date" DATE NOT NULL,
    "subtotal" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "discount_total" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "tax_total" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "grand_total" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "taxid" TEXT,
    "reference_number" TEXT,
    "moadian_status" TEXT,
    "moadian_error" TEXT,
    "confirmation_reference_id" TEXT,
    "tax_result" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "sales_tax_invoices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "sales_tax_invoices_company_id_number_key" ON "sales_tax_invoices"("company_id", "number");
CREATE UNIQUE INDEX "sales_tax_invoices_taxid_key" ON "sales_tax_invoices"("taxid");
CREATE INDEX "sales_tax_invoices_company_id_status_idx" ON "sales_tax_invoices"("company_id", "status");
CREATE INDEX "sales_tax_invoices_company_id_customer_party_id_idx" ON "sales_tax_invoices"("company_id", "customer_party_id");

CREATE TABLE "sales_tax_invoice_lines" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "sales_tax_invoice_id" UUID NOT NULL,
    "sales_line_id" UUID,
    "sstid" TEXT,
    "description" TEXT NOT NULL,
    "mu" TEXT,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit_price" DECIMAL(20,4) NOT NULL,
    "prdis" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "dis" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "adis" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "vra" DECIMAL(9,4) NOT NULL DEFAULT 0,
    "vam" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "tsstam" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "line_order" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "sales_tax_invoice_lines_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "sales_tax_invoice_lines_sales_tax_invoice_id_idx" ON "sales_tax_invoice_lines"("sales_tax_invoice_id");

CREATE TABLE "sales_tax_invoice_submissions" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "uid" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "retry" BOOLEAN NOT NULL DEFAULT false,
    "status" "MoadianSubmissionStatus" NOT NULL DEFAULT 'PENDING',
    "reference_number" TEXT,
    "error_code" TEXT,
    "error_detail" TEXT,
    "confirmation_reference_id" TEXT,
    "tax_result" TEXT,
    "payload_snapshot" JSONB NOT NULL,
    "sent_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inquired_at" TIMESTAMPTZ(6),
    CONSTRAINT "sales_tax_invoice_submissions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "sales_tax_invoice_submissions_uid_key" ON "sales_tax_invoice_submissions"("uid");
CREATE INDEX "sales_tax_invoice_submissions_invoice_id_idx" ON "sales_tax_invoice_submissions"("invoice_id");

CREATE TABLE "purchase_tax_invoices" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "status" "PurchaseTaxInvoiceStatus" NOT NULL DEFAULT 'REGISTERED',
    "supplier_party_id" UUID NOT NULL,
    "supplier_invoice_number" TEXT NOT NULL,
    "invoice_date" DATE NOT NULL,
    "total" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "tax_total" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "registered_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "purchase_tax_invoices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "purchase_tax_invoices_company_id_number_key" ON "purchase_tax_invoices"("company_id", "number");
CREATE INDEX "purchase_tax_invoices_company_id_supplier_party_id_idx" ON "purchase_tax_invoices"("company_id", "supplier_party_id");

ALTER TABLE "sales_tax_invoices" ADD CONSTRAINT "sales_tax_invoices_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_tax_invoices" ADD CONSTRAINT "sales_tax_invoices_customer_party_id_fkey" FOREIGN KEY ("customer_party_id") REFERENCES "parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_tax_invoice_lines" ADD CONSTRAINT "sales_tax_invoice_lines_sales_tax_invoice_id_fkey" FOREIGN KEY ("sales_tax_invoice_id") REFERENCES "sales_tax_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sales_tax_invoice_submissions" ADD CONSTRAINT "sales_tax_invoice_submissions_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "sales_tax_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "purchase_tax_invoices" ADD CONSTRAINT "purchase_tax_invoices_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_tax_invoices" ADD CONSTRAINT "purchase_tax_invoices_supplier_party_id_fkey" FOREIGN KEY ("supplier_party_id") REFERENCES "parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
