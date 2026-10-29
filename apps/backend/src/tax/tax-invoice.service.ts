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
  /** Serializes concurrent creations for the SAME sales document — two
   *  simultaneous creates must not both pass the remaining-quantity check.
   *  (In-process gate: deployment is single-instance; cross-instance gap is
   *  documented in docs/08. pg_advisory_xact_lock was verified NOT to
   *  serialize concurrent same-client interactive transactions.) */
  private readonly creationGates = new Map<string, Promise<unknown>>();

  async createFromSalesDocument(
    companyId: string,
    input: {
      salesDocumentId: string;
      subject?: 'MAIN' | 'CORRECTIVE' | 'CANCEL' | 'RETURN';
      issueDate?: Date;
      relatedTaxid?: string; // original invoice taxid for CORRECTIVE/CANCEL/RETURN
      lineOverrides?: Array<{ salesLineId: string; quantity: string }>;
      // official جدول ۲: sstid is a REQUIRED body field per line — the caller
      // supplies the product→goods-code mapping resolved from the registered
      // goods list (GET_SERVICE_STUFF_LIST); unmapped lines block submission
      lineSstids?: Array<{ salesLineId: string; sstid: string }>;
    },
    actor: { id: string; username: string },
  ) {
    const prev = this.creationGates.get(input.salesDocumentId) ?? Promise.resolve();
    const gate = prev.catch(() => undefined).then(() => this.doCreate(companyId, input, actor));
    this.creationGates.set(input.salesDocumentId, gate);
    try {
      return await gate;
    } finally {
      if (this.creationGates.get(input.salesDocumentId) === gate) this.creationGates.delete(input.salesDocumentId);
    }
  }

  private async doCreate(
    companyId: string,
    input: {
      salesDocumentId: string;
      subject?: 'MAIN' | 'CORRECTIVE' | 'CANCEL' | 'RETURN';
      issueDate?: Date;
      relatedTaxid?: string;
      lineOverrides?: Array<{ salesLineId: string; quantity: string }>;
      lineSstids?: Array<{ salesLineId: string; sstid: string }>;
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
    const subject = input.subject ?? 'MAIN';
    if (subject !== 'MAIN' && !input.relatedTaxid) {
      // official template: corrective/cancel/return invoices must reference
      // the original invoice's taxid (irtaxid header field)
      throw new ValidationError('TAX_INVOICE_RELATED_TAXID_REQUIRED', { subject });
    }
    // official format: a 22-char alphanumeric taxid is mandatory for
    // non-MAIN subjects (fifteenth review)
    if (subject !== 'MAIN' && input.relatedTaxid && !/^[A-Z0-9]{22}$/.test(input.relatedTaxid)) {
      throw new ValidationError('TAX_INVOICE_RELATED_TAXID_INVALID', { relatedTaxid: input.relatedTaxid });
    }
    // inty: a corrective/cancel/return invoice has the SAME type as the
    // original it adjusts (they are tied via irtaxid); MAIN derives from the
    // buyer's economic-operator status
    let inty: 1 | 2 | 3 = this.deriveInty(subject, doc.customer, input.relatedTaxid);
    if (subject !== 'MAIN' && input.relatedTaxid) {
      const original = await this.prisma.salesTaxInvoice.findFirst({
        where: { companyId, taxid: input.relatedTaxid },
        select: { inty: true, status: true },
      });
      if (original && original.status === 'CANCELLED') {
        throw new ValidationError('TAX_INVOICE_REFERENCE_CANCELLED', { relatedTaxid: input.relatedTaxid });
      }
      if (original) inty = original.inty as 1 | 2 | 3;
      // external references (not in our DB) are accepted: the authority
      // performs the final validation of externally-issued taxids
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

    // Over-invoicing guard (Critical Tax Audit + sixteenth review): only
    // MAIN-subject invoices consume the loading-based issuance cap.
    // CORRECTIVE/CANCEL/RETURN invoices are REFERENCE-LINKED adjustments of
    // an existing submission — they never count as newly issued quantity or
    // discount here (an explicit design decision: reference-linked subjects
    // do not touch the cap). CANCELLED invoices are excluded, so cancelling
    // frees the quantity for re-issuance (p8-12).
    const priorLines = await this.prisma.salesTaxInvoiceLine.findMany({
      where: {
        companyId,
        salesLineId: { in: doc.lines.map((l) => l.id) },
        salesTaxInvoice: { status: { not: 'CANCELLED' }, subject: 'MAIN' },
      },
      select: { salesLineId: true, quantity: true, dis: true },
    });
    const issuedByLine = new Map<string, Prisma.Decimal>();
    const issuedDiscountByLine = new Map<string, Prisma.Decimal>();
    for (const l of priorLines) {
      if (!l.salesLineId) continue;
      issuedByLine.set(l.salesLineId, (issuedByLine.get(l.salesLineId) ?? new Prisma.Decimal(0)).plus(l.quantity));
      // cumulative discount allocation: prior stages' applied discounts
      issuedDiscountByLine.set(
        l.salesLineId,
        (issuedDiscountByLine.get(l.salesLineId) ?? new Prisma.Decimal(0)).plus(l.dis),
      );
    }

    // The remaining-quantity cap applies to MAIN invoices only — corrective/
    // cancel/return invoices ADJUST a prior invoice (they reference it via
    // relatedTaxid) and do not consume fresh loaded quantity.
    const enforceCap = (input.subject ?? 'MAIN') === 'MAIN';
    const lines: Array<{
      salesLineId: string;
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
      lineOrder: number;
    }> = [];
    for (const line of doc.lines) {
      const requested = overrideByLine.get(line.id) ?? loadedByLine.get(line.id) ?? new Prisma.Decimal(0);
      const alreadyIssued = issuedByLine.get(line.id) ?? new Prisma.Decimal(0);
      const remaining = new Prisma.Decimal(loadedByLine.get(line.id) ?? 0).minus(alreadyIssued);
      if (enforceCap && requested.gt(remaining)) {
        throw new ValidationError('TAX_INVOICE_QUANTITY_EXCEEDED', {
          salesLineId: line.id,
          requested: requested.toString(),
          remaining: remaining.toString(),
        });
      }
      if (enforceCap && remaining.isZero() && requested.isZero()) continue; // nothing left to invoice on this line
      const quantity = requested;
      // official RC_IITP.IS_V7.9 قاعده عمومی مبالغ (صفحه مبانی): «تمامی مقادیر
      // ریالی و ارزی می‌بایست، با احتساب رقم اعشار ذکر شده در سند و با روش
      // قطع کردن (TRUNCATION) محاسبه و در صورتحساب ثبت گردد» — فیلدهای ریالی
      // سرآیند/بدنه با دقت ۱۸ رقم صحیح و ۰ رقم اعشار تعریف شده‌اند.
      const truncateRial = (value: Prisma.Decimal) => value.truncated();
      const gross = truncateRial(new Prisma.Decimal(line.unitPrice).times(quantity));
      // PARTIAL-INVOICE DISCOUNT ALLOCATION (fifteenth review): the sales
      // line's discountAmount is the TOTAL discount for the whole ordered
      // quantity. CUMULATIVE allocation — each stage receives TRUNCATE(
      // discountAmount × cumulativeQty ÷ orderedQty) minus prior stages' dis:
      // a partial invoice never re-applies the full discount AND the final
      // stage exactly exhausts it (no drift, no over-allocation)
      const orderedQuantity = new Prisma.Decimal(line.orderedQuantity);
      const cumulativeQuantity = (issuedByLine.get(line.id) ?? new Prisma.Decimal(0)).plus(quantity);
      const cumulativeDiscount = orderedQuantity.isZero()
        ? new Prisma.Decimal(0)
        : truncateRial(new Prisma.Decimal(line.discountAmount).times(cumulativeQuantity).dividedBy(orderedQuantity));
      const discount = cumulativeDiscount.minus(
        issuedDiscountByLine.get(line.id) ?? new Prisma.Decimal(0),
      );
      const net = gross.minus(discount);
      const vra = new Prisma.Decimal(line.taxRateSnapshot ?? 0);
      const vam = truncateRial(net.times(vra).dividedBy(100));
      // official RC_IITP.IS_V7.9 line formulas (جدول ۲ + فرمول‌های کنترلی):
      //   adis (Is)   = Es − Gs  = prdis − dis   (مبلغ بعد از تخفیف)
      //   vam  (Ks)   = TRUNCATE(adis × vra / 100)
      //   tsstam (Os) = Ks + Is  = vam + adis    (مبلغ کل کالا/خدمت)
      // نمونه رسمی دستورالعمل: prdis=20000, dis=500, adis=19500, vam=1755,
      // tsstam=21255 (= 19500 + 1755)
      const adis = net;
      const tsstam = adis.plus(vam);
      lines.push({
        salesLineId: line.id,
        sstid: input.lineSstids?.find((m) => m.salesLineId === line.id)?.sstid ?? null,
        description: line.printableDescription ?? line.productVariant.nameFa,
        // official جدول ۲: mu is the authority's unit CODE — mapped per UOM;
        // the internal symbol is never sent (unmapped -> submission blocked)
        mu: line.uom.moadianUnitCode ?? null,
        quantity,
        unitPrice: new Prisma.Decimal(line.unitPrice),
        prdis: gross,
        dis: discount,
        adis,
        vra,
        vam,
        tsstam,
        lineOrder: line.lineOrder,
      });
    }
    if (lines.length === 0 || lines.every((l) => l.quantity.isZero())) {
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
        subject,
        inty,
        relatedTaxid: input.relatedTaxid ?? null,
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

  /** UNKNOWN-OUTCOME resolution: a SENDING invoice (crashed claim) or a
   *  PENDING submission is reconciled against the authority BEFORE any
   *  resend. Returns the resolved invoice status:
   *  'SUBMITTED' (still pending at the authority — caller waits),
   *  'SUCCESS', or 'FAILED' (safe to retry). Newer attempt outcomes always
   *  win over older ones — stale responses never overwrite newer state.
   *
   *  RECOVERY CONSISTENCY (ninth review): every submission+invoice state
   *  transition is ONE database transaction — a partial write (submission
   *  terminal while the invoice stays stale) can never be persisted. A
   *  database failure during recovery is INCONCLUSIVE ('SUBMITTED' → the
   *  caller waits; it must NEVER be read as safe-to-retry). With NO PENDING
   *  submission, the latest persisted attempt is reconciled against the
   *  parent invoice: an accepted (SUCCESS) attempt repairs the invoice and
   *  NEVER unlocks a new send; only an AUTHORITATIVE FAILED attempt unlocks
   *  the official retry. */
  private async recoverPending(
    companyId: string,
    invoiceId: string,
  ): Promise<'SUBMITTED' | 'SUCCESS' | 'FAILED'> {
    const invoiceMeta = await this.prisma.salesTaxInvoice.findUniqueOrThrow({
      where: { id: invoiceId },
      select: { subject: true, relatedTaxid: true },
    });
    const pending = await this.prisma.salesTaxInvoiceSubmission.findMany({
      where: { invoiceId, companyId, status: 'PENDING' },
      orderBy: { attempt: 'desc' },
    });
    if (pending.length > 0) {
      const results = await this.adapter.inquiryByUid(pending.map((s) => s.uid));
      const byUid = new Map(results.map((r) => [r.uid, r]));
      const latest = pending[0]; // newest attempt (attempt desc)
      const latestResult = byUid.get(latest.uid);
      for (const submission of pending) {
        const result = byUid.get(submission.uid);
        if (!result || result.status === 'PENDING') continue;
        const isLatest = submission.id === latest.id;
        try {
          // submission + (for the newest attempt) invoice in ONE transaction:
          // either both persist or neither does
          await this.prisma.$transaction(async (tx) => {
            await tx.salesTaxInvoiceSubmission.update({
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
            if (isLatest && result.status === 'SUCCESS') {
              await tx.salesTaxInvoice.update({
                where: { id: invoiceId },
                data: {
                  status: 'SUCCESS',
                  moadianStatus: 'SUCCESS',
                  moadianError: null,
                  confirmationReferenceId: result.confirmationReferenceId || null,
                  taxResult: result.taxResult || null,
                },
              });
              // ابطالی confirmed → free the referenced original's quantity
              if (invoiceMeta.subject === 'CANCEL') {
                await this.cancelReferencedOriginal(tx, companyId, invoiceMeta.relatedTaxid);
              }
            } else if (isLatest && result.status === 'FAILED') {
              await tx.salesTaxInvoice.update({
                where: { id: invoiceId },
                data: {
                  status: 'FAILED',
                  moadianStatus: 'FAILED',
                  moadianError: `${result.errorCode ?? ''}: ${result.errorDetail ?? ''}`,
                },
              });
            }
          });
        } catch {
          // local persistence failed AFTER the remote answer: the transaction
          // rolled back BOTH writes, the submission stays PENDING with its
          // durable uid — an INCONCLUSIVE state. The caller waits; retrying
          // over an unknown outcome is forbidden.
          return 'SUBMITTED';
        }
      }
      if (latestResult?.status === 'SUCCESS') return 'SUCCESS';
      if (latestResult?.status === 'FAILED') return 'FAILED';
      return 'SUBMITTED';
    }

    // NO PENDING submission: an empty query is NOT proof that retry is safe
    // (a partially-persisted SUCCESS would otherwise unlock a duplicate).
    // Reconcile the latest persisted attempt's terminal state with the
    // parent invoice (ninth review #2).
    const invoiceRow = await this.prisma.salesTaxInvoice.findUniqueOrThrow({
      where: { id: invoiceId },
      select: { status: true, subject: true, relatedTaxid: true, confirmationReferenceId: true, taxResult: true },
    });
    const latestAny = await this.prisma.salesTaxInvoiceSubmission.findFirst({
      where: { invoiceId, companyId },
      orderBy: { attempt: 'desc' },
    });
    if (!latestAny) {
      // genuinely nothing was ever sent — no uid exists. A stale SENDING
      // status can only come from a crashed claim before any packet existed:
      // restore READY so the next send is a normal (retry=false) first attempt.
      if (invoiceRow.status === 'SENDING') {
        await this.prisma.salesTaxInvoice
          .update({ where: { id: invoiceId }, data: { status: 'READY' } })
          .catch(() => undefined);
      }
      return 'FAILED';
    }
    if (latestAny.status === 'SUCCESS') {
      // an ACCEPTED attempt exists — repair any stale invoice status and
      // NEVER unlock a new send over an accepted uid. For an ابطالی invoice
      // the repair and the referenced-original cancellation commit TOGETHER
      // (eighteenth review #3): a torn SUCCESS-without-cancellation state is
      // reconciled here idempotently, without any new submission.
      const repairSuccess = async (tx: Prisma.TransactionClient | PrismaService) => {
        await tx.salesTaxInvoice.update({
          where: { id: invoiceId },
          data: {
            status: 'SUCCESS',
            moadianStatus: 'SUCCESS',
            moadianError: null,
            confirmationReferenceId: latestAny.confirmationReferenceId || invoiceRow.confirmationReferenceId || null,
            taxResult: latestAny.taxResult || invoiceRow.taxResult || null,
          },
        });
        if (invoiceRow.subject === 'CANCEL') {
          await this.cancelReferencedOriginal(tx, companyId, invoiceRow.relatedTaxid);
        }
      };
      // BOTH branches run through a Prisma transaction (nineteenth review):
      // the invoice repair and the referenced-original cancellation commit or
      // roll back together — a persistence failure is INCONCLUSIVE
      // ('SUBMITTED'), never a completed recovery and never an authorization
      // to re-submit; the authority's persisted SUCCESS record stays intact
      try {
        await this.prisma.$transaction(repairSuccess);
      } catch {
        return 'SUBMITTED';
      }
      return 'SUCCESS';
    }
    if (latestAny.status === 'FAILED') {
      // an AUTHORITATIVE rejection is recorded — repair a stale in-flight
      // invoice status so the official retry can proceed
      if (invoiceRow.status === 'SENDING' || invoiceRow.status === 'SUBMITTED') {
        try {
          await this.prisma.salesTaxInvoice.update({
            where: { id: invoiceId },
            data: {
              status: 'FAILED',
              moadianStatus: 'FAILED',
              moadianError: latestAny.errorCode
                ? `${latestAny.errorCode}: ${latestAny.errorDetail ?? ''}`
                : latestAny.errorDetail ?? null,
            },
          });
        } catch {
          return 'SUBMITTED'; // repair failed → inconclusive, wait
        }
      }
      return 'FAILED';
    }
    return 'SUBMITTED'; // PENDING latest (defensive) → wait
  }

  /** Atomic claim: only one concurrent caller can move READY→SENDING.
   *  UNKNOWN-OUTCOME SAFETY: if a previous attempt is still PENDING (its
   *  result never became final — e.g. timeout after the authority accepted
   *  the packet), send() NEVER blindly resends. It inquires the pending uid
   *  first: PENDING → caller waits; SUCCESS → invoice promoted; FAILED →
   *  safe retry proceeds. Duplicate-response 5005 (duplicate.request.uid)
   *  is treated as ALREADY ACCEPTED, not a failure. */
  async send(
    companyId: string,
    invoiceId: string,
    actor: { id: string; username: string },
  ): Promise<
    | { status: 'SUBMITTED' | 'SUCCESS' | 'FAILED'; submissionId?: string; uid?: string; referenceNumber?: string | null; errorCode?: string; awaitingInquiry?: boolean; recoveredLateSuccess?: boolean }
  > {
    const invoice = await this.prisma.salesTaxInvoice.findFirst({
      where: { id: invoiceId, companyId },
      include: { lines: true, customer: { select: { type: true, nameFa: true, nationalId: true, economicCode: true, nationalCode: true } } },
    });
    if (!invoice) throw new NotFoundError('Tax invoice not found', { invoiceId });
    // official RC_IITP.IS_V7.9 جدول ۲: tins = the SELLER's registered economic
    // code and MUST match the taxpayer's own records — taken from the
    // authoritative company configuration, never from the buyer
    const sellerCompany = await this.prisma.company.findUniqueOrThrow({
      where: { id: companyId },
      select: { economicCode: true },
    });
    const sellerEconomicCode = sellerCompany.economicCode ?? null;
    // authoritative-failure tracking: recoverPending() may resolve a prior
    // attempt to FAILED — the OFFICIAL retry=true flag must reflect the
    // post-recovery state, not the stale pre-call snapshot
    let authoritativeFailure = false;
    if (invoice.status === 'SENDING') {
      // crash/timeout recovery path: a prior claim never completed — check
      // its pending submissions instead of blocking forever
      const recovered = await this.recoverPending(companyId, invoiceId);
      if (recovered === 'SUBMITTED') {
        // the authority still holds the packet unresolved — never resend
        throw new ConflictError('TAX_INVOICE_SEND_IN_PROGRESS');
      }
      if (recovered === 'SUCCESS') {
        // late success recovered from the authority — report it, never resend
        return { status: 'SUCCESS' as const, recoveredLateSuccess: true };
      }
      // recovered FAILED — the retry flag depends on WHAT failed: a FAILED
      // row is an authoritative rejection (retry=true); a READY row means
      // nothing was ever sent (crashed claim before any uid existed) and the
      // next send is a normal first attempt
      const row = await this.prisma.salesTaxInvoice.findUniqueOrThrow({
        where: { id: invoiceId },
        select: { status: true },
      });
      authoritativeFailure = row.status === 'FAILED';
    }
    // PRE-GATE reconciliation (nineteenth review): an already-SUCCESS ابطالی
    // invoice may still owe the referenced-original cancellation (a legacy
    // torn state from before the transactional fix). send() itself is gated
    // for SUCCESS invoices, so the idempotent recovery runs here first — the
    // cap frees even though the redundant send is then rejected by the gate.
    if (invoice.status === 'SUCCESS' && invoice.subject === 'CANCEL' && invoice.relatedTaxid) {
      const cancelHistory = await this.prisma.salesTaxInvoiceSubmission.count({
        where: { invoiceId, companyId },
      });
      if (cancelHistory > 0) {
        const verified = await this.recoverPending(companyId, invoiceId);
        if (verified === 'SUBMITTED') {
          // the referenced-original update failed -> inconclusive; the caller
          // retries recovery later (idempotent)
          return { status: 'SUBMITTED' as const, awaitingInquiry: true };
        }
        // verified 'SUCCESS': the reconciliation committed - fall through to
        // the gate, which rejects the redundant send of an accepted invoice
      }
    }

    // strict sendable gate: a SUBMITTED invoice always goes through
    // inquiry() first (p8-04 contract) — send() can never bypass the
    // authority's unresolved verdict, so no duplicate can be created
    if (invoice.status !== 'READY' && invoice.status !== 'FAILED' && !authoritativeFailure) {
      throw new ConflictError('TAX_INVOICE_NOT_SENDABLE', { status: invoice.status });
    }
    // unknown-outcome guard: a still-PENDING prior submission means the
    // authority may have (or has) the packet — resolve it before resending
    const pendingPrior = await this.prisma.salesTaxInvoiceSubmission.findFirst({
      where: { invoiceId, companyId, status: 'PENDING' },
      orderBy: { attempt: 'desc' },
    });
    if (pendingPrior) {
      const recovered = await this.recoverPending(companyId, invoiceId);
      if (recovered === 'SUBMITTED') {
        // unknown outcome is STILL pending at the authority — wait, no resend
        await this.prisma.salesTaxInvoice.update({
          where: { id: invoiceId },
          data: { status: 'SUBMITTED', moadianStatus: 'PENDING' },
        });
        return { status: 'SUBMITTED' as const, awaitingInquiry: true };
      }
      // recovered SUCCESS (late success) → reflect and stop
      if (recovered === 'SUCCESS') {
        return { status: 'SUCCESS' as const, recoveredLateSuccess: true };
      }
      // prior attempt is definitively FAILED → fall through to a safe retry
      authoritativeFailure = true;
    } else if (invoice.status === 'FAILED') {
      // NO PENDING attempt: an empty PENDING query is not proof that retry is
      // safe (ninth review #2) — a torn partial write may have persisted an
      // ACCEPTED attempt while the invoice shows FAILED. Verify the latest
      // persisted attempt before minting a new uid.
      const hasHistory = await this.prisma.salesTaxInvoiceSubmission.count({
        where: { invoiceId, companyId },
      });
      if (hasHistory > 0) {
        const verified = await this.recoverPending(companyId, invoiceId);
        if (verified === 'SUCCESS') {
          return { status: 'SUCCESS' as const, recoveredLateSuccess: true };
        }
        if (verified === 'SUBMITTED') {
          return { status: 'SUBMITTED' as const, awaitingInquiry: true };
        }
        // verified FAILED: the authority definitively rejected the latest
        // attempt — official retry proceeds
        authoritativeFailure = true;
      }
    }
    const isRetry = authoritativeFailure || invoice.status === 'FAILED';
    // FAIL-SAFE PAYLOAD VALIDATION (final audit #2): the payload is built and
    // fully validated BEFORE any state change — an incomplete payload (unmapped
    // sstid, missing taxid in non-mock mode, inconsistent totals) is rejected
    // with a specific domain error and never reaches the submission lifecycle
    // or the wire. This boundary cannot be bypassed: every submission passes
    // through send().
    const submissionMode = (process.env.MOADIAN_MODE ?? 'mock') as 'mock' | 'sandbox' | 'live';
    const payload = this.buildPayload({ ...invoice, sellerEconomicCode });
    TaxInvoiceService.validateSubmissionPayload(payload, submissionMode !== 'mock');

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
        retry: isRetry, // internal bookkeeping only — official v1.6 wire has no retry field
        data: JSON.stringify(payload),
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
      // official §7/§8: the response uid MUST echo our requestTraceId — an
      // uncorrelated/missing response is an UNKNOWN outcome (safe catch below),
      // never an accepted submission
      const response = responses.find((r) => r.uid === uid);
      if (!response) throw new Error('MOADIAN_INVOICE_RESPONSE_MISMATCH');
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
        // defensive: the official v1.6 submission response carries NO
        // errorCode field — any adapter-surfaced errorCode is unexpected and
        // treated as a transport-level rejection, never as a documented
        // duplicate/retry signal
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
      // AMBIGUOUS OUTCOME (final acceptance audit #4): an enqueue error means
      // the packet MAY have reached the authority — it is NEVER a definitive
      // failure. The submission stays PENDING with its durable uid and the
      // invoice goes SUBMITTED (awaiting inquiry); recoverPending() and the
      // pendingPrior guard reconcile THIS exact uid before any resend, so a
      // blind retry with a NEW uid (→ duplicate invoice at the authority)
      // can never happen. Only an AUTHORITATIVE inquiry result unlocks the
      // official retry (FAILED → new uid, retry=true).
      await this.prisma.salesTaxInvoiceSubmission.update({
        where: { id: submission.id },
        data: { errorCode: 'TRANSPORT', errorDetail: message },
      });
      await this.prisma.salesTaxInvoice.update({
        where: { id: invoiceId },
        data: { status: 'SUBMITTED', moadianStatus: 'PENDING', moadianError: `TRANSPORT: ${message}` },
      });
      return {
        status: 'SUBMITTED' as const,
        submissionId: submission.id,
        uid,
        errorCode: 'TRANSPORT',
        awaitingInquiry: true,
      };
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
    const byUid = new Map(results.map((r) => [r.uid, r]));
    let finalStatus: SalesTaxInvoiceStatus | null = null;
    const latest = pending[0]; // attempt desc → newest attempt
    for (const submission of pending) {
      const result = byUid.get(submission.uid);
      if (!result || result.status === 'PENDING') continue;
      if (submission.id !== latest.id) {
        // stale attempt: its own row only — never the invoice status
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
        continue;
      }
      // newest attempt: submission + invoice in ONE transaction — a failure
      // after the remote answer rolls back BOTH writes and leaves the
      // submission PENDING (recoverable, same uid) instead of a torn state
      // that could later be misread as safe-to-retry (ninth review #3)
      await this.prisma.$transaction(async (tx) => {
        await tx.salesTaxInvoiceSubmission.update({
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
          await tx.salesTaxInvoice.update({
            where: { id: invoiceId },
            data: {
              status: 'SUCCESS',
              moadianStatus: 'SUCCESS',
              moadianError: null,
              confirmationReferenceId: result.confirmationReferenceId || null,
              taxResult: result.taxResult || null,
            },
          });
          // ابطالی confirmed at the authority → the referenced original is
          // now officially cancelled (its issuance quantity is freed)
          if (invoice.subject === 'CANCEL') {
            await this.cancelReferencedOriginal(tx, companyId, invoice.relatedTaxid);
          }
        } else {
          await tx.salesTaxInvoice.update({
            where: { id: invoiceId },
            data: { status: 'FAILED', moadianStatus: 'FAILED', moadianError: `${result.errorCode}: ${result.errorDetail ?? ''}` },
          });
        }
      });
      finalStatus = result.status;
    }
    return { status: finalStatus ?? 'PENDING' };
  }

  // ─── invoice type derivation (official issuance rules) ──────────────────
  /** Official inty semantics (الگوی صورتحساب الکترونیکی، دستورالعمل صدور —
   *  tax.gov.ir): نوع اول (1) = buyer IS a registered economic operator
   *  (کد اقتصادی present); نوع دوم (2) = buyer is a final consumer without
   *  economic code; نوع سوم (3) = export (not implemented). CORRECTIVE/
   *  CANCEL/RETURN invoices inherit the ORIGINAL invoice's type (they adjust
   *  it and carry its taxid via irtaxid); when the original is not in our
   *  system, derive from the buyer. Subject is INDEPENDENT of inty. */
  deriveInty(
    subject: 'MAIN' | 'CORRECTIVE' | 'CANCEL' | 'RETURN',
    buyer: { type: string; economicCode: string | null; nationalId: string | null },
    relatedTaxid?: string | null,
  ): 1 | 2 | 3 {
    if (subject !== 'MAIN' && relatedTaxid) {
      // synchronous best-effort lookup; callers may pre-resolve
    }
    return buyer.economicCode ? 1 : 2;
  }

  /** CANCEL-subject lifecycle (seventeenth review): when an ابطالی invoice
   *  reaches SUCCESS at the authority, the REFERENCED original invoice is
   *  now officially cancelled — mark it CANCELLED (atomic, company-scoped)
   *  so the loading-based issuance cap frees its quantity. Before the
   *  authority confirms (PENDING/IN_PROGRESS) or if the cancellation fails,
   *  the original stays consumed. */
  /** tx: the CALLER's transaction-scoped client — the referenced-original
   *  cancellation commits or rolls back together with the cancellation
   *  invoice + submission state (eighteenth review). `moadianStatus` is NOT
   *  touched: its documented values are PENDING/SUCCESS/FAILED (last
   *  inquiry) — the original's own acceptance state stays intact; the
   *  internal lifecycle state lives in `status = CANCELLED`. Company-scoped
   *  and taxid-scoped: an external/missing reference touches nothing. */
  private async cancelReferencedOriginal(
    tx: Prisma.TransactionClient | PrismaService,
    companyId: string,
    relatedTaxid: string | null,
  ): Promise<void> {
    if (!relatedTaxid) return;
    await tx.salesTaxInvoice.updateMany({
      where: { companyId, taxid: relatedTaxid, status: { not: 'CANCELLED' } },
      data: { status: 'CANCELLED' },
    });
  }

  // ─── Moadian payload (official template mapping) ─────────────────────────

  /** Header/body/payment mapping per the official invoice template. Field
   *  names follow the fetched technical instruction; the header `taxid` is
   *  set by the adapter when fiscal key material is configured. */
  private buildPayload(invoice: {
    number: string;
    taxid: string | null;
    sellerEconomicCode: string | null;
    subject: 'MAIN' | 'CORRECTIVE' | 'CANCEL' | 'RETURN';
    inty: number;
    issueDate: Date;
    createdAt: Date;
    customer: { type: 'COMPANY' | 'PERSON'; nameFa: string; nationalId: string | null; economicCode: string | null; nationalCode: string | null };
    subtotal: Prisma.Decimal;
    discountTotal: Prisma.Decimal;
    taxTotal: Prisma.Decimal;
    grandTotal: Prisma.Decimal;
    relatedTaxid: string | null;
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
    // Official template field mapping (دستورالعمل فنی, tax.gov.ir):
    // Official جدول ۷ (technical instruction, tax.gov.ir):
    //  inty — invoice TYPE (independent of subject): 1=نوع اول, 2=نوع دوم,
    //    3=نوع سوم (NOT implemented in Phase 8 — no "purchase" assumption).
    //  ins — SUBJECT: 1=اصلی, 2=اصلاحی, 3=ابطالی, 4=برگشت از فروش.
    //  irtaxid — ORIGINAL invoice taxid, required for non-MAIN subjects.
    //  indatim — صدور: Timestamp, 14 digits = MILLISECONDS (sample
    //    1655620821274). issueDate is DATE-only → midnight ms.
    //  indati2m — ایجاد: Timestamp ms = the moment this invoice record was
    //    created in our system (createdAt).
    //  taxid — 22-character unique tax id (generated with fiscal key
    //    material — documented gap; nullable until then).
    //  tins — buyer national id (legal) / national code (real person).
    //  tob — buyer business type: 1=حقوقی (COMPANY), 2=حقیقی (PERSON).
    //  tprdis/tdis/tadis/tvam/tbill — grand totals, all Decimal strings.
    const subjectToIns: Record<string, number> = { MAIN: 1, CORRECTIVE: 2, CANCEL: 3, RETURN: 4 };
    const ins = subjectToIns[invoice.subject] ?? 1;
    // official RC_IITP.IS_V7.9 جدول ۲: tob (نوع شخص خریدار) — 1=حقیقی
    // (individual), 2=حقوقی (legal entity), 3=مشارکت مدنی, 4=اتباع غیرایرانی
    const tob = invoice.customer.type === 'COMPANY' ? 2 : 1;
    // official RC_IITP.IS_V7.9 جدول ۲:
    //   tins = شماره اقتصادی **فروشنده** (SELLER — must match the taxpayer's
    //         own registered economic code; NOT the buyer),
    //   tinb = شماره اقتصادی خریدار (buyer economic code, per tob pattern),
    //   bid  = شناسه/شماره ملی خریدار (buyer national id, per tob pattern):
    //          tob=1 → شماره ملی (nationalCode), tob=2 → شناسه ملی (nationalId)
    const bid = invoice.customer.type === 'COMPANY' ? invoice.customer.nationalId : invoice.customer.nationalCode;
    const tinb = invoice.customer.economicCode ?? null;
    return {
      header: {
        // official RC_IITP.IS_V7.9 جدول ۲ ردیف ۱: taxid (شماره منحصربه‌فرد
        // مالیاتی) is the FIRST header field — generated with fiscal key
        // material (documented gap); validation blocks non-mock submission
        // while it is absent
        taxid: invoice.taxid ?? null,
        // SELLER identity (official جدول ۲) — must match the taxpayer's own
        // economic code; the BUYER carries tinb/bid below
        tins: invoice.sellerEconomicCode ?? null,
        inno: invoice.number,
        inty: invoice.inty,
        // official RC_TICS.IS_v1.6 §7 example carries `inp` (الگوی صورتحساب)
        // in the header — 1 = the default pattern
        inp: 1,
        ins,
        ...(invoice.subject !== 'MAIN' && invoice.relatedTaxid
          ? { irtaxid: invoice.relatedTaxid }
          : {}),
        indatim: invoice.issueDate.getTime(),
        indati2m: invoice.createdAt.getTime(),
        // BUYER identity per tob pattern (tob=1 → bid=شماره ملی; tob=2 →
        // bid=شناسه ملی + tinb=شماره اقتصادی)
        bid: bid ?? null,
        tinb: tinb ?? null,
        tob,
        tprdis: invoice.subtotal.toString(),
        tdis: invoice.discountTotal.toString(),
        tadis: invoice.subtotal.minus(invoice.discountTotal).toString(),
        tvam: invoice.taxTotal.toString(),
        // official RC_IITP.IS_V7.9 جدول ۲: todam (جمع عوارض) — no other-duties
        // data source exists yet, so the honest value is an exact zero
        todam: '0',
        tbill: invoice.grandTotal.toString(),
      },
      body: invoice.lines.map((l) => ({
        sstid: l.sstid,
        sstt: l.description,
        mu: l.mu,
        am: l.quantity.toString(),
        fee: l.unitPrice.toString(),
        // official RC_IITP.IS_V7.9: cfee (Cf = Cs/Exr) is the unit price in
        // FOREIGN CURRENCY — only for currency-sale patterns (14 int/4 dec).
        // Our supported domestic patterns do not carry it (the official §7
        // sample body omits cfee) — it is NOT a duplicate of fee.
        prdis: l.prdis.toString(),
        dis: l.dis.toString(),
        adis: l.adis.toString(),
        vra: l.vra.toString(),
        vam: l.vam.toString(),
        tsstam: l.tsstam.toString(),
      })),
      // official RC_TICS.IS_v1.6 §7 example: the payments array is TOP-LEVEL
      // and named `payments` (our submission sends it empty — payment
      // mapping is a documented gap pending a data decision)
      payments: [],
    };
  }

  /** FAIL-SAFE submission payload validation (final audit #2). Pure and
   *  static so tests exercise the exact production rules. Throws a
   *  ValidationError with a specific, actionable code — a knowingly invalid
   *  payload never reaches the wire. */
  static validateSubmissionPayload(
    payload: {
      header: Record<string, unknown>;
      body: Array<Record<string, unknown>>;
      payments: unknown[];
    },
    requireTaxid: boolean,
  ): void {
    const header = payload.header ?? {};
    // tins is checked by the dedicated SELLER identity rule below
    const requiredFields = ['inno', 'indatim', 'indati2m', 'tprdis', 'tdis', 'tadis', 'tvam', 'todam', 'tbill'];
    const missing = requiredFields.filter((f) => {
      const v = header[f];
      return v === null || v === undefined || v === '';
    });
    if (missing.length > 0) {
      throw new ValidationError('TAX_INVOICE_PAYLOAD_FIELD_MISSING', { fields: missing });
    }
    // SELLER identity: official جدول ۲ rule 1 — tins is the seller's own
    // registered economic code and is mandatory for domestic submissions
    if (typeof header.tins !== 'string' || (header.tins as string).length === 0) {
      throw new ValidationError('TAX_INVOICE_PAYLOAD_SELLER_TINS_UNAVAILABLE', {
        remediation: 'تنظیم کد اقتصادی شرکت (فروشنده) در پیکربندی شرکت الزامی است',
      });
    }
    // BUYER identity per tob pattern (official جدول ۲): tob=1 (حقیقی) ->
    // bid = شماره ملی; tob=2 (حقوقی) -> bid = شناسه ملی + tinb = شماره اقتصادی
    const tob = Number(header.tob);
    if (![1, 2, 3, 4].includes(tob)) {
      throw new ValidationError('TAX_INVOICE_PAYLOAD_FIELD_INVALID', { fields: ['tob'] });
    }
    if (tob === 1 && (typeof header.bid !== 'string' || (header.bid as string).length === 0)) {
      throw new ValidationError('TAX_INVOICE_PAYLOAD_BUYER_ID_MISSING', { fields: ['bid'] });
    }
    if (tob === 2 && (typeof header.bid !== 'string' || (header.bid as string).length === 0)) {
      throw new ValidationError('TAX_INVOICE_PAYLOAD_BUYER_ID_MISSING', { fields: ['bid'] });
    }
    if (tob === 2 && (typeof header.tinb !== 'string' || (header.tinb as string).length === 0)) {
      throw new ValidationError('TAX_INVOICE_PAYLOAD_BUYER_ID_MISSING', { fields: ['tinb'] });
    }
    // conditional reference: non-MAIN subjects MUST carry the original taxid
    if (Number(header.ins) !== 1 && (typeof header.irtaxid !== 'string' || (header.irtaxid as string).length === 0)) {
      throw new ValidationError('TAX_INVOICE_PAYLOAD_IRTAXID_REQUIRED', { ins: header.ins });
    }
    if (![1, 2, 3].includes(Number(header.inty)) || ![1, 2, 3, 4].includes(Number(header.ins)) || Number(header.inp) !== 1) {
      throw new ValidationError('TAX_INVOICE_PAYLOAD_FIELD_INVALID', { fields: ['inty', 'ins', 'inp'] });
    }
    if (!Number.isInteger(Number(header.indatim)) || Number(header.indatim) <= 0) {
      throw new ValidationError('TAX_INVOICE_PAYLOAD_FIELD_INVALID', { fields: ['indatim'] });
    }
    if (requireTaxid && (typeof header.taxid !== 'string' || header.taxid.length === 0)) {
      // taxid generation needs the fiscal-key material + the separate
      // «قالب شناسه یکتای حافظه مالیاتی و شماره منحصر به فرد مالیاتی»
      // document — a real (sandbox/live) submission is impossible without it
      throw new ValidationError('TAX_INVOICE_PAYLOAD_TAXID_UNAVAILABLE', {
        remediation: 'fiscal key material must be configured so the official taxid can be generated',
      });
    }
    // official format (docs/08, official sample A1121604C220002F095011):
    // exactly 22 alphanumeric characters
    if (typeof header.taxid === 'string' && header.taxid.length > 0 && !/^[A-Z0-9]{22}$/.test(header.taxid)) {
      throw new ValidationError('TAX_INVOICE_PAYLOAD_TAXID_INVALID', { taxid: header.taxid });
    }
    if (!Array.isArray(payload.body) || payload.body.length === 0) {
      throw new ValidationError('TAX_INVOICE_PAYLOAD_BODY_EMPTY');
    }
    const unmapped = payload.body
      .map((line, index) => (typeof line.sstid === 'string' && line.sstid.length > 0 ? null : index))
      .filter((index): index is number => index !== null);
    if (unmapped.length > 0) {
      // official جدول ۲: sstid (کد کالا/خدمت) is a REQUIRED body field —
      // every line must be mapped from the registered goods list first
      throw new ValidationError('TAX_INVOICE_PAYLOAD_SSTID_UNMAPPED', {
        bodyIndexes: unmapped,
        remediation: 'assign the official goods/service code (sstid) to every line before submission',
      });
    }
    const headerMonetary = ['tprdis', 'tdis', 'tadis', 'tvam', 'todam', 'tbill'];
    for (const field of headerMonetary) {
      const value = new Prisma.Decimal(String(header[field]));
      if (!value.isFinite() || value.isNegative()) {
        throw new ValidationError('TAX_INVOICE_PAYLOAD_FIELD_INVALID', { fields: [field] });
      }
    }
    const lineSum = { prdis: new Prisma.Decimal(0), dis: new Prisma.Decimal(0), adis: new Prisma.Decimal(0), vam: new Prisma.Decimal(0), tsstam: new Prisma.Decimal(0) };
    for (const [index, line] of payload.body.entries()) {
      const am = new Prisma.Decimal(String(line.am ?? '0'));
      const fee = new Prisma.Decimal(String(line.fee ?? '0'));
      const prdis = new Prisma.Decimal(String(line.prdis ?? '0'));
      const dis = new Prisma.Decimal(String(line.dis ?? '0'));
      const adis = new Prisma.Decimal(String(line.adis ?? '0'));
      const vam = new Prisma.Decimal(String(line.vam ?? '0'));
      const tsstam = new Prisma.Decimal(String(line.tsstam ?? '0'));
      // numeric sanity: finite, non-negative, non-zero quantity/price
      for (const [field, value] of [['prdis', prdis], ['dis', dis], ['adis', adis], ['vam', vam], ['tsstam', tsstam], ['fee', fee]] as const) {
        if (!value.isFinite() || value.isNegative()) {
          throw new ValidationError('TAX_INVOICE_PAYLOAD_FIELD_INVALID', { bodyIndex: index, fields: [field] });
        }
      }
      if (am.isNegative() || am.isZero() || fee.isZero()) {
        throw new ValidationError('TAX_INVOICE_PAYLOAD_FIELD_INVALID', { bodyIndex: index, fields: ['am', 'fee'] });
      }
      // official line relations (RC_IITP.IS_V7.9): adis = prdis − dis;
      // tsstam = adis + vam
      if (!adis.eq(prdis.minus(dis)) || !tsstam.eq(adis.plus(vam))) {
        throw new ValidationError('TAX_INVOICE_PAYLOAD_LINE_TOTALS_MISMATCH', { bodyIndex: index });
      }
      lineSum.prdis = lineSum.prdis.plus(prdis);
      lineSum.dis = lineSum.dis.plus(dis);
      lineSum.adis = lineSum.adis.plus(adis);
      lineSum.vam = lineSum.vam.plus(vam);
      lineSum.tsstam = lineSum.tsstam.plus(tsstam);
    }
    // monetary consistency (Decimal-exact, official totals relations)
    const tprdis = new Prisma.Decimal(String(header.tprdis));
    const tdis = new Prisma.Decimal(String(header.tdis));
    const tadis = new Prisma.Decimal(String(header.tadis));
    const tvam = new Prisma.Decimal(String(header.tvam));
    const todam = new Prisma.Decimal(String(header.todam));
    const tbill = new Prisma.Decimal(String(header.tbill));
    if (!tadis.eq(tprdis.minus(tdis)) || !tbill.eq(tadis.plus(tvam).plus(todam))) {
      throw new ValidationError('TAX_INVOICE_PAYLOAD_TOTALS_MISMATCH', {
        tprdis: header.tprdis,
        tdis: header.tdis,
        tadis: header.tadis,
        tvam: header.tvam,
        tbill: header.tbill,
      });
    }
    // exact header↔body agreement for EVERY official total column
    if (!lineSum.prdis.eq(tprdis) || !lineSum.dis.eq(tdis) || !lineSum.adis.eq(tadis)) {
      throw new ValidationError('TAX_INVOICE_PAYLOAD_TOTALS_MISMATCH', {
        sumPrdis: lineSum.prdis.toString(),
        sumDis: lineSum.dis.toString(),
        sumAdis: lineSum.adis.toString(),
      });
    }
    if (!lineSum.vam.eq(tvam)) {
      throw new ValidationError('TAX_INVOICE_PAYLOAD_TOTALS_MISMATCH', { sumVam: lineSum.vam.toString(), tvam: header.tvam });
    }
    if (!lineSum.tsstam.eq(tbill)) {
      throw new ValidationError('TAX_INVOICE_PAYLOAD_TOTALS_MISMATCH', { sumTsstam: lineSum.tsstam.toString(), tbill: header.tbill });
    }
    if (!Array.isArray(payload.payments)) {
      throw new ValidationError('TAX_INVOICE_PAYLOAD_FIELD_INVALID', { fields: ['payments'] });
    }
    // official RC_IITP.IS_V7.9 جدول ۲: mu (واحد اندازه‌گیری) is a REQUIRED
    // body field carrying the AUTHORITY's unit code — an unmapped UOM (null
    // mu) blocks submission BEFORE any state change (sixteenth review)
    const muUnmapped = payload.body
      .map((line, index) => (typeof line.mu === 'string' && line.mu.length > 0 ? null : index))
      .filter((index): index is number => index !== null);
    if (muUnmapped.length > 0) {
      throw new ValidationError('TAX_INVOICE_PAYLOAD_MU_UNMAPPED', {
        bodyIndexes: muUnmapped,
        remediation: 'map every UOM to its official unit code (Uom.moadianUnitCode) before submission',
      });
    }
    // official RC_IITP.IS_V7.9 جدول ۲۴: setm (روش تسویه) 1=نقدی, 2=نسیه,
    // 3=نقدی/نسیه; setm=3 requires cap (مبلغ پرداختی نقدی) + insp (مبلغ نسیه).
    // NO settlement-method data source exists in the ERP yet — a real
    // (sandbox/live) submission is BLOCKED until that data model exists
    // (documented gap; the official §7 example shows an empty payments array
    // is what the wire carries for unreported settlements).
    if (requireTaxid) {
      const setm = Number(header.setm);
      if (![1, 2, 3].includes(setm)) {
        throw new ValidationError('TAX_INVOICE_PAYLOAD_SETM_UNAVAILABLE', {
          remediation: 'capture the settlement method (روش تسویه) on the invoice before real submission',
        });
      }
      if (setm === 3) {
        const cap = header.cap === null || header.cap === undefined ? '' : String(header.cap);
        const insp = header.insp === null || header.insp === undefined ? '' : String(header.insp);
        if (cap.length === 0 || insp.length === 0) {
          throw new ValidationError('TAX_INVOICE_PAYLOAD_SETM_FIELDS_REQUIRED', { fields: ['cap', 'insp'] });
        }
      }
    }
  }

  /** operator/integration mapping entry: assign the official goods/service
   *  code (sstid) to an invoice line (the GET_SERVICE_STUFF_LIST-driven
   *  mapping itself is a documented data gap — this records the decision). */
  async assignLineSstid(
    companyId: string,
    taxInvoiceLineId: string,
    sstid: string,
    actor: { id: string; username: string },
  ): Promise<void> {
    const trimmed = sstid.trim();
    if (!trimmed) throw new ValidationError('TAX_INVOICE_SSTID_EMPTY');
    const existing = await this.prisma.salesTaxInvoiceLine.findFirst({
      where: { id: taxInvoiceLineId, companyId },
      select: { id: true, salesTaxInvoice: { select: { status: true } } },
    });
    if (!existing) throw new NotFoundError('Tax invoice line not found', { taxInvoiceLineId });
    const parentStatus = existing.salesTaxInvoice.status;
    // official lifecycle: the goods/service code is mappable only while the
    // invoice has not entered the submission pipeline
    if (parentStatus !== 'READY' && parentStatus !== 'FAILED') {
      throw new ConflictError('TAX_INVOICE_LINE_NOT_MAPPABLE', { status: parentStatus });
    }
    // ATOMIC against concurrent status transitions: the conditional UPDATE
    // re-checks the parent status at write time — a claim (READY→SENDING)
    // racing this write makes it a no-op, which surfaces as a conflict
    const updated = await this.prisma.salesTaxInvoiceLine.updateMany({
      where: {
        id: taxInvoiceLineId,
        companyId,
        salesTaxInvoice: { status: { in: ['READY', 'FAILED'] } },
      },
      data: { sstid: trimmed },
    });
    if (updated.count === 0) {
      throw new ConflictError('TAX_INVOICE_LINE_NOT_MAPPABLE', { status: parentStatus });
    }
    await this.audit.record({
      entityType: 'sales_tax_invoice_line',
      entityId: taxInvoiceLineId,
      action: AuditAction.UPDATE,
      companyId,
      actor,
      newValues: { sstid: trimmed },
    });
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
