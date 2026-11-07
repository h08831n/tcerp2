-- D-5: weighbridge (باسکول) recording on loadings — in/out gross weights and
-- the computed net, plus the ticket reference. Nullable: loadings without
-- weighbridge data behave exactly as before.
ALTER TABLE "loadings" ADD COLUMN "weighbridge_ticket_no" TEXT;
ALTER TABLE "loadings" ADD COLUMN "weighbridge_in_kg" DECIMAL(18,4);
ALTER TABLE "loadings" ADD COLUMN "weighbridge_out_kg" DECIMAL(18,4);
ALTER TABLE "loadings" ADD COLUMN "weighbridge_net_kg" DECIMAL(18,4);
ALTER TABLE "loadings" ADD COLUMN "weighbridge_at" TIMESTAMPTZ(6);
