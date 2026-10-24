-- Phase 8 third/fourth review: attempt-level durable state machine. The run
-- becomes a day-scoped aggregate; each send attempt is its own durable row
-- with an immutable uid (a rejected packet is resubmitted as a NEW packet
-- with retry=true — the old uid/history is never overwritten).
--
-- DATA PRESERVATION (fourth review #2): every existing run identity and
-- result is copied into an equivalent attempt row BEFORE the obsolete run
-- columns are dropped — no diagnostic history is lost. Old-model semantics
-- carried over verbatim (same enum):
--   PREPARED  = identity persisted, submission not started -> resume-safe
--   SUBMITTED = packet sent, outcome unknown               -> inquire-only,
--              never resent (recovery anchor is the copied uid)
--   PENDING / SUCCESS / REJECTED / UNKNOWN copied as-is.
-- The old model persisted no payload snapshot, so migrated attempts carry an
-- empty snapshot; their recovery anchor is the copied uid/reference result.
-- DEPLOYMENT NOTE (fifth review): this migration is intentionally
-- self-contained (data copy BEFORE the drops) — the copy can never be a
-- follow-up migration because the source columns would already be gone.
-- Prisma never re-runs a recorded migration: an environment that applied the
-- pre-fix drop-only variant (commit db3c86b) has already lost the source
-- columns; that table is diagnostic-only (no business/tax data). Detection
-- for operators: compare _prisma_migrations.started_at of this migration
-- against the fix commit date (7daf814, 2026-10-24). Never edit an applied
-- migration again — forward migrations only.
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

-- copy the legacy per-run submission identity/result into attempt rows
-- BEFORE dropping the source columns (uid was NOT NULL on the old model, so
-- every existing run row is migrated)
INSERT INTO "moadian_diagnostic_attempts" (
    "id", "run_id", "company_id", "attempt", "uid", "retry", "status",
    "reference_number", "error_code", "error_detail",
    "confirmation_reference_id", "tax_result", "payload_snapshot",
    "sent_at", "inquired_at", "created_at", "updated_at"
)
SELECT
    gen_random_uuid(),
    r."id",
    r."company_id",
    1,
    r."uid",
    false,
    r."status",
    r."reference_number",
    r."error_code",
    r."error_detail",
    r."confirmation_reference_id",
    r."tax_result",
    '{}'::jsonb,
    r."sent_at",
    r."inquired_at",
    r."created_at",
    r."updated_at"
FROM "moadian_diagnostic_runs" r;

CREATE UNIQUE INDEX "moadian_diagnostic_attempts_run_id_attempt_key" ON "moadian_diagnostic_attempts"("run_id", "attempt");
CREATE UNIQUE INDEX "moadian_diagnostic_attempts_uid_key" ON "moadian_diagnostic_attempts"("uid");
CREATE INDEX "moadian_diagnostic_attempts_company_id_status_idx" ON "moadian_diagnostic_attempts"("company_id", "status");

ALTER TABLE "moadian_diagnostic_attempts" ADD CONSTRAINT "moadian_diagnostic_attempts_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "moadian_diagnostic_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- drop the obsolete run columns only AFTER the data above is preserved
ALTER TABLE "moadian_diagnostic_runs" DROP COLUMN IF EXISTS "uid";
ALTER TABLE "moadian_diagnostic_runs" DROP COLUMN IF EXISTS "reference_number";
ALTER TABLE "moadian_diagnostic_runs" DROP COLUMN IF EXISTS "error_code";
ALTER TABLE "moadian_diagnostic_runs" DROP COLUMN IF EXISTS "error_detail";
ALTER TABLE "moadian_diagnostic_runs" DROP COLUMN IF EXISTS "confirmation_reference_id";
ALTER TABLE "moadian_diagnostic_runs" DROP COLUMN IF EXISTS "tax_result";
ALTER TABLE "moadian_diagnostic_runs" DROP COLUMN IF EXISTS "sent_at";
ALTER TABLE "moadian_diagnostic_runs" DROP COLUMN IF EXISTS "inquired_at";
