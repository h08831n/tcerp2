import { Injectable } from '@nestjs/common';
import {
  Prisma,
  PurchaseTaxInvoiceOrderAllocation,
  SalesTaxInvoiceOrderAllocation,
  TaxDefinition,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit.dto';
import { ConflictError, ForbiddenError, NotFoundError } from '../common/errors';
import { RequestContext } from '../auth/auth.service';
import { CreateTaxDefinitionDto, UpdateTaxDefinitionDto } from './tax.dto';

export const TAX_USED_SETTING_KEY = 'tax.definition.used';

type UsedMap = Record<string, string>; // definitionId → ISO usedAt

/**
 * Tax definitions are company-scoped and IMMUTABLE after first use: a rate
 * change means creating a NEW definition; documents keep rate snapshots.
 *
 * NOTE (schema-vs-code): the frozen schema has no `usedAt` column on
 * tax_definitions. First-use is therefore tracked in a company-scoped Setting
 * (`tax.definition.used` → {definitionId: ISO timestamp}). Adding the real
 * column is a one-line schema amendment recommended for the next gate.
 */
@Injectable()
export class TaxDefinitionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  private async readUsedMap(companyId: string): Promise<UsedMap> {
    const setting = await this.prisma.setting.findUnique({
      where: { companyId_key: { companyId, key: TAX_USED_SETTING_KEY } },
      select: { value: true },
    });
    return (setting?.value as UsedMap) ?? {};
  }

  private async writeUsedMap(companyId: string, used: UsedMap): Promise<void> {
    await this.prisma.setting.upsert({
      where: { companyId_key: { companyId, key: TAX_USED_SETTING_KEY } },
      create: { companyId, key: TAX_USED_SETTING_KEY, value: used, category: 'tax' },
      update: { value: used },
    });
  }

  async getUsedAt(companyId: string, id: string): Promise<Date | null> {
    const used = await this.readUsedMap(companyId);
    return used[id] ? new Date(used[id]) : null;
  }

  /**
   * Mark a definition as used (called by the document phases; one-way — the
   * first timestamp is retained forever).
   */
  async markUsed(companyId: string, id: string): Promise<Date> {
    const definition = await this.prisma.taxDefinition.findUnique({ where: { id } });
    if (!definition || definition.companyId !== companyId) {
      throw new NotFoundError('Tax definition not found', { id });
    }
    const used = await this.readUsedMap(companyId);
    if (used[id]) return new Date(used[id]); // one-way: keep the first stamp
    const now = new Date();
    used[id] = now.toISOString();
    await this.writeUsedMap(companyId, used);
    return now;
  }

  async list(companyId: string): Promise<TaxDefinition[]> {
    return this.prisma.taxDefinition.findMany({
      where: { companyId },
      orderBy: { code: 'asc' },
    });
  }

  async getById(companyId: string, id: string): Promise<TaxDefinition> {
    const definition = await this.prisma.taxDefinition.findUnique({ where: { id } });
    if (!definition || definition.companyId !== companyId) {
      throw new NotFoundError('Tax definition not found', { id });
    }
    return definition;
  }

  async create(
    companyId: string,
    dto: CreateTaxDefinitionDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<TaxDefinition> {
    const definition = await this.prisma.taxDefinition.create({
      data: {
        companyId,
        code: dto.code,
        name: dto.name,
        rate: dto.rate,
        isActive: dto.isActive ?? true,
      },
    });
    await this.auditService.record({
      entityType: 'tax_definition',
      entityId: definition.id,
      action: AuditAction.CREATE,
      actor,
      companyId,
      newValues: { code: definition.code, rate: Number(definition.rate) },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return definition;
  }

  /**
   * Update mutable fields; the rate is immutable once the definition is used.
   */
  async update(
    companyId: string,
    id: string,
    dto: UpdateTaxDefinitionDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<TaxDefinition> {
    const existing = await this.getById(companyId, id);

    if (dto.rate !== undefined && Number(dto.rate) !== Number(existing.rate)) {
      const usedAt = await this.getUsedAt(companyId, id);
      if (usedAt) {
        throw new ForbiddenError('TAX_DEFINITION_IMMUTABLE', {
          usedAt,
          hint: 'Create a new tax definition for the new rate.',
        });
      }
    }

    const updated = await this.prisma.taxDefinition.update({
      where: { id: existing.id },
      data: {
        name: dto.name,
        rate: dto.rate,
        isActive: dto.isActive,
      },
    });
    await this.auditService.record({
      entityType: 'tax_definition',
      entityId: id,
      action: AuditAction.UPDATE,
      actor,
      companyId,
      oldValues: { name: existing.name, rate: Number(existing.rate), isActive: existing.isActive },
      newValues: { name: updated.name, rate: Number(updated.rate), isActive: updated.isActive },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return updated;
  }
}

/**
 * Explicit M:N allocations between tax invoices and orders (REQUIREMENTS
 * correction gate — no generic polymorphic allocation table). The pair
 * (invoiceId, documentId) is UNIQUE; a second allocation of the same pair is
 * a ConflictError. One invoice may allocate to many orders and vice versa.
 */
@Injectable()
export class TaxAllocationService {
  constructor(private readonly prisma: PrismaService) {}

  async allocateSales(input: {
    companyId: string;
    salesTaxInvoiceId: string;
    salesDocumentId: string;
    allocatedAmount: number;
    allocatedQuantity?: number;
  }): Promise<SalesTaxInvoiceOrderAllocation> {
    if (!(input.allocatedAmount > 0)) {
      throw new ConflictError('ALLOCATION_AMOUNT_POSITIVE', { allocatedAmount: input.allocatedAmount });
    }
    try {
      return await this.prisma.salesTaxInvoiceOrderAllocation.create({
        data: {
          companyId: input.companyId,
          salesTaxInvoiceId: input.salesTaxInvoiceId,
          salesDocumentId: input.salesDocumentId,
          allocatedAmount: input.allocatedAmount,
          allocatedQuantity: input.allocatedQuantity,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictError('ALLOCATION_EXISTS', {
          salesTaxInvoiceId: input.salesTaxInvoiceId,
          salesDocumentId: input.salesDocumentId,
        });
      }
      throw error;
    }
  }

  async allocatePurchase(input: {
    companyId: string;
    purchaseTaxInvoiceId: string;
    purchaseDocumentId: string;
    allocatedAmount: number;
    allocatedQuantity?: number;
  }): Promise<PurchaseTaxInvoiceOrderAllocation> {
    if (!(input.allocatedAmount > 0)) {
      throw new ConflictError('ALLOCATION_AMOUNT_POSITIVE', { allocatedAmount: input.allocatedAmount });
    }
    try {
      return await this.prisma.purchaseTaxInvoiceOrderAllocation.create({
        data: {
          companyId: input.companyId,
          purchaseTaxInvoiceId: input.purchaseTaxInvoiceId,
          purchaseDocumentId: input.purchaseDocumentId,
          allocatedAmount: input.allocatedAmount,
          allocatedQuantity: input.allocatedQuantity,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictError('ALLOCATION_EXISTS', {
          purchaseTaxInvoiceId: input.purchaseTaxInvoiceId,
          purchaseDocumentId: input.purchaseDocumentId,
        });
      }
      throw error;
    }
  }

  async listSalesByInvoice(companyId: string, salesTaxInvoiceId: string) {
    return this.prisma.salesTaxInvoiceOrderAllocation.findMany({
      where: { companyId, salesTaxInvoiceId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async listPurchaseByInvoice(companyId: string, purchaseTaxInvoiceId: string) {
    return this.prisma.purchaseTaxInvoiceOrderAllocation.findMany({
      where: { companyId, purchaseTaxInvoiceId },
      orderBy: { createdAt: 'asc' },
    });
  }
}
