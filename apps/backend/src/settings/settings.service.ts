import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit.dto';
import { RequestContext } from '../auth/auth.service';
import { ValidationError } from '../common/errors';
import { SettingQueryDto, UpsertSettingDto } from './settings.dto';
import {
  SETTING_DEFINITIONS,
  SETTING_DEFINITIONS_BY_KEY,
  validateSettingValue,
  type SettingDefinition,
} from './settings-registry';
import { Paginated } from '../common/dto/pagination.dto';

export type Setting = Prisma.SettingGetPayload<object>;

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

/** Company-scoped settings (REQUIREMENTS §67: every change audited). */
@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async list(companyId: string, query: SettingQueryDto): Promise<Paginated<Setting>> {
    const where: Prisma.SettingWhereInput = {
      companyId,
      category: query.category,
    };
    const [items, total] = await Promise.all([
      this.prisma.setting.findMany({
        where,
        orderBy: { key: 'asc' },
        skip: query.skip,
        take: query.take,
      }),
      this.prisma.setting.count({ where }),
    ]);
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  /** Convenience accessor for other services (company-scoped). */
  async get<T = unknown>(companyId: string, key: string): Promise<T | null> {
    const setting = await this.prisma.setting.findUnique({
      where: { companyId_key: { companyId, key } },
    });
    return (setting?.value as T) ?? null;
  }

  async upsert(
    companyId: string,
    dto: UpsertSettingDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<Setting> {
    // CORE-003 §4 — the LEGACY raw-key route is hardened: only registry keys
    // may be written, and ONLY through the typed validation. Arbitrary keys
    // and values outside the catalog are refused (no uncontrolled writes).
    const legacyDef = SETTING_DEFINITIONS_BY_KEY.get(dto.key);
    if (!legacyDef) {
      throw new ValidationError(
        'SETTING_KEY_NOT_IN_REGISTRY — از مرکز تنظیمات استفاده کنید',
        { key: dto.key },
      );
    }
    const legacyCheck = validateSettingValue(legacyDef, dto.value);
    if (!legacyCheck.ok) throw new ValidationError(legacyCheck.error, { key: dto.key });

    const existing = await this.prisma.setting.findUnique({
      where: { companyId_key: { companyId, key: dto.key } },
    });

    const setting = await this.prisma.setting.upsert({
      where: { companyId_key: { companyId, key: dto.key } },
      create: {
        companyId,
        key: dto.key,
        value: toJson(dto.value),
        category: dto.category ?? existing?.category ?? 'general',
        description: dto.description,
        updatedBy: actor.id,
      },
      update: {
        value: toJson(dto.value),
        category: dto.category,
        description: dto.description,
        updatedBy: actor.id,
      },
    });

    // REQUIREMENTS §67: every settings change must be audited (old + new).
    await this.auditService.record({
      entityType: 'setting',
      entityId: setting.id,
      action: existing ? AuditAction.UPDATE : AuditAction.CREATE,
      actor,
      companyId,
      oldValues: existing ? { key: existing.key, value: existing.value, category: existing.category } : undefined,
      newValues: { key: setting.key, value: setting.value, category: setting.category },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return setting;
  }

  /**
   * CORE-003 — the settings CENTER feed: registry definitions merged with
   * this company's current overrides. `inDefault` marks rows whose current
   * value equals the registry default (FE shows the restore action only for
   * overridden entries).
   */
  async catalog(companyId: string) {
    const rows = await this.prisma.setting.findMany({ where: { companyId } });
    const byKey = new Map(rows.map((r) => [r.key, r]));
    return SETTING_DEFINITIONS.map((def) => {
      const row = byKey.get(def.key);
      const value = row ? row.value : def.defaultValue;
      const overridden = !!row && JSON.stringify(row.value) !== JSON.stringify(def.defaultValue);
      return {
        key: def.key,
        category: def.category,
        type: def.type,
        labelFa: def.labelFa,
        descriptionFa: def.descriptionFa,
        options: def.options ?? null,
        consumer: def.consumer,
        value: def.isSecret ? '••••••••' : value,
        isSecret: def.isSecret ?? false,
        isOverridden: overridden,
        updatedAt: row?.updatedAt ?? null,
        updatedByName: row?.updatedBy ?? null,
        defaultValue: def.isSecret ? '••••••••' : def.defaultValue,
      };
    });
  }

  /** Typed upsert: the registry validates/coerces by definition type. */
  async upsertRegistered(
    companyId: string,
    key: string,
    rawValue: unknown,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<Setting> {
    const def = SETTING_DEFINITIONS_BY_KEY.get(key);
    if (!def) throw new ValidationError(`Unknown setting key: ${key}`);
    const check = validateSettingValue(def, rawValue);
    if (!check.ok) throw new ValidationError(check.error, { key });
    return this.upsert(
      companyId,
      { key, value: check.value as object, category: def.category, description: def.descriptionFa },
      actor,
      ctx,
    );
  }

  /** Restore a setting to its registry default = delete the override row. */
  async restoreDefault(
    companyId: string,
    key: string,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<{ key: string; restored: boolean }> {
    const def = SETTING_DEFINITIONS_BY_KEY.get(key);
    if (!def) throw new ValidationError(`Unknown setting key: ${key}`);
    const existing = await this.prisma.setting.findUnique({
      where: { companyId_key: { companyId, key } },
    });
    if (!existing) return { key, restored: false };
    await this.prisma.$transaction([
      this.prisma.setting.delete({ where: { companyId_key: { companyId, key } } }),
    ]);
    await this.auditService.record({
      entityType: 'setting',
      entityId: existing.id,
      action: AuditAction.DELETE,
      actor,
      companyId,
      oldValues: { key, value: existing.value },
      newValues: { key, value: 'RESTORED_DEFAULT', defaultValue: def.defaultValue },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return { key, restored: true };
  }

  /** Registry (definitions only) — for the FE to know what exists. */
  definitions(): SettingDefinition[] {
    return SETTING_DEFINITIONS;
  }
}
