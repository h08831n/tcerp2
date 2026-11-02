-- R4-9 (final gate): idempotencyKey uniqueness was GLOBAL — the P2002
-- refetch could return ANOTHER company message (cross-company leak).
-- Company-scoped uniqueness: existing data is safe (the global unique
-- already guarantees no duplicate keys, so the composite add cannot fail).
DROP INDEX IF EXISTS "sms_messages_idempotency_key_key";
CREATE UNIQUE INDEX "sms_messages_company_id_idempotency_key_key" ON "sms_messages"("company_id", "idempotency_key");
