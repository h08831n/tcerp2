import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ForbiddenError } from '../common/errors';

export interface CompanyMembership {
  companyId: string;
  /** True when companyId === users.default_company_id (single canonical source). */
  isDefault: boolean;
  nameFa: string;
}

type RequestHeaders = Record<string, string | string[] | undefined>;

function headerString(headers: RequestHeaders, name: string): string | undefined {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

/**
 * Resolves the active company for a request (REQUIREMENTS §26-27, multi-company):
 *   1. `x-company-id` header when present — the caller must be a member,
 *      otherwise ForbiddenError.
 *   2. the user's `defaultCompanyId` (validated membership).
 *   3. the user's first membership.
 *
 * Mini-Gate: UserCompany no longer carries isDefault — users.default_company_id
 * is the single canonical source of the default company.
 *
 * Scoped controllers/services call `requireCompanyId(user, headers)` at the
 * start of an operation; the resolved id is then passed down explicitly
 * (no hidden AsyncLocalStorage magic — every query stays auditable).
 */
@Injectable()
export class CompanyContextService {
  constructor(private readonly prisma: PrismaService) {}

  /** Resolved company id for the request; throws when the user has none. */
  async requireCompanyId(
    user: { id: string } | undefined,
    headers: RequestHeaders,
  ): Promise<string> {
    const id = await this.resolveCompanyId(user, headers);
    if (!id) {
      throw new ForbiddenError('User is not a member of any company', { userId: user?.id });
    }
    return id;
  }

  /** Like requireCompanyId but null for platform-level operations (e.g. queue). */
  async resolveCompanyId(
    user: { id: string } | undefined,
    headers: RequestHeaders,
  ): Promise<string | null> {
    if (!user) throw new ForbiddenError('Authentication required');

    const headerValue = headerString(headers, 'x-company-id');
    if (headerValue) {
      await this.assertMember(user.id, headerValue);
      return headerValue;
    }

    const memberships = await this.memberships(user.id);
    if (memberships.length === 0) return null;

    // defaultCompanyId wins only when the user is (still) a member.
    const def = memberships.find((m) => m.isDefault);
    return def ? def.companyId : memberships[0].companyId;
  }

  /**
   * Lenient resolution for the PermissionsGuard: never throws. The
   * x-company-id header is honoured only when the user is a member;
   * otherwise the user's default company (when still a member of it);
   * otherwise null — only platform-wide (companyId IS NULL) permission
   * overrides apply.
   */
  async resolveLenientCompanyId(
    user: { id: string } | undefined,
    headers: RequestHeaders,
  ): Promise<string | null> {
    if (!user) return null;

    const headerValue = headerString(headers, 'x-company-id');
    if (headerValue) {
      const member = await this.isMember(user.id, headerValue);
      if (member) return headerValue;
    }

    const row = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { defaultCompanyId: true },
    });
    if (row?.defaultCompanyId && (await this.isMember(user.id, row.defaultCompanyId))) {
      return row.defaultCompanyId;
    }
    return null;
  }

  /** Memberships of a user with company names (used by GET /auth/me). */
  async memberships(userId: string): Promise<CompanyMembership[]> {
    const [rows, user] = await Promise.all([
      this.prisma.userCompany.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
        select: {
          companyId: true,
          company: { select: { nameFa: true } },
        },
      }),
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { defaultCompanyId: true },
      }),
    ]);
    return rows.map((r) => ({
      companyId: r.companyId,
      isDefault: !!user && user.defaultCompanyId === r.companyId,
      nameFa: r.company.nameFa,
    }));
  }

  /** ForbiddenError unless the user is a member of the company. */
  async assertMember(userId: string, companyId: string): Promise<void> {
    const member = await this.prisma.userCompany.findUnique({
      where: { userId_companyId: { userId, companyId } },
      select: { userId: true },
    });
    if (!member) {
      throw new ForbiddenError('User is not a member of the requested company', {
        companyId,
      });
    }
  }

  /** Non-throwing membership probe. */
  async isMember(userId: string, companyId: string): Promise<boolean> {
    const member = await this.prisma.userCompany.findUnique({
      where: { userId_companyId: { userId, companyId } },
      select: { userId: true },
    });
    return !!member;
  }
}
