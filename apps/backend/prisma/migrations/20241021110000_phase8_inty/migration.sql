-- Phase 8 protocol correction: official header field inty (invoice TYPE:
-- 1=نوع اول, 2=نوع دوم, 3=نوع سوم) is independent of ins (subject).
ALTER TABLE "sales_tax_invoices" ADD COLUMN "inty" INTEGER NOT NULL DEFAULT 1;
