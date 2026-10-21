-- Phase 8 audit: corrective/cancel/return invoices reference the original
-- invoice taxid (official header field irtaxid).
ALTER TABLE "sales_tax_invoices" ADD COLUMN "related_taxid" TEXT;
