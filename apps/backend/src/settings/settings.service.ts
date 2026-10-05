import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit.dto';
import { RequestContext } from '../auth/auth.service';
import { SettingQueryDto, UpsertSettingDto } from './settings.dto';
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
}
