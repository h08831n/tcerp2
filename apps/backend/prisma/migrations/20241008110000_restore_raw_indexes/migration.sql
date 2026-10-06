-- Restore raw pg_trgm/support indexes that the diff-based phase-4 migration
-- briefly dropped (Prisma cannot see raw SQL indexes). Idempotent.
CREATE INDEX IF NOT EXISTS "parties_name_fa_trgm_idx" ON "parties" USING gin ("name_fa" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "brands_name_fa_trgm_idx" ON "brands" USING gin ("name_fa" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "product_templates_name_fa_trgm_idx" ON "product_templates" USING gin ("name_fa" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "contact_phones_normalized_value_idx" ON "contact_phones" ("normalized_value");
