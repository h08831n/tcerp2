import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SequencesService } from '../sequences/sequences.service';
import { TaxInvoiceService } from './tax-invoice.service';
import { TaxInvoiceController } from './tax-invoice.controller';
import { PERMISSIONS_KEY } from '../common/decorators/permissions.decorator';
import { TEST_INTEGRATION, disconnectIntegrationPrisma } from '../testing/integration';
import { assertSafeIntegrationDatabase } from '../testing/db-guard';

jest.setTimeout(120000);

const DB_URL = process.env.DATABASE_URL;

if (TEST_INTEGRATION) assertSafeIntegrationDatabase(DB_URL);

const ACTOR = { id: '00000000-0000-4000-8000-0000000000a1', username: 'admin' };

/** Deterministic fake Moadian adapter (per-test behavior, no env games). */
class FakeMoadianAdapter {
  failEnqueue = false;
  inquiryQueue: Array<'PENDING' | 'SUCCESS' | 'FAILED'> = [];
  inquired: string[] = [];
  enqueued: Array<{ uid: string; retry: boolean }> = [];

  async getToken() {
    return { token: 'fake', expiresInSeconds: 900 };
  }
  async enqueue(packets: Array<{ uid: string; retry: boolean; data: string }>) {
    this.enqueued.push(...packets.map((p) => ({ uid: p.uid, retry: p.retry })));
    if (this.failEnqueue) throw new Error('INJECTED: enqueue transport failure');
    return packets.map((p) => ({ uid: p.uid, referenceNumber: `ref-${p.uid.slice(0, 8)}` }));
  }
  async inquiryByUid(uids: string[]) {
    this.inquired.push(...uids);
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

describe('p8a — Critical Tax Audit (payload, over-invoicing, unknown outcomes)', () => {
  let prismaService: PrismaService;
  let prisma: PrismaClient;
  let service: TaxInvoiceService;
  let fakeAdapter: FakeMoadianAdapter;
  let COMPANY = '';
  const created: string[] = [];
  let seq = 0;

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
      data: { nameFa: `p8a-${Date.now()}`, status: 'ACTIVE', economicCode: '411151234567', nationalId: '10109999999' },
    });
    COMPANY = company.id;
    created.push(COMPANY);
    for (const dt of ['SALES_TAX_INVOICE', 'PURCHASE_TAX_INVOICE']) {
      await prismaService.sequence.create({
        data: { companyId: COMPANY, documentType: dt, name: dt, prefix: dt === 'SALES_TAX_INVOICE' ? 'STI' : 'PTI', padding: 5, resetCycle: 'NEVER' },
      });
    }
  });

  const itif = TEST_INTEGRATION && DB_URL ? it : (n: string, f: jest.ProvidesCallback) => it.skip(n, f);

  /** minimal COMPLETED doc + one taxed line + loading allocation of `loaded` */
  async function makeDoc(loaded: string, opts: { withEconomicCode?: boolean } = {}) {
    seq += 1;
    const stamp = `${Date.now()}-${seq}`;
    const customer = await prisma.party.create({
      data: {
        companyId: COMPANY,
        type: 'PERSON',
        nameFa: `p8a مشتری ${stamp}`,
        economicCode: opts.withEconomicCode === false ? null : '411598765432',
        nationalCode: `0012${seq}789${String(seq).padStart(3, '0')}`,
        roles: { create: [{ role: 'CUSTOMER' }] },
      },
    });
    created.push(customer.id);
    const salesperson = await prisma.user.create({
      data: { username: `p8a-${stamp}`, passwordHash: 'x', status: 'ACTIVE' },
    });
    created.push(salesperson.id);
    const uomCategory = await prisma.uomCategory.create({ data: { companyId: COMPANY, code: `W-${stamp}`, nameFa: 'وزن' } });
    created.push(uomCategory.id);
    const uom = await prisma.uom.create({
      data: { companyId: COMPANY, categoryId: uomCategory.id, nameFa: `kg-${stamp}`, symbol: `kg-${stamp}`, conversionRatio: new Prisma.Decimal(1), isBaseUnit: true },
    });
    created.push(uom.id);
    const variant = await prisma.productVariant.create({
      data: {
        companyId: COMPANY,
        templateId: (
          await prisma.productTemplate.create({
            data: {
              companyId: COMPANY,
              categoryId: (
                await prisma.productCategory.create({
                  data: { companyId: COMPANY, code: `P8A-${stamp}`, nameFa: 'p8a' },
                })
              ).id,
              nameFa: 'p8a',
            },
          })
        ).id,
        sku: `P8A-${stamp}`,
        nameFa: 'کالای p8a',
        combinationKey: `p8a-${stamp}`,
      },
    });
    created.push(variant.id);
    const doc = await prisma.salesDocument.create({
      data: {
        companyId: COMPANY,
        documentNumber: `P8A-${stamp}`,
        customerPartyId: customer.id,
        salespersonUserId: salesperson.id,
        documentDate: new Date(),
        status: 'COMPLETED',
        lines: {
          create: {
            companyId: COMPANY,
            productVariantId: variant.id,
            orderedQuantity: new Prisma.Decimal(999),
            uomId: uom.id,
            unitPrice: new Prisma.Decimal('123.45'),
            discountAmount: new Prisma.Decimal('23.45'),
            taxRateSnapshot: new Prisma.Decimal(9),
            subtotal: new Prisma.Decimal('0'),
            lineTotal: new Prisma.Decimal('0'),
          },
        },
      },
      include: { lines: true },
    });
    created.push(doc.id);
    const line = doc.lines[0];
    const loading = await prisma.loading.create({ data: { companyId: COMPANY, loadingDate: new Date() } });
    created.push(loading.id);
    const loadingLine = await prisma.loadingLine.create({
      data: { loadingId: loading.id, productVariantId: line.productVariantId, actualQuantity: new Prisma.Decimal(loaded), uomId: uom.id },
    });
    created.push(loadingLine.id);
    await prisma.loadingAllocation.create({
      data: { companyId: COMPANY, loadingLineId: loadingLine.id, salesLineId: line.id, allocatedQuantity: new Prisma.Decimal(loaded) },
    });
    return { doc, line };
  }

  afterAll(async () => {
    if (!prismaService || !COMPANY) {
      if (prismaService) await prismaService.$disconnect();
      return;
    }
    const failures: string[] = [];
    try {
      const steps: Array<[string, () => Promise<unknown>]> = [
        ['submission', () => prisma.salesTaxInvoiceSubmission.deleteMany({ where: { companyId: COMPANY } })],
        ['taxLine', () => prisma.salesTaxInvoiceLine.deleteMany({ where: { companyId: COMPANY } })],
        ['taxInvoice', () => prisma.salesTaxInvoice.deleteMany({ where: { companyId: COMPANY } })],
        ['salesAllocation', () => prisma.salesTaxInvoiceOrderAllocation.deleteMany({ where: { companyId: COMPANY } })],
        ['loadingAllocation', () => prisma.loadingAllocation.deleteMany({ where: { companyId: COMPANY } })],
        ['loadingLine', () => prisma.loadingLine.deleteMany({ where: { loading: { companyId: COMPANY } } })],
        ['loading', () => prisma.loading.deleteMany({ where: { companyId: COMPANY } })],
        ['salesLine', () => prisma.salesLine.deleteMany({ where: { companyId: COMPANY } })],
        ['salesDocument', () => prisma.salesDocument.deleteMany({ where: { companyId: COMPANY } })],
        ['variant', () => prisma.productVariant.deleteMany({ where: { companyId: COMPANY } })],
        ['template', () => prisma.productTemplate.deleteMany({ where: { companyId: COMPANY } })],
        ['category', () => prisma.productCategory.deleteMany({ where: { companyId: COMPANY } })],
        ['uom', () => prisma.uom.deleteMany({ where: { companyId: COMPANY } })],
        ['uomCategory', () => prisma.uomCategory.deleteMany({ where: { companyId: COMPANY } })],
        ['party', () => prisma.party.deleteMany({ where: { companyId: COMPANY } })],
        ['user', () => prisma.user.deleteMany({ where: { username: { startsWith: 'p8a-' } } })],
        ['sequence', () => prisma.sequence.deleteMany({ where: { companyId: COMPANY } })],
      ];
      for (const [name, run] of steps) {
        try {
          await run();
        } catch (e) {
          failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      try {
        await prisma.company.delete({ where: { id: COMPANY } });
      } catch (e) {
        failures.push(`company: ${e instanceof Error ? e.message : String(e)}`);
      }
    } finally {
      await prismaService.$disconnect().catch(() => undefined);
    }
    if (failures.length > 0) {
      throw new Error(`p8a cleanup INCOMPLETE — test data left behind: ${failures.join(' | ')}`);
    }
    await disconnectIntegrationPrisma();
  });

  itif('p8-10 payload audit: header/body fields match the official template exactly', async () => {
    const { doc } = await makeDoc('20');
    const issued = new Date('2026-03-15T10:30:00Z');
    const invoice = await service.createFromSalesDocument(COMPANY, { salesDocumentId: doc.id, issueDate: issued, lineSstids: [{ salesLineId: doc.lines[0].id, sstid: '2710000138624' }] }, ACTOR);
    await service.send(COMPANY, invoice.id, ACTOR);
    const submission = await prisma.salesTaxInvoiceSubmission.findFirstOrThrow({
      where: { invoiceId: invoice.id },
      orderBy: { attempt: 'desc' },
    });
    const packet = (submission.payloadSnapshot as { packets: Array<{ data: string }> }).packets[0];
    const payload = JSON.parse(packet.data) as {
      header: Record<string, string>;
      body: Array<Record<string, string>>;
      payments: Array<Record<string, string>>;
    };
    expect(payload.header.inno).toBe(invoice.number);
    expect(payload.header.inty).toBe(1); // MAIN → type 1
    expect(payload.header.ins).toBe(1); // subject اصلی
    const createdFresh = await prisma.salesTaxInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
    // inty = invoice TYPE (1=نوع اول), independent of ins (subject) — جدول ۷
    expect(payload.header.inty).toBe(1);
    expect(createdFresh.inty).toBe(1);
    expect(payload.header.ins).toBe(1); // subject اصلی
    // indatim/indati2m = MILLISECONDS (official Timestamp 14 digits, sample
    // 1655620821274): indatim = issue date midnight (DATE column),
    // indati2m = record creation moment
    expect(payload.header.indatim).toBe(new Date('2026-03-15').getTime());
    expect(Number.isInteger(payload.header.indatim)).toBe(true);
    expect(payload.header.indatim).toBeGreaterThan(1_600_000_000_000); // ms, not seconds
    expect(payload.header.indati2m).toBe(createdFresh.createdAt.getTime());
    expect(Number.isInteger(payload.header.indati2m)).toBe(true);
        const buyer = await prisma.party.findFirstOrThrow({
      where: { companyId: COMPANY, id: invoice.customerPartyId },
    });
    // official RC_IITP.IS_V7.9 جدول ۲: tins = SELLER economic code (must
    // match the taxpayer's own records); tob = buyer person type with
    // 1=حقیقی, 2=حقوقی; bid/tinb carry the BUYER identity per tob
    expect(payload.header.tins).toBe('411151234567'); // seller (company) economic code
    expect(payload.header.tob).toBe(1); // buyer is a real person (حقیقی)
    expect(payload.header.bid).toBe(buyer.nationalCode); // buyer شماره ملی
    expect(payload.header.taxid).toBeNull(); // generated only with fiscal key material
    expect(Array.isArray(payload.payments)).toBe(true);
    // totals: prdis=20×123.45=2469; tdis=23.45; tadis=2445.55; tvam=2445.55×9%=220.0995; tbill=2665.6495
    expect(payload.header.tprdis).toBe('2469');
    expect(payload.header.tdis).toBe('23.45');
    expect(payload.header.tadis).toBe('2445.55');
    expect(payload.header.tvam).toBe('220.0995');
    expect(payload.header.tbill).toBe('2665.6495');
    expect(payload.body).toHaveLength(1);
    expect(payload.body[0].am).toBe('20');
    expect(payload.body[0].fee).toBe('123.45');
    expect(payload.body[0].prdis).toBe('2469');
    expect(payload.body[0].dis).toBe('23.45');
    expect(payload.body[0].vra).toBe('9');
    expect(payload.body[0].vam).toBe('220.0995');
    expect(payload.body[0].tsstam).toBe('220.0995');
    // official RC_TICS.IS_v1.6 §7: the top-level payments array is named
    // `payments` and `inp` (الگوی) is a header field
    expect(Array.isArray(payload.payments)).toBe(true);
    expect(payload.payments).toHaveLength(0); // payment mapping: documented gap
    expect(payload.header.inp).toBe(1);
    // internal consistency: Σ line vam == tvam; prdis − dis == tadis
    const sumVam = payload.body.reduce((s: Prisma.Decimal, b) => s.plus(b.vam), new Prisma.Decimal(0));
    expect(sumVam.toString()).toBe(payload.header.tvam);
    expect(new Prisma.Decimal(payload.header.tprdis).minus(payload.header.tdis).toString()).toBe(payload.header.tadis);
  });

  itif('p8-11 corrective invoice inherits the ORIGINAL invoice type (inty), ins is independent, irtaxid required', async () => {
    const { doc } = await makeDoc('5');
    const original = await service.createFromSalesDocument(COMPANY, { salesDocumentId: doc.id, lineSstids: [{ salesLineId: doc.lines[0].id, sstid: '2710000138624' }] }, ACTOR);
    const taxid = 'A1B2C3D4E5F6G7H';
    await prisma.salesTaxInvoice.update({ where: { id: original.id }, data: { taxid } });
    await expect(
      service.createFromSalesDocument(COMPANY, { salesDocumentId: doc.id, subject: 'CORRECTIVE' }, ACTOR),
    ).rejects.toThrow('TAX_INVOICE_RELATED_TAXID_REQUIRED');
    const corrective = await service.createFromSalesDocument(COMPANY, {
      salesDocumentId: doc.id,
      subject: 'CORRECTIVE',
      relatedTaxid: taxid,
      lineSstids: [{ salesLineId: doc.lines[0].id, sstid: '2710000138624' }],
    }, ACTOR);
    await service.send(COMPANY, corrective.id, ACTOR);
    const submission = await prisma.salesTaxInvoiceSubmission.findFirstOrThrow({
      where: { invoiceId: corrective.id },
      orderBy: { attempt: 'desc' },
    });
    const payload = JSON.parse((submission.payloadSnapshot as { packets: Array<{ data: string }> }).packets[0].data) as {
      header: Record<string, unknown>;
    };
    // inty INHERITS the original's type (buyer is an economic operator →
    // original inty=1); ins=2 (اصلاحی) is the independent subject dimension —
    // per official issuance rules inty is determined by the buyer, NOT by subject
    expect(payload.header.inty).toBe(1);
    expect(payload.header.ins).toBe(2);
    expect(payload.header.irtaxid).toBe(taxid);
    const correctiveRow = await prisma.salesTaxInvoice.findUniqueOrThrow({ where: { id: corrective.id } });
    expect(correctiveRow.inty).toBe(1); // inherited row-level
    expect(correctiveRow.subject).toBe('CORRECTIVE');
    expect(payload.header.indati2m).toBe(correctiveRow.createdAt.getTime());
  });

  itif('p8-17 table-driven inty/ins derivation: buyer determines type, subject is independent', async () => {
    // buyer WITH economicCode → نوع اول (inty=1) for every subject
    const { doc: b2bDoc } = await makeDoc('4');
    const b2bMain = await service.createFromSalesDocument(COMPANY, { salesDocumentId: b2bDoc.id, lineSstids: [{ salesLineId: b2bDoc.lines[0].id, sstid: '2710000138624' }] }, ACTOR);
    expect(b2bMain.inty).toBe(1);
    expect(b2bMain.subject).toBe('MAIN');
    // consumer WITHOUT economicCode → نوع دوم (inty=2)
    const { doc: consumerDoc } = await makeDoc('4', { withEconomicCode: false });
    const consumerMain = await service.createFromSalesDocument(COMPANY, { salesDocumentId: consumerDoc.id, lineSstids: [{ salesLineId: consumerDoc.lines[0].id, sstid: '2710000138624' }] }, ACTOR);
    expect(consumerMain.inty).toBe(2);
    expect(consumerMain.subject).toBe('MAIN');
    // corrective on a consumer invoice: inherits inty=2, ins=2
    const consumerTaxid = 'B1B2C3D4E5F6G7H';
    await prisma.salesTaxInvoice.update({ where: { id: consumerMain.id }, data: { taxid: consumerTaxid } });
    const corrective = await service.createFromSalesDocument(COMPANY, {
      salesDocumentId: consumerDoc.id,
      subject: 'RETURN',
      relatedTaxid: consumerTaxid,
      lineSstids: [{ salesLineId: consumerDoc.lines[0].id, sstid: '2710000138624' }],
    }, ACTOR);
    expect(corrective.inty).toBe(2); // inherited from consumer original
    expect(corrective.subject).toBe('RETURN');
    expect(corrective.relatedTaxid).toBe(consumerTaxid);
  });

  itif('p8-12 over-invoicing blocked; cancelled frees; override above remaining rejected', async () => {
    const { doc, line } = await makeDoc('50');
    const first = await service.createFromSalesDocument(COMPANY, { salesDocumentId: doc.id, lineSstids: [{ salesLineId: doc.lines[0].id, sstid: '2710000138624' }] }, ACTOR);
    expect((await prisma.salesTaxInvoiceLine.findUniqueOrThrow({ where: { id: first.lines[0].id } })).quantity.toString()).toBe('50');
    await expect(
      service.createFromSalesDocument(COMPANY, { salesDocumentId: doc.id, lineSstids: [{ salesLineId: doc.lines[0].id, sstid: '2710000138624' }] }, ACTOR),
    ).rejects.toThrow('TAX_INVOICE_QUANTITY_EXCEEDED');
    // cancellation (never accepted by the authority) frees the loaded quantity
    await prisma.salesTaxInvoice.update({ where: { id: first.id }, data: { status: 'CANCELLED' } });
    const second = await service.createFromSalesDocument(COMPANY, { salesDocumentId: doc.id, lineSstids: [{ salesLineId: doc.lines[0].id, sstid: '2710000138624' }] }, ACTOR);
    expect((await prisma.salesTaxInvoiceLine.findUniqueOrThrow({ where: { id: second.lines[0].id } })).quantity.toString()).toBe('50');
    await expect(
      service.createFromSalesDocument(COMPANY, {
        salesDocumentId: doc.id,
        lineOverrides: [{ salesLineId: line.id, quantity: '60' }],
      }, ACTOR),
    ).rejects.toThrow('TAX_INVOICE_QUANTITY_EXCEEDED');
  });

  itif('p8-13 unknown outcome: stuck SENDING → recovery inquires, NEVER blind-resends', async () => {
    const { doc } = await makeDoc('10');
    const invoice = await service.createFromSalesDocument(COMPANY, { salesDocumentId: doc.id, lineSstids: [{ salesLineId: doc.lines[0].id, sstid: '2710000138624' }] }, ACTOR);
    const res = await service.send(COMPANY, invoice.id, ACTOR);
    expect(res.status).toBe('SUBMITTED');
    // simulate crash between claim and completion
    await prisma.salesTaxInvoice.update({ where: { id: invoice.id }, data: { status: 'SENDING' } });
    fakeAdapter.inquiryQueue.push('PENDING'); // authority still holds the packet
    const before = await prisma.salesTaxInvoiceSubmission.count({ where: { invoiceId: invoice.id } });
    await expect(service.send(COMPANY, invoice.id, ACTOR)).rejects.toThrow('TAX_INVOICE_SEND_IN_PROGRESS');
    const after = await prisma.salesTaxInvoiceSubmission.count({ where: { invoiceId: invoice.id } });
    expect(after).toBe(before); // NO blind resend
    fakeAdapter.inquiryQueue.push('SUCCESS');
    expect((await service.inquiry(COMPANY, invoice.id)).status).toBe('SUCCESS');
  });

  itif(
    'p8-14 uncorrelated submission response (official v1.6) is an UNKNOWN outcome — never accepted, never FAILED',
    async () => {
      // official RC_TICS.IS_v1.6 §7: the response uid MUST echo the sent
      // requestTraceId. An uncorrelated/malformed response is rejected by the
      // adapter and lands in the safe UNKNOWN path (submission stays PENDING,
      // invoice awaiting inquiry) — never accepted, never failed, no resend.
      const { doc } = await makeDoc('8');
      const invoice = await service.createFromSalesDocument(COMPANY, { salesDocumentId: doc.id, lineSstids: [{ salesLineId: doc.lines[0].id, sstid: '2710000138624' }] }, ACTOR);
      const realEnqueue = fakeAdapter.enqueue.bind(fakeAdapter);
      fakeAdapter.enqueue = async (packets) => {
        await realEnqueue(packets); // the authority "received" packet #1
        return [{ uid: 'not-our-trace-id', referenceNumber: 'ref-foreign' }]; // uncorrelated response
      };
      const res = await service.send(COMPANY, invoice.id, ACTOR);
      expect(res.status).toBe('SUBMITTED');
      expect(res.awaitingInquiry).toBe(true);
      fakeAdapter.enqueue = realEnqueue;
      const submission = await prisma.salesTaxInvoiceSubmission.findFirstOrThrow({
        where: { invoiceId: invoice.id },
        orderBy: { attempt: 'desc' },
      });
      expect(submission.status).toBe('PENDING'); // UNKNOWN outcome — recoverable
      expect(submission.errorCode).toBe('TRANSPORT');
      const enqueuedBefore = fakeAdapter.enqueued.length;
      // a re-send while the outcome is unresolved is blocked — no duplicate
      await expect(service.send(COMPANY, invoice.id, ACTOR)).rejects.toThrow('TAX_INVOICE_NOT_SENDABLE');
      expect(fakeAdapter.enqueued.length).toBe(enqueuedBefore);
      // recovery via the SAME uid: the authority accepted packet #1
      fakeAdapter.inquiryQueue.push('SUCCESS');
      expect((await service.inquiry(COMPANY, invoice.id)).status).toBe('SUCCESS');
      const fresh = await prisma.salesTaxInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
      expect(fresh.status).toBe('SUCCESS');
      expect(fresh.moadianError).toBeNull();
      expect(await prisma.salesTaxInvoiceSubmission.count({ where: { invoiceId: invoice.id } })).toBe(1);
    },
  );

  itif('p8-15 stale response: older-attempt SUCCESS never overwrites newer FAILED', async () => {
    const { doc } = await makeDoc('6');
    const invoice = await service.createFromSalesDocument(COMPANY, { salesDocumentId: doc.id, lineSstids: [{ salesLineId: doc.lines[0].id, sstid: '2710000138624' }] }, ACTOR);
    await service.send(COMPANY, invoice.id, ACTOR); // attempt 1 → PENDING
    fakeAdapter.inquiryQueue.push('FAILED');
    await service.inquiry(COMPANY, invoice.id); // attempt 1 FAILED
    const retry = await service.send(COMPANY, invoice.id, ACTOR); // attempt 2 → PENDING
    expect(retry.status).toBe('SUBMITTED');
    // simulate the authority LATE-accepting attempt 1 (stale success)
    await prisma.salesTaxInvoiceSubmission.update({
      where: {
        uid: (await prisma.salesTaxInvoiceSubmission.findFirstOrThrow({ where: { invoiceId: invoice.id, attempt: 1 } })).uid,
      },
      data: { status: 'PENDING' },
    });
    fakeAdapter.inquiryQueue.push('FAILED', 'SUCCESS'); // call order=attempt-desc: attempt2→FAILED, attempt1→SUCCESS (stale)
    const final = await service.inquiry(COMPANY, invoice.id);
    expect(final.status).toBe('FAILED'); // newest attempt wins
    const fresh = await prisma.salesTaxInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(fresh.status).toBe('FAILED');
  });

  itif('p8-16 concurrent creation cannot over-issue (gate serializes same doc)', async () => {
    const { doc } = await makeDoc('10');
    const [a, b] = await Promise.allSettled([
      service.createFromSalesDocument(COMPANY, { salesDocumentId: doc.id, lineSstids: [{ salesLineId: doc.lines[0].id, sstid: '2710000138624' }] }, ACTOR),
      service.createFromSalesDocument(COMPANY, { salesDocumentId: doc.id, lineSstids: [{ salesLineId: doc.lines[0].id, sstid: '2710000138624' }] }, ACTOR),
    ]);
    const fulfilled = [a, b].filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBe(1);
    const lines = await prisma.salesTaxInvoiceLine.findMany({
      where: { salesLineId: (await prisma.salesLine.findFirstOrThrow({ where: { salesDocumentId: doc.id } })).id },
    });
    expect(lines.reduce((s, l) => s.plus(l.quantity), new Prisma.Decimal(0)).toString()).toBe('10');
  });


  // ninth review — recovery consistency: submission+invoice transitions are
  // ONE transaction, a DB failure after the remote answer is INCONCLUSIVE
  // (never safe-to-retry), and a persisted SUCCESS attempt never unlocks a
  // new send
  itif(
    'p8-17a invoice-update failure after remote SUCCESS rolls back the transaction; same uid re-inquired, no new uid/enqueue',
    async () => {
      const { doc } = await makeDoc('9');
      const invoice = await service.createFromSalesDocument(COMPANY, { salesDocumentId: doc.id, lineSstids: [{ salesLineId: doc.lines[0].id, sstid: '2710000138624' }] }, ACTOR);
      const sent = await service.send(COMPANY, invoice.id, ACTOR);
      expect(sent.status).toBe('SUBMITTED');
      const uid = sent.uid!;
      await prisma.salesTaxInvoice.update({ where: { id: invoice.id }, data: { status: 'SENDING' } });
      // the FIRST recovery response is an AUTHORITATIVE SUCCESS so that
      // recoverPending() actually enters the submission+invoice transaction
      // (a PENDING answer would skip it — vacuous pass, tenth review)
      fakeAdapter.inquiryQueue.push('SUCCESS');

      // inject a deterministic failure in the PARENT invoice update INSIDE
      // the recovery transaction, after the remote inquiry answered SUCCESS
      let injectionHits = 0; // proof the failure hook was actually reached
      const realTransaction = prisma.$transaction.bind(prisma);
      const txSpy = jest
        .spyOn(prisma, '$transaction')
        .mockImplementationOnce((async (arg: unknown) => {
          return realTransaction(async (tx: Prisma.TransactionClient) => {
            const failingTx = new Proxy(tx, {
              get(target, prop) {
                if (prop === 'salesTaxInvoice') {
                  return new Proxy(target.salesTaxInvoice, {
                    get(t, p) {
                      if (p === 'update') {
                        return (...args: unknown[]) => {
                          injectionHits += 1;
                          return Promise.reject(new Error('INJECTED: invoice update failure'));
                        };
                      }
                      const v = Reflect.get(t, p, t);
                      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
                    },
                  });
                }
                return Reflect.get(target, prop);
              },
            });
            return (arg as (tx: Prisma.TransactionClient) => unknown)(failingTx);
          });
        }) as never);
      const enqueuedBefore = fakeAdapter.enqueued.length;
      const inquiredBefore = fakeAdapter.inquired.filter((u) => u === uid).length;
      // the spy is ALWAYS restored — even when an assertion or the send
      // itself fails (eleventh review: test isolation)
      try {
        await expect(service.send(COMPANY, invoice.id, ACTOR)).rejects.toThrow('TAX_INVOICE_SEND_IN_PROGRESS');
        // the injected failure hook WAS reached, exactly once, after SUCCESS
        expect(injectionHits).toBe(1);
        // the transaction rolled back BOTH writes: submission stays PENDING
        // (recoverable, durable uid) and the invoice keeps its pre-recovery state
        const submission = await prisma.salesTaxInvoiceSubmission.findUniqueOrThrow({ where: { uid } });
        expect(submission.status).toBe('PENDING');
        const afterFailure = await prisma.salesTaxInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
        expect(afterFailure.status).toBe('SENDING');
        expect(fakeAdapter.enqueued.length).toBe(enqueuedBefore); // no new uid was minted
        expect(fakeAdapter.inquired.filter((u) => u === uid).length).toBe(inquiredBefore + 1);
      } finally {
        txSpy.mockRestore();
      }

      // a subsequent recovery inquiries the SAME persisted uid and converges
      fakeAdapter.inquiryQueue.push('SUCCESS');
      const retried = await service.send(COMPANY, invoice.id, ACTOR);
      expect(retried.status).toBe('SUCCESS');
      expect(fakeAdapter.enqueued.length).toBe(enqueuedBefore); // STILL no enqueue
      expect(fakeAdapter.inquired.filter((u) => u === uid).length).toBe(inquiredBefore + 2); // same uid
      const promoted = await prisma.salesTaxInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
      expect(promoted.status).toBe('SUCCESS');
      expect(await prisma.salesTaxInvoiceSubmission.count({ where: { invoiceId: invoice.id } })).toBe(1);
    },
  );

  itif(
    'p8-17b persisted SUCCESS attempt is never misclassified as safe-to-retry (torn partial write repaired)',
    async () => {
      const { doc } = await makeDoc('7');
      const invoice = await service.createFromSalesDocument(COMPANY, { salesDocumentId: doc.id, lineSstids: [{ salesLineId: doc.lines[0].id, sstid: '2710000138624' }] }, ACTOR);
      const sent = await service.send(COMPANY, invoice.id, ACTOR);
      expect(sent.status).toBe('SUBMITTED');
      // simulate the torn state the defect produced: submission terminal
      // SUCCESS, parent invoice stale FAILED (worst case — sendable!)
      await prisma.salesTaxInvoiceSubmission.update({
        where: { uid: sent.uid! },
        data: { status: 'SUCCESS', confirmationReferenceId: 'conf-torn' },
      });
      await prisma.salesTaxInvoice.update({
        where: { id: invoice.id },
        data: { status: 'FAILED', moadianStatus: 'FAILED', moadianError: 'stale' },
      });
      const enqueuedBefore = fakeAdapter.enqueued.length;
      const res = await service.send(COMPANY, invoice.id, ACTOR);
      // the accepted attempt is detected: retry is REJECTED, success reported
      expect(res.status).toBe('SUCCESS');
      expect(res.recoveredLateSuccess).toBe(true);
      expect(fakeAdapter.enqueued.length).toBe(enqueuedBefore); // NO new uid, NO duplicate
      const repaired = await prisma.salesTaxInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
      expect(repaired.status).toBe('SUCCESS');
      expect(repaired.confirmationReferenceId).toBe('conf-torn'); // from the persisted accepted attempt
      expect(await prisma.salesTaxInvoiceSubmission.count({ where: { invoiceId: invoice.id } })).toBe(1);
    },
  );

  itif(
    'p8-17c inquiry() has the same atomic protection: parent-update failure rolls back, submission stays recoverable',
    async () => {
      const { doc } = await makeDoc('5');
      const invoice = await service.createFromSalesDocument(COMPANY, { salesDocumentId: doc.id, lineSstids: [{ salesLineId: doc.lines[0].id, sstid: '2710000138624' }] }, ACTOR);
      const sent = await service.send(COMPANY, invoice.id, ACTOR);
      expect(sent.status).toBe('SUBMITTED');
      const uid = sent.uid!;
      const realTransaction = prisma.$transaction.bind(prisma);
      let injectionHits = 0; // proof the failure hook was actually reached
      const txSpy = jest
        .spyOn(prisma, '$transaction')
        .mockImplementationOnce((async (arg: unknown) => {
          return realTransaction(async (tx: Prisma.TransactionClient) => {
            const failingTx = new Proxy(tx, {
              get(target, prop) {
                if (prop === 'salesTaxInvoice') {
                  return new Proxy(target.salesTaxInvoice, {
                    get(t, p) {
                      if (p === 'update') {
                        return (...args: unknown[]) => {
                          injectionHits += 1;
                          return Promise.reject(new Error('INJECTED: invoice update failure'));
                        };
                      }
                      const v = Reflect.get(t, p, t);
                      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
                    },
                  });
                }
                return Reflect.get(target, prop);
              },
            });
            return (arg as (tx: Prisma.TransactionClient) => unknown)(failingTx);
          });
        }) as never);
      fakeAdapter.inquiryQueue.push('SUCCESS');
      const enqueuedBefore = fakeAdapter.enqueued.length;
      // the spy is ALWAYS restored — even when an assertion or the inquiry
      // itself fails (eleventh review: test isolation)
      try {
        await expect(service.inquiry(COMPANY, invoice.id)).rejects.toThrow('INJECTED');
        // the injected failure hook WAS reached inside the inquiry transaction
        expect(injectionHits).toBe(1);
        // rolled back: the submission remains PENDING with its durable uid
        const submission = await prisma.salesTaxInvoiceSubmission.findUniqueOrThrow({ where: { uid } });
        expect(submission.status).toBe('PENDING');
      } finally {
        txSpy.mockRestore();
      }
      // a later inquiry (no injection) recovers on the SAME uid — no resend
      fakeAdapter.inquiryQueue.push('SUCCESS');
      const recovered = await service.inquiry(COMPANY, invoice.id);
      expect(recovered.status).toBe('SUCCESS');
      expect(fakeAdapter.enqueued.length).toBe(enqueuedBefore);
      expect(fakeAdapter.inquired.filter((u) => u === uid).length).toBe(2); // same uid both times
      const promoted = await prisma.salesTaxInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
      expect(promoted.status).toBe('SUCCESS');
      expect(await prisma.salesTaxInvoiceSubmission.count({ where: { invoiceId: invoice.id } })).toBe(1);
    },
  );


  // final audit #2 — fail-safe payload validation at the submission boundary
  itif(
    'p8-23a unmapped sstid → specific domain error BEFORE any state change; assignLineSstid then allows submission',
    async () => {
      const { doc } = await makeDoc('6');
      // create WITHOUT the goods-code mapping → sstid stays null
      const invoice = await service.createFromSalesDocument(COMPANY, { salesDocumentId: doc.id }, ACTOR);
      const enqueuedBefore = fakeAdapter.enqueued.length;
      await expect(service.send(COMPANY, invoice.id, ACTOR)).rejects.toThrow(
        'TAX_INVOICE_PAYLOAD_SSTID_UNMAPPED',
      );
      // fail-fast: nothing was claimed, nothing was submitted, nothing was sent
      expect(fakeAdapter.enqueued.length).toBe(enqueuedBefore);
      expect(
        await prisma.salesTaxInvoiceSubmission.count({ where: { invoiceId: invoice.id } }),
      ).toBe(0);
      const untouched = await prisma.salesTaxInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
      expect(untouched.status).toBe('READY');
      // the operator maps the lines via the assignment entry point
      const line = await prisma.salesTaxInvoiceLine.findFirstOrThrow({
        where: { salesTaxInvoiceId: invoice.id },
      });
      await service.assignLineSstid(COMPANY, line.id, '2710000138624', ACTOR);
      const res = await service.send(COMPANY, invoice.id, ACTOR);
      expect(res.status).toBe('SUBMITTED');
      const submission = await prisma.salesTaxInvoiceSubmission.findFirstOrThrow({
        where: { invoiceId: invoice.id },
      });
      const payload = JSON.parse(
        (submission.payloadSnapshot as { packets: Array<{ data: string }> }).packets[0].data,
      ) as { body: Array<{ sstid: string }> };
      expect(payload.body.every((l) => l.sstid === '2710000138624')).toBe(true);
    },
  );

  itif('p8-23b sandbox mode without taxid → TAX_INVOICE_PAYLOAD_TAXID_UNAVAILABLE (never a fabricated id)', async () => {
    const { doc } = await makeDoc('4');
    const invoice = await service.createFromSalesDocument(COMPANY, { salesDocumentId: doc.id, lineSstids: [{ salesLineId: doc.lines[0].id, sstid: '2710000138624' }] }, ACTOR);
    const previousMode = process.env.MOADIAN_MODE;
    process.env.MOADIAN_MODE = 'sandbox'; // a REAL authority requires a real taxid
    try {
      await expect(service.send(COMPANY, invoice.id, ACTOR)).rejects.toThrow(
        'TAX_INVOICE_PAYLOAD_TAXID_UNAVAILABLE',
      );
      expect(
        await prisma.salesTaxInvoiceSubmission.count({ where: { invoiceId: invoice.id } }),
      ).toBe(0);
    } finally {
      if (previousMode === undefined) delete process.env.MOADIAN_MODE;
      else process.env.MOADIAN_MODE = previousMode;
    }
  });

  it('p8-23c validateSubmissionPayload: totals, fields, sstid, taxid and payments rules', () => {
    const valid = {
      header: {
        inno: 'INV-1',
        taxid: null,
        indatim: 1683997837988,
        indati2m: 1683997837988,
        inty: 1,
        inp: 1,
        ins: 1,
        tins: '411151234567', // seller economic code (official جدول ۲)
        tob: 1, // buyer = real person (حقیقی)
        bid: '0012345678', // buyer شماره ملی (required for tob=1)
        tprdis: '20000',
        tdis: '500',
        tadis: '19500',
        tvam: '1755',
        todam: '0',
        tbill: '21255',
      },
      body: [{ sstid: '2710000138624', am: '2', fee: '10000', vam: '1755' }],
      payments: [],
    };
    expect(() => TaxInvoiceService.validateSubmissionPayload(valid, false)).not.toThrow();
    // a valid payload with a taxid passes even in strict mode
    expect(() =>
      TaxInvoiceService.validateSubmissionPayload(
        { ...valid, header: { ...valid.header, taxid: 'A1121604C220002F095011' } },
        true,
      ),
    ).not.toThrow();
    // tob=2 (حقوقی): bid + tinb are the required buyer fields
    expect(() =>
      TaxInvoiceService.validateSubmissionPayload(
        {
          ...valid,
          header: { ...valid.header, tob: 2, bid: '10109999999', tinb: '411199999999' },
        },
        false,
      ),
    ).not.toThrow();
    expect(() =>
      TaxInvoiceService.validateSubmissionPayload(
        { ...valid, header: { ...valid.header, tob: 2, bid: '10109999999' } },
        false,
      ),
    ).toThrow('TAX_INVOICE_PAYLOAD_BUYER_ID_MISSING');
    // non-MAIN subject without irtaxid is rejected
    expect(() =>
      TaxInvoiceService.validateSubmissionPayload(
        { ...valid, header: { ...valid.header, ins: 2 } },
        false,
      ),
    ).toThrow('TAX_INVOICE_PAYLOAD_IRTAXID_REQUIRED');
    // missing seller tins is rejected (official جدول ۲ rule 1)
    const noTins = JSON.parse(JSON.stringify(valid));
    noTins.header.tins = '';
    expect(() => TaxInvoiceService.validateSubmissionPayload(noTins, false)).toThrow(
      'TAX_INVOICE_PAYLOAD_SELLER_TINS_UNAVAILABLE',
    );
    // strict (sandbox/live): missing taxid is rejected — never fabricated
    expect(() => TaxInvoiceService.validateSubmissionPayload(valid, true)).toThrow(
      'TAX_INVOICE_PAYLOAD_TAXID_UNAVAILABLE',
    );
    // required header fields
    const missingInno = JSON.parse(JSON.stringify(valid));
    missingInno.header.inno = '';
    expect(() => TaxInvoiceService.validateSubmissionPayload(missingInno, false)).toThrow(
      'TAX_INVOICE_PAYLOAD_FIELD_MISSING',
    );
    // empty seller tins → the dedicated seller-identity error
    const missingTins = JSON.parse(JSON.stringify(valid));
    missingTins.header.tins = '';
    expect(() => TaxInvoiceService.validateSubmissionPayload(missingTins, false)).toThrow(
      'TAX_INVOICE_PAYLOAD_SELLER_TINS_UNAVAILABLE',
    );
    // absent seller tins (header built without it) → same dedicated error
    const absentTins = JSON.parse(JSON.stringify(valid));
    delete absentTins.header.tins;
    expect(() => TaxInvoiceService.validateSubmissionPayload(absentTins, false)).toThrow(
      'TAX_INVOICE_PAYLOAD_SELLER_TINS_UNAVAILABLE',
    );
    // invalid classification fields
    const badInty = JSON.parse(JSON.stringify(valid));
    badInty.header.inty = 9;
    expect(() => TaxInvoiceService.validateSubmissionPayload(badInty, false)).toThrow(
      'TAX_INVOICE_PAYLOAD_FIELD_INVALID',
    );
    // empty body
    expect(() =>
      TaxInvoiceService.validateSubmissionPayload({ ...valid, body: [] }, false),
    ).toThrow('TAX_INVOICE_PAYLOAD_BODY_EMPTY');
    // unmapped sstid
    const unmapped = JSON.parse(JSON.stringify(valid));
    unmapped.body[0].sstid = null;
    expect(() => TaxInvoiceService.validateSubmissionPayload(unmapped, false)).toThrow(
      'TAX_INVOICE_PAYLOAD_SSTID_UNMAPPED',
    );
    // totals: tadis ≠ tprdis − tdis
    const badTotals = JSON.parse(JSON.stringify(valid));
    badTotals.header.tadis = '99999';
    expect(() => TaxInvoiceService.validateSubmissionPayload(badTotals, false)).toThrow(
      'TAX_INVOICE_PAYLOAD_TOTALS_MISMATCH',
    );
    // totals: tbill ≠ tadis + tvam + todam
    const badBill = JSON.parse(JSON.stringify(valid));
    badBill.header.tbill = '1';
    expect(() => TaxInvoiceService.validateSubmissionPayload(badBill, false)).toThrow(
      'TAX_INVOICE_PAYLOAD_TOTALS_MISMATCH',
    );
    // totals: Σ body vam ≠ tvam
    const badVam = JSON.parse(JSON.stringify(valid));
    badVam.body[0].vam = '1';
    expect(() => TaxInvoiceService.validateSubmissionPayload(badVam, false)).toThrow(
      'TAX_INVOICE_PAYLOAD_TOTALS_MISMATCH',
    );
    // payments must be an array
    expect(() =>
      TaxInvoiceService.validateSubmissionPayload({ ...valid, payments: {} as unknown as unknown[] }, false),
    ).toThrow('TAX_INVOICE_PAYLOAD_FIELD_INVALID');
  });

  // thirteenth review — the mapping workflow is usable through the REAL
  // application: DTO forwarding, secured assign endpoint, company scoping
  itif(
    'p8-24 controller-level mapping workflow: lineSstids forwarded, secured assign endpoint, cross-company rejected',
    async () => {
      const { doc } = await makeDoc('6');
      const controller = new TaxInvoiceController(service, {
        requireCompanyId: async () => COMPANY,
      } as never);
      const requestStub = { headers: {} } as never;

      // permission metadata on the mapping route (backend-enforced)
      expect(Reflect.getMetadata(PERMISSIONS_KEY, controller.assignLineSstid)).toEqual(['tax.edit']);

      // 1) the create DTO forwards lineSstids into the service
      const createdInvoice = await controller.createFromSales(
        {
          salesDocumentId: doc.id,
          lineSstids: [{ salesLineId: doc.lines[0].id, sstid: '2710000138624' }],
        },
        ACTOR,
        requestStub,
      );
      const createdLine = await prisma.salesTaxInvoiceLine.findFirstOrThrow({
        where: { salesTaxInvoiceId: createdInvoice.id },
      });
      expect(createdLine.sstid).toBe('2710000138624');

      // 2) the assign endpoint records a correction on the invoice line
      await controller.assignLineSstid(createdLine.id, { sstid: '9999999999999' }, ACTOR, requestStub);
      const remapped = await prisma.salesTaxInvoiceLine.findUniqueOrThrow({ where: { id: createdLine.id } });
      expect(remapped.sstid).toBe('9999999999999');

      // 3) cross-company access is rejected (company scoping is DB-filtered)
      const otherCompany = await prisma.company.create({
        data: { nameFa: `p8-cross-${Date.now()}`, status: 'ACTIVE', economicCode: '411199999999' },
      });
      created.push(otherCompany.id);
      const controllerOther = new TaxInvoiceController(service, {
        requireCompanyId: async () => otherCompany.id,
      } as never);
      await expect(
        controllerOther.assignLineSstid(createdLine.id, { sstid: '8888888888888' }, ACTOR, requestStub),
      ).rejects.toThrow('Tax invoice line not found');
      const untouched = await prisma.salesTaxInvoiceLine.findUniqueOrThrow({ where: { id: createdLine.id } });
      expect(untouched.sstid).toBe('9999999999999');
    },
  );});
