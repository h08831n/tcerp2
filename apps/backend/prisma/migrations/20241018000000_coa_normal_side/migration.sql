-- Phase 7C: normalSide derived column on ChartOfAccount (ASSET/EXPENSE → DEBIT)
ALTER TABLE "chart_of_accounts" ADD COLUMN IF NOT EXISTS "normal_side" TEXT NOT NULL DEFAULT 'DEBIT';
UPDATE "chart_of_accounts" SET "normal_side" = 'CREDIT' WHERE "type" IN ('LIABILITY', 'EQUITY', 'REVENUE');
