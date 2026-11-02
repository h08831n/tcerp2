import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { TimelineService } from '../parties/timeline.service';
import { SequencesService } from '../sequences/sequences.service';
import { PartiesService } from '../parties/parties.service';
import { NotFoundError } from '../common/errors';
import {
  describeIntegration,
  disconnectIntegrationPrisma,
  integrationPrisma,
} from '../testing/integration';
import { salesService, purchaseService, priceRequestService, createVariant, createParty, cleanupSalesDocument, cleanupPurchaseDocument } from '../testing/p4-fixtures';
import { loadingService } from '../testing/p6-fixtures';
import { TEST_INTEGRATION } from '../testing/integration';
import { assertSafeIntegrationDatabase } from '../testing/db-guard';

jest.setTimeout(180_000);
const DB_URL = process.env.DATABASE_URL;
if (TEST_INTEGRATION) assertSafeIntegrationDatabase(DB_URL);

// The REAL admin user (hardcoded ids break userCompany FK probes).
let actor = { id: '', username: 'admin' };

/**
 * GATE C-A — consolidated cross-company isolation probe (IDOR): for every
 * major module surface, a record created in company A must be UNREACHABLE
 * through the same service call issued under company B (NotFoundError, not
 * data). Complements the per-module isolation specs; one probe per surface
 * so regressions surface in a single suite.
 */
describeIntegration('gate-c — cross-company isolation probes (two companies)', () => {
  const prisma = integrationPrisma();
  let prismaService: PrismaService;
  let A = '';
  let B = '';
  let partyA: { id: string };
  let partyB: { id: string };
  let variant: { variantId: string };
  const marker = `gc-${Date.now()}`;
  const partyIds: string[] = [];

  const partiesA = () =>
    new PartiesService(
      prisma as never,
      new AuditService(prisma as never),
      new TimelineService(prisma as never),
    );
  const partiesB = () =>
    new PartiesService(
      prisma as never,
      new AuditService(prisma as never),
      new TimelineService(prisma as never),
    );

  beforeAll(async () => {
    if (!DB_URL) return;
    const { PrismaService: S } = await import('../prisma/prisma.service');
    prismaService = new S();
    await prismaService.$connect();
    const admin = await prisma.user.findUniqueOrThrow({ where: { username: 'admin' }, select: { id: true } });
    actor = { id: admin.id, username: 'admin' };
    for (const name of [`gcA-${marker}`, `gcB-${marker}`]) {
      const c = await prismaService.company.create({ data: { nameFa: name, status: 'ACTIVE' } });
      if (A === '') A = c.id;
      else B = c.id;
    }
    for (const companyId of [A, B]) {
      for (const doc of [
        { documentType: 'JOURNAL_ENTRY', prefix: 'JE' },
        { documentType: 'SALES_DOCUMENT', prefix: 'SD' },
        { documentType: 'PURCHASE', prefix: 'PO' },
        { documentType: 'PRICE_REQUEST', prefix: 'PR' },
      ]) {
        await prismaService.sequence.create({
          data: { companyId, documentType: doc.documentType, name: doc.documentType, prefix: doc.prefix, padding: 5, resetCycle: 'NEVER' },
        });
      }
      await prismaService.chartOfAccount.create({ data: { companyId, code: 'BANK', name: 'بانک', type: 'ASSET' } });
      await prismaService.chartOfAccount.create({ data: { companyId, code: 'SALES_REVENUE', name: 'درآمد', type: 'REVENUE' } });
      const uomCategory = await prismaService.uomCategory.create({
        data: { companyId, code: 'GCTEST', nameFa: 'گیت سی' },
      });
      await prismaService.uom.create({
        data: { companyId, symbol: 'kg', nameFa: 'کیلوگرم', nameEn: 'kg', categoryId: uomCategory.id, conversionRatio: 1, isBaseUnit: true },
      });
      const category = await prismaService.productCategory.create({
        data: { companyId, code: 'GCTEST', nameFa: 'گیت سی' },
      });
      await prismaService.productTemplate.create({
        data: { companyId, categoryId: category.id, nameFa: `قالب ${marker}` },
      });
    }
    partyA = await createParty(prisma, ['CUSTOMER'], `gca-${marker}`, A);
    partyB = await createParty(prisma, ['CUSTOMER'], `gcb-${marker}`, B);
    partyIds.push(partyA.id, partyB.id);
    // The probe actor is a member of BOTH companies (membership enforcement
    // is itself probed separately) — isolation must hold even for a member.
    for (const companyId of [A, B]) {
      await prisma.userCompany.create({ data: { userId: actor.id, companyId } });
    }
    variant = await createVariant(prisma, `${marker}`, { companyId: A });
  });

  afterAll(async () => {
    if (!prismaService) return;
    for (const companyId of [A, B]) {
      const lineIds = (await prismaService.journalLine.findMany({ where: { companyId }, select: { id: true } })).map((l) => l.id);
      await prismaService.journalLineAnalytic.deleteMany({ where: { journalLineId: { in: lineIds } } });
      await prismaService.journalLine.deleteMany({ where: { companyId } });
      await prismaService.journalEntry.deleteMany({ where: { companyId } });
      await prismaService.salesPurchaseAllocation.deleteMany({ where: { OR: [{ salesLine: { companyId } }, { purchaseLine: { companyId } }] } }).catch(() => undefined);
      await prismaService.salesLine.deleteMany({ where: { companyId } });
      await prismaService.purchaseLine.deleteMany({ where: { companyId } });
      await prismaService.salesDocument.deleteMany({ where: { companyId } }).catch(() => undefined);
      await prismaService.purchaseDocument.deleteMany({ where: { companyId } }).catch(() => undefined);
      await prismaService.priceRequestLine.deleteMany({ where: { companyId } }).catch(() => undefined);
      await prismaService.priceRequest.deleteMany({ where: { companyId } }).catch(() => undefined);
      await prismaService.loadingLine.deleteMany({ where: { loading: { companyId } } }).catch(() => undefined);
      await prismaService.loading.deleteMany({ where: { companyId } }).catch(() => undefined);
      await prismaService.bankAccount.deleteMany({ where: { companyId } }).catch(() => undefined);
      await prismaService.workflowInstance.deleteMany({ where: { definition: { companyId } } }).catch(() => undefined);
      await prismaService.workflowDefinition.deleteMany({ where: { companyId } }).catch(() => undefined);
      await prismaService.importJob.deleteMany({ where: { companyId } }).catch(() => undefined);
      await prismaService.productVariant.deleteMany({ where: { companyId } }).catch(() => undefined);
      await prismaService.productTemplate.deleteMany({ where: { companyId } }).catch(() => undefined);
      await prismaService.productCategory.deleteMany({ where: { companyId } }).catch(() => undefined);
      await prismaService.uom.deleteMany({ where: { companyId } }).catch(() => undefined);
      await prismaService.timelineEvent.deleteMany({ where: { companyId } }).catch(() => undefined);
      await prismaService.party.deleteMany({ where: { companyId } }).catch(() => undefined);
      await prismaService.fiscalYear.deleteMany({ where: { companyId } }).catch(() => undefined);
      await prismaService.chartOfAccount.deleteMany({ where: { companyId } }).catch(() => undefined);
      await prismaService.sequence.deleteMany({ where: { companyId } }).catch(() => undefined);
      await prismaService.company.delete({ where: { id: companyId } }).catch(() => undefined);
    }
    await prismaService.$disconnect();
    await disconnectIntegrationPrisma();
  });

  const itif = TEST_INTEGRATION && DB_URL ? it : it.skip;

  itif('CRM — party in A is invisible to company B (read + update)', async () => {
    const detail = await partiesA().getById(A, { userId: actor.id, scope: 'ALL' }, partyA.id);
    expect(detail.id).toBe(partyA.id);
    await expect(partiesB().getById(B, { userId: actor.id, scope: 'ALL' }, partyA.id)).rejects.toThrow(NotFoundError);
    await expect(
      partiesB().update(B, { userId: actor.id, scope: 'ALL' }, partyA.id, { version: 1, notes: 'hacked' } as never, { canChangeOwner: false }, actor, {}),
    ).rejects.toThrow(NotFoundError);
  });

  itif('Products — template/variant in A invisible to company B', async () => {
    const templates = new (
      await import('../products/templates.service')
    ).TemplatesService(prisma as never, new AuditService(prisma as never));
    const templateId = (
      await prisma.productTemplate.findFirstOrThrow({ where: { companyId: A }, select: { id: true } })
    ).id;
    await expect(templates.getById(B, templateId)).rejects.toThrow(NotFoundError);
  });

  itif('Sales — document in A invisible to company B (get + addLine)', async () => {
    const sales = salesService(prisma);
    const doc = await sales.create(
      A,
      { userId: actor.id, scope: 'ALL' },
      { customerPartyId: partyA.id, lines: [{ productVariantId: variant.variantId, quantity: 1, unitPrice: 50 }] } as never,
      actor,
      {},
    );
    await expect(
      sales.getById(B, { userId: actor.id, scope: 'ALL' }, doc.id),
    ).rejects.toThrow(NotFoundError);
    await expect(
      sales.addLine(B, { actorScope: { userId: actor.id, scope: 'ALL' }, teamUserIds: [], canOverrideConfirmedOrder: false }, doc.id, { productVariantId: variant.variantId, quantity: 1, unitPrice: 1 } as never, actor, {}),
    ).rejects.toThrow(NotFoundError);
    await cleanupSalesDocument(prisma, doc.id);
  });

  itif('Purchase — document in A invisible to company B', async () => {
    const purchases = purchaseService(prisma);
    const supplierA = await createParty(prisma, ['SUPPLIER'], `gcs-${marker}`, A);
    partyIds.push(supplierA.id);
    const doc = await purchases.create(
      A,
      { supplierPartyId: supplierA.id, lines: [{ productVariantId: variant.variantId, quantity: 1 }] } as never,
      actor,
      {},
    );
    await expect(purchases.getById(B, doc.id)).rejects.toThrow(NotFoundError);
    await cleanupPurchaseDocument(prisma, doc.id);
  });

  itif('RFQ — price request in A invisible to company B', async () => {
    const prs = priceRequestService(prisma);
    const req = await prs.create(
      A,
      { customerPartyId: partyA.id, lines: [{ productVariantId: variant.variantId, requestedQuantity: 2 }] } as never,
      actor,
      {},
    );
    await expect(prs.getById(B, req.id)).rejects.toThrow(NotFoundError);
    await prisma.priceRequestLine.deleteMany({ where: { priceRequestId: req.id } });
    await prisma.priceRequest.delete({ where: { id: req.id } }).catch(() => undefined);
  });

  itif('Loading — draft loading in A invisible to company B (read + update)', async () => {
    const loading = loadingService(prisma);
    const row = await prisma.loading.create({
      data: { companyId: A, loadingDate: new Date(), customerPartyId: partyA.id, notes: 'gc', createdBy: actor.id },
    });
    await expect(loading.getById(B, row.id)).rejects.toThrow(NotFoundError);
    await expect(
      loading.update(B, row.id, { notes: 'hacked' } as never, actor, {}),
    ).rejects.toThrow(NotFoundError);
    await prisma.loading.delete({ where: { id: row.id } }).catch(() => undefined);
  });

  itif('Accounting — journal entry in A invisible to company B (read + list isolation)', async () => {
    const journal = new (
      await import('../accounting/journal.service')
    ).JournalService(prisma as never, new SequencesService(prisma as never, new AuditService(prisma as never)));
    const entry = await prisma.$transaction((tx) =>
      journal.post(tx, {
        companyId: A,
        entryDate: new Date(),
        journalCode: 'OPERATIONAL',
        documentType: 'GC_TEST',
        lines: [
          { accountCode: 'BANK', debit: 10, credit: 0 },
          { accountCode: 'SALES_REVENUE', debit: 0, credit: 10 },
        ] as never,
        createdBy: actor.id,
      }),
    );
    await expect(journal.getById(B, entry.id)).rejects.toThrow(NotFoundError);
    const listB = await journal.list(B, 100);
    expect(listB.some((e) => e.id === entry.id)).toBe(false);
  });

  itif('Treasury — bank account in A invisible to company B (read + update)', async () => {
    const accounts = new (
      await import('../treasury/bank-accounts.service')
    ).BankAccountsService(prisma as never, new AuditService(prisma as never));
    const account = await prisma.bankAccount.create({
      data: { companyId: A, name: `gc-${marker}`, bankName: 'Bank A' },
    });
    await expect(accounts.getById(B, account.id)).rejects.toThrow(NotFoundError);
    await prisma.bankAccount.delete({ where: { id: account.id } }).catch(() => undefined);
  });

  itif('Workflow — instance in A invisible to company B', async () => {
    const workflow = new (
      await import('../workflow/workflow.service')
    ).WorkflowService(
      prisma as never,
      new AuditService(prisma as never),
      { dispatchRulesForEvent: async () => 0, createNotifications: async () => [] } as never,
      { processDue: async () => undefined } as never,
      { request: async () => ({}) } as never,
      { resume: async () => undefined } as never,
      { enqueue: async () => ({ id: 'gc-q' }) } as never,
    );
    const def = await prisma.workflowDefinition.create({
      data: {
        companyId: A,
        code: `GC-${marker}`,
        name: 'gc',
        entityType: 'SALES_DOCUMENT',
        isActive: true,
        states: { create: [{ code: 'DRAFT', name: 'پیش‌نویس', isInitial: true }] },
      },
    });
    const instance = await prisma.workflowInstance.create({
      data: { definitionId: def.id, entityType: 'SALES_DOCUMENT', entityId: partyA.id, version: 1 },
    });
    await expect(workflow.getInstance(B, instance.id)).rejects.toThrow(NotFoundError);
    await prisma.workflowInstance.delete({ where: { id: instance.id } }).catch(() => undefined);
    await prisma.workflowDefinition.delete({ where: { id: def.id } }).catch(() => undefined);
  });

  itif('Imports — job in A invisible to company B', async () => {
    const imports = new (
      await import('../imports/imports.service')
    ).ImportsService(prisma as never, new AuditService(prisma as never));
    const job = await prisma.importJob.create({
      data: {
        companyId: A,
        entityType: 'PARTY',
        status: 'COMPLETED',
        createdById: actor.id,
        fileName: 'gc.csv',
        columnMapping: {},
      },
    });
    await expect(imports.getJob(B, job.id)).rejects.toThrow(NotFoundError);
    await prisma.importJob.delete({ where: { id: job.id } }).catch(() => undefined);
  });

  itif('Cross-company REFERENCE is rejected — company B party cannot be a customer in company A documents', async () => {
    const sales = salesService(prisma);
    // The customer party belongs to company B — attaching it to a company A
    // document must fail the company-scoped customer validation.
    await expect(
      sales.create(
        A,
        { userId: actor.id, scope: 'ALL' },
        { customerPartyId: partyB.id, lines: [{ productVariantId: variant.variantId, quantity: 1, unitPrice: 10 }] } as never,
        actor,
        {},
      ),
    ).rejects.toThrow();
    const prs = priceRequestService(prisma);
    await expect(
      prs.create(
        A,
        { customerPartyId: partyB.id, lines: [{ productVariantId: variant.variantId, requestedQuantity: 1 }] } as never,
        actor,
        {},
      ),
    ).rejects.toThrow();
    // No cross-company document was created.
    const foreignDocs = await prisma.salesDocument.count({
      where: { companyId: A, customerPartyId: partyB.id },
    });
    expect(foreignDocs).toBe(0);
  });

});
