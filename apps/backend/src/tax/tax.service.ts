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

/**
 * Tax definitions are company-scoped and IMMUTABLE after first use (Mini-Gate #4):
 * `lockedAt` is set on first use and never cleared; afterwards code/rate/name
 * changes are forbidden (isActive may still toggle). A rate change means
 * creating a NEW definition; documents keep rate snapshots.
 */
@Injectable()
export class TaxDefinitionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Mark a definition as used — sets `lockedAt = now` when it is still null
   * (one-way; the first stamp is retained forever and can never be cleared).
   * Accepts an optional transaction client so document phases can stamp the
   * definition atomically with their own writes.
   */
  async markUsed(
    companyId: string,
    id: string,
    tx?: Pick<Prisma.TransactionClient, 'taxDefinition'>,
  ): Promise<Date> {
    const client = tx ?? this.prisma;
    const definition = await client.taxDefinition.findUnique({ where: { id } });
    if (!definition || definition.companyId !== companyId) {
      throw new NotFoundError('Tax definition not found', { id });
    }
    if (definition.lockedAt) return definition.lockedAt; // one-way: keep the first stamp
    const now = new Date();
    const updated = await client.taxDefinition.update({
      where: { id },
      data: { lockedAt: now },
    });
    return updated.lockedAt ?? now;
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
   * Update mutable fields. Once `lockedAt` is set (first use) code/rate/name
   * changes are FORBIDDEN — only the isActive toggle is still allowed.
   */
  async update(
    companyId: string,
    id: string,
    dto: UpdateTaxDefinitionDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<TaxDefinition> {
    const existing = await this.getById(companyId, id);

    if (existing.lockedAt) {
      const identityChanged =
        (dto.code !== undefined && dto.code !== existing.code) ||
        (dto.rate !== undefined && Number(dto.rate) !== Number(existing.rate)) ||
        (dto.name !== undefined && dto.name !== existing.name);
      if (identityChanged) {
        throw new ForbiddenError('TAX_DEFINITION_IMMUTABLE', {
          lockedAt: existing.lockedAt,
          hint: 'Create a new tax definition for the new rate.',
        });
      }
    }

    const updated = await this.prisma.taxDefinition.update({
      where: { id: existing.id },
      data: {
        code: dto.code,
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
      oldValues: { code: existing.code, name: existing.name, rate: Number(existing.rate), isActive: existing.isActive },
      newValues: { code: updated.code, name: updated.name, rate: Number(updated.rate), isActive: updated.isActive },
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
