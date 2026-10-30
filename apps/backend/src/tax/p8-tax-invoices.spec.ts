import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SequencesService } from '../sequences/sequences.service';
import { TaxInvoiceService } from './tax-invoice.service';
import { TEST_INTEGRATION, integrationPrisma, disconnectIntegrationPrisma } from '../testing/integration';
import { assertSafeIntegrationDatabase } from '../testing/db-guard';

jest.setTimeout(90000);

const DB_URL = process.env.DATABASE_URL;

if (TEST_INTEGRATION) assertSafeIntegrationDatabase(DB_URL);

const ACTOR = { id: '00000000-0000-4000-8000-0000000000a1', username: 'admin' };

/** Fake Moadian adapter — deterministic, per-test behavior without env games. */
class FakeMoadianAdapter {
  failEnqueue = false;
  inquiryQueue: Array<'PENDING' | 'SUCCESS' | 'FAILED'> = [];
  enqueued: Array<{ uid: string; retry: boolean }> = [];
  inquiries = 0;

  async getToken() {
    return { token: 'fake', expiresInSeconds: 900 };
  }
  async enqueue(packets: Array<{ uid: string; retry: boolean; data: string }>) {
    this.enqueued.push(...packets.map((p) => ({ uid: p.uid, retry: p.retry })));
    if (this.failEnqueue) throw new Error('INJECTED: enqueue transport failure');
    return packets.map((p) => ({ uid: p.uid, referenceNumber: `ref-${p.uid.slice(0, 8)}` }));
  }
  async inquiryByUid(uids: string[]) {
    this.inquiries += uids.length;
    return uids.map((uid) => {
      const next = this.inquiryQueue.shift() ?? 'SUCCESS';
      if (next === 'PENDING') return { uid, status: 'PENDING' as const };
      if (next === 'FAILED')
        return { uid, status: 'FAILED' as const, errorCode: 'CONTENT', errorDetail: 'Duplicate tax id' };
      return {
        uid,
        status: 'SUCCESS' as const,
        confirmationReferenceId: `conf-${uid.slice(0, 8)}`,
        taxResult: 'fake-tax-result',
      };
    });
  }
  async getServerInformation() {
    return { publicKeyId: 'fake', publicKeyPem: 'fake' };
  }
}

describe('p8 — Tax invoices & Moadian (hermetic live DB)', () => {
  let prismaService: PrismaService;
  let prisma: PrismaClient;
  let service: TaxInvoiceService;
  let fakeAdapter: FakeMoadianAdapter;
  let COMPANY = '';
  const mySalesLineIds: string[] = [];
  const mySalesDocIds: string[] = [];
  const myLoadingAllocationIds: string[] = [];
  const myLoadingIds: string[] = [];
  const myLoadingLineIds: string[] = [];
  const myPartyIds: string[] = [];
  const myUserIds: string[] = [];
  const myVariantIds: string[] = [];

  beforeAll(async () => {
    if (!TEST_INTEGRATION || !DB_URL) return;
    const { PrismaService: S } = await import('../prisma/prisma.service');
    prismaService = new S();
    prisma = prismaService as unknown as PrismaClient;
    await prismaService.$connect();
    const audit = new AuditService(prismaService as never);
    fakeAdapter = new FakeMoadianAdapter();
    service = new TaxInvoiceService(
      prismaService as never,
      new SequencesService(prismaService as never, audit),
      audit,
      fakeAdapter as never,
    );

    const company = await prismaService.company.create({
      data: { nameFa: `p8-${Date.now()}`, status: 'ACTIVE', economicCode: '411151234567' },
    });
    COMPANY = company.id;
    const salesperson = await prismaService.user.create({
      data: { username: `p8-${Date.now()}`, passwordHash: 'not-a-real-login', status: 'ACTIVE' },
    });
    myUserIds.push(salesperson.id);
    for (const dt of ['SALES_TAX_INVOICE', 'PURCHASE_TAX_INVOICE']) {
      await prismaService.sequence.create({
        data: { companyId: COMPANY, documentType: dt, name: dt, prefix: dt === 'SALES_TAX_INVOICE' ? 'STI' : 'PTI', padding: 5, resetCycle: 'NEVER' },
      });
    }
    const customer = await prismaService.party.create({
      data: {
        companyId: COMPANY,
        type: 'COMPANY',
        nameFa: 'p8 مشتری',
        economicCode: '411598765432',
        nationalId: '10101234567',
        roles: { create: [{ role: 'CUSTOMER' }] },
      },
    });
    myPartyIds.push(customer.id);
    // a variant + uom for sales lines
    const uomCategory = await prismaService.uomCategory.create({
      data: { companyId: COMPANY, code: 'WEIGHT-P8', nameFa: 'وزن p8' },
    });
    const uom = await prismaService.uom.create({
      data: { companyId: COMPANY, categoryId: uomCategory.id, nameFa: 'کیلوگرم', symbol: 'kg', conversionRatio: new Prisma.Decimal(1), isBaseUnit: true, moadianUnitCode: '164' },
    });
    const template = await prismaService.productTemplate.create({
      data: {
        companyId: COMPANY,
        categoryId: (await prismaService.productCategory.create({ data: { companyId: COMPANY, code: 'P8', nameFa: 'p8' } })).id,
        nameFa: 'p8 قالب',
      },
    });
    const variant = await prismaService.productVariant.create({
      data: {
        companyId: COMPANY,
        templateId: template.id,
        sku: 'P8-1',
        nameFa: 'میلگرد p8',
        combinationKey: 'p8-1',
      },
    });
    myVariantIds.push(variant.id);
    // COMPLETED sales document with one taxed line
    const doc = await prismaService.salesDocument.create({
      data: {
        companyId: COMPANY,
        documentNumber: `P8-${Date.now()}`,
        customerPartyId: customer.id,
        salespersonUserId: myUserIds[0],
        documentDate: new Date(),
        status: 'COMPLETED',
        lines: {
          create: {
            companyId: COMPANY,
            productVariantId: variant.id,
            orderedQuantity: new Prisma.Decimal(100),
            uomId: uom.id,
            unitPrice: new Prisma.Decimal('123.45'),
            discountAmount: new Prisma.Decimal('23.45'),
            taxDefinitionId: null,
            taxRateSnapshot: new Prisma.Decimal(9),
            subtotal: new Prisma.Decimal('12345'),
            taxAmount: new Prisma.Decimal('1108.9245'),
            lineTotal: new Prisma.Decimal('13430.9245'),
          },
        },
      },
      include: { lines: true },
    });
    mySalesDocIds.push(doc.id);
    mySalesLineIds.push(doc.lines[0].id);
    // the customer's party needs the tax identity columns (Party-level)
    await prismaService.party.update({
      where: { id: customer.id },
      data: { economicCode: '411598765432', nationalId: '10101234567' },
    });
    // loading allocation: 50 kg invoiced for this line (tax_invoiced_quantity)
    const loading = await prismaService.loading.create({
      data: { companyId: COMPANY, loadingDate: new Date() },
    });
    const loadingLine = await prismaService.loadingLine.create({
      data: {
        loadingId: loading.id,
        productVariantId: variant.id,
        actualQuantity: new Prisma.Decimal(50),
        uomId: uom.id,
      },
    });
    const allocation = await prismaService.loadingAllocation.create({
      data: {
        companyId: COMPANY,
        loadingLineId: loadingLine.id,
        salesLineId: doc.lines[0].id,
        allocatedQuantity: new Prisma.Decimal(50),
      },
    });
    myLoadingAllocationIds.push(allocation.id);
    myLoadingIds.push(loading.id);
    myLoadingLineIds.push(loadingLine.id);
  });

  const itif = TEST_INTEGRATION && DB_URL
    ? it
    : (name: string, fn: jest.ProvidesCallback) => {
        // eslint-disable-next-line no-console
        console.warn(`[p8] SKIPPED (no DATABASE_URL): ${name}`);
        return it.skip(name, fn);
      };

  /** own COMPLETED doc per test — the over-invoicing cap (Critical Tax
   *  Audit) means one doc yields ONE full invoice, so send/inquiry tests
   *  each need a fresh document. */
  async function makeOwnDoc() {
    const customer = await prisma.party.create({
      data: {
        companyId: COMPANY,
        type: 'PERSON',
        nameFa: `p8 مشتری ${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        economicCode: '411598765432',
        nationalCode: `0012345${String(Math.floor(Math.random() * 1e5)).padStart(5, '0')}`,
        roles: { create: [{ role: 'CUSTOMER' }] },
      },
    });
    myPartyIds.push(customer.id);
    const salesperson = await prisma.user.create({
      data: { username: `p8-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, passwordHash: 'x', status: 'ACTIVE' },
    });
    myUserIds.push(salesperson.id);
    const uom = await prisma.uom.findFirstOrThrow({ where: { companyId: COMPANY } });
    const doc = await prisma.salesDocument.create({
      data: {
        companyId: COMPANY,
        documentNumber: `P8-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        customerPartyId: customer.id,
        salespersonUserId: salesperson.id,
        documentDate: new Date(),
        status: 'COMPLETED',
        lines: {
          create: {
            companyId: COMPANY,
            productVariantId: myVariantIds[0],
            orderedQuantity: new Prisma.Decimal(999),
            uomId: uom.id,
            unitPrice: new Prisma.Decimal('123.45'),
            taxRateSnapshot: new Prisma.Decimal(9),
            subtotal: new Prisma.Decimal('0'),
            lineTotal: new Prisma.Decimal('0'),
          },
        },
      },
      include: { lines: true },
    });
    mySalesDocIds.push(doc.id);
    mySalesLineIds.push(doc.lines[0].id);
    const loading = await prisma.loading.create({ data: { companyId: COMPANY, loadingDate: new Date() } });
    const loadingLine = await prisma.loadingLine.create({
      data: { loadingId: loading.id, productVariantId: myVariantIds[0], actualQuantity: new Prisma.Decimal(50), uomId: uom.id },
    });
    await prisma.loadingAllocation.create({
      data: { companyId: COMPANY, loadingLineId: loadingLine.id, salesLineId: doc.lines[0].id, allocatedQuantity: new Prisma.Decimal(50) },
    });
    return doc;
  }

  afterAll(async () => {
    if (!prismaService || !COMPANY) {
      if (prismaService) await prismaService.$disconnect();
      return;
    }
    const failures: string[] = [];
    try {
      const steps: Array<[string, () => Promise<unknown>]> = [
        ['submission', () => prismaService.salesTaxInvoiceSubmission.deleteMany({ where: { companyId: COMPANY } })],
        ['taxLine', () => prismaService.salesTaxInvoiceLine.deleteMany({ where: { companyId: COMPANY } })],
        // Allocation rows BEFORE the invoices: the Phase 9B alignment added
        // the physical allocation→invoice FKs the schema always declared.
        ['salesAllocation', () => prismaService.salesTaxInvoiceOrderAllocation.deleteMany({ where: { companyId: COMPANY } })],
        ['purchaseAllocation', () => prismaService.purchaseTaxInvoiceOrderAllocation.deleteMany({ where: { companyId: COMPANY } })],
        ['taxInvoice', () => prismaService.salesTaxInvoice.deleteMany({ where: { companyId: COMPANY } })],
        ['purchaseTaxInvoice', () => prismaService.purchaseTaxInvoice.deleteMany({ where: { companyId: COMPANY } })],
        ['loadingAllocation', () => prismaService.loadingAllocation.deleteMany({ where: { companyId: COMPANY } })],
        ['loadingLine', () => prismaService.loadingLine.deleteMany({ where: { loading: { companyId: COMPANY } } })],
        ['loading', () => prismaService.loading.deleteMany({ where: { companyId: COMPANY } })],
        ['salesLine', () => prismaService.salesLine.deleteMany({ where: { id: { in: mySalesLineIds } } })],
        ['salesDocument', () => prismaService.salesDocument.deleteMany({ where: { id: { in: mySalesDocIds } } })],
        ['variant', () => prismaService.productVariant.deleteMany({ where: { id: { in: myVariantIds } } })],
        ['template', () => prismaService.productTemplate.deleteMany({ where: { companyId: COMPANY } })],
        ['category', () => prismaService.productCategory.deleteMany({ where: { companyId: COMPANY } })],
        ['uom', () => prismaService.uom.deleteMany({ where: { companyId: COMPANY } })],
        ['party', () => prismaService.party.deleteMany({ where: { id: { in: myPartyIds }, companyId: COMPANY } })],
        ['user', () => prismaService.user.deleteMany({ where: { id: { in: myUserIds } } })],
        ['uomCategory', () => prismaService.uomCategory.deleteMany({ where: { companyId: COMPANY } })],
        ['sequence', () => prismaService.sequence.deleteMany({ where: { companyId: COMPANY } })],
      ];
      for (const [name, run] of steps) {
        try {
          await run();
        } catch (e) {
          failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      try {
        await prismaService.company.delete({ where: { id: COMPANY } });
      } catch (e) {
        failures.push(`company: ${e instanceof Error ? e.message : String(e)}`);
      }
    } finally {
      await prismaService.$disconnect().catch(() => undefined);
    }
    if (failures.length > 0) {
      throw new Error(`p8 cleanup INCOMPLETE — test data left behind: ${failures.join(' | ')}`);
    }
    await disconnectIntegrationPrisma();
  });

  itif('p8-01 create from COMPLETED doc: loaded quantities, exact Decimal totals, allocation', async () => {
    const docId = mySalesDocIds[0];
    const invoice = await service.createFromSalesDocument(COMPANY, { salesDocumentId: docId }, ACTOR);
    const withLines = await prisma.salesTaxInvoice.findUniqueOrThrow({
      where: { id: invoice.id },
      include: { lines: true },
    });
    expect(invoice.status).toBe('READY');
    expect(invoice.number).toMatch(/^STI-\d{5}$/); // resetCycle NEVER → no year segment
    // tax_invoiced_quantity = 50 (loading allocation), not 100 (ordered)
    expect(withLines.lines[0].quantity.toString()).toBe('50');
    // official قطع truncation + CUMULATIVE discount allocation
    // (RC_IITP.IS_V7.9: rial values 0 decimals; ordered=100, stage=50 ->
    // dis=TRUNC(23.45×50/100)=11): prdis=6172; adis=6161;
    // vam=TRUNC(6161×9%)=554; tsstam=6715; grandTotal=6161+554=6715
    expect(withLines.lines[0].prdis.toString()).toBe('6172');
    expect(withLines.lines[0].dis.toString()).toBe('11');
    expect(withLines.lines[0].adis.toString()).toBe('6161');
    expect(withLines.lines[0].vam.toString()).toBe('554');
    expect(withLines.lines[0].tsstam.toString()).toBe('6715');
    expect(invoice.subtotal.toString()).toBe('6172');
    expect(invoice.taxTotal.toString()).toBe('554');
    expect(invoice.grandTotal.toString()).toBe('6715');
    // M:N allocation to the source order created with the invoice total
    const allocations = await prisma.salesTaxInvoiceOrderAllocation.findMany({
      where: { companyId: COMPANY, salesTaxInvoiceId: invoice.id },
    });
    expect(allocations).toHaveLength(1);
    expect(allocations[0].salesDocumentId).toBe(docId);
    expect(allocations[0].allocatedAmount.toString()).toBe('6715'); // grandTotal with official truncation
  });

  itif('p8-02 invalid sources rejected (draft doc, missing identity, zero quantity)', async () => {
    // DRAFT document
    const draft = await prisma.salesDocument.create({
      data: {
        companyId: COMPANY,
        documentNumber: `P8-D-${Date.now()}`,
        customerPartyId: myPartyIds[0],
        salespersonUserId: myUserIds[0],
        documentDate: new Date(),
        status: 'DRAFT',
      },
    });
    mySalesDocIds.push(draft.id);
    await expect(
      service.createFromSalesDocument(COMPANY, { salesDocumentId: draft.id }, ACTOR),
    ).rejects.toThrow('TAX_INVOICE_SOURCE_NOT_COMPLETED');
    // customer without ANY tax identity
    const anon = await prisma.party.create({
      data: { companyId: COMPANY, type: 'PERSON', nameFa: 'p8 بی‌هویت', roles: { create: [{ role: 'CUSTOMER' }] } },
    });
    myPartyIds.push(anon.id);
    const anonDoc = await prisma.salesDocument.create({
      data: {
        companyId: COMPANY,
        documentNumber: `P8-A-${Date.now()}`,
        customerPartyId: anon.id,
        salespersonUserId: myUserIds[0],
        documentDate: new Date(),
        status: 'COMPLETED',
      },
    });
    mySalesDocIds.push(anonDoc.id);
    await expect(
      service.createFromSalesDocument(COMPANY, { salesDocumentId: anonDoc.id }, ACTOR),
    ).rejects.toThrow('TAX_INVOICE_CUSTOMER_IDENTITY_MISSING');
    // COMPLETED doc but no loading allocations → zero invoiced quantity
    const zeroDoc = await prisma.salesDocument.create({
      data: {
        companyId: COMPANY,
        documentNumber: `P8-Z-${Date.now()}`,
        customerPartyId: myPartyIds[0],
        salespersonUserId: myUserIds[0],
        documentDate: new Date(),
        status: 'COMPLETED',
        lines: {
          create: {
            companyId: COMPANY,
            productVariantId: myVariantIds[0],
            orderedQuantity: new Prisma.Decimal(10),
            unitPrice: new Prisma.Decimal('10'),
            subtotal: new Prisma.Decimal('100'),
            lineTotal: new Prisma.Decimal('100'),
            uomId: (await prisma.uom.findFirstOrThrow({ where: { companyId: COMPANY } })).id,
          },
        },
      },
    });
    mySalesDocIds.push(zeroDoc.id);
    mySalesLineIds.push((await prisma.salesLine.findFirstOrThrow({ where: { salesDocumentId: zeroDoc.id } })).id);
    await expect(
      service.createFromSalesDocument(COMPANY, { salesDocumentId: zeroDoc.id }, ACTOR),
    ).rejects.toThrow('TAX_INVOICE_NO_INVOICED_QUANTITY');
  });

  itif('p8-03 salesperson without tax.view is forbidden (REQUIREMENTS)', async () => {
    expect(() => service.assertNotSalespersonOnly(['sales.view', 'sales.create'])).toThrow(
      'TAX_INVOICE_ACCESS_FORBIDDEN',
    );
    // accountant-ish permission set passes
    expect(() => service.assertNotSalespersonOnly(['tax.view', 'accounting.report'])).not.toThrow();
  });

  itif('p8-04 send → SUBMITTED with unique uid + submission row; re-send while SUBMITTED conflicts', async () => {
    const doc = await makeOwnDoc();
    const invoice = await service.createFromSalesDocument(COMPANY, { salesDocumentId: doc.id, lineSstids: [{ salesLineId: doc.lines[0].id, sstid: '2710000138624' }] }, ACTOR);
    const res = await service.send(COMPANY, invoice.id, ACTOR);
    expect(res.status).toBe('SUBMITTED');
    const submission = await prisma.salesTaxInvoiceSubmission.findUniqueOrThrow({
      where: { uid: res.uid! },
    });
    expect(submission.status).toBe('PENDING');
    expect(submission.retry).toBe(false);
    expect(submission.referenceNumber).toMatch(/^ref-/);
    expect(submission.payloadSnapshot).toBeTruthy(); // exact packet stored
    const updated = await prisma.salesTaxInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(updated.status).toBe('SUBMITTED');
    expect(updated.referenceNumber).toBe(submission.referenceNumber);
    // second send while SUBMITTED is rejected (no duplicate submissions)
    await expect(service.send(COMPANY, invoice.id, ACTOR)).rejects.toThrow('TAX_INVOICE_NOT_SENDABLE');
    const count = await prisma.salesTaxInvoiceSubmission.count({ where: { invoiceId: invoice.id } });
    expect(count).toBe(1);
  });

  itif('p8-05 inquiry lifecycle: PENDING → SUCCESS and → FAILED', async () => {
    const successDoc = await makeOwnDoc();
    const successInvoice = await service.createFromSalesDocument(COMPANY, { salesDocumentId: successDoc.id, lineSstids: [{ salesLineId: successDoc.lines[0].id, sstid: '2710000138624' }] }, ACTOR);
    await service.send(COMPANY, successInvoice.id, ACTOR);
    fakeAdapter.inquiryQueue.push('PENDING');
    expect((await service.inquiry(COMPANY, successInvoice.id)).status).toBe('PENDING');
    const still = await prisma.salesTaxInvoice.findUniqueOrThrow({ where: { id: successInvoice.id } });
    expect(still.status).toBe('SUBMITTED');
    expect((await service.inquiry(COMPANY, successInvoice.id)).status).toBe('SUCCESS');
    const done = await prisma.salesTaxInvoice.findUniqueOrThrow({ where: { id: successInvoice.id } });
    expect(done.status).toBe('SUCCESS');
    expect(done.confirmationReferenceId).toMatch(/^conf-/);

    // FAILED inquiry → FAILED invoice, retry carries retry=true
    const failDoc = await makeOwnDoc();
    const failInvoice = await service.createFromSalesDocument(COMPANY, { salesDocumentId: failDoc.id, lineSstids: [{ salesLineId: failDoc.lines[0].id, sstid: '2710000138624' }] }, ACTOR);
    await service.send(COMPANY, failInvoice.id, ACTOR);
    fakeAdapter.inquiryQueue.push('FAILED');
    expect((await service.inquiry(COMPANY, failInvoice.id)).status).toBe('FAILED');
    const failed = await prisma.salesTaxInvoice.findUniqueOrThrow({ where: { id: failInvoice.id } });
    expect(failed.status).toBe('FAILED');
    expect(failed.moadianError).toContain('Duplicate tax id');
    const beforeAttempts = await prisma.salesTaxInvoiceSubmission.count({ where: { invoiceId: failInvoice.id } });
    const retry = await service.send(COMPANY, failInvoice.id, ACTOR);
    expect(retry.status).toBe('SUBMITTED');
    const submissions = await prisma.salesTaxInvoiceSubmission.findMany({
      where: { invoiceId: failInvoice.id },
      orderBy: { attempt: 'asc' },
    });
    expect(submissions.length).toBe(beforeAttempts + 1);
    expect(submissions[submissions.length - 1].retry).toBe(true);
    expect(submissions[submissions.length - 1].uid).not.toBe(submissions[0].uid);
  });

  itif(
    'p8-06 enqueue transport failure = AMBIGUOUS outcome: stays PENDING, a retry NEVER mints a new uid (no duplicate invoice)',
    async () => {
      const doc = await makeOwnDoc();
      const invoice = await service.createFromSalesDocument(COMPANY, { salesDocumentId: doc.id, lineSstids: [{ salesLineId: doc.lines[0].id, sstid: '2710000138624' }] }, ACTOR);
      // the failure flag is ALWAYS cleared — even when the send or an
      // assertion fails (eleventh review: test isolation)
      try {
        fakeAdapter.failEnqueue = true;
        const res = await service.send(COMPANY, invoice.id, ACTOR);
        // transport errors are UNKNOWN outcomes: the packet MAY have reached
        // the authority — never a definitive FAILED
        expect(res.status).toBe('SUBMITTED');
        expect(res.awaitingInquiry).toBe(true);
        expect(res.errorCode).toBe('TRANSPORT');
        const afterFail = await prisma.salesTaxInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
        expect(afterFail.status).toBe('SUBMITTED');
        expect(afterFail.moadianError).toContain('INJECTED'); // sanitized reason kept visible
        const pendingSub = await prisma.salesTaxInvoiceSubmission.findFirstOrThrow({
          where: { invoiceId: invoice.id, status: 'PENDING' },
        });
        expect(pendingSub.errorCode).toBe('TRANSPORT');
      } finally {
        fakeAdapter.failEnqueue = false;
      }
      const enqueuedAfterFailure = fakeAdapter.enqueued.length;

      // a re-send while the outcome is unresolved is BLOCKED — no second
      // packet can ever be minted while the authority's verdict is unknown
      await expect(service.send(COMPANY, invoice.id, ACTOR)).rejects.toThrow('TAX_INVOICE_NOT_SENDABLE');
      expect(fakeAdapter.enqueued.length).toBe(enqueuedAfterFailure); // NO duplicate enqueue

      // reconciliation goes through inquiry() on the SAME persisted uid
      fakeAdapter.inquiryQueue.push('SUCCESS'); // the authority accepted packet #1
      expect((await service.inquiry(COMPANY, invoice.id)).status).toBe('SUCCESS');
      const promoted = await prisma.salesTaxInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
      expect(promoted.status).toBe('SUCCESS');
      expect(promoted.moadianError).toBeNull();
      // exactly one submission with one uid — no duplicate invoice exists
      expect(await prisma.salesTaxInvoiceSubmission.count({ where: { invoiceId: invoice.id } })).toBe(1);
    },
  );

  itif(
    'p8-06b transport failure then AUTHORITATIVE rejection → official retry with a NEW uid and retry=true',
    async () => {
      const doc = await makeOwnDoc();
      const invoice = await service.createFromSalesDocument(COMPANY, { salesDocumentId: doc.id, lineSstids: [{ salesLineId: doc.lines[0].id, sstid: '2710000138624' }] }, ACTOR);
      // the failure flag is ALWAYS cleared — even when the send fails
      try {
        fakeAdapter.failEnqueue = true;
        await service.send(COMPANY, invoice.id, ACTOR);
      } finally {
        fakeAdapter.failEnqueue = false;
      }
      // the authority definitively REJECTS the transport-pending packet —
      // only this authoritative answer unlocks the official retry
      fakeAdapter.inquiryQueue.push('FAILED');
      expect((await service.inquiry(COMPANY, invoice.id)).status).toBe('FAILED');
      const retryRes = await service.send(COMPANY, invoice.id, ACTOR);
      expect(retryRes.status).toBe('SUBMITTED');
      const submissions = await prisma.salesTaxInvoiceSubmission.findMany({
        where: { invoiceId: invoice.id },
        orderBy: { attempt: 'asc' },
      });
      expect(submissions).toHaveLength(2);
      expect(submissions[0].status).toBe('FAILED'); // authoritative rejection recorded
      expect(submissions[0].errorCode).toBe('CONTENT'); // authoritative code wins over TRANSPORT
      expect(submissions[1].attempt).toBe(2);
      expect(submissions[1].retry).toBe(true); // official retry flag after authoritative failure
      expect(submissions[1].uid).not.toBe(submissions[0].uid); // new uid — safe: #1 was authoritatively rejected
    },
  );

  itif('p8-07 two concurrent sends on one invoice claim atomically (single submission)', async () => {
    const doc = await makeOwnDoc();
    const invoice = await service.createFromSalesDocument(COMPANY, { salesDocumentId: doc.id, lineSstids: [{ salesLineId: doc.lines[0].id, sstid: '2710000138624' }] }, ACTOR);
    const [a, b] = await Promise.allSettled([
      service.send(COMPANY, invoice.id, ACTOR),
      service.send(COMPANY, invoice.id, ACTOR),
    ]);
    const settled = [a, b].map((r) => (r.status === 'fulfilled' ? r.value.status : 'conflict'));
    // exactly one SUBMITTED; the other either conflicted or also returned with
    // the atomic claim — in both cases exactly ONE submission must exist
    const submissions = await prisma.salesTaxInvoiceSubmission.findMany({ where: { invoiceId: invoice.id } });
    expect(submissions.length).toBe(1);
    expect(settled.filter((s) => s === 'SUBMITTED').length).toBe(1);
  });

  itif('p8-08 purchase tax invoice registration + M:N allocation', async () => {
    const purchase = await service.registerPurchase(
      COMPANY,
      {
        supplierPartyId: myPartyIds[0],
        supplierInvoiceNumber: `SUP-${Date.now()}`,
        invoiceDate: new Date(),
        total: '5000',
        taxTotal: '450',
      },
      ACTOR,
    );
    expect(purchase.number).toMatch(/^PTI-\d{5}$/);
    const allocation = await prisma.purchaseTaxInvoiceOrderAllocation.create({
      data: {
        companyId: COMPANY,
        purchaseTaxInvoiceId: purchase.id,
        purchaseDocumentId: mySalesDocIds[0], // substitute; real purchase docs same shape
        allocatedAmount: new Prisma.Decimal('5000'),
      },
    });
    expect(allocation.allocatedAmount.toString()).toBe('5000');
  });

  itif('p8-09 sales document Moadian registration status', async () => {
    // fresh doc with an invoice that is created but never sent → Not Registered
    const freshDoc = await makeOwnDoc();
    await service.createFromSalesDocument(COMPANY, { salesDocumentId: freshDoc.id, lineSstids: [{ salesLineId: freshDoc.lines[0].id, sstid: '2710000138624' }] }, ACTOR);
    const notRegistered = await service.salesDocumentMoadianStatus(COMPANY, freshDoc.id);
    expect(notRegistered.moadianStatus).toBe('Not Registered');
    // doc sent + confirmed → Fully Registered with covered amount
    const sentDoc = await makeOwnDoc();
    const inv = await service.createFromSalesDocument(COMPANY, { salesDocumentId: sentDoc.id, lineSstids: [{ salesLineId: sentDoc.lines[0].id, sstid: '2710000138624' }] }, ACTOR);
    await service.send(COMPANY, inv.id, ACTOR);
    fakeAdapter.inquiryQueue.push('SUCCESS');
    await service.inquiry(COMPANY, inv.id);
    // doc.total drives the coverage percentage — set it to the invoice total
    const invFresh = await prisma.salesTaxInvoice.findUniqueOrThrow({ where: { id: inv.id } });
    await prisma.salesDocument.update({ where: { id: sentDoc.id }, data: { total: invFresh.grandTotal } });
    const registered = await service.salesDocumentMoadianStatus(COMPANY, sentDoc.id);
    expect(registered.moadianStatus).toBe('Fully Registered');
    expect(registered.invoiceCount).toBe(1);
    expect(registered.coveredPct).not.toBeNull();
  });
});
