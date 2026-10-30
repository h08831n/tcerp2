-- Phase 9A correction gate: SYSTEM idempotency - (company_id, idempotency_key)
-- unique so a repeated automation key can never create a second activity,
-- enforced by the DB even under concurrent triggers. NULL = user-created.
ALTER TABLE "activities" ADD COLUMN "idempotency_key" TEXT;
CREATE UNIQUE INDEX "activities_company_id_idempotency_key_key" ON "activities"("company_id", "idempotency_key");
