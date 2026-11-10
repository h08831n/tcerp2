-- CORE-004: user self-profile — avatar URL field (additive). The URL points
-- at a file uploaded through the Files module (or any external URL); the
-- Header avatar renders it when present. No other identity fields change.
ALTER TABLE "users" ADD COLUMN "avatar_url" TEXT;
