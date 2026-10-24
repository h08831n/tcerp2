-- Phase 8 hardening: durable Moadian diagnostic sandbox-test runs.
CREATE TYPE "MoadianDiagnosticRunStatus" AS ENUM ('PREPARED', 'SUBMITTED', 'PENDING', 'SUCCESS', 'REJECTED', 'UNKNOWN');

CREATE TABLE "moadian_diagnostic_runs" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "run_day" TEXT NOT NULL,
    "uid" TEXT NOT NULL,
    "fiscal_id" TEXT NOT NULL,
    "status" "MoadianDiagnosticRunStatus" NOT NULL DEFAULT 'PREPARED',
    "reference_number" TEXT,
    "error_code" TEXT,
    "error_detail" TEXT,
    "confirmation_reference_id" TEXT,
    "tax_result" TEXT,
    "sent_at" TIMESTAMPTZ(6),
    "inquired_at" TIMESTAMPTZ(6),
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "moadian_diagnostic_runs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "moadian_diagnostic_runs_uid_key" ON "moadian_diagnostic_runs"("uid");
CREATE UNIQUE INDEX "moadian_diagnostic_runs_company_id_run_day_key" ON "moadian_diagnostic_runs"("company_id", "run_day");
CREATE INDEX "moadian_diagnostic_runs_company_id_status_idx" ON "moadian_diagnostic_runs"("company_id", "status");

ALTER TABLE "moadian_diagnostic_runs" ADD CONSTRAINT "moadian_diagnostic_runs_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
