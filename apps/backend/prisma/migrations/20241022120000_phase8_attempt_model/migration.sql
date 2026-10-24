-- Phase 8 third review: attempt-level model. The run becomes a day-scoped
-- aggregate; each send attempt is its own durable row with an immutable uid
-- (official retry rules: a rejected packet is resubmitted as a NEW packet
-- with retry=true — the old uid/history is never overwritten).
ALTER TABLE "moadian_diagnostic_runs" DROP COLUMN IF EXISTS "uid";
ALTER TABLE "moadian_diagnostic_runs" DROP COLUMN IF EXISTS "reference_number";
ALTER TABLE "moadian_diagnostic_runs" DROP COLUMN IF EXISTS "error_code";
ALTER TABLE "moadian_diagnostic_runs" DROP COLUMN IF EXISTS "error_detail";
ALTER TABLE "moadian_diagnostic_runs" DROP COLUMN IF EXISTS "confirmation_reference_id";
ALTER TABLE "moadian_diagnostic_runs" DROP COLUMN IF EXISTS "tax_result";
ALTER TABLE "moadian_diagnostic_runs" DROP COLUMN IF EXISTS "sent_at";
ALTER TABLE "moadian_diagnostic_runs" DROP COLUMN IF EXISTS "inquired_at";

CREATE TABLE "moadian_diagnostic_attempts" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "uid" TEXT NOT NULL,
    "retry" BOOLEAN NOT NULL DEFAULT false,
    "status" "MoadianDiagnosticRunStatus" NOT NULL DEFAULT 'PREPARED',
    "reference_number" TEXT,
    "error_code" TEXT,
    "error_detail" TEXT,
    "confirmation_reference_id" TEXT,
    "tax_result" TEXT,
    "payload_snapshot" JSONB NOT NULL,
    "sent_at" TIMESTAMPTZ(6),
    "inquired_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "moadian_diagnostic_attempts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "moadian_diagnostic_attempts_run_id_attempt_key" ON "moadian_diagnostic_attempts"("run_id", "attempt");
CREATE UNIQUE INDEX "moadian_diagnostic_attempts_uid_key" ON "moadian_diagnostic_attempts"("uid");
CREATE INDEX "moadian_diagnostic_attempts_company_id_status_idx" ON "moadian_diagnostic_attempts"("company_id", "status");

ALTER TABLE "moadian_diagnostic_attempts" ADD CONSTRAINT "moadian_diagnostic_attempts_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "moadian_diagnostic_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
