-- Phase 11 (Gate G slice 4): PRODUCT_VARIANT import entity — variants are
-- imported INTO an EXISTING template identified by code; sku (company-unique)
-- is the natural upsert key.
ALTER TYPE "ImportEntityType" ADD VALUE 'PRODUCT_VARIANT';
