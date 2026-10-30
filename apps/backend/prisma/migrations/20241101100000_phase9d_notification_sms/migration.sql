-- Phase 9D: SMS center (templates + durable send log) and the SMS channel
-- policy on notification rules. Forward-only, applied to tcerp_test/CI only.

ALTER TABLE "notification_rules" ADD COLUMN "sms_config" JSONB;

CREATE TABLE "sms_templates" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name_fa" TEXT NOT NULL,
    "body_template" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- updated_at has NO database default: Prisma's @updatedAt sets it client-side.
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "sms_templates_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "sms_templates_company_id_code_key" ON "sms_templates"("company_id", "code");
ALTER TABLE "sms_templates" ADD CONSTRAINT "sms_templates_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Every outbound SMS is a durable row created AT ENQUEUE time (QUEUED) and
-- flipped by the sms.send handler (SENT / FAILED + provider response) — the
-- send report IS the log; resend = a fresh row.
CREATE TYPE "SmsMessageStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED');
CREATE TYPE "SmsMessageSource" AS ENUM ('AUTOMATION', 'NOTIFICATION_RULE', 'MANUAL');

CREATE TABLE "sms_messages" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "to" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "status" "SmsMessageStatus" NOT NULL DEFAULT 'QUEUED',
    "source" "SmsMessageSource" NOT NULL,
    "source_id" TEXT,
    "template_code" TEXT,
    "party_id" UUID,
    "error" TEXT,
    "provider_response" JSONB,
    "queued_job_id" UUID,
    "idempotency_key" TEXT NOT NULL,
    "requested_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ(6),
    CONSTRAINT "sms_messages_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "sms_messages_idempotency_key_key" ON "sms_messages"("idempotency_key");
CREATE INDEX "sms_messages_company_id_created_at_idx" ON "sms_messages"("company_id", "created_at");
CREATE INDEX "sms_messages_company_id_status_idx" ON "sms_messages"("company_id", "status");
ALTER TABLE "sms_messages" ADD CONSTRAINT "sms_messages_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
