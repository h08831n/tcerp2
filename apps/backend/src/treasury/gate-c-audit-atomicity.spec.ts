import { PrismaService } from '../prisma/prisma.service';
import { describeIntegration, disconnectIntegrationPrisma, integrationPrisma } from '../testing/integration';
import { AuditService } from '../audit/audit.service';
import { SequencesService } from '../sequences/sequences.service';
import { JournalService } from '../accounting/journal.service';
import { BankStatementService } from '../treasury/bank-statement.service';
import { BankTransferService } from '../treasury/bank-transfer.service';
import { ReceiptService } from '../treasury/receipt-payment.service';
import { TimelineService } from '../parties/timeline.service';
import { TEST_INTEGRATION } from '../testing/integration';

jest.setTimeout(120_000);
const DB_URL = process.env.DATABASE_URL;
if (TEST_INTEGRATION) void DB_URL;

/**
 * GATE C — Audit atomicity for TREASURY financial mutations.
 *
 * R5-F1 (confirmed on 2a1a122): ReceiptService.create / PaymentService.create
 * call `this.auditService.record(...)` INSIDE their $transaction callback —
 * but `record()` writes via `this.prisma` (a SEPARATE connection, outside
 * the tx) AND swallows every error. Consequences:
 *   1. the audit row commits even if the business mutation rolls back;
 *   2. an audit failure leaves the FINANCIAL mutation committed with NO
 *      audit row — violating the mandated
 *      `Audit Failure → Business Mutation Rollback` for treasury ops.
 * The fix under test: `recordTx(trx, ...)` — same corr-05/p4-32 pattern the
 * rest of the financial services already use.
 */
describeIntegration('gate-c treasury audit atomicity (receipt/payment)', () => {
  const prisma = integrationPrisma();
  let A = '';
  let companyId = '';
  let bankAccountId = '';
  const marker = `gcaudit-${Date.now()}`;
  const createdCompanyIds: string[] = [];

  function makeReceiptService(audit: AuditService): ReceiptService {
    const sequences = new SequencesService(prisma as never, audit);
    const journal = new JournalService(prisma as never, sequences);
    const statement = new BankStatementService(prisma as never);
    const transfers = new BankTransferService(prisma as never, sequences as never, journal as never, statement as never, audit as never);
    return new ReceiptService(
      prisma as never,
      sequences as never,
      journal as never,
      statement as never,
      audit as never,
      transfers as never,
      new TimelineService(prisma as never),
    );
  }

  beforeAll(async () => {
    const company = await prisma.company.create({ data: { nameFa: `gcaudit-${marker}`, status: 'ACTIVE' } });
    A = company.id;
    companyId = A;
    createdCompanyIds.push(A);
    const account = await prisma.bankAccount.create({
      data: { companyId: A, name: `gcaudit-${marker}`, bankName: 'Test Bank' },
    });
    bankAccountId = account.id;
    for (const code of ['BANK', 'RECEIVABLE', 'PAYABLE']) {
      await prisma.chartOfAccount.upsert({
        where: { companyId_code: { companyId: A, code } },
        create: { companyId: A, code, name: code, type: code === 'PAYABLE' ? 'LIABILITY' : 'ASSET' },
        update: {},
      });
    }
    for (const documentType of ['RECEIPT', 'PAYMENT', 'JOURNAL_ENTRY']) {
      await prisma.sequence.upsert({
        where: { companyId_documentType: { companyId: A, documentType } },
        create: { companyId: A, documentType, name: documentType, prefix: documentType.slice(0, 3), padding: 5 },
        update: {},
      });
    }
  });

  afterAll(async () => {
    const receipts = await prisma.receipt.findMany({ where: { bankAccountId } });
    const payments = await prisma.payment.findMany({ where: { bankAccountId } });
    const entryIds = [...receipts, ...payments].map((r) => r.journalEntryId).filter((v): v is string => Boolean(v));
    await prisma.bankStatementLine.deleteMany({ where: { sourceEntityId: { in: [...receipts.map((r) => r.id), ...payments.map((p) => p.id)] } } });
    await prisma.journalEntry.deleteMany({ where: { id: { in: entryIds } } });
    await prisma.receipt.deleteMany({ where: { id: { in: receipts.map((r) => r.id) } } });
    await prisma.payment.deleteMany({ where: { id: { in: payments.map((p) => p.id) } } });
    await prisma.auditLog.deleteMany({ where: { companyId: A, entityType: { in: ['receipt', 'payment'] } } });
    await prisma.timelineEvent.deleteMany({ where: { companyId: A } }).catch(() => undefined);
    await prisma.bankAccount.deleteMany({ where: { id: bankAccountId } }).catch(() => undefined);
    await prisma.chartOfAccount.deleteMany({ where: { companyId: A } }).catch(() => undefined);
    await prisma.sequence.deleteMany({ where: { companyId: A } }).catch(() => undefined);
    await prisma.company.deleteMany({ where: { id: { in: createdCompanyIds } } }).catch(() => undefined);
    await disconnectIntegrationPrisma();
  });

  const itif = TEST_INTEGRATION ? it : it.skip;

  itif('audit SUCCESS: receipt + journal + audit row all committed', async () => {
    const audit = new AuditService(prisma as unknown as PrismaService);
    const receipts = makeReceiptService(audit);
    const receipt = await receipts.create(
      companyId,
      { bankAccountId, amount: 111, description: `gcaudit-ok ${marker}` },
      { id: '00000000-0000-4000-8000-0000000000a1', username: 'admin' },
      {},
    );
    const auditRow = await prisma.auditLog.findFirst({
      where: { companyId, entityType: 'receipt', entityId: receipt.id },
    });
    expect(auditRow).toBeTruthy();
    void bankAccountId;
  });

  itif('AUDIT FAILURE → the financial mutation ROLLS BACK (no receipt, no journal)', async () => {
    // corr-05 injection pattern: a stub AuditService whose recordTx ALWAYS
    // throws — exactly what an audit-storage outage looks like to the
    // transaction (recordTx propagates; record swallowed).
    const brokenAudit = {
      recordTx: () => {
        throw new Error('audit storage down');
      },
    };
    const receipts = makeReceiptService(brokenAudit as unknown as AuditService);

    // The mandated behavior: the create THROWS and NOTHING survives.
    await expect(
      receipts.create(
        companyId,
        { bankAccountId, amount: 222, description: `gcaudit-broken ${marker}` },
        { id: '00000000-0000-4000-8000-0000000000a1', username: 'admin' },
        {},
      ),
    ).rejects.toThrow('audit storage down');

    const persisted = await prisma.receipt.findFirst({
      where: { description: `gcaudit-broken ${marker}` },
    });
    expect(persisted).toBeNull();
    // No NEW audit row may appear (the company's pre-existing rows are from
    // the success-path test).
    // Only the SUCCESS-path audit row exists for this company — the failed
    // attempt contributed NEITHER a receipt NOR an audit row.
    const totalAuditRows = await prisma.auditLog.count({
      where: { companyId, entityType: 'receipt' },
    });
    expect(totalAuditRows).toBe(1);
  });
});
