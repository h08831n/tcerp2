-- Backlog: access-token revocation on password reset. tokenVersion is
-- embedded in the access-token JWT and compared per-request by JwtAuthGuard;
-- every password reset (admin API or operator CLI) increments it, so all
-- previously issued ACCESS tokens die immediately (refresh tokens were
-- already revoked on reset).
ALTER TABLE "users" ADD COLUMN "token_version" INTEGER NOT NULL DEFAULT 0;
