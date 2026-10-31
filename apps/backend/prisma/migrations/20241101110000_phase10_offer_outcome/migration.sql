-- Phase 10 (Gate F slice 2): explicit supplier-offer outcome (WON/LOST) so
-- the win/loss report aggregates DECIDED facts, not inferences. Forward-only.
CREATE TYPE "OfferOutcome" AS ENUM ('WON', 'LOST');

ALTER TABLE "supplier_offers" ADD COLUMN "outcome" "OfferOutcome",
  ADD COLUMN "outcome_decided_at" TIMESTAMPTZ(6),
  ADD COLUMN "outcome_decided_by" UUID;
