import { Injectable } from '@nestjs/common';
import { IntegrationConfig } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit.dto';
import { NotFoundError } from '../common/errors';
import { RequestContext } from '../auth/auth.service';

/** Integration adapter configs (SMS/Telegram/…), company scoped. */
@Injectable()
export class IntegrationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async list(companyId: string): Promise<IntegrationConfig[]> {
    return this.prisma.integrationConfig.findMany({
      where: { companyId },
      orderBy: { code: 'asc' },
    });
  }

  async getById(companyId: string, id: string): Promise<IntegrationConfig> {
    const config = await this.prisma.integrationConfig.findUnique({ where: { id } });
    if (!config || config.companyId !== companyId) {
      throw new NotFoundError('Integration config not found', { id });
    }
    return config;
  }

  async create(
    companyId: string,
    data: { code: string; name: string; type: string; config: Record<string, unknown>; isActive?: boolean },
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<IntegrationConfig> {
    const created = await this.prisma.integrationConfig.create({
      data: {
        companyId,
        code: data.code,
        name: data.name,
        type: data.type,
        isActive: data.isActive ?? false,
        config: data.config as object,
        updatedBy: actor.id,
      },
    });
    await this.auditService.record({
      entityType: 'integration_config',
      entityId: created.id,
      action: AuditAction.CREATE,
      actor,
      companyId,
      newValues: { code: created.code, type: created.type, isActive: created.isActive },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return created;
  }

  async update(
    companyId: string,
    id: string,
    data: { name?: string; isActive?: boolean; isPrimary?: boolean; config?: Record<string, unknown> },
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<IntegrationConfig> {
    const existing = await this.getById(companyId, id);
    const updated = await this.prisma.integrationConfig.update({
      where: { id: existing.id },
      data: {
        name: data.name,
        isActive: data.isActive,
        isPrimary: data.isPrimary,
        config: data.config as object | undefined,
        updatedBy: actor.id,
      },
    });
    await this.auditService.record({
      entityType: 'integration_config',
      entityId: id,
      action: AuditAction.UPDATE,
      actor,
      companyId,
      oldValues: { name: existing.name, isActive: existing.isActive },
      newValues: { name: updated.name, isActive: updated.isActive },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return updated;
  }

  async remove(
    companyId: string,
    id: string,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<void> {
    const existing = await this.getById(companyId, id);
    await this.prisma.integrationConfig.delete({ where: { id: existing.id } });
    await this.auditService.record({
      entityType: 'integration_config',
      entityId: id,
      action: AuditAction.DELETE,
      actor,
      companyId,
      oldValues: { code: existing.code },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  }
}
