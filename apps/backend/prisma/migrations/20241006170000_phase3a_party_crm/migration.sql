-- CreateEnum
CREATE TYPE "PartyType" AS ENUM ('PERSON', 'COMPANY');

-- CreateEnum
CREATE TYPE "PartyRoleType" AS ENUM ('CUSTOMER', 'SUPPLIER', 'DRIVER', 'CARRIER', 'PARTNER');

-- CreateEnum
CREATE TYPE "PhoneKind" AS ENUM ('MOBILE', 'PHONE', 'FAX', 'WHATSAPP');

-- CreateEnum
CREATE TYPE "AddressType" AS ENUM ('MAIN', 'BILLING', 'SHIPPING', 'UNLOADING', 'OFFICE', 'WAREHOUSE', 'OTHER');

-- CreateEnum
CREATE TYPE "ScoreLevel" AS ENUM ('BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'VIP');

-- AlterTable
ALTER TABLE "user_permission_overrides" ALTER COLUMN "id" DROP DEFAULT;

-- CreateTable
CREATE TABLE "parties" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "type" "PartyType" NOT NULL,
    "name_fa" TEXT NOT NULL,
    "name_en" TEXT,
    "internal_code" TEXT,
    "registration_number" TEXT,
    "national_id" TEXT,
    "economic_code" TEXT,
    "postal_code" TEXT,
    "website" TEXT,
    "email" TEXT,
    "first_name" TEXT,
    "last_name" TEXT,
    "gender" TEXT,
    "birth_date" DATE,
    "national_code" TEXT,
    "owner_user_id" UUID,
    "notes" TEXT,
    "score" INTEGER,
    "score_level" "ScoreLevel",
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ(6),
    "archived_by" UUID,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "parties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "party_roles" (
    "id" UUID NOT NULL,
    "party_id" UUID NOT NULL,
    "role" "PartyRoleType" NOT NULL,
    "since" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,

    CONSTRAINT "party_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "party_phones" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "party_id" UUID NOT NULL,
    "kind" "PhoneKind" NOT NULL DEFAULT 'MOBILE',
    "raw_value" TEXT NOT NULL,
    "normalized_value" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "extension" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "party_phones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contacts" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "party_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "position" TEXT,
    "email" TEXT,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_phones" (
    "id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "kind" "PhoneKind" NOT NULL DEFAULT 'MOBILE',
    "raw_value" TEXT NOT NULL,
    "normalized_value" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "contact_phones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "addresses" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "party_id" UUID NOT NULL,
    "type" "AddressType" NOT NULL DEFAULT 'MAIN',
    "country" TEXT NOT NULL DEFAULT 'ایران',
    "province" TEXT,
    "city" TEXT,
    "postal_code" TEXT,
    "line" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_score_history" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "party_id" UUID NOT NULL,
    "score" INTEGER NOT NULL,
    "level" "ScoreLevel" NOT NULL,
    "metrics" JSONB NOT NULL,
    "computed_at" TIMESTAMPTZ(6) NOT NULL,
    "computed_by" UUID,
    "note" TEXT,

    CONSTRAINT "customer_score_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "financial_responsibilities" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "responsible_party_id" UUID NOT NULL,
    "member_party_id" UUID NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "financial_responsibilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "timeline_events" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "data" JSONB,
    "actor_type" TEXT NOT NULL DEFAULT 'USER',
    "actor_user_id" UUID,
    "visible" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "timeline_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "parties_company_id_name_fa_idx" ON "parties"("company_id", "name_fa");

-- CreateIndex
CREATE INDEX "parties_company_id_type_archived_at_idx" ON "parties"("company_id", "type", "archived_at");

-- CreateIndex
CREATE INDEX "parties_company_id_owner_user_id_idx" ON "parties"("company_id", "owner_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "parties_company_id_internal_code_key" ON "parties"("company_id", "internal_code");

-- CreateIndex
CREATE UNIQUE INDEX "parties_company_id_national_id_key" ON "parties"("company_id", "national_id");

-- CreateIndex
CREATE UNIQUE INDEX "parties_company_id_national_code_key" ON "parties"("company_id", "national_code");

-- CreateIndex
CREATE UNIQUE INDEX "party_roles_party_id_role_key" ON "party_roles"("party_id", "role");

-- CreateIndex
CREATE INDEX "party_phones_party_id_idx" ON "party_phones"("party_id");

-- CreateIndex
CREATE INDEX "party_phones_company_id_normalized_value_idx" ON "party_phones"("company_id", "normalized_value");

-- CreateIndex
CREATE INDEX "contacts_party_id_idx" ON "contacts"("party_id");

-- CreateIndex
CREATE INDEX "contact_phones_contact_id_idx" ON "contact_phones"("contact_id");

-- CreateIndex
CREATE INDEX "addresses_party_id_idx" ON "addresses"("party_id");

-- CreateIndex
CREATE INDEX "customer_score_history_party_id_computed_at_idx" ON "customer_score_history"("party_id", "computed_at");

-- CreateIndex
CREATE INDEX "financial_responsibilities_company_id_responsible_party_id_idx" ON "financial_responsibilities"("company_id", "responsible_party_id");

-- CreateIndex
CREATE UNIQUE INDEX "financial_responsibilities_company_id_responsible_party_id__key" ON "financial_responsibilities"("company_id", "responsible_party_id", "member_party_id");

-- CreateIndex
CREATE UNIQUE INDEX "financial_responsibilities_company_id_member_party_id_key" ON "financial_responsibilities"("company_id", "member_party_id");

-- CreateIndex
CREATE INDEX "timeline_events_entity_type_entity_id_created_at_idx" ON "timeline_events"("entity_type", "entity_id", "created_at");

-- CreateIndex
CREATE INDEX "timeline_events_company_id_created_at_idx" ON "timeline_events"("company_id", "created_at");

-- CreateIndex
CREATE INDEX "user_company_roles_company_id_role_id_idx" ON "user_company_roles"("company_id", "role_id");

-- AddForeignKey
ALTER TABLE "parties" ADD CONSTRAINT "parties_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parties" ADD CONSTRAINT "parties_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "party_roles" ADD CONSTRAINT "party_roles_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "party_phones" ADD CONSTRAINT "party_phones_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_phones" ADD CONSTRAINT "contact_phones_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_score_history" ADD CONSTRAINT "customer_score_history_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_responsibilities" ADD CONSTRAINT "financial_responsibilities_responsible_party_id_fkey" FOREIGN KEY ("responsible_party_id") REFERENCES "parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_responsibilities" ADD CONSTRAINT "financial_responsibilities_member_party_id_fkey" FOREIGN KEY ("member_party_id") REFERENCES "parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timeline_events" ADD CONSTRAINT "timeline_events_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Phase 3A: duplicate-detection support (REQUIREMENTS §4)
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "parties_name_fa_trgm_idx" ON "parties" USING gin ("name_fa" gin_trgm_ops);

-- Exact duplicate normalized mobile blocked per company (MOBILE only).
CREATE UNIQUE INDEX "parties_mobile_uniq"
ON "party_phones" ("company_id", "normalized_value")
WHERE "kind" = 'MOBILE';
