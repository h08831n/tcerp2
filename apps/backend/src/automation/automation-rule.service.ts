import { Injectable } from '@nestjs/common';
import { AutomationRule, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit.dto';
import { evaluateConditions, RuleConditions } from '../notifications/notification-conditions';
import { NotFoundError } from '../common/errors';
import { RequestContext } from '../auth/auth.service';
import { Paginated } from '../common/dto/pagination.dto';
import {
  AutomationRunQueryDto,
  CreateAutomationRuleDto,
  UpdateAutomationRuleDto,
} from './automation.dto';

/**
 * Automation rules CRUD (Phase 5 lean subset of REQUIREMENTS §52).
 * Rules are company-scoped, unique per (company, code) and versioned — every
 * run references the rule version it executed with. Conditions reuse the
 * pure notification-condition evaluator (AND/OR nesting).
 */
@Injectable()
export class AutomationRuleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async list(
    companyId: string,
    filters: { triggerType?: AutomationRule['triggerType']; enabled?: boolean } = {},
  ): Promise<AutomationRule[]> {
    return this.prisma.automationRule.findMany({
      where: { companyId, triggerType: filters.triggerType, enabled: filters.enabled },
      orderBy: { createdAt: 'asc' },
    });
  }

  async getById(companyId: string, id: string): Promise<AutomationRule> {
    const rule = await this.prisma.automationRule.findUnique({ where: { id } });
    if (!rule || rule.companyId !== companyId) {
      throw new NotFoundError('Automation rule not found', { id });
    }
    return rule;
  }

  async create(
    companyId: string,
    dto: CreateAutomationRuleDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<AutomationRule> {
    const rule = await this.prisma.automationRule.create({
      data: {
        companyId,
        code: dto.code,
        nameFa: dto.nameFa,
        triggerType: dto.triggerType,
        triggerConfig: dto.triggerConfig as Prisma.InputJsonValue,
        conditionConfig: (dto.conditionConfig ?? undefined) as Prisma.InputJsonValue | undefined,
        actionType: dto.actionType,
        actionConfig: dto.actionConfig as Prisma.InputJsonValue,
        enabled: dto.enabled ?? true,
      },
    });
    await this.auditService.record({
      entityType: 'automation_rule',
      entityId: rule.id,
      action: AuditAction.CREATE,
      companyId,
      actor,
      newValues: { code: rule.code, triggerType: rule.triggerType, actionType: rule.actionType },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return rule;
  }

  async update(
    companyId: string,
    id: string,
    dto: UpdateAutomationRuleDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<AutomationRule> {
    const existing = await this.getById(companyId, id);
    const rule = await this.prisma.automationRule.update({
      where: { id: existing.id },
      data: {
        nameFa: dto.nameFa,
        triggerType: dto.triggerType,
        triggerConfig: dto.triggerConfig as Prisma.InputJsonValue | undefined,
        conditionConfig: dto.conditionConfig as Prisma.InputJsonValue | undefined,
        actionType: dto.actionType,
        actionConfig: dto.actionConfig as Prisma.InputJsonValue | undefined,
        enabled: dto.enabled,
        version: { increment: 1 },
      },
    });
    await this.auditService.record({
      entityType: 'automation_rule',
      entityId: id,
      action: AuditAction.UPDATE,
      companyId,
      actor,
      oldValues: {
        code: existing.code,
        enabled: existing.enabled,
        version: existing.version,
      },
      newValues: { code: rule.code, enabled: rule.enabled, version: rule.version },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return rule;
  }

  async remove(
    companyId: string,
    id: string,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<void> {
    const existing = await this.getById(companyId, id);
    await this.prisma.automationRule.delete({ where: { id: existing.id } });
    await this.auditService.record({
      entityType: 'automation_rule',
      entityId: id,
      action: AuditAction.DELETE,
      companyId,
      actor,
      oldValues: { code: existing.code },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  }

  async listRuns(
    companyId: string,
    ruleId: string,
    query: AutomationRunQueryDto,
  ): Promise<Paginated<Prisma.AutomationRunGetPayload<{ include: { rule: { select: { code: true; nameFa: true } } } }>> > {
    await this.getById(companyId, ruleId);
    const where: Prisma.AutomationRunWhereInput = { ruleId, status: query.status };
    const [items, total] = await Promise.all([
      this.prisma.automationRun.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.take,
        include: { rule: { select: { code: true, nameFa: true } } },
      }),
      this.prisma.automationRun.count({ where }),
    ]);
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  /** Evaluate the rule's conditionConfig against an event (pure helper). */
  evaluate(rule: AutomationRule, event: Record<string, unknown>): boolean {
    return evaluateConditions(
      (rule.conditionConfig ?? undefined) as RuleConditions,
      event,
    );
  }
}
