-- Phase 11 (Gate G slice 2): DAILY_PRICE import entity — the daily price's
-- (company, variant, date, uom) unique is the natural upsert key.
ALTER TYPE "ImportEntityType" ADD VALUE 'DAILY_PRICE';
