-- Phase 9A: generic Activity Engine (REQUIREMENTS §49) — attachable to any
-- important entity, created by USER or SYSTEM, company-scoped, audited.
-- Completed activities are locked for normal users; manager override is
-- permission-gated and audited (reason recorded).

CREATE TYPE "ActivityPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');
CREATE TYPE "ActivityStatus" AS ENUM ('PENDING', 'COMPLETED', 'CANCELLED');

CREATE TABLE "activity_types" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name_fa" TEXT NOT NULL,
    "color" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "activity_types_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "activities" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "type_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "related_entity_type" TEXT NOT NULL,
    "related_entity_id" UUID NOT NULL,
    "created_by_type" TEXT NOT NULL DEFAULT 'USER',
    "created_by_id" UUID,
    "assigned_to_id" UUID,
    "priority" "ActivityPriority" NOT NULL DEFAULT 'NORMAL',
    "scheduled_date" TIMESTAMPTZ(6),
    "due_date" TIMESTAMPTZ(6),
    "status" "ActivityStatus" NOT NULL DEFAULT 'PENDING',
    "completed_at" TIMESTAMPTZ(6),
    "completed_by_id" UUID,
    "last_override_by_id" UUID,
    "last_override_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "activities_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "activity_types_company_id_code_key" ON "activity_types"("company_id", "code");
CREATE INDEX "activity_types_company_id_active_idx" ON "activity_types"("company_id", "active");
CREATE INDEX "activities_company_id_assigned_to_id_status_due_date_idx" ON "activities"("company_id", "assigned_to_id", "status", "due_date");
CREATE INDEX "activities_company_id_related_entity_type_related_entity_id_idx" ON "activities"("company_id", "related_entity_type", "related_entity_id");
CREATE INDEX "activities_company_id_due_date_idx" ON "activities"("company_id", "due_date");

ALTER TABLE "activity_types" ADD CONSTRAINT "activity_types_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "activities" ADD CONSTRAINT "activities_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "activities" ADD CONSTRAINT "activities_type_id_fkey" FOREIGN KEY ("type_id") REFERENCES "activity_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "activities" ADD CONSTRAINT "activities_assigned_to_id_fkey" FOREIGN KEY ("assigned_to_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "activities" ADD CONSTRAINT "activities_completed_by_id_fkey" FOREIGN KEY ("completed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
