import { Injectable, Logger } from '@nestjs/common';
import { randomBytes, randomInt, createHmac } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { UnauthorizedError, ForbiddenError, ValidationError } from '../common/errors';
import { Inject } from '@nestjs/common';
import { AppConfig, CONFIG } from '../config/configuration';
import { SmsService } from '../notifications/sms.service';

export const PORTAL_OTP_TTL_MS = 2 * 60_000;
export const PORTAL_OTP_MAX_ATTEMPTS = 3;
export const PORTAL_SESSION_TTL_MS = 24 * 3_600_000;
export const PORTAL_PENDING_TTL_MS = 5 * 60_000;

/**
 * Portal OTP + Session infrastructure (Gate D-2 Phase 1).
 * OTP is HMAC-SHA256(JWT_SECRET, challengeId + code) — not plain sha256.
 * Consumption is atomic (updateMany CAS). Session selection is atomic.
 * No raw OTP, HMAC or session token is ever logged.
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

  async requestOtp(mobile: string, companyId: string): Promise<{ challengeId: string }> {
    const challengeId = crypto.randomUUID();
    const code = randomInt(100000, 999999).toString();
    const codeHmac = this.hmac(challengeId + code);
    const expiresAt = new Date(Date.now() + PORTAL_OTP_TTL_MS);

    await this.prisma.portalOtpCode.create({
      data: { mobile, challengeId, codeHmac, expiresAt },
    });

    // Rate limit: 1 per minute per mobile (enforced by DB query below).
    const recentCount = await this.prisma.portalOtpCode.count({
      where: {
        mobile,
        createdAt: { gt: new Date(Date.now() - 60_000) },
      },
    });
    if (recentCount > 2) {
      throw new ValidationError('OTP_RATE_LIMITED');
    }

    const account = await this.prisma.portalAccount.findFirst({
      where: { companyId, verifiedMobile: mobile, status: 'ACTIVE' },
      select: { id: true },
    });
    if (!account) {
      // Uniform response — no enumeration
      return { challengeId };
    }

    // Send SMS via the existing SmsService (enqueueSend is durable)
    await this.smsService.enqueueSend(companyId, {
      to: mobile,
      text: `کد ورود: ${code}`,
      source: 'PORTAL',
      idempotencyKey: `portal-otp:${challengeId}`,
    } as never);

    return { challengeId };
  }

  async verifyOtp(mobile: string, challengeId: string, code: string): Promise<{
    portalAccountIds: string[];
    pendingToken?: string;
    sessionToken?: string;
    companyId?: string;
    partyId?: string;
  }> {
    const codeHmac = this.hmac(challengeId + code);
    const now = new Date();

    // Atomic consumption: only ONE concurrent verify can succeed.
    const consumed = await this.prisma.portalOtpCode.updateMany({
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
      await this.prisma.portalOtpCode.updateMany({
        where: { mobile, challengeId, consumed: false },
        data: { attempts: { increment: 1 } },
      });
      throw new UnauthorizedError('INVALID_OTP');
    }

    // Find ACTIVE PortalAccounts with this mobile
    const accounts = await this.prisma.portalAccount.findMany({
      where: { verifiedMobile: mobile, status: 'ACTIVE' },
      select: { id: true, companyId: true, partyId: true },
    });

    if (accounts.length === 0) {
      throw new UnauthorizedError('INVALID_OTP');
    }

    if (accounts.length === 1) {
      // Single account → direct ACTIVE_SESSION
      const sessionToken = await this.createSession(accounts[0].id);
      return { portalAccountIds: [accounts[0].id], pendingToken: undefined, sessionToken };
    }

    // Multiple accounts → PENDING_SELECTION
    const rawPending = randomBytes(48).toString('hex');
    const pendingHash = this.hmac(rawPending);
    await this.prisma.portalPendingSelection.create({
      data: {
        tokenHash: pendingHash,
        portalAccountIds: accounts.map((a) => a.id),
        expiresAt: new Date(Date.now() + PORTAL_PENDING_TTL_MS),
      },
    });
    return { portalAccountIds: accounts.map((a) => a.id), pendingToken: rawPending };
  }

  async selectCompany(rawPendingToken: string, selectedPortalAccountId: string): Promise<{ sessionToken: string; companyId: string; partyId: string }> {
    const pendingHash = this.hmac(rawPendingToken);
    const now = new Date();

    // Atomic consumption of the pending selection (one-time CAS)
    const pending = await this.prisma.$transaction(async (trx) => {
      const consumed = await trx.portalPendingSelection.updateMany({
        where: { tokenHash: pendingHash, consumed: false, expiresAt: { gt: now } },
        data: { consumed: true },
      });
      if (consumed.count === 0) throw new UnauthorizedError('SELECTION_EXPIRED');

      const row = await trx.portalPendingSelection.findFirstOrThrow({
        where: { tokenHash: pendingHash },
      });

      // Validate the selected account is in the whitelist
      const allowed = row.portalAccountIds as string[];
      if (!allowed.includes(selectedPortalAccountId)) {
        throw new ForbiddenError('PORTAL_ACCOUNT_NOT_ALLOWED');
      }

      return row;
    });

    // Validate the selected account is ACTIVE
    const account = await this.prisma.portalAccount.findFirstOrThrow({
      where: { id: selectedPortalAccountId, status: 'ACTIVE' },
      select: { id: true, companyId: true, partyId: true },
    });

    const sessionToken = await this.createSession(account.id);
    return {
      sessionToken,
      companyId: account.companyId,
      partyId: account.partyId,
    };
  }

  private async createSession(portalAccountId: string): Promise<string> {
    const raw = randomBytes(48).toString('hex');
    await this.prisma.portalSession.create({
      data: {
        portalAccountId,
        tokenHash: this.hmac(raw),
        expiresAt: new Date(Date.now() + PORTAL_SESSION_TTL_MS),
      },
    });
    return raw;
  }
}
