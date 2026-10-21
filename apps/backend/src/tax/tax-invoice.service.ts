import * as crypto from 'node:crypto';
import { Prisma, MoadianSubmissionStatus, SalesTaxInvoiceStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit.dto';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../common/errors';
import { SequencesService } from '../sequences/sequences.service';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { MOADIAN_ADAPTER, MoadianAdapter, MoadianPacket } from './moadian/moadian-adapter';

const PACKET_TYPE = 'INVOICE.V01';

/**
 * Phase 8 — Sales tax invoices + Moadian submission lifecycle.
 *
 * Design invariants (docs/08):
 *  - A tax invoice is a REPORTING layer over a COMPLETED sales document. No
 *    accounting journals here — tax/revenue were already booked by loading
 *    events (docs/05 §7, ratified boundary).
 *  - Quantities come from LOADING allocations (tax_invoiced_quantity ≠
 *    ordered_quantity), REQUIREMENTS §tax_invoiced_quantity.
 *  - Submission state machine: DRAFT → READY → SENDING (atomic claim) →
 *    SUBMITTED → (inquiry) SUCCESS | FAILED → retry (retry=true) → SENDING…
 *  - Every send attempt is a SalesTaxInvoiceSubmission row with a globally
 *    unique uid — duplicates are impossible both app-side (status claim) and
 *    DB-side (uid UNIQUE).
 *  - Moadian config: MOADIAN_MODE=mock (default) | sandbox | live. sandbox/
 *    live require runtime credentials that are NEVER stored in the repo.
 */
@Injectable()
export class TaxInvoiceService {
  private readonly logger = new Logger('TaxInvoiceService');
  private readonly adapter: MoadianAdapter;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sequences: SequencesService,
    private readonly audit: AuditService,
    @Inject(MOADIAN_ADAPTER) adapter: MoadianAdapter,
  ) {
    this.adapter = adapter;
  }

  // ─── creation ────────────────────────────────────────────────────────────

  /**
   * Build a DRAFT tax invoice from a sales document: lines snapshot the
   * sales-line tax data, quantities = SUM(loading allocations) per line
   * (tax_invoiced_quantity), VAT per line from the tax rate snapshot.
   */
  async createFromSalesDocument(
    companyId: string,
    input: {
      salesDocumentId: string;
      subject?: 'MAIN' | 'CORRECTIVE' | 'CANCEL' | 'RETURN';
      issueDate?: Date;
      lineOverrides?: Array<{ salesLineId: string; quantity: string }>;
    },
    actor: { id: string; username: string },
  ) {
    const doc = await this.prisma.salesDocument.findFirst({
      where: { id: input.salesDocumentId, companyId },
      include: { customer: true, lines: { orderBy: { lineOrder: 'asc' }, include: { productVariant: true, uom: true, taxDefinition: true } } },
    });
    if (!doc) throw new NotFoundError('Sales document not found', { salesDocumentId: input.salesDocumentId });
    if (doc.status !== 'COMPLETED') {
      throw new ValidationError('TAX_INVOICE_SOURCE_NOT_COMPLETED', { status: doc.status });
    }
    if (!doc.customer.economicCode && !doc.customer.nationalId && !doc.customer.nationalCode) {
      throw new ValidationError('TAX_INVOICE_CUSTOMER_IDENTITY_MISSING', { customerPartyId: doc.customerPartyId });
    }

    const loadedByLine = new Map<string, Prisma.Decimal>();
    const allocations = (
      await this.prisma.loadingAllocation.findMany({
        where: { companyId, salesLineId: { in: doc.lines.map((l) => l.id) } },
        select: { salesLineId: true, allocatedQuantity: true },
      })
    ).filter((a): a is typeof a & { salesLineId: string } => !!a.salesLineId);
    for (const a of allocations) {
      loadedByLine.set(
        a.salesLineId,
        (loadedByLine.get(a.salesLineId) ?? new Prisma.Decimal(0)).plus(
          a.allocatedQuantity ?? new Prisma.Decimal(0),
        ),
      );
    }

    const overrideByLine = new Map(
      (input.lineOverrides ?? []).map((o) => [o.salesLineId, new Prisma.Decimal(o.quantity)]),
    );
    const lines = doc.lines.map((line) => {
      const quantity = overrideByLine.get(line.id) ?? loadedByLine.get(line.id) ?? new Prisma.Decimal(0);
      const gross = new Prisma.Decimal(line.unitPrice).times(quantity);
      const discount = new Prisma.Decimal(line.discountAmount);
      const net = gross.minus(discount);
      const vra = new Prisma.Decimal(line.taxRateSnapshot ?? 0);
      const vam = net.times(vra).dividedBy(100);
      return {
        salesLineId: line.id,
        sstid: null as string | null, // official service code — mapped from the goods list at send time (documented gap)
        description: line.printableDescription ?? line.productVariant.nameFa,
        mu: line.uom.symbol,
        quantity,
        unitPrice: new Prisma.Decimal(line.unitPrice),
        prdis: gross,
        dis: discount,
        adis: new Prisma.Decimal(0),
        vra,
        vam,
        tsstam: vam,
        lineOrder: line.lineOrder,
      };
    });
    if (lines.every((l) => l.quantity.isZero())) {
      throw new ValidationError('TAX_INVOICE_NO_INVOICED_QUANTITY', { salesDocumentId: input.salesDocumentId });
    }

    const subtotal = lines.reduce((s, l) => s.plus(l.prdis), new Prisma.Decimal(0));
    const discountTotal = lines.reduce((s, l) => s.plus(l.dis), new Prisma.Decimal(0));
    const taxTotal = lines.reduce((s, l) => s.plus(l.vam), new Prisma.Decimal(0));
    const grandTotal = subtotal.minus(discountTotal).plus(taxTotal);

    const { number } = await this.sequences.allocate(companyId, 'SALES_TAX_INVOICE', this.prisma);
    const invoice = await this.prisma.salesTaxInvoice.create({
      data: {
        companyId,
        number,
        status: 'READY',
        subject: input.subject ?? 'MAIN',
        customerPartyId: doc.customerPartyId,
        issueDate: input.issueDate ?? new Date(),
        subtotal,
        discountTotal,
        taxTotal,
        grandTotal,
        createdBy: actor.id,
        lines: { create: lines.map((l) => ({ ...l, companyId })) },
        salesAllocations: {
          create: { companyId, salesDocumentId: doc.id, allocatedAmount: grandTotal },
        },
      },
      include: { lines: true },
    });
    await this.audit.record({
      entityType: 'sales_tax_invoice',
      entityId: invoice.id,
      action: AuditAction.CREATE,
      companyId,
      actor,
      newValues: { number, salesDocumentId: input.salesDocumentId, grandTotal: grandTotal.toString() },
    });
    return invoice;
  }

  async list(
    companyId: string,
    query: { page?: number; pageSize?: number; status?: SalesTaxInvoiceStatus; from?: Date; to?: Date; customerId?: string },
  ) {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(Math.max(query.pageSize ?? 20, 1), 100);
    const where: Prisma.SalesTaxInvoiceWhereInput = {
      companyId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.customerId ? { customerPartyId: query.customerId } : {}),
      ...(query.from || query.to
        ? { issueDate: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.salesTaxInvoice.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { customer: { select: { nameFa: true } } },
      }),
      this.prisma.salesTaxInvoice.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  async getById(companyId: string, id: string) {
    const invoice = await this.prisma.salesTaxInvoice.findFirst({
      where: { id, companyId },
      include: {
        customer: { select: { nameFa: true, nationalId: true, economicCode: true, nationalCode: true } },
        lines: { orderBy: { lineOrder: 'asc' } },
        submissions: { orderBy: { sentAt: 'desc' } },
        salesAllocations: true,
      },
    });
    if (!invoice) throw new NotFoundError('Tax invoice not found', { id });
    return invoice;
  }

  // ─── submission lifecycle ────────────────────────────────────────────────

  /** Atomic claim: only one concurrent caller can move READY→SENDING. */
  async send(companyId: string, invoiceId: string, actor: { id: string; username: string }) {
    const invoice = await this.prisma.salesTaxInvoice.findFirst({
      where: { id: invoiceId, companyId },
      include: { lines: true, customer: true },
    });
    if (!invoice) throw new NotFoundError('Tax invoice not found', { invoiceId });
    if (invoice.status === 'SENDING') {
      throw new ConflictError('TAX_INVOICE_SEND_IN_PROGRESS');
    }
    if (invoice.status !== 'READY' && invoice.status !== 'FAILED') {
      throw new ConflictError('TAX_INVOICE_NOT_SENDABLE', { status: invoice.status });
    }
    const isRetry = invoice.status === 'FAILED';
    // atomic claim (like the loading allocation pattern): READY/FAILED → SENDING
    const claimed = await this.prisma.salesTaxInvoice.updateMany({
      where: { id: invoiceId, companyId, status: { in: ['READY', 'FAILED'] } },
      data: { status: 'SENDING' },
    });
    if (claimed.count === 0) throw new ConflictError('TAX_INVOICE_SEND_IN_PROGRESS');

    const attemptRow = await this.prisma.salesTaxInvoiceSubmission.findFirst({
      where: { invoiceId, companyId },
      orderBy: { attempt: 'desc' },
      select: { attempt: true },
    });
    const attempt = (attemptRow?.attempt ?? 0) + 1;
    const uid = crypto.randomUUID();

    const packets: MoadianPacket[] = [
      {
        uid,
        packetType: PACKET_TYPE,
        retry: isRetry,
        data: JSON.stringify(this.buildPayload(invoice)),
        encryptionKeyId: '',
        symmetricKey: '',
        iv: '',
        fiscalId: process.env.MOADIAN_FISCAL_ID ?? '',
        dataSignature: '',
      },
    ];

    const submission = await this.prisma.salesTaxInvoiceSubmission.create({
      data: {
        companyId,
        invoiceId,
        uid,
        attempt,
        retry: isRetry,
        status: 'PENDING',
        payloadSnapshot: { packets } as unknown as Prisma.InputJsonValue,
      },
    });

    try {
      const responses = await this.adapter.enqueue(packets);
      const response = responses[0];
      await this.prisma.salesTaxInvoiceSubmission.update({
        where: { id: submission.id },
        data: {
          status: 'PENDING',
          referenceNumber: response?.referenceNumber || null,
          errorCode: response?.errorCode || null,
          errorDetail: response?.errorDetail || null,
        },
      });
      if (response?.errorCode) {
        // transport-level rejection (bad request, duplicate uid, too large…)
        await this.prisma.salesTaxInvoice.update({
          where: { id: invoiceId },
          data: {
            status: 'FAILED',
            moadianStatus: 'FAILED',
            moadianError: `${response.errorCode}: ${response.errorDetail ?? ''}`,
            referenceNumber: response.referenceNumber || null,
          },
        });
        await this.audit.record({
          entityType: 'sales_tax_invoice',
          entityId: invoiceId,
          action: AuditAction.UPDATE,
          companyId,
          actor,
          oldValues: { status: 'SENDING' },
          newValues: { status: 'FAILED', errorCode: response.errorCode },
        });
        return { status: 'FAILED' as const, submissionId: submission.id, errorCode: response.errorCode };
      }
      await this.prisma.salesTaxInvoice.update({
        where: { id: invoiceId },
        data: {
          status: 'SUBMITTED',
          moadianStatus: 'PENDING',
          moadianError: null,
          referenceNumber: response?.referenceNumber || null,
        },
      });
      await this.audit.record({
        entityType: 'sales_tax_invoice',
        entityId: invoiceId,
        action: AuditAction.UPDATE,
        companyId,
        actor,
        newValues: { uid, attempt, referenceNumber: response?.referenceNumber ?? null, retry: isRetry },
      });
      return { status: 'SUBMITTED' as const, submissionId: submission.id, uid, referenceNumber: response?.referenceNumber ?? null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.prisma.salesTaxInvoiceSubmission.update({
        where: { id: submission.id },
        data: { status: 'FAILED', errorDetail: message },
      });
      await this.prisma.salesTaxInvoice.update({
        where: { id: invoiceId },
        data: { status: 'FAILED', moadianStatus: 'FAILED', moadianError: message },
      });
      return { status: 'FAILED' as const, submissionId: submission.id, errorCode: 'TRANSPORT' };
    }
  }

  /** INQUIRY_BY_UID over recent submissions → updates invoice + submissions. */
  async inquiry(companyId: string, invoiceId: string) {
    const invoice = await this.prisma.salesTaxInvoice.findFirst({
      where: { id: invoiceId, companyId },
      include: { submissions: { where: { status: 'PENDING' }, orderBy: { attempt: 'desc' } } },
    });
    if (!invoice) throw new NotFoundError('Tax invoice not found', { invoiceId });
    const pending = invoice.submissions;
    if (pending.length === 0) throw new ConflictError('TAX_INVOICE_NO_PENDING_SUBMISSION');
    const results = await this.adapter.inquiryByUid(pending.map((s) => s.uid));
    let finalStatus: SalesTaxInvoiceStatus | null = null;
    for (const result of results) {
      const submission = pending.find((s) => s.uid === result.uid);
      if (!submission) continue;
      if (result.status === 'PENDING') continue;
      await this.prisma.salesTaxInvoiceSubmission.update({
        where: { id: submission.id },
        data: {
          status: result.status,
          errorCode: result.errorCode || null,
          errorDetail: result.errorDetail || null,
          confirmationReferenceId: result.confirmationReferenceId || null,
          taxResult: result.taxResult || null,
          inquiredAt: new Date(),
        },
      });
      if (result.status === 'SUCCESS') {
        await this.prisma.salesTaxInvoice.update({
          where: { id: invoiceId },
          data: {
            status: 'SUCCESS',
            moadianStatus: 'SUCCESS',
            moadianError: null,
            confirmationReferenceId: result.confirmationReferenceId || null,
            taxResult: result.taxResult || null,
          },
        });
        finalStatus = 'SUCCESS';
      } else {
        await this.prisma.salesTaxInvoice.update({
          where: { id: invoiceId },
          data: { status: 'FAILED', moadianStatus: 'FAILED', moadianError: `${result.errorCode}: ${result.errorDetail ?? ''}` },
        });
        finalStatus = 'FAILED';
      }
    }
    return { status: finalStatus ?? 'PENDING' };
  }

  // ─── Moadian payload (official template mapping) ─────────────────────────

  /** Header/body/payment mapping per the official invoice template. Field
   *  names follow the fetched technical instruction; the header `taxid` is
   *  set by the adapter when fiscal key material is configured. */
  private buildPayload(invoice: {
    number: string;
    subject: 'MAIN' | 'CORRECTIVE' | 'CANCEL' | 'RETURN';
    issueDate: Date;
    customer: { nameFa: string; nationalId: string | null; economicCode: string | null; nationalCode: string | null };
    subtotal: Prisma.Decimal;
    discountTotal: Prisma.Decimal;
    taxTotal: Prisma.Decimal;
    grandTotal: Prisma.Decimal;
    lines: Array<{
      sstid: string | null;
      description: string;
      mu: string | null;
      quantity: Prisma.Decimal;
      unitPrice: Prisma.Decimal;
      prdis: Prisma.Decimal;
      dis: Prisma.Decimal;
      adis: Prisma.Decimal;
      vra: Prisma.Decimal;
      vam: Prisma.Decimal;
      tsstam: Prisma.Decimal;
    }>;
  }) {
    const subjectMap: Record<string, number> = { MAIN: 1, CORRECTIVE: 2, CANCEL: 3, RETURN: 4 };
    return {
      header: {
        inno: invoice.number,
        inty: 1, // type 1 = فروش (types 2/3 are corrective/purchase per the official spec)
        ins: subjectMap[invoice.subject] ?? 1,
        indatim: invoice.issueDate.toISOString().slice(0, 10),
        tins: invoice.customer.nationalId ?? invoice.customer.nationalCode ?? null,
        tob: 1, // business type: حقوقی/حقیقی — refined at send time from party data
        tprdis: invoice.subtotal.toString(),
        tdis: invoice.discountTotal.toString(),
        tadis: invoice.discountTotal.toString(),
        tvam: invoice.taxTotal.toString(),
        tbill: invoice.grandTotal.toString(),
      },
      body: invoice.lines.map((l) => ({
        sstid: l.sstid,
        sstt: l.description,
        mu: l.mu,
        am: l.quantity.toString(),
        fee: l.unitPrice.toString(),
        cfee: l.unitPrice.toString(),
        prdis: l.prdis.toString(),
        dis: l.dis.toString(),
        adis: l.adis.toString(),
        vra: l.vra.toString(),
        vam: l.vam.toString(),
        tsstam: l.tsstam.toString(),
      })),
      payment: [],
    };
  }

  // ─── purchase tax invoices (received from suppliers) ─────────────────────

  async registerPurchase(
    companyId: string,
    input: { supplierPartyId: string; supplierInvoiceNumber: string; invoiceDate: Date; total: string; taxTotal: string },
    actor: { id: string; username: string },
  ) {
    const { number } = await this.sequences.allocate(companyId, 'PURCHASE_TAX_INVOICE', this.prisma);
    const invoice = await this.prisma.purchaseTaxInvoice.create({
      data: {
        companyId,
        number,
        supplierPartyId: input.supplierPartyId,
        supplierInvoiceNumber: input.supplierInvoiceNumber,
        invoiceDate: input.invoiceDate,
        total: new Prisma.Decimal(input.total),
        taxTotal: new Prisma.Decimal(input.taxTotal),
        registeredBy: actor.id,
      },
    });
    await this.audit.record({
      entityType: 'purchase_tax_invoice',
      entityId: invoice.id,
      action: AuditAction.CREATE,
      companyId,
      actor,
      newValues: { number, supplierInvoiceNumber: input.supplierInvoiceNumber },
    });
    return invoice;
  }

  async listPurchase(
    companyId: string,
    query: { page?: number; pageSize?: number; supplierId?: string },
  ) {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(Math.max(query.pageSize ?? 20, 1), 100);
    const where: Prisma.PurchaseTaxInvoiceWhereInput = {
      companyId,
      ...(query.supplierId ? { supplierPartyId: query.supplierId } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.purchaseTaxInvoice.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { supplier: { select: { nameFa: true } } },
      }),
      this.prisma.purchaseTaxInvoice.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  /** Moadian registration status of a sales order (REQUIREMENTS §1211). */
  async salesDocumentMoadianStatus(companyId: string, salesDocumentId: string) {
    const doc = await this.prisma.salesDocument.findFirst({
      where: { id: salesDocumentId, companyId },
      select: { id: true, total: true },
    });
    if (!doc) throw new NotFoundError('Sales document not found', { salesDocumentId });
    const allocations = await this.prisma.salesTaxInvoiceOrderAllocation.findMany({
      where: { companyId, salesDocumentId },
      include: { salesTaxInvoice: { select: { status: true, moadianStatus: true, number: true } } },
    });
    const registered = allocations.filter(
      (a) => a.salesTaxInvoice && ['SUCCESS', 'SUBMITTED'].includes(a.salesTaxInvoice.status),
    );
    const covered = registered.reduce(
      (s, a) => s.plus(a.allocatedAmount),
      new Prisma.Decimal(0),
    );
    const total = new Prisma.Decimal(doc.total);
    const coveredPct = total.isZero() ? null : covered.dividedBy(total).times(100).toDecimalPlaces(2);
    const moadianStatus =
      registered.length === 0
        ? 'Not Registered'
        : covered.gte(total) && !total.isZero()
          ? 'Fully Registered'
          : 'Partially Registered';
    return {
      moadianStatus,
      invoiceCount: registered.length,
      coveredAmount: covered,
      coveredPct,
      allocations,
    };
  }

  /** Salesperson guard (REQUIREMENTS: salesperson has no tax invoice access). */
  assertNotSalespersonOnly(permissions: string[]) {
    if (permissions.includes('sales.view') && !permissions.includes('tax.view')) {
      throw new ForbiddenError('TAX_INVOICE_ACCESS_FORBIDDEN');
    }
  }
}
