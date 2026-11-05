import { CanActivate, ExecutionContext, Injectable, Inject } from '@nestjs/common';
import { createHmac } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { UnauthorizedError, ForbiddenError } from '../common/errors';
import { AppConfig, CONFIG } from '../config/configuration';

export const PORTAL_SESSION_COOKIE = 'portal_session';

/**
 * Portal session guard (Gate D-2 Phase 1): validates the portal_session
 * cookie on EVERY /api/portal/* request. Checks:
 *   - session exists and not expired
 *   - PortalAccount.status is ACTIVE
 *   - Company.status is ACTIVE
 *   - Party is not archived
 * Attaches request.portalSession for the controller.
 */
@Injectable()
export class PortalAuthGuard implements CanActivate {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const raw = request.cookies?.[PORTAL_SESSION_COOKIE];
    if (!raw) {
      throw new UnauthorizedError('Portal session required');
    }

    const tokenHash = createHmac('sha256', this.config.JWT_SECRET).update(raw).digest('hex');
    const session = await this.prisma.portalSession.findUnique({
      where: { tokenHash },
      include: {
        portalAccount: {
          include: {
            company: { select: { id: true, status: true } },
          },
        },
      },
    });

    if (!session || session.expiresAt < new Date()) {
      throw new UnauthorizedError('Portal session expired');
    }

    const pa = session.portalAccount;
    if (pa.status !== 'ACTIVE') {
      throw new ForbiddenError('Portal account is not active');
    }
    if (pa.company.status !== 'ACTIVE') {
      throw new ForbiddenError('Company is not active');
    }

    // Party archived check via direct query (no Prisma relation on PortalAccount)
    const party = await this.prisma.party.findUnique({
      where: { id: pa.partyId },
      select: { archivedAt: true },
    });
    if (party?.archivedAt) {
      throw new ForbiddenError('Party is archived');
    }

    request.portalSession = {
      portalAccountId: pa.id,
      companyId: pa.companyId,
      partyId: pa.partyId,
      verifiedMobile: pa.verifiedMobile,
    };
    return true;
  }
}
