import { Injectable } from '@nestjs/common';
import { Prisma, PublishChannel, PublishingTemplate } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit.dto';
import { NotFoundError } from '../common/errors';
import { RequestContext } from '../auth/auth.service';
import {
  CreatePublishingTemplateDto,
  RenderPreviewDto,
  UpdatePublishingTemplateDto,
} from './publishing.dto';
import { renderBody } from './publishing-render';
import { parseDayKey, todayKey } from '../pricing/day';

/**
 * Per-channel publishing templates (REQUIREMENTS §18): placeholders
 * {product} {variantSku} {size} {grade} {brand} {price} {date} {uom}.
 * Unique per (company, channel, code); CRUD is audited; renderPreview lets
 * operators verify a template against a real variant + date.
 */
@Injectable()
export class PublishingTemplateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async list(companyId: string, channel?: PublishChannel): Promise<PublishingTemplate[]> {
    return this.prisma.publishingTemplate.findMany({
      where: { companyId, channel },
      orderBy: [{ channel: 'asc' }, { code: 'asc' }],
    });
  }

  async getById(companyId: string, id: string): Promise<PublishingTemplate> {
    const template = await this.prisma.publishingTemplate.findUnique({ where: { id } });
    if (!template || template.companyId !== companyId) {
      throw new NotFoundError('Publishing template not found', { id });
    }
    return template;
  }

  async create(
    companyId: string,
    dto: CreatePublishingTemplateDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<PublishingTemplate> {
    const template = await this.prisma.publishingTemplate.create({
      data: {
        companyId,
        channel: dto.channel,
        code: dto.code,
        nameFa: dto.nameFa,
        bodyTemplate: dto.bodyTemplate,
        isActive: dto.isActive ?? true,
      },
    });
    await this.auditService.record({
      entityType: 'publishing_template',
      entityId: template.id,
      action: AuditAction.CREATE,
      companyId,
      actor,
      newValues: { channel: template.channel, code: template.code, isActive: template.isActive },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return template;
  }

  async update(
    companyId: string,
    id: string,
    dto: UpdatePublishingTemplateDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<PublishingTemplate> {
    const existing = await this.getById(companyId, id);
    const template = await this.prisma.publishingTemplate.update({
      where: { id: existing.id },
      data: {
        channel: dto.channel,
        nameFa: dto.nameFa,
        bodyTemplate: dto.bodyTemplate,
        isActive: dto.isActive,
      },
    });
    await this.auditService.record({
      entityType: 'publishing_template',
      entityId: id,
      action: AuditAction.UPDATE,
      companyId,
      actor,
      oldValues: {
        channel: existing.channel,
        nameFa: existing.nameFa,
        bodyTemplate: existing.bodyTemplate,
        isActive: existing.isActive,
      },
      newValues: {
        channel: template.channel,
        nameFa: template.nameFa,
        bodyTemplate: template.bodyTemplate,
        isActive: template.isActive,
      },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return template;
  }

  async remove(
    companyId: string,
    id: string,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<void> {
    const existing = await this.getById(companyId, id);
    await this.prisma.publishingTemplate.delete({ where: { id: existing.id } });
    await this.auditService.record({
      entityType: 'publishing_template',
      entityId: id,
      action: AuditAction.DELETE,
      companyId,
      actor,
      oldValues: { channel: existing.channel, code: existing.code },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  }

  /**
   * Render a template (or ad-hoc body) for ONE variant + date. The variant
   * must have a daily price on that date (that is what {price}/{uom} come
   * from). Unknown placeholders come back left empty + warnings.
   */
  async renderPreview(companyId: string, dto: RenderPreviewDto) {
    const dayKey = dto.date ?? todayKey();
    const day = parseDayKey(dayKey);

    const price = await this.prisma.dailyPrice.findFirst({
      where: { companyId, productVariantId: dto.variantId, date: day },
      orderBy: { updatedAt: 'desc' },
      include: {
        uom: { select: { symbol: true } },
        productVariant: {
          select: {
            sku: true,
            nameFa: true,
            template: {
              select: { nameFa: true, brand: { select: { nameFa: true } } },
            },
          },
        },
      },
    });
    if (!price) {
      throw new NotFoundError('No daily price for this variant on that date', {
        variantId: dto.variantId,
        date: dayKey,
      });
    }

    const attributeVars = await this.attributeVars(companyId, [dto.variantId]);
    const vars: Record<string, string> = {
      product: price.productVariant.template.nameFa,
      variantSku: price.productVariant.sku,
      size: attributeVars.get(dto.variantId)?.size ?? '',
      grade: attributeVars.get(dto.variantId)?.grade ?? '',
      brand: price.productVariant.template.brand?.nameFa ?? '',
      price: price.price.toString(),
      date: dayKey,
      uom: price.uom.symbol,
      ...attributeVars.get(dto.variantId)?.extra,
    };

    let bodyTemplate = dto.bodyTemplate;
    let templateId: string | null = null;
    let templateCode: string | null = null;
    let channel: PublishChannel | null = dto.channel ?? null;
    if (dto.templateId) {
      const template = await this.getById(companyId, dto.templateId);
      bodyTemplate = template.bodyTemplate;
      templateId = template.id;
      templateCode = template.code;
      channel = template.channel;
    }
    if (!bodyTemplate) {
      throw new NotFoundError('templateId or bodyTemplate is required');
    }

    const rendered = renderBody(bodyTemplate, vars);
    return {
      text: rendered.text,
      warnings: rendered.warnings,
      vars,
      templateId,
      templateCode,
      channel,
      date: dayKey,
    };
  }

  /**
   * {size}/{grade} (and any other attribute code) per variant, resolved from
   * the variant's attribute values (attribute.code, case-insensitive; value
   * is the Persian display value). Attributes are dynamic — anything the
   * template references that no variant value provides renders empty.
   */
  async attributeVars(
    companyId: string,
    variantIds: string[],
  ): Promise<Map<string, { size: string; grade: string; extra: Record<string, string> }>> {
    const result = new Map<string, { size: string; grade: string; extra: Record<string, string> }>();
    if (variantIds.length === 0) return result;
    const rows = await this.prisma.variantAttributeValue.findMany({
      where: { variantId: { in: variantIds }, variant: { companyId } },
      include: {
        attribute: { select: { code: true, nameFa: true } },
        attributeValue: { select: { valueFa: true } },
      },
    });
    for (const row of rows) {
      const entry = result.get(row.variantId) ?? { size: '', grade: '', extra: {} };
      const code = row.attribute.code.toLowerCase();
      const value = row.attributeValue.valueFa;
      if (code === 'size') entry.size = value;
      else if (code === 'grade') entry.grade = value;
      entry.extra[code] = value;
      result.set(row.variantId, entry);
    }
    return result;
  }
}

/** Prisma-safe JSON coercion for rendered payloads. */
export function renderedToJson(
  rendered: import('./publishing-adapter').RenderedPublishPayload,
): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(rendered)) as Prisma.InputJsonValue;
}
