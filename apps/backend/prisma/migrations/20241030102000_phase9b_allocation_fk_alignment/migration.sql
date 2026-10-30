-- Phase 9B alignment: the schema declares Purchase/SalesTaxInvoice relations
-- on the tax-invoice order-allocation tables (Phase 8 FK comments), but the
-- correction-gate migration created these tables without the physical FK
-- constraints. This forward-only migration aligns the database with the
-- declared model. Both reference columns are NOT NULL and invoice rows are
-- never hard-deleted, so RESTRICT matches the Prisma default it declares.
-- Constraint names are pre-truncated to fit PostgreSQL's 63-char identifier
-- limit exactly as Prisma expects them (a longer literal name would be
-- truncated by the server at a different point and read back as drift).
ALTER TABLE "sales_tax_invoice_order_allocations"
  ADD CONSTRAINT "sales_tax_invoice_order_allocations_sales_tax_invoice_id_fkey"
  FOREIGN KEY ("sales_tax_invoice_id") REFERENCES "sales_tax_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "purchase_tax_invoice_order_allocations"
  ADD CONSTRAINT "purchase_tax_invoice_order_allocations_purchase_tax_invoic_fkey"
  FOREIGN KEY ("purchase_tax_invoice_id") REFERENCES "purchase_tax_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
