import { Injectable } from '@nestjs/common';
import { PortalAccount, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit.dto';
import { ConflictError, NotFoundError } from '../common/errors';
import { RequestContext } from '../auth/auth.service';
import { CreatePortalAccountDto } from './portal.dto';

/**
 * Portal accounts (Mini-Gate #3): one verified mobile per company and one
 * website user per company. The (company_id, website_user_id) partial unique
 * index `portal_accounts_website_user_uniq` exists in the database (raw SQL,
 * invisible to Prisma); the same rule is enforced in the service so callers
 * get a typed ConflictError instead of a raw P2002.
 */
@Injectable()
export class PortalAccountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async list(companyId: string, status?: PortalAccount['status']): Promise<PortalAccount[]> {
    return this.prisma.portalAccount.findMany({
      where: { companyId, status },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getById(companyId: string, id: string): Promise<PortalAccount> {
    const account = await this.prisma.portalAccount.findUnique({ where: { id } });
    if (!account || account.companyId !== companyId) {
      throw new NotFoundError('Portal account not found', { id });
    }
    return account;
  }

  async create(
    companyId: string,
    dto: CreatePortalAccountDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<PortalAccount> {
    // Service-level uniqueness checks (the DB unique indexes stay the last
    // line of defence for concurrent races).
    const clashes = await this.prisma.portalAccount.findMany({
      where: {
        companyId,
        OR: [
          { verifiedMobile: dto.verifiedMobile },
          ...(dto.websiteUserId ? [{ websiteUserId: dto.websiteUserId }] : []),
        ],
      },
      select: { verifiedMobile: true, websiteUserId: true },
    });
    if (clashes.some((c) => c.verifiedMobile === dto.verifiedMobile)) {
      throw new ConflictError('PORTAL_LINK_EXISTS', { field: 'verifiedMobile' });
    }
    if (dto.websiteUserId && clashes.some((c) => c.websiteUserId === dto.websiteUserId)) {
      throw new ConflictError('PORTAL_LINK_EXISTS', { field: 'websiteUserId' });
    }

    let account: PortalAccount;
    try {
      account = await this.prisma.portalAccount.create({
        data: {
          companyId,
          partyId: dto.partyId,
          websiteUserId: dto.websiteUserId,
          verifiedMobile: dto.verifiedMobile,
          status: dto.status ?? 'PENDING',
        },
      });
    } catch (error) {
      // Lost a race against the unique indexes (companyId, verifiedMobile) or
      // the partial index (companyId, websiteUserId).
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictError('PORTAL_LINK_EXISTS', { companyId });
      }
      throw error;
    }

    await this.auditService.record({
      entityType: 'portal_account',
      entityId: account.id,
      action: AuditAction.CREATE,
      actor,
      companyId,
      newValues: {
        partyId: account.partyId,
        websiteUserId: account.websiteUserId,
        verifiedMobile: account.verifiedMobile,
        status: account.status,
      },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return account;
  }

  async remove(
    companyId: string,
    id: string,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<void> {
    const existing = await this.getById(companyId, id);
    await this.prisma.portalAccount.delete({ where: { id: existing.id } });
    await this.auditService.record({
      entityType: 'portal_account',
      entityId: id,
      action: AuditAction.DELETE,
      actor,
      companyId,
      oldValues: {
        partyId: existing.partyId,
        websiteUserId: existing.websiteUserId,
        verifiedMobile: existing.verifiedMobile,
      },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  }
}
