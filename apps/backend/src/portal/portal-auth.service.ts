import { Injectable, Logger } from '@nestjs/common';
import { randomBytes, randomInt, createHmac } from 'crypto';
import { SmsMessageSource } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppError, UnauthorizedError, ForbiddenError } from '../common/errors';
import { Inject } from '@nestjs/common';
import { AppConfig, CONFIG } from '../config/configuration';
import { SmsService } from '../notifications/sms.service';
import { normalizeIranMobile } from '../common/utils/phone';

export const PORTAL_OTP_TTL_MS = 2 * 60_000;
export const PORTAL_OTP_MAX_ATTEMPTS = 3;
export const PORTAL_SESSION_TTL_MS = 24 * 3_600_000;
export const PORTAL_PENDING_TTL_MS = 5 * 60_000;

/**
 * Portal OTP + Session infrastructure (Gate D-2 Phase 1).
 * OTP is HMAC-SHA256(JWT_SECRET, challengeId + code) — not plain sha256.
 * Consumption is atomic (updateMany CAS). Session selection is atomic.
 * No raw OTP, HMAC or session token is ever logged.
 *
 * D2-10: request-otp is MOBILE-ONLY (docs/15 API contract) — the account
 *        lookup is cross-company and one SMS carries the code; the response
 *        never discloses account/company existence.
 * D2-11: the rate limit (mobile 1/min + IP 10/hour by default) runs ATOMICALLY
 *        BEFORE the challenge row is created — a limited request leaves no
 *        challenge row behind.
 * D2-12: select-company consumes the pending token, validates the account/
 *        company/party and creates the session inside ONE transaction — a
 *        validation failure does NOT burn the one-time token.
 */
@Injectable()
export class PortalOtpService {
  private readonly logger = new Logger('PortalOtpService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly smsService: SmsService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  private hmac(data: string): string {
    return createHmac('sha256', this.config.JWT_SECRET).update(data).digest('hex');
  }

  private static otpRateLimited(): AppError {
    // 429 with a stable machine code — deliberately distinct from the
    // uniform INVALID_OTP responses so clients can back off.
    return new AppError(429, 'OTP_RATE_LIMITED', 'OTP_RATE_LIMITED');
  }

  async requestOtp(mobileInput: string, ip?: string): Promise<{ challengeId: string; sent: true }> {
    const mobile = normalizeIranMobile(mobileInput);
    const challengeId = crypto.randomUUID();
    const code = randomInt(100000, 999999).toString();
    const codeHmac = this.hmac(challengeId + code);
    const expiresAt = new Date(Date.now() + PORTAL_OTP_TTL_MS);

    // D2-11: atomic rate limit + challenge creation in ONE transaction.
    // Advisory locks are ALWAYS taken in the same order — mobile first, then
    // IP — so two concurrent requests (different mobiles, shared IP) cannot
    // deadlock, and the count-then-create pair cannot race on EITHER
    // dimension: a limited request throws BEFORE any row exists.
    await this.prisma.$transaction(async (trx) => {
      await trx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${mobile}))`;
      if (ip) {
        await trx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'ip:' + ip}))`;
      }
      const recentPerMinute = await trx.portalOtpCode.count({
        where: { mobile, createdAt: { gt: new Date(Date.now() - 60_000) } },
      });
      if (recentPerMinute >= this.config.PORTAL_OTP_MOBILE_PER_MINUTE) {
        throw PortalOtpService.otpRateLimited();
      }
      if (ip) {
        const perHourByIp = await trx.portalOtpCode.count({
          where: { ip, createdAt: { gt: new Date(Date.now() - 3_600_000) } },
        });
        if (perHourByIp >= this.config.PORTAL_OTP_IP_PER_HOUR) {
          throw PortalOtpService.otpRateLimited();
        }
      }
      // Resend contract (docs/17 §4): a fresh challenge invalidates every
      // previous unconsumed challenge for the same mobile — two live codes
      // can never coexist.
      await trx.portalOtpCode.updateMany({
        where: { mobile, consumed: false },
        data: { consumed: true },
      });
      await trx.portalOtpCode.create({
        data: { mobile, challengeId, codeHmac, expiresAt, ip: ip ?? null },
      });
    });

    // D2-10: the mobile may hold ACTIVE accounts in SEVERAL companies — the
    // OTP flow selects the company AFTER verification (docs/15). The SMS
    // content is company-agnostic, so one message via the oldest account's
    // company (its provider config) is enough. Company must be ACTIVE too —
    // a login that could never pass the guard must not receive a code.
    const account = await this.prisma.portalAccount.findFirst({
      where: { verifiedMobile: mobile, status: 'ACTIVE', company: { status: 'ACTIVE' } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, companyId: true },
    });
    if (account) {
      await this.smsService.enqueueSend(account.companyId, {
        to: mobile,
        text: `کد ورود: ${code}`,
        source: SmsMessageSource.PORTAL,
        idempotencyKey: `portal-otp:${challengeId}`,
      });
    }

    // Uniform response — account/company existence is never disclosed.
    return { challengeId, sent: true };
  }

  async verifyOtp(mobileInput: string, challengeId: string, code: string): Promise<{
    portalAccountIds: string[];
    pendingToken?: string;
    pendingOptions?: Array<{ portalAccountId: string; companyName: string }>;
    sessionToken?: string;
    companyId?: string;
    partyId?: string;
  }> {
    const mobile = normalizeIranMobile(mobileInput);
    const codeHmac = this.hmac(challengeId + code);
    const now = new Date();

    // Consumption and the resulting state (session OR pending selection) are
    // ONE transaction: if the account lookup or the session/pending insert
    // fails, the whole tx rolls back and the code stays usable — a failed
    // verify never burns the OTP (recovery = retry the same code).
    return this.prisma.$transaction(async (trx) => {
      // Atomic consumption: only ONE concurrent verify can succeed.
      const consumed = await trx.portalOtpCode.updateMany({
        where: {
          mobile,
          challengeId,
          codeHmac,
          consumed: false,
          attempts: { lt: PORTAL_OTP_MAX_ATTEMPTS },
          expiresAt: { gt: now },
        },
        data: { consumed: true },
      });
      if (consumed.count === 0) {
        // Increment attempts for wrong code (atomic)
        await trx.portalOtpCode.updateMany({
          where: { mobile, challengeId, consumed: false },
          data: { attempts: { increment: 1 } },
        });
        throw new UnauthorizedError('INVALID_OTP');
      }

      // Find ACTIVE PortalAccounts with this mobile (companies must be
      // ACTIVE — a session on a suspended company could never pass the
      // guard). A failure here rolls the consumption back.
      const accounts = await trx.portalAccount.findMany({
        where: { verifiedMobile: mobile, status: 'ACTIVE', company: { status: 'ACTIVE' } },
        select: { id: true, companyId: true, partyId: true, company: { select: { nameFa: true } } },
      });

      if (accounts.length === 0) {
        throw new UnauthorizedError('INVALID_OTP');
      }

      if (accounts.length === 1) {
        // Single account → direct ACTIVE_SESSION (raw token generated first —
        // its HMAC is stored; the raw value only ever leaves via Set-Cookie).
        const sessionToken = randomBytes(48).toString('hex');
        await trx.portalSession.create({
          data: {
            portalAccountId: accounts[0].id,
            tokenHash: this.hmac(sessionToken),
            expiresAt: new Date(Date.now() + PORTAL_SESSION_TTL_MS),
          },
        });
        return {
          portalAccountIds: [accounts[0].id],
          sessionToken,
        };
      }

      // Multiple accounts → PENDING_SELECTION with the SAFE options list
      // (D2-18: portalAccountId + company display name, nothing internal).
      const rawPending = randomBytes(48).toString('hex');
      const pendingHash = this.hmac(rawPending);
      await trx.portalPendingSelection.create({
        data: {
          tokenHash: pendingHash,
          portalAccountIds: accounts.map((a) => a.id),
          expiresAt: new Date(Date.now() + PORTAL_PENDING_TTL_MS),
        },
      });
      return {
        portalAccountIds: accounts.map((a) => a.id),
        pendingToken: rawPending,
        pendingOptions: accounts.map((a) => ({ portalAccountId: a.id, companyName: a.company.nameFa })),
      };
    });
  }

  async selectCompany(rawPendingToken: string, selectedPortalAccountId: string): Promise<{ sessionToken: string; companyId: string; partyId: string }> {
    const pendingHash = this.hmac(rawPendingToken);
    const now = new Date();

    // D2-12: token consumption + account validation + session creation are
    // ONE transaction. Any failure rolls the CAS back — the one-time token
    // survives so the customer can pick another company. Two concurrent
    // selects cannot both win the CAS (row lock → second sees consumed).
    return this.prisma.$transaction(async (trx) => {
      const consumed = await trx.portalPendingSelection.updateMany({
        where: { tokenHash: pendingHash, consumed: false, expiresAt: { gt: now } },
        data: { consumed: true },
      });
      if (consumed.count === 0) throw new UnauthorizedError('SELECTION_EXPIRED');

      const row = await trx.portalPendingSelection.findFirstOrThrow({
        where: { tokenHash: pendingHash },
      });

      // The selected account must be one of the verified whitelist entries.
      const allowed = row.portalAccountIds as string[];
      if (!allowed.includes(selectedPortalAccountId)) {
        throw new ForbiddenError('PORTAL_ACCOUNT_NOT_ALLOWED');
      }

      const account = await trx.portalAccount.findFirst({
        where: { id: selectedPortalAccountId, status: 'ACTIVE' },
        select: { id: true, companyId: true, partyId: true, company: { select: { status: true } } },
      });
      if (!account) {
        throw new ForbiddenError('PORTAL_ACCOUNT_SUSPENDED');
      }
      if (account.company.status !== 'ACTIVE') {
        throw new ForbiddenError('COMPANY_NOT_ACTIVE');
      }
      const party = await trx.party.findUnique({
        where: { id: account.partyId },
        select: { archivedAt: true },
      });
      if (!party || party.archivedAt) {
        throw new ForbiddenError('PARTY_ARCHIVED');
      }

      const raw = randomBytes(48).toString('hex');
      await trx.portalSession.create({
        data: {
          portalAccountId: account.id,
          tokenHash: this.hmac(raw),
          expiresAt: new Date(Date.now() + PORTAL_SESSION_TTL_MS),
        },
      });
      return { sessionToken: raw, companyId: account.companyId, partyId: account.partyId };
    });
  }

  /** Logout contract: the stored session row is revoked (deleted) so every
   *  copy of the cookie becomes invalid immediately. Idempotent. */
  async revokeSession(sessionId: string): Promise<void> {
    await this.prisma.portalSession.deleteMany({ where: { id: sessionId } });
  }
}
