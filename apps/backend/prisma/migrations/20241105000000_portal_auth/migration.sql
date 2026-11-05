-- Gate D-2 Phase 1: Portal OTP + Session infrastructure
-- 3 NEW tables (additive, no changes to existing tables)

CREATE TABLE portal_otp_codes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mobile        VARCHAR(20) NOT NULL,
  challenge_id  UUID NOT NULL UNIQUE,
  code_hmac     CHAR(64) NOT NULL,
  attempts      INT DEFAULT 0,
  consumed      BOOLEAN DEFAULT FALSE,
  expires_at    TIMESTAMPTZ(6) NOT NULL,
  created_at    TIMESTAMPTZ(6) DEFAULT now()
);
CREATE INDEX idx_portal_otp_mobile ON portal_otp_codes(mobile, expires_at);

CREATE TABLE portal_pending_selections (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash         CHAR(64) NOT NULL UNIQUE,
  portal_account_ids UUID[] NOT NULL,
  consumed           BOOLEAN DEFAULT FALSE,
  expires_at         TIMESTAMPTZ(6) NOT NULL,
  created_at         TIMESTAMPTZ(6) DEFAULT now()
);

CREATE TABLE portal_sessions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash         CHAR(64) NOT NULL UNIQUE,
  portal_account_id  UUID NOT NULL REFERENCES portal_accounts(id),
  created_at         TIMESTAMPTZ(6) DEFAULT now(),
  expires_at         TIMESTAMPTZ(6) NOT NULL
);
CREATE INDEX idx_portal_sessions_account ON portal_sessions(portal_account_id, expires_at);
