-- CreateEnum
CREATE TYPE "FiscalYearStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "AnalyticDimensionType" AS ENUM ('CUSTOMER', 'SUPPLIER', 'EMPLOYEE', 'PROJECT', 'COST_CENTER');

-- AlterEnum
BEGIN;
CREATE TYPE "AccountType_new" AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE');
-- Map legacy INCOME to REVENUE before the enum swap (review item 4 vocabulary)
ALTER TABLE "chart_of_accounts" ALTER COLUMN "type" TYPE "AccountType_new" USING (CASE WHEN "type"::text = 'INCOME' THEN 'REVENUE' ELSE "type"::text END)::"AccountType_new";
ALTER TYPE "AccountType" RENAME TO "AccountType_old";
ALTER TYPE "AccountType_new" RENAME TO "AccountType";
DROP TYPE "AccountType_old";
COMMIT;

-- DropIndex

-- DropIndex

-- DropIndex

-- DropIndex

-- CreateTable
CREATE TABLE "fiscal_years" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name_fa" TEXT NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "status" "FiscalYearStatus" NOT NULL DEFAULT 'OPEN',
    "closing_entry_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "fiscal_years_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fiscal_periods" (
    "id" UUID NOT NULL,
    "fiscal_year_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name_fa" TEXT NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "status" "FiscalYearStatus" NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fiscal_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_line_analytics" (
    "id" UUID NOT NULL,
    "journal_line_id" UUID NOT NULL,
    "dimension_type" "AnalyticDimensionType" NOT NULL,
    "dimension_id" UUID NOT NULL,
    "label" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journal_line_analytics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fiscal_years_company_id_code_key" ON "fiscal_years"("company_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "fiscal_periods_fiscal_year_id_code_key" ON "fiscal_periods"("fiscal_year_id", "code");

-- CreateIndex
CREATE INDEX "journal_line_analytics_dimension_type_dimension_id_idx" ON "journal_line_analytics"("dimension_type", "dimension_id");

-- CreateIndex
CREATE UNIQUE INDEX "journal_line_analytics_journal_line_id_dimension_type_dimen_key" ON "journal_line_analytics"("journal_line_id", "dimension_type", "dimension_id");

-- AddForeignKey
ALTER TABLE "fiscal_years" ADD CONSTRAINT "fiscal_years_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fiscal_periods" ADD CONSTRAINT "fiscal_periods_fiscal_year_id_fkey" FOREIGN KEY ("fiscal_year_id") REFERENCES "fiscal_years"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_line_analytics" ADD CONSTRAINT "journal_line_analytics_journal_line_id_fkey" FOREIGN KEY ("journal_line_id") REFERENCES "journal_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Phase 7A: seed OPEN fiscal year 1405 + 12 Jalali monthly periods for
-- companies that do not have one (idempotent).
INSERT INTO fiscal_years (id, company_id, code, name_fa, start_date, end_date, status, created_at, updated_at)
SELECT gen_random_uuid(), c.id, '1405', 'سال مالی ۱۴۰۵', DATE '2026-03-21', DATE '2027-03-20', 'OPEN', now(), now()
FROM companies c
WHERE NOT EXISTS (SELECT 1 FROM fiscal_years f WHERE f.company_id = c.id AND f.code = '1405');

INSERT INTO fiscal_periods (id, fiscal_year_id, code, name_fa, start_date, end_date, status, created_at)
SELECT gen_random_uuid(), f.id, '1405-' || lpad(m::text, 2, '0'), 'ماه ' || lpad(m::text, 2, '0'),
       (f.start_date + ((m - 1) * interval '1 month'))::date,
       LEAST((f.start_date + (m * interval '1 month') - interval '1 day')::date, f.end_date),
       'OPEN', now()
FROM fiscal_years f
CROSS JOIN generate_series(1, 12) AS m
WHERE f.code = '1405'
  AND NOT EXISTS (SELECT 1 FROM fiscal_periods p WHERE p.fiscal_year_id = f.id);
