import { Injectable } from '@nestjs/common';
import { Party, PartyRoleType, PhoneKind, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit.dto';
import { RequestContext } from '../auth/auth.service';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../common/errors';
import { Paginated } from '../common/dto/pagination.dto';
import { normalizeIranMobile, normalizePhone } from '../common/utils/phone';
import { normalizePersianName } from '../common/utils/persian-name';
import { assertInScope, RecordScope, scopeWhere } from './party-scope';
import { TimelineService } from './timeline.service';
import {
  AddPartyPhoneDto,
  AddRoleDto,
  AssignOwnerDto,
  CheckDuplicateDto,
  CreateAddressDto,
  CreateContactDto,
  CreatePartyDto,
  PartyQueryDto,
  UpdateAddressDto,
  UpdateContactDto,
  UpdatePartyDto,
} from './parties.dto';

type Client = PrismaService | Prisma.TransactionClient;

/** Record-scope actor context resolved by the controller per request. */
export interface ActorScope {
  userId: string;
  scope: RecordScope;
}

export interface SimilarNameCandidate {
  partyId: string;
  nameFa: string;
  similarity: number;
}

/** pg_trgm similar-name gate (REQUIREMENTS §4): warning only, never blocks. */
export const SIMILAR_NAME_THRESHOLD = 0.85;

interface SimilarNameRow {
  id: string;
  name_fa: string;
  similarity: number | string;
}

const LIST_SELECT = {
  id: true,
  companyId: true,
  type: true,
  nameFa: true,
  nameEn: true,
  internalCode: true,
  score: true,
  scoreLevel: true,
  ownerUserId: true,
  owner: { select: { id: true, username: true, firstName: true, lastName: true } },
  version: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.PartySelect;

const DETAIL_SELECT = {
  ...LIST_SELECT,
  nationalId: true,
  nationalCode: true,
  economicCode: true,
  registrationNumber: true,
  postalCode: true,
  website: true,
  email: true,
  firstName: true,
  lastName: true,
  gender: true,
  birthDate: true,
  notes: true,
  createdBy: true,
  roles: { select: { id: true, role: true, since: true, notes: true } },
  phones: {
    select: {
      id: true,
      kind: true,
      rawValue: true,
      normalizedValue: true,
      isPrimary: true,
      extension: true,
      notes: true,
      createdAt: true,
    },
  },
  contacts: {
    select: {
      id: true,
      name: true,
      position: true,
      email: true,
      isPrimary: true,
      notes: true,
      phones: {
        select: { id: true, kind: true, rawValue: true, normalizedValue: true, isPrimary: true },
      },
    },
  },
  addresses: {
    select: {
      id: true,
      type: true,
      country: true,
      province: true,
      city: true,
      postalCode: true,
      line: true,
      isPrimary: true,
      createdAt: true,
    },
  },
} satisfies Prisma.PartySelect;

export interface PhoneInput {
  kind: PhoneKind;
  value: string;
  isPrimary?: boolean;
  extension?: string;
  notes?: string;
}

/** Normalize one phone input into the persisted row shape. */
export function toPhoneRow(input: PhoneInput): {
  kind: PhoneKind;
  rawValue: string;
  normalizedValue: string;
  isPrimary: boolean;
  extension?: string;
  notes?: string;
} {
  return {
    kind: input.kind,
    rawValue: input.value,
    normalizedValue: normalizePhone(input.kind, input.value),
    isPrimary: input.isPrimary ?? false,
    extension: input.extension,
    notes: input.notes,
  };
}

/**
 * Map a P2002 unique violation to a domain ConflictError whose message is a
 * stable token (e.g. `DUPLICATE_PHONE`); null when the error is not a
 * mapped unique violation.
 */
export function mapUniqueViolation(
  error: unknown,
  targetOf: (target: string) => { token: string; details?: unknown } | null,
): Error | null {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    const raw = error.meta?.target;
    const target = Array.isArray(raw) ? raw.join(',') : String(raw ?? '');
    const mapped = targetOf(target);
    if (mapped) {
      return new ConflictError(mapped.token, {
        target,
        ...(mapped.details && typeof mapped.details === 'object' ? mapped.details : {}),
      });
    }
  }
  return null;
}

/**
 * Party / CRM core (Phase 3A). Every operation is company-scoped (the
 * controller resolves companyId through CompanyContextService), record-scope
 * filtered (OWN/TEAM/ALL) and audited; party mutations are optimistic-locked
 * on the `version` column.
 */
@Injectable()
export class PartiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly timeline: TimelineService,
  ) {}

  // ─────────────────────── scope helpers ───────────────────────

  /** User ids sharing a team with `userId` (TEAM scope). */
  async teamUserIds(userId: string): Promise<string[]> {
    const memberships = await this.prisma.teamMember.findMany({
      where: { userId },
      select: { teamId: true },
    });
    if (memberships.length === 0) return [];
    const rows = await this.prisma.teamMember.findMany({
      where: { teamId: { in: memberships.map((m) => m.teamId) } },
      select: { userId: true },
    });
    return [...new Set(rows.map((r) => r.userId))];
  }

  private async teamIdsFor(actorScope: ActorScope): Promise<string[]> {
    return actorScope.scope === 'TEAM' ? this.teamUserIds(actorScope.userId) : [];
  }

  private assertScope(
    actorScope: ActorScope,
    teamIds: string[],
    party: { id: string; ownerUserId: string | null },
  ): void {
    assertInScope(actorScope.scope, actorScope.userId, teamIds, party);
  }

  // ─────────────────────── duplicate detection ───────────────────────

  /**
   * Exact duplicate check for normalized MOBILE numbers inside the company.
   * Mirrors the partial unique index `parties_mobile_uniq`; throws
   * ConflictError `DUPLICATE_PHONE` with the offending partyId.
   */
  static async assertNoDuplicateMobile(
    client: Client,
    companyId: string,
    phones: PhoneInput[],
    excludePartyId?: string,
  ): Promise<string[]> {
    const mobiles = [
      ...new Set(
        phones
          .filter((p) => p.kind === 'MOBILE')
          .map((p) => normalizeIranMobile(p.value)),
      ),
    ];
    if (mobiles.length === 0) return [];
    const existing = await client.partyPhone.findFirst({
      where: {
        companyId,
        kind: 'MOBILE',
        normalizedValue: { in: mobiles },
        ...(excludePartyId ? { partyId: { not: excludePartyId } } : {}),
      },
      select: { partyId: true, normalizedValue: true },
    });
    if (existing) {
      throw new ConflictError('DUPLICATE_PHONE', {
        partyId: existing.partyId,
        mobile: existing.normalizedValue,
      });
    }
    return mobiles;
  }

  /**
   * Similar-name candidates via pg_trgm `similarity() >= 0.85` (the `%`
   * operator lets the planner use the `parties_name_fa_trgm_idx` GIN index).
   * Excludes self and archived parties. Parameter-bound ($queryRaw) — no
   * string interpolation.
   */
  async findSimilarNames(
    companyId: string,
    nameFa: string,
    excludePartyId?: string,
  ): Promise<SimilarNameCandidate[]> {
    const normalized = normalizePersianName(nameFa);
    if (!normalized) return [];

    let conditions = Prisma.sql`company_id = ${companyId}::uuid AND archived_at IS NULL AND name_fa % ${normalized} AND similarity(name_fa, ${normalized}) >= ${SIMILAR_NAME_THRESHOLD}`;
    if (excludePartyId) {
      conditions = Prisma.sql`${conditions} AND id <> ${excludePartyId}::uuid`;
    }
    const rows = await this.prisma.$queryRaw<SimilarNameRow[]>(
      Prisma.sql`SELECT id, name_fa, similarity(name_fa, ${normalized}) AS similarity
                 FROM parties
                 WHERE ${conditions}
                 ORDER BY similarity DESC, name_fa ASC
                 LIMIT 10`,
    );
    return rows.map((r) => ({
      partyId: r.id,
      nameFa: r.name_fa,
      similarity: Number(r.similarity),
    }));
  }

  /** POST /parties/check-duplicate — exact mobile match + similar names. */
  async checkDuplicate(
    companyId: string,
    dto: CheckDuplicateDto,
  ): Promise<{
    exact?: { partyId: string; nameFa: string; mobile: string };
    similar: SimilarNameCandidate[];
  }> {
    let exact: { partyId: string; nameFa: string; mobile: string } | undefined;
    if (dto.mobile) {
      const normalized = normalizeIranMobile(dto.mobile);
      const row = await this.prisma.partyPhone.findFirst({
        where: {
          companyId,
          kind: 'MOBILE',
          normalizedValue: normalized,
          ...(dto.excludePartyId ? { partyId: { not: dto.excludePartyId } } : {}),
        },
        select: { partyId: true, normalizedValue: true, party: { select: { nameFa: true } } },
      });
      if (row) {
        exact = { partyId: row.partyId, nameFa: row.party.nameFa, mobile: row.normalizedValue };
      }
    }
    const similar = dto.nameFa
      ? await this.findSimilarNames(companyId, dto.nameFa, dto.excludePartyId)
      : [];
    return { exact, similar };
  }

  // ─────────────────────── CRUD ───────────────────────

  async list(
    companyId: string,
    actorScope: ActorScope,
    query: PartyQueryDto,
  ): Promise<Paginated<Partial<Party>>> {
    const teamIds = await this.teamIdsFor(actorScope);
    const where: Prisma.PartyWhereInput = {
      companyId,
      ...scopeWhere(actorScope.scope, actorScope.userId, teamIds),
      ...(query.type ? { type: query.type } : {}),
      ...(query.role ? { roles: { some: { role: query.role } } } : {}),
      ...(query.ownerUserId ? { ownerUserId: query.ownerUserId } : {}),
      ...(query.scoreLevel ? { scoreLevel: query.scoreLevel } : {}),
      ...(query.archived ? { archivedAt: { not: null } } : { archivedAt: null }),
      ...(query.search ? this.searchWhere(query.search) : {}),
    };
    const sortField = ['nameFa', 'createdAt', 'score'].includes(query.sortBy ?? '')
      ? (query.sortBy as 'nameFa' | 'createdAt' | 'score')
      : 'createdAt';
    const [items, total] = await Promise.all([
      this.prisma.party.findMany({
        where,
        select: LIST_SELECT,
        orderBy: { [sortField]: query.sortDir },
        skip: query.skip,
        take: query.take,
      }),
      this.prisma.party.count({ where }),
    ]);
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  private searchWhere(search: string): Prisma.PartyWhereInput {
    const clauses: Prisma.PartyWhereInput[] = [
      { nameFa: { contains: search, mode: 'insensitive' as const } },
      { nameEn: { contains: search, mode: 'insensitive' as const } },
      { internalCode: { contains: search, mode: 'insensitive' as const } },
    ];
    let normalizedMobile: string | null = null;
    try {
      normalizedMobile = normalizeIranMobile(search);
    } catch {
      normalizedMobile = null;
    }
    if (normalizedMobile) {
      clauses.push({ phones: { some: { normalizedValue: { in: [normalizedMobile] } } } });
    } else {
      const stripped = search.replace(/[\s\-().\u200c]/g, '');
      if (stripped) {
        clauses.push({ phones: { some: { normalizedValue: { contains: stripped } } } });
      }
    }
    return { OR: clauses };
  }

  async getById(companyId: string, actorScope: ActorScope, id: string) {
    const teamIds = await this.teamIdsFor(actorScope);
    const party = await this.prisma.party.findUnique({
      where: { id },
      select: DETAIL_SELECT,
    });
    if (!party || party.companyId !== companyId) {
      throw new NotFoundError('Party not found', { id });
    }
    this.assertScope(actorScope, teamIds, party);
    return party;
  }

  async create(
    companyId: string,
    dto: CreatePartyDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<{ party: Party; warnings: SimilarNameCandidate[] }> {
    const phoneRows = (dto.phones ?? []).map(toPhoneRow);
    const primaryCount = phoneRows.filter((p) => p.isPrimary).length;
    if (primaryCount > 1) {
      throw new ValidationError('At most one primary phone is allowed', { primaryCount });
    }
    // Exact duplicates are blocked; similar names are WARNING ONLY.
    await PartiesService.assertNoDuplicateMobile(
      this.prisma,
      companyId,
      (dto.phones ?? []).map((p) => ({
        kind: p.kind,
        value: p.value,
        isPrimary: p.isPrimary,
        extension: p.extension,
        notes: p.notes,
      })),
    );
    const warnings = dto.nameFa ? await this.findSimilarNames(companyId, dto.nameFa) : [];

    const ownerUserId = dto.ownerUserId ?? actor.id;
    const owner = await this.prisma.user.findUnique({
      where: { id: ownerUserId },
      select: { id: true },
    });
    if (!owner) {
      throw new ValidationError('Owner user not found', { ownerUserId });
    }

    const roles = [...new Set(dto.roles ?? [])];

    let party: Party;
    try {
      party = await this.prisma.$transaction(async (trx) => {
        const created = await trx.party.create({
          data: {
            company: { connect: { id: companyId } },
            owner: { connect: { id: ownerUserId } },
            type: dto.type,
            nameFa: dto.nameFa.trim(),
            nameEn: dto.nameEn,
            internalCode: dto.internalCode,
            registrationNumber: dto.registrationNumber,
            nationalId: dto.nationalId,
            economicCode: dto.economicCode,
            postalCode: dto.postalCode,
            website: dto.website,
            email: dto.email,
            firstName: dto.firstName,
            lastName: dto.lastName,
            gender: dto.gender,
            birthDate: dto.birthDate ? new Date(dto.birthDate) : undefined,
            nationalCode: dto.nationalCode,
            notes: dto.notes,
            createdBy: actor.id,
            roles: roles.length ? { create: roles.map((role) => ({ role })) } : undefined,
            phones: phoneRows.length
              ? { create: phoneRows.map((p) => ({ ...p, companyId })) }
              : undefined,
          },
        });
        await this.timeline.record(trx, {
          companyId,
          entityType: 'PARTY',
          entityId: created.id,
          type: 'PARTY_CREATED',
          title: 'ایجاد طرف حساب',
          description: created.nameFa,
          data: { partyId: created.id, type: created.type, roles },
          actorUserId: actor.id,
        });
        return created;
      });
    } catch (error) {
      const mapped = mapUniqueViolation(error, (target) => {
        if (target.includes('normalized_value') || target.includes('parties_mobile_uniq')) {
          return { token: 'DUPLICATE_PHONE', details: { companyId } };
        }
        if (target.includes('internal_code')) {
          return { token: 'DUPLICATE_INTERNAL_CODE', details: { companyId } };
        }
        if (target.includes('national_id')) {
          return { token: 'DUPLICATE_NATIONAL_ID', details: { companyId } };
        }
        if (target.includes('national_code')) {
          return { token: 'DUPLICATE_NATIONAL_CODE', details: { companyId } };
        }
        return null;
      });
      throw mapped ?? error;
    }

    await this.auditService.record({
      entityType: 'party',
      entityId: party.id,
      action: AuditAction.CREATE,
      actor,
      companyId,
      newValues: {
        type: party.type,
        nameFa: party.nameFa,
        roles,
        phones: phoneRows.map((p) => ({ kind: p.kind, normalizedValue: p.normalizedValue })),
        ownerUserId,
      },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return { party, warnings };
  }

  async update(
    companyId: string,
    actorScope: ActorScope,
    id: string,
    dto: UpdatePartyDto,
    opts: { canChangeOwner: boolean },
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    const teamIds = await this.teamIdsFor(actorScope);
    const oldParty = await this.prisma.party.findUnique({ where: { id } });
    if (!oldParty || oldParty.companyId !== companyId) {
      throw new NotFoundError('Party not found', { id });
    }
    this.assertScope(actorScope, teamIds, oldParty);
    if (oldParty.version !== dto.version) {
      throw new ConflictError('VERSION_CONFLICT', {
        id,
        expectedVersion: oldParty.version,
        receivedVersion: dto.version,
      });
    }

    let ownerChanged = false;
    let newOwnerUserId: string | null | undefined;
    const data: Prisma.PartyUpdateManyMutationInput = {};
    if (dto.nameFa !== undefined) data.nameFa = dto.nameFa.trim();
    if (dto.nameEn !== undefined) data.nameEn = dto.nameEn;
    if (dto.internalCode !== undefined) data.internalCode = dto.internalCode;
    if (dto.registrationNumber !== undefined) data.registrationNumber = dto.registrationNumber;
    if (dto.nationalId !== undefined) data.nationalId = dto.nationalId;
    if (dto.economicCode !== undefined) data.economicCode = dto.economicCode;
    if (dto.postalCode !== undefined) data.postalCode = dto.postalCode;
    if (dto.website !== undefined) data.website = dto.website;
    if (dto.email !== undefined) data.email = dto.email;
    if (dto.firstName !== undefined) data.firstName = dto.firstName;
    if (dto.lastName !== undefined) data.lastName = dto.lastName;
    if (dto.gender !== undefined) data.gender = dto.gender;
    if (dto.birthDate !== undefined) {
      data.birthDate = dto.birthDate ? new Date(dto.birthDate) : null;
    }
    if (dto.nationalCode !== undefined) data.nationalCode = dto.nationalCode;
    if (dto.notes !== undefined) data.notes = dto.notes;
    if (dto.ownerUserId !== undefined && dto.ownerUserId !== oldParty.ownerUserId) {
      if (!opts.canChangeOwner) {
        throw new ForbiddenError('Changing the party owner requires parties.owner.change', {
          id,
        });
      }
      if (dto.ownerUserId === null) {
        newOwnerUserId = null;
      } else {
        const owner = await this.prisma.user.findUnique({
          where: { id: dto.ownerUserId },
          select: { id: true },
        });
        if (!owner) {
          throw new ValidationError('Owner user not found', { ownerUserId: dto.ownerUserId });
        }
        newOwnerUserId = dto.ownerUserId;
      }
      ownerChanged = true;
    }

    try {
      await this.prisma.$transaction(async (trx) => {
        const updated = await trx.party.updateMany({
          where: { id, version: dto.version },
          data: { ...data, version: dto.version + 1 },
        });
        if (updated.count !== 1) {
          throw new ConflictError('VERSION_CONFLICT', { id });
        }
        if (ownerChanged) {
          // ownerUserId is a relation — connect/disconnect after the guarded
          // updateMany claimed the version.
          await trx.party.update({
            where: { id },
            data: {
              owner:
                newOwnerUserId === null
                  ? { disconnect: true }
                  : { connect: { id: newOwnerUserId } },
            },
          });
          await this.timeline.record(trx, {
            companyId,
            entityType: 'PARTY',
            entityId: id,
            type: 'OWNER_CHANGED',
            title: 'تغییر مالک طرف حساب',
            description: oldParty.nameFa,
            data: {
              partyId: id,
              oldOwnerUserId: oldParty.ownerUserId,
              newOwnerUserId,
            },
            actorUserId: actor.id,
          });
        }
        await this.timeline.record(trx, {
          companyId,
          entityType: 'PARTY',
          entityId: id,
          type: 'PARTY_UPDATED',
          title: 'ویرایش طرف حساب',
          description: oldParty.nameFa,
          data: { partyId: id, fields: Object.keys(data).filter((k) => k !== 'version') },
          actorUserId: actor.id,
        });
        return updated;
      });
    } catch (error) {
      const mapped = mapUniqueViolation(error, (target) => {
        if (target.includes('internal_code')) {
          return { token: 'DUPLICATE_INTERNAL_CODE', details: { companyId } };
        }
        if (target.includes('national_id')) {
          return { token: 'DUPLICATE_NATIONAL_ID', details: { companyId } };
        }
        if (target.includes('national_code')) {
          return { token: 'DUPLICATE_NATIONAL_CODE', details: { companyId } };
        }
        return null;
      });
      throw mapped ?? error;
    }

    const oldValues: Record<string, unknown> = {};
    const newValues: Record<string, unknown> = {};
    for (const key of Object.keys(data)) {
      oldValues[key] = (oldParty as unknown as Record<string, unknown>)[key];
      newValues[key] = (data as Record<string, unknown>)[key];
    }
    await this.auditService.record({
      entityType: 'party',
      entityId: id,
      action: AuditAction.UPDATE,
      actor,
      companyId,
      oldValues,
      newValues,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    if (ownerChanged) {
      await this.auditService.record({
        entityType: 'party',
        entityId: id,
        action: 'OWNER_CHANGED',
        actor,
        companyId,
        oldValues: { ownerUserId: oldParty.ownerUserId },
        newValues: { ownerUserId: newOwnerUserId },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
    }

    return this.getById(companyId, actorScope, id);
  }

  /** POST /parties/:id/owner — dedicated owner reassignment endpoint. */
  async changeOwner(
    companyId: string,
    actorScope: ActorScope,
    id: string,
    dto: AssignOwnerDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    const teamIds = await this.teamIdsFor(actorScope);
    const party = await this.prisma.party.findUnique({ where: { id } });
    if (!party || party.companyId !== companyId) {
      throw new NotFoundError('Party not found', { id });
    }
    this.assertScope(actorScope, teamIds, party);
    const owner = await this.prisma.user.findUnique({
      where: { id: dto.userId },
      select: { id: true },
    });
    if (!owner) {
      throw new ValidationError('Owner user not found', { ownerUserId: dto.userId });
    }

    await this.prisma.$transaction(async (trx) => {
      const updated = await trx.party.updateMany({
        where: { id, version: party.version },
        data: { ownerUserId: dto.userId, version: party.version + 1 },
      });
      if (updated.count !== 1) {
        throw new ConflictError('VERSION_CONFLICT', { id });
      }
      await this.timeline.record(trx, {
        companyId,
        entityType: 'PARTY',
        entityId: id,
        type: 'OWNER_CHANGED',
        title: 'تغییر مالک طرف حساب',
        description: party.nameFa,
        data: { partyId: id, oldOwnerUserId: party.ownerUserId, newOwnerUserId: dto.userId },
        actorUserId: actor.id,
      });
    });

    await this.auditService.record({
      entityType: 'party',
      entityId: id,
      action: 'OWNER_CHANGED',
      actor,
      companyId,
      oldValues: { ownerUserId: party.ownerUserId },
      newValues: { ownerUserId: dto.userId },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return this.getById(companyId, actorScope, id);
  }

  // ─────────────────────── archive / restore ───────────────────────

  async archive(
    companyId: string,
    actorScope: ActorScope,
    id: string,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    const teamIds = await this.teamIdsFor(actorScope);
    const party = await this.prisma.party.findUnique({ where: { id } });
    if (!party || party.companyId !== companyId) {
      throw new NotFoundError('Party not found', { id });
    }
    this.assertScope(actorScope, teamIds, party);
    if (party.archivedAt) {
      throw new ConflictError('ALREADY_ARCHIVED', { id });
    }

    const archivedAt = new Date();
    await this.prisma.$transaction(async (trx) => {
      const updated = await trx.party.updateMany({
        where: { id, version: party.version },
        data: { archivedAt, archivedBy: actor.id, version: party.version + 1 },
      });
      if (updated.count !== 1) {
        throw new ConflictError('VERSION_CONFLICT', { id });
      }
      await this.timeline.record(trx, {
        companyId,
        entityType: 'PARTY',
        entityId: id,
        type: 'PARTY_ARCHIVED',
        title: 'آرشیو طرف حساب',
        description: party.nameFa,
        data: { partyId: id },
        actorUserId: actor.id,
      });
    });

    await this.auditService.record({
      entityType: 'party',
      entityId: id,
      action: AuditAction.ARCHIVE,
      actor,
      companyId,
      oldValues: { archivedAt: party.archivedAt },
      newValues: { archivedAt: archivedAt.toISOString(), archivedBy: actor.id },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return this.getById(companyId, actorScope, id);
  }

  async restore(
    companyId: string,
    actorScope: ActorScope,
    id: string,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    const teamIds = await this.teamIdsFor(actorScope);
    const party = await this.prisma.party.findUnique({ where: { id } });
    if (!party || party.companyId !== companyId) {
      throw new NotFoundError('Party not found', { id });
    }
    this.assertScope(actorScope, teamIds, party);
    if (!party.archivedAt) {
      throw new ConflictError('NOT_ARCHIVED', { id });
    }

    await this.prisma.$transaction(async (trx) => {
      const updated = await trx.party.updateMany({
        where: { id, version: party.version },
        data: { archivedAt: null, archivedBy: null, version: party.version + 1 },
      });
      if (updated.count !== 1) {
        throw new ConflictError('VERSION_CONFLICT', { id });
      }
      await this.timeline.record(trx, {
        companyId,
        entityType: 'PARTY',
        entityId: id,
        type: 'PARTY_RESTORED',
        title: 'بازگردانی طرف حساب',
        description: party.nameFa,
        data: { partyId: id },
        actorUserId: actor.id,
      });
    });

    await this.auditService.record({
      entityType: 'party',
      entityId: id,
      action: 'RESTORED',
      actor,
      companyId,
      oldValues: { archivedAt: party.archivedAt },
      newValues: { archivedAt: null },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return this.getById(companyId, actorScope, id);
  }

  // ─────────────────────── roles ───────────────────────

  async addRole(
    companyId: string,
    actorScope: ActorScope,
    id: string,
    dto: AddRoleDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    await this.getById(companyId, actorScope, id); // company + scope check
    let role;
    try {
      role = await this.prisma.$transaction(async (trx) => {
        const created = await trx.partyRole.create({
          data: { partyId: id, role: dto.role, notes: dto.notes },
        });
        await this.timeline.record(trx, {
          companyId,
          entityType: 'PARTY',
          entityId: id,
          type: 'ROLE_ADDED',
          title: 'افزودن نقش',
          description: dto.role,
          data: { partyId: id, role: dto.role },
          actorUserId: actor.id,
        });
        return created;
      });
    } catch (error) {
      const mapped = mapUniqueViolation(error, () => ({
        token: 'ROLE_EXISTS',
        details: { partyId: id, role: dto.role },
      }));
      throw mapped ?? error;
    }
    await this.auditService.record({
      entityType: 'party',
      entityId: id,
      action: 'ROLE_ADDED',
      actor,
      companyId,
      newValues: { role: dto.role, notes: dto.notes },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return role;
  }

  async removeRole(
    companyId: string,
    actorScope: ActorScope,
    id: string,
    role: PartyRoleType,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    await this.getById(companyId, actorScope, id);
    const existing = await this.prisma.partyRole.findUnique({
      where: { partyId_role: { partyId: id, role } },
    });
    if (!existing) {
      throw new NotFoundError('Party does not hold this role', { partyId: id, role });
    }
    await this.prisma.$transaction(async (trx) => {
      await trx.partyRole.delete({ where: { id: existing.id } });
      await this.timeline.record(trx, {
        companyId,
        entityType: 'PARTY',
        entityId: id,
        type: 'ROLE_REMOVED',
        title: 'حذف نقش',
        description: role,
        data: { partyId: id, role },
        actorUserId: actor.id,
      });
    });
    await this.auditService.record({
      entityType: 'party',
      entityId: id,
      action: 'ROLE_REMOVED',
      actor,
      companyId,
      oldValues: { role },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return { removed: true, role };
  }

  // ─────────────────────── phones ───────────────────────

  async addPhone(
    companyId: string,
    actorScope: ActorScope,
    id: string,
    dto: AddPartyPhoneDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    await this.getById(companyId, actorScope, id);
    const row = toPhoneRow(dto);
    return this.prisma.$transaction(async (trx) => {
      // Same rule as creation (partial unique `parties_mobile_uniq` backstop).
      await PartiesService.assertNoDuplicateMobile(trx, companyId, [dto], id);
      if (row.isPrimary) {
        await trx.partyPhone.updateMany({ where: { partyId: id }, data: { isPrimary: false } });
      }
      let phone;
      try {
        phone = await trx.partyPhone.create({ data: { companyId, partyId: id, ...row } });
      } catch (error) {
        const mapped = mapUniqueViolation(error, () => ({
          token: 'DUPLICATE_PHONE',
          details: { partyId: id, mobile: row.normalizedValue },
        }));
        throw mapped ?? error;
      }
      await this.timeline.record(trx, {
        companyId,
        entityType: 'PARTY',
        entityId: id,
        type: 'PHONE_ADDED',
        title: 'افزودن شماره تماس',
        description: row.rawValue,
        data: {
          partyId: id,
          phoneId: phone.id,
          kind: row.kind,
          normalizedValue: row.normalizedValue,
        },
        actorUserId: actor.id,
      });
      await this.auditService.record({
        entityType: 'party',
        entityId: id,
        action: 'PHONE_ADDED',
        actor,
        companyId,
        newValues: { phoneId: phone.id, kind: row.kind, normalizedValue: row.normalizedValue },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return phone;
    });
  }

  async removePhone(
    companyId: string,
    actorScope: ActorScope,
    id: string,
    phoneId: string,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    await this.getById(companyId, actorScope, id);
    const phone = await this.prisma.partyPhone.findFirst({
      where: { id: phoneId, partyId: id },
    });
    if (!phone) {
      throw new NotFoundError('Phone not found for this party', { partyId: id, phoneId });
    }
    await this.prisma.$transaction(async (trx) => {
      await trx.partyPhone.delete({ where: { id: phone.id } });
      await this.timeline.record(trx, {
        companyId,
        entityType: 'PARTY',
        entityId: id,
        type: 'PHONE_REMOVED',
        title: 'حذف شماره تماس',
        description: phone.rawValue,
        data: { partyId: id, phoneId, normalizedValue: phone.normalizedValue },
        actorUserId: actor.id,
      });
    });
    await this.auditService.record({
      entityType: 'party',
      entityId: id,
      action: 'PHONE_REMOVED',
      actor,
      companyId,
      oldValues: { phoneId, normalizedValue: phone.normalizedValue },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return { removed: true, phoneId };
  }

  // ─────────────────────── contacts ───────────────────────

  async addContact(
    companyId: string,
    actorScope: ActorScope,
    id: string,
    dto: CreateContactDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    await this.getById(companyId, actorScope, id);
    const phoneRows = (dto.phones ?? []).map((p) => ({
      kind: p.kind,
      rawValue: p.value,
      normalizedValue: normalizePhone(p.kind, p.value),
      isPrimary: p.isPrimary ?? false,
    }));
    return this.prisma.$transaction(async (trx) => {
      if (dto.isPrimary) {
        await trx.contact.updateMany({ where: { partyId: id }, data: { isPrimary: false } });
      }
      const contact = await trx.contact.create({
        data: {
          companyId,
          partyId: id,
          name: dto.name,
          position: dto.position,
          email: dto.email,
          isPrimary: dto.isPrimary ?? false,
          notes: dto.notes,
          phones: phoneRows.length ? { create: phoneRows } : undefined,
        },
        include: { phones: true },
      });
      await this.timeline.record(trx, {
        companyId,
        entityType: 'PARTY',
        entityId: id,
        type: 'CONTACT_ADDED',
        title: 'افزودن شخص رابط',
        description: contact.name,
        data: { partyId: id, contactId: contact.id },
        actorUserId: actor.id,
      });
      await this.auditService.record({
        entityType: 'party',
        entityId: id,
        action: 'CONTACT_ADDED',
        actor,
        companyId,
        newValues: { contactId: contact.id, name: contact.name },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return contact;
    });
  }

  async updateContact(
    companyId: string,
    actorScope: ActorScope,
    id: string,
    contactId: string,
    dto: UpdateContactDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    await this.getById(companyId, actorScope, id);
    const existing = await this.prisma.contact.findFirst({
      where: { id: contactId, partyId: id },
    });
    if (!existing) {
      throw new NotFoundError('Contact not found for this party', { partyId: id, contactId });
    }
    const data: Prisma.ContactUncheckedUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.position !== undefined) data.position = dto.position;
    if (dto.email !== undefined) data.email = dto.email;
    if (dto.notes !== undefined) data.notes = dto.notes;
    if (dto.isPrimary !== undefined) data.isPrimary = dto.isPrimary;

    const contact = await this.prisma.$transaction(async (trx) => {
      if (dto.isPrimary) {
        await trx.contact.updateMany({ where: { partyId: id }, data: { isPrimary: false } });
      }
      const updated = await trx.contact.update({ where: { id: existing.id }, data });
      await this.timeline.record(trx, {
        companyId,
        entityType: 'PARTY',
        entityId: id,
        type: 'CONTACT_UPDATED',
        title: 'ویرایش شخص رابط',
        description: updated.name,
        data: { partyId: id, contactId: updated.id },
        actorUserId: actor.id,
      });
      return updated;
    });
    await this.auditService.record({
      entityType: 'party',
      entityId: id,
      action: 'CONTACT_UPDATED',
      actor,
      companyId,
      oldValues: { contactId, name: existing.name },
      newValues: dto,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return contact;
  }

  async removeContact(
    companyId: string,
    actorScope: ActorScope,
    id: string,
    contactId: string,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    await this.getById(companyId, actorScope, id);
    const existing = await this.prisma.contact.findFirst({
      where: { id: contactId, partyId: id },
    });
    if (!existing) {
      throw new NotFoundError('Contact not found for this party', { partyId: id, contactId });
    }
    await this.prisma.$transaction(async (trx) => {
      await trx.contact.delete({ where: { id: existing.id } });
      await this.timeline.record(trx, {
        companyId,
        entityType: 'PARTY',
        entityId: id,
        type: 'CONTACT_REMOVED',
        title: 'حذف شخص رابط',
        description: existing.name,
        data: { partyId: id, contactId },
        actorUserId: actor.id,
      });
    });
    await this.auditService.record({
      entityType: 'party',
      entityId: id,
      action: 'CONTACT_REMOVED',
      actor,
      companyId,
      oldValues: { contactId, name: existing.name },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return { removed: true, contactId };
  }

  // ─────────────────────── addresses ───────────────────────

  async addAddress(
    companyId: string,
    actorScope: ActorScope,
    id: string,
    dto: CreateAddressDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    await this.getById(companyId, actorScope, id);
    return this.prisma.$transaction(async (trx) => {
      if (dto.isPrimary) {
        await trx.address.updateMany({ where: { partyId: id }, data: { isPrimary: false } });
      }
      const address = await trx.address.create({
        data: {
          companyId,
          partyId: id,
          type: dto.type,
          country: dto.country,
          province: dto.province,
          city: dto.city,
          postalCode: dto.postalCode,
          line: dto.line,
          isPrimary: dto.isPrimary ?? false,
        },
      });
      await this.timeline.record(trx, {
        companyId,
        entityType: 'PARTY',
        entityId: id,
        type: 'ADDRESS_ADDED',
        title: 'افزودن نشانی',
        description: address.line,
        data: { partyId: id, addressId: address.id, addressType: address.type },
        actorUserId: actor.id,
      });
      await this.auditService.record({
        entityType: 'party',
        entityId: id,
        action: 'ADDRESS_ADDED',
        actor,
        companyId,
        newValues: { addressId: address.id, line: address.line, type: address.type },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return address;
    });
  }

  async updateAddress(
    companyId: string,
    actorScope: ActorScope,
    id: string,
    addressId: string,
    dto: UpdateAddressDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    await this.getById(companyId, actorScope, id);
    const existing = await this.prisma.address.findFirst({
      where: { id: addressId, partyId: id },
    });
    if (!existing) {
      throw new NotFoundError('Address not found for this party', { partyId: id, addressId });
    }
    const data: Prisma.AddressUncheckedUpdateInput = {};
    if (dto.type !== undefined) data.type = dto.type;
    if (dto.province !== undefined) data.province = dto.province;
    if (dto.city !== undefined) data.city = dto.city;
    if (dto.postalCode !== undefined) data.postalCode = dto.postalCode;
    if (dto.line !== undefined) data.line = dto.line;
    if (dto.isPrimary !== undefined) data.isPrimary = dto.isPrimary;

    const address = await this.prisma.$transaction(async (trx) => {
      if (dto.isPrimary) {
        await trx.address.updateMany({ where: { partyId: id }, data: { isPrimary: false } });
      }
      const updated = await trx.address.update({ where: { id: existing.id }, data });
      await this.timeline.record(trx, {
        companyId,
        entityType: 'PARTY',
        entityId: id,
        type: 'ADDRESS_UPDATED',
        title: 'ویرایش نشانی',
        description: updated.line,
        data: { partyId: id, addressId: updated.id },
        actorUserId: actor.id,
      });
      return updated;
    });
    await this.auditService.record({
      entityType: 'party',
      entityId: id,
      action: 'ADDRESS_UPDATED',
      actor,
      companyId,
      oldValues: { addressId, line: existing.line },
      newValues: dto,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return address;
  }

  async removeAddress(
    companyId: string,
    actorScope: ActorScope,
    id: string,
    addressId: string,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    await this.getById(companyId, actorScope, id);
    const existing = await this.prisma.address.findFirst({
      where: { id: addressId, partyId: id },
    });
    if (!existing) {
      throw new NotFoundError('Address not found for this party', { partyId: id, addressId });
    }
    await this.prisma.$transaction(async (trx) => {
      await trx.address.delete({ where: { id: existing.id } });
      await this.timeline.record(trx, {
        companyId,
        entityType: 'PARTY',
        entityId: id,
        type: 'ADDRESS_REMOVED',
        title: 'حذف نشانی',
        description: existing.line,
        data: { partyId: id, addressId },
        actorUserId: actor.id,
      });
    });
    await this.auditService.record({
      entityType: 'party',
      entityId: id,
      action: 'ADDRESS_REMOVED',
      actor,
      companyId,
      oldValues: { addressId, line: existing.line },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return { removed: true, addressId };
  }
}
