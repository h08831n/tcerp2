-- Mini-Gate migration (2026-10-06):
--   #1 Company-scoped role assignments (user_roles -> user_company_roles)
--   #2 default company canonical on users (user_companies.is_default dropped)
--   #3 portal_accounts partial unique on (company_id, website_user_id)
--   #4 tax_definitions.locked_at
--   #5 notifications.company_id + composite index
--   #6 queue idempotency scoped to (company_id, idempotency_key)
--   #8 files: filename moved from blob to attachment (per-upload metadata)

-- 1) user_company_roles before dropping user_roles (backfill global roles
--    into every company the user is a member of; users without membership
--    fall back to the default company).
CREATE TABLE "user_company_roles" (
    "user_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "assigned_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assigned_by" UUID,
    CONSTRAINT "user_company_roles_pkey" PRIMARY KEY ("user_id","company_id","role_id")
);
INSERT INTO "user_company_roles" ("user_id", "company_id", "role_id")
SELECT ur."user_id",
       COALESCE(uc."company_id", u."default_company_id",
                '00000000-0000-4000-8000-000000000001'::uuid),
       ur."role_id"
FROM "user_roles" ur
JOIN "users" u ON u."id" = ur."user_id"
LEFT JOIN "user_companies" uc ON uc."user_id" = ur."user_id"
ON CONFLICT ("user_id", "company_id", "role_id") DO NOTHING;

-- 2) user_companies: is_default dropped (users.default_company_id is canonical)
ALTER TABLE "user_companies" DROP COLUMN IF EXISTS "is_default";

-- 3) tax_definitions.locked_at
ALTER TABLE "tax_definitions" ADD COLUMN "locked_at" TIMESTAMPTZ(6);

-- 4) notifications company scope
ALTER TABLE "notifications" ADD COLUMN "company_id" UUID;
DROP INDEX IF EXISTS "notifications_user_id_status_created_at_idx";
CREATE INDEX "notifications_user_id_company_id_status_created_at_idx" ON "notifications"("user_id", "company_id", "status", "created_at");

-- 5) queue idempotency: company-scoped unique
DROP INDEX IF EXISTS "queue_jobs_idempotency_key_key";
CREATE UNIQUE INDEX "queue_jobs_company_id_idempotency_key_key" ON "queue_jobs"("company_id", "idempotency_key");

-- 6) files: metadata per attachment; blob keeps only content facts.
--    Backfill existing attachments from the blob filename; existing
--    attachments (dev data) attach to the default company.
ALTER TABLE "file_attachments" ADD COLUMN "company_id" UUID;
ALTER TABLE "file_attachments" ADD COLUMN "display_name" TEXT;
ALTER TABLE "file_attachments" ADD COLUMN "original_filename" TEXT;
UPDATE "file_attachments" fa
SET "company_id" = '00000000-0000-4000-8000-000000000001'::uuid,
    "original_filename" = fb."filename"
FROM "file_blobs" fb
WHERE fb."id" = fa."file_blob_id";
ALTER TABLE "file_attachments" ALTER COLUMN "company_id" SET NOT NULL;
ALTER TABLE "file_attachments" ALTER COLUMN "original_filename" SET NOT NULL;
ALTER TABLE "file_blobs" DROP COLUMN "filename";
CREATE INDEX "file_attachments_company_id_idx" ON "file_attachments"("company_id");

-- 7) user_permission_overrides: company scope (null = platform-wide)
ALTER TABLE "user_permission_overrides" DROP CONSTRAINT "user_permission_overrides_pkey";
ALTER TABLE "user_permission_overrides" ADD COLUMN "id" UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE "user_permission_overrides" ADD COLUMN "company_id" UUID;
ALTER TABLE "user_permission_overrides" ADD CONSTRAINT "user_permission_overrides_pkey" PRIMARY KEY ("id");
CREATE UNIQUE INDEX "user_permission_overrides_user_id_permission_id_company_id_key" ON "user_permission_overrides"("user_id", "permission_id", "company_id");

-- 8) FKs
ALTER TABLE "user_company_roles" ADD CONSTRAINT "user_company_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_company_roles" ADD CONSTRAINT "user_company_roles_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_company_roles" ADD CONSTRAINT "user_company_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_permission_overrides" ADD CONSTRAINT "user_permission_overrides_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "file_attachments" ADD CONSTRAINT "file_attachments_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 9) drop global role assignment (superseded by user_company_roles)
DROP TABLE IF EXISTS "user_roles";

-- 10) Mini-Gate #3: partial unique — one website user per company party
CREATE UNIQUE INDEX "portal_accounts_website_user_uniq"
ON "portal_accounts" ("company_id", "website_user_id")
WHERE "website_user_id" IS NOT NULL;
