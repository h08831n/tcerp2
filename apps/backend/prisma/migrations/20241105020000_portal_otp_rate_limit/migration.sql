-- D2-11: server-side rate limiting needs the client IP on every OTP
-- challenge (mobile 1/min + IP 10/hour, docs/15 §rate limit) and
-- (mobile, created_at) / (ip, created_at) indexes for the window counts.
ALTER TABLE "portal_otp_codes" ADD COLUMN "ip" TEXT;
CREATE INDEX "portal_otp_codes_mobile_created_at_idx" ON "portal_otp_codes"("mobile", "created_at");
CREATE INDEX "portal_otp_codes_ip_created_at_idx" ON "portal_otp_codes"("ip", "created_at");
