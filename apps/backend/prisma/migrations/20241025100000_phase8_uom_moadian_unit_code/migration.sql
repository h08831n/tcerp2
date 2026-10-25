-- Phase 8 fifteenth review: the official Moadian payload's `mu` field is the
-- authority's unit CODE (RC_IITP.IS_V7.9 جدول ۲) — never the internal UOM
-- symbol. Nullable until the operator maps the UOM to its official code;
-- unmapped UOMs block tax-invoice submission (fail-safe).
ALTER TABLE "uoms" ADD COLUMN "moadian_unit_code" TEXT;
