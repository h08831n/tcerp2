-- D-2 Phase 3 (final review): customer portal file visibility — DEFAULT DENY.
-- An attachment is visible in the customer portal ONLY when explicitly
-- marked customer_visible (by the uploading employee or a later toggle).
-- Internal attachments on the same documents stay invisible by default.
ALTER TABLE "file_attachments" ADD COLUMN "customer_visible" BOOLEAN NOT NULL DEFAULT FALSE;
