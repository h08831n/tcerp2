-- CR-001: CRM pipeline completion (Odoo-style lead → opportunity → customer law).
--
-- 1. opportunities.lead_id: traceability of lead → opportunity conversion.
--    UNIQUE (nullable) = an idempotency guarantee: the SAME lead can never
--    produce two opportunities, even under concurrent convert requests.
--    ON DELETE SET NULL: archiving (hard-deleting) a lead must NOT destroy
--    the opportunity — the deal history survives, only the pointer goes.
-- 2. opportunities.expected_close_date: DATE (date-only) — the Kanban card's
--    «تاریخ احتمالی نهایی شدن». Date-only on purpose: no time, no timezone
--    shifting (R5-P1 policy — calendar dates are UTC-midnight anchored).
-- 3. LeadStatus += 'CONVERTED': a terminal lead state set by the explicit
--    convert operation. ADDITIVE only — no data rewritten.

-- ALTER TYPE ... ADD VALUE cannot run inside a transaction on some PG
-- versions; Prisma wraps migrations in a transaction, so it is placed FIRST
-- and guarded with IF NOT EXISTS (PG 16 allows it in-transaction as long as
-- the new value is not used in the same transaction — it is not).
ALTER TYPE "LeadStatus" ADD VALUE IF NOT EXISTS 'CONVERTED';

ALTER TABLE "opportunities" ADD COLUMN "lead_id" UUID;
ALTER TABLE "opportunities" ADD COLUMN "expected_close_date" DATE;

CREATE UNIQUE INDEX "opportunities_lead_id_key" ON "opportunities"("lead_id");
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_lead_id_fkey"
  FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "opportunities_expected_close_date_idx" ON "opportunities"("expected_close_date");
