-- Phase 3A corrections (#6): PostgreSQL NULL-distinct semantics mean the
-- composite unique (user_id, permission_id, company_id) does NOT enforce a
-- single platform-wide override when company_id IS NULL. Same for queue
-- platform jobs. Partial unique indexes close both gaps at the DB level.

-- Only one platform-wide override per (user, permission).
CREATE UNIQUE INDEX "user_permission_overrides_platform_uniq"
ON "user_permission_overrides" ("user_id", "permission_id")
WHERE "company_id" IS NULL;

-- Only one platform-level queue job per idempotency key.
CREATE UNIQUE INDEX "queue_jobs_platform_idempotency_uniq"
ON "queue_jobs" ("idempotency_key")
WHERE "company_id" IS NULL;
