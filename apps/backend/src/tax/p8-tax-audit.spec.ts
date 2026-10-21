import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SequencesService } from '../sequences/sequences.service';
import { TaxInvoiceService } from './tax-invoice.service';
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
    const invoice = await service.createFromSalesDocument(COMPANY, { salesDocumentId: doc.id, issueDate: issued }, ACTOR);
    await service.send(COMPANY, invoice.id, ACTOR);
    const submission = await prisma.salesTaxInvoiceSubmission.findFirstOrThrow({
      where: { invoiceId: invoice.id },
      orderBy: { attempt: 'desc' },
    });
    const packet = (submission.payloadSnapshot as { packets: Array<{ data: string }> }).packets[0];
    const payload = JSON.parse(packet.data) as {
      header: Record<string, string>;
      body: Array<Record<string, string>>;
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
    expect(payload.header.tins).toBe(buyer.nationalCode); // buyer national code (real person)
    expect(payload.header.tob).toBe(2); // حقیقی
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
    // internal consistency: Σ line vam == tvam; prdis − dis == tadis
    const sumVam = payload.body.reduce((s: Prisma.Decimal, b) => s.plus(b.vam), new Prisma.Decimal(0));
    expect(sumVam.toString()).toBe(payload.header.tvam);
    expect(new Prisma.Decimal(payload.header.tprdis).minus(payload.header.tdis).toString()).toBe(payload.header.tadis);
  });

  itif('p8-11 corrective invoice inherits the ORIGINAL invoice type (inty), ins is independent, irtaxid required', async () => {
    const { doc } = await makeDoc('5');
    const original = await service.createFromSalesDocument(COMPANY, { salesDocumentId: doc.id }, ACTOR);
    const taxid = 'A1B2C3D4E5F6G7H';
    await prisma.salesTaxInvoice.update({ where: { id: original.id }, data: { taxid } });
    await expect(
      service.createFromSalesDocument(COMPANY, { salesDocumentId: doc.id, subject: 'CORRECTIVE' }, ACTOR),
    ).rejects.toThrow('TAX_INVOICE_RELATED_TAXID_REQUIRED');
    const corrective = await service.createFromSalesDocument(COMPANY, {
      salesDocumentId: doc.id,
      subject: 'CORRECTIVE',
      relatedTaxid: taxid,
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
    const b2bMain = await service.createFromSalesDocument(COMPANY, { salesDocumentId: b2bDoc.id }, ACTOR);
    expect(b2bMain.inty).toBe(1);
    expect(b2bMain.subject).toBe('MAIN');
    // consumer WITHOUT economicCode → نوع دوم (inty=2)
    const { doc: consumerDoc } = await makeDoc('4', { withEconomicCode: false });
    const consumerMain = await service.createFromSalesDocument(COMPANY, { salesDocumentId: consumerDoc.id }, ACTOR);
    expect(consumerMain.inty).toBe(2);
    expect(consumerMain.subject).toBe('MAIN');
    // corrective on a consumer invoice: inherits inty=2, ins=2
    const consumerTaxid = 'B1B2C3D4E5F6G7H';
    await prisma.salesTaxInvoice.update({ where: { id: consumerMain.id }, data: { taxid: consumerTaxid } });
    const corrective = await service.createFromSalesDocument(COMPANY, {
      salesDocumentId: consumerDoc.id,
      subject: 'RETURN',
      relatedTaxid: consumerTaxid,
    }, ACTOR);
    expect(corrective.inty).toBe(2); // inherited from consumer original
    expect(corrective.subject).toBe('RETURN');
    expect(corrective.relatedTaxid).toBe(consumerTaxid);
  });

  itif('p8-12 over-invoicing blocked; cancelled frees; override above remaining rejected', async () => {
    const { doc, line } = await makeDoc('50');
    const first = await service.createFromSalesDocument(COMPANY, { salesDocumentId: doc.id }, ACTOR);
    expect((await prisma.salesTaxInvoiceLine.findUniqueOrThrow({ where: { id: first.lines[0].id } })).quantity.toString()).toBe('50');
    await expect(
      service.createFromSalesDocument(COMPANY, { salesDocumentId: doc.id }, ACTOR),
    ).rejects.toThrow('TAX_INVOICE_QUANTITY_EXCEEDED');
    // cancellation (never accepted by the authority) frees the loaded quantity
    await prisma.salesTaxInvoice.update({ where: { id: first.id }, data: { status: 'CANCELLED' } });
    const second = await service.createFromSalesDocument(COMPANY, { salesDocumentId: doc.id }, ACTOR);
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
    const invoice = await service.createFromSalesDocument(COMPANY, { salesDocumentId: doc.id }, ACTOR);
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

  itif('p8-14 duplicate uid response (5005) = already accepted, NOT failed', async () => {
    const { doc } = await makeDoc('8');
    const invoice = await service.createFromSalesDocument(COMPANY, { salesDocumentId: doc.id }, ACTOR);
    const seenUids: string[] = [];
    const realEnqueue = fakeAdapter.enqueue.bind(fakeAdapter);
    fakeAdapter.enqueue = async (packets) => {
      const uid = packets[0].uid;
      const res = seenUids.includes(uid)
        ? [{ uid, referenceNumber: '', errorCode: '5005', errorDetail: 'duplicate.request.uid' }]
        : await realEnqueue(packets);
      seenUids.push(uid);
      return res;
    };
    // first send OK; then crash → SENDING; recovery finds FAILED?? — the
    // authority has it pending: inquiry says SUCCESS → invoice promoted
    const first = await service.send(COMPANY, invoice.id, ACTOR);
    expect(first.status).toBe('SUBMITTED');
    await prisma.salesTaxInvoice.update({ where: { id: invoice.id }, data: { status: 'SENDING' } });
    fakeAdapter.inquiryQueue.push('PENDING');
    await expect(service.send(COMPANY, invoice.id, ACTOR)).rejects.toThrow('TAX_INVOICE_SEND_IN_PROGRESS');
    fakeAdapter.inquiryQueue.push('SUCCESS');
    expect((await service.inquiry(COMPANY, invoice.id)).status).toBe('SUCCESS');
    const fresh = await prisma.salesTaxInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(fresh.status).toBe('SUCCESS');
    expect(fresh.moadianError).toBeNull();
  });

  itif('p8-15 stale response: older-attempt SUCCESS never overwrites newer FAILED', async () => {
    const { doc } = await makeDoc('6');
    const invoice = await service.createFromSalesDocument(COMPANY, { salesDocumentId: doc.id }, ACTOR);
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
      service.createFromSalesDocument(COMPANY, { salesDocumentId: doc.id }, ACTOR),
      service.createFromSalesDocument(COMPANY, { salesDocumentId: doc.id }, ACTOR),
    ]);
    const fulfilled = [a, b].filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBe(1);
    const lines = await prisma.salesTaxInvoiceLine.findMany({
      where: { salesLineId: (await prisma.salesLine.findFirstOrThrow({ where: { salesDocumentId: doc.id } })).id },
    });
    expect(lines.reduce((s, l) => s.plus(l.quantity), new Prisma.Decimal(0)).toString()).toBe('10');
  });
});
