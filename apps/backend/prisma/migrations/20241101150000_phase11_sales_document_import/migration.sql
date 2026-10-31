-- Phase 11 (Gate G slice 5): SALES_DOCUMENT import entity — legacy draft
-- documents imported with operator-provided numbers; the number is the dedupe
-- key and imported documents are NEVER updated (corrections go through the
-- document lifecycle).
ALTER TYPE "ImportEntityType" ADD VALUE 'SALES_DOCUMENT';
