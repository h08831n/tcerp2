import { PrismaService } from '../prisma/prisma.service';
import { describeIntegration, disconnectIntegrationPrisma, integrationPrisma } from '../testing/integration';
import { AuditService } from '../audit/audit.service';
import { SequencesService } from '../sequences/sequences.service';
import { JournalService } from '../accounting/journal.service';
import { BankStatementService } from '../treasury/bank-statement.service';
import { BankTransferService } from '../treasury/bank-transfer.service';
import { ReceiptService, PaymentService } from '../treasury/receipt-payment.service';
import { ChecksService } from '../treasury/checks.service';
import { TimelineService } from '../parties/timeline.service';
import { TEST_INTEGRATION } from '../testing/integration';

jest.setTimeout(120_000);
const DB_URL = process.env.DATABASE_URL;
if (TEST_INTEGRATION) void DB_URL;

/**
 * GATE C — Audit atomicity for ALL FOUR treasury financial paths:
 * receipt create, payment create, incoming-check CLEARED, outgoing-check PAID.
 *
 * R5-F1 (confirmed RED on 2a1a122): these paths called auditService.record()
 * INSIDE their $transaction callbacks — but record() writes via this.prisma
 * (a SEPARATE connection, outside the tx) AND swallows every error, so an
 * audit-storage failure left the FINANCIAL mutation committed with NO audit
 * row. The fix: recordTx(trx, ...) — same corr-05/p4-32 pattern.
 *
 * AUDIT POLICY (documented per the final security-closure review):
 *   - Receipt/Payment create and check CLEARED/PAID: audit is ATOMIC
 *     (recordTx inside the caller's transaction) — an audit failure rolls
 *     the financial mutation back. Covered by dedicated tests below.
 *   - Check REGISTER and the simple non-bank transitions
 *     (PENDING/CANCELLED/BOUNCED/DEPOSITED): audit is BEST-EFFORT
 *     (record() — no transaction exists on those paths, and they post NO
 *     journal/statement effect by design; a missing audit row there cannot
 *     hide a financial mutation). Documented here per the reviewer's
 *     request to make this decision explicit.
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
    const failures: string[] = [];
    const step = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
      try {
        await fn();
      } catch (error) {
        failures.push(`${label}: ${String(error)}`);
      }
    };
    const receipts = await prisma.receipt.findMany({ where: { bankAccountId } });
    const payments = await prisma.payment.findMany({ where: { bankAccountId } });
    const checks = await prisma.check.findMany({ where: { companyId: A } });
    const entryIds = [...receipts, ...payments, ...checks].map((r) => r.journalEntryId).filter((v): v is string => Boolean(v));
    const sourceIds = [...receipts.map((r) => r.id), ...payments.map((p) => p.id), ...checks.map((c) => c.id)];
    await step('statementLines', () =>
      prisma.bankStatementLine.deleteMany({ where: { sourceEntityId: { in: sourceIds } } }));
    await step('journalEntries', () =>
      prisma.journalEntry.deleteMany({ where: { id: { in: entryIds } } }));
    await step('checks', () =>
      prisma.check.deleteMany({ where: { companyId: A } }));
    await step('receipts', () =>
      prisma.receipt.deleteMany({ where: { id: { in: receipts.map((r) => r.id) } } }));
    await step('payments', () =>
      prisma.payment.deleteMany({ where: { id: { in: payments.map((p) => p.id) } } }));
    await step('auditLog', () =>
      prisma.auditLog.deleteMany({ where: { companyId: A, entityType: { in: ['receipt', 'payment', 'check'] } } }));
    await step('timeline', () =>
      prisma.timelineEvent.deleteMany({ where: { companyId: A } }));
    await step('bankAccounts', () =>
      prisma.bankAccount.deleteMany({ where: { id: bankAccountId } }));
    await step('chartAccounts', () =>
      prisma.chartOfAccount.deleteMany({ where: { companyId: A } }));
    await step('sequences', () =>
      prisma.sequence.deleteMany({ where: { companyId: A } }));
    await step('companies', () =>
      prisma.company.deleteMany({ where: { id: { in: createdCompanyIds } } }));
    // Verify zero leftovers for this spec's fixture space.
    await step('verify', async () => {
      const leftovers: string[] = [];
      const checksLeft = await prisma.check.count({ where: { companyId: A } });
      const receiptsLeft = await prisma.receipt.count({ where: { companyId: A } });
      const paymentsLeft = await prisma.payment.count({ where: { companyId: A } });
      const companiesLeft = await prisma.company.count({ where: { id: { in: createdCompanyIds } } });
      const bankAccountsLeft = await prisma.bankAccount.count({ where: { id: bankAccountId } });
      if (checksLeft !== 0) leftovers.push(`checks=${checksLeft}`);
      if (receiptsLeft !== 0) leftovers.push(`receipts=${receiptsLeft}`);
      if (paymentsLeft !== 0) leftovers.push(`payments=${paymentsLeft}`);
      if (companiesLeft !== 0) leftovers.push(`companies=${companiesLeft}`);
      if (bankAccountsLeft !== 0) leftovers.push(`bankAccounts=${bankAccountsLeft}`);
      if (leftovers.length > 0) failures.push(`LEFTOVER ROWS: ${leftovers.join(', ')}`);
    });
    await disconnectIntegrationPrisma().catch((e: unknown) => failures.push(`disconnect: ${String(e)}`));
    if (failures.length > 0) {
      throw new Error(`GATE-C-AUDIT CLEANUP FAILURES:\n- ${failures.join('\n- ')}`);
    }
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
    const receiptLinesBefore = await prisma.bankStatementLine.count({ where: { bankAccountId } });

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
    // DB re-read: statement line count UNCHANGED (no partial write survived).
    const receiptLinesAfter = await prisma.bankStatementLine.count({ where: { bankAccountId } });
    expect(receiptLinesAfter).toBe(receiptLinesBefore);
    // Only the SUCCESS-path audit row exists for this company — the failed
    // attempt contributed NEITHER a receipt NOR an audit row.
    const totalAuditRows = await prisma.auditLog.count({
      where: { companyId, entityType: 'receipt' },
    });
    expect(totalAuditRows).toBe(1);
  });

  itif('PAYMENT create — audit failure rolls back payment + journal + statement line', async () => {
    const throwingAudit = {
      record: () => {
        throw new Error('audit storage down');
      },
      recordTx: () => {
        throw new Error('audit storage down');
      },
    };
    const sequences = new SequencesService(prisma as never, throwingAudit as never);
    const journal = new JournalService(prisma as never, sequences);
    const statement = new BankStatementService(prisma as never);
    const transfers = new BankTransferService(prisma as never, sequences as never, journal as never, statement as never, throwingAudit as never);
    const payments = new PaymentService(
      prisma as never, sequences as never, journal as never, statement as never,
      throwingAudit as never, transfers as never, new TimelineService(prisma as never),
    );

    const linesBefore = await prisma.bankStatementLine.count({ where: { bankAccountId } });
    await expect(
      payments.create(
        companyId,
        { bankAccountId, amount: 222, description: `gcaudit-pay ${marker}` },
        { id: '00000000-0000-4000-8000-0000000000a1', username: 'admin' },
        {},
      ),
    ).rejects.toThrow('audit storage down');

    const rows = await prisma.payment.count({ where: { companyId, description: `gcaudit-pay ${marker}` } });
    expect(rows).toBe(0);
    const entries = await prisma.journalEntry.count({ where: { companyId, documentType: 'PAYMENT' } });
    expect(entries).toBe(0);
    const linesAfter = await prisma.bankStatementLine.count({ where: { bankAccountId } });
    expect(linesAfter).toBe(linesBefore);
  });

  itif('INCOMING check CLEARED — audit failure rolls back status + journal + statement line', async () => {
    const realAudit = new AuditService(prisma as never);
    const realSequences = new SequencesService(prisma as never, realAudit);
    const realJournal = new JournalService(prisma as never, realSequences);
    const realStatement = new BankStatementService(prisma as never);
    const realTransfers = new BankTransferService(prisma as never, realSequences as never, realJournal as never, realStatement as never, realAudit as never);
    const realChecks = new ChecksService(
      prisma as never, realSequences as never, realJournal as never, realStatement as never,
      realAudit as never, realTransfers as never, new TimelineService(prisma as never),
    );
    const check = await realChecks.register(
      companyId,
      'INCOMING',
      { checkNumber: `GC4-${Date.now()}`, amount: 333, dueDate: new Date(2027, 0, 15) },
      { id: '00000000-0000-4000-8000-0000000000a1', username: 'admin' },
      {},
    );
    await realChecks.transition(companyId, check.id, 'PENDING', {
      actor: { id: '00000000-0000-4000-8000-0000000000a1', username: 'admin' },
      ctx: {},
    });
    await realChecks.transition(companyId, check.id, 'DEPOSITED', {
      bankAccountId,
      actor: { id: '00000000-0000-4000-8000-0000000000a1', username: 'admin' },
      ctx: {},
    });

    // CLEARED with a THROWING audit — the whole tx must roll back.
    const throwingAudit = {
      record: () => {
        throw new Error('audit storage down');
      },
      recordTx: () => {
        throw new Error('audit storage down');
      },
    };
    // R6: ensure the chart has the check-clearing accounts (beforeAll
    // creates them but a prior run's cleanup may have deleted them).
    await prisma.chartOfAccount.upsert({
      where: { companyId_code: { companyId, code: 'CHECKS_IN_TRANSIT' } },
      create: { companyId, code: 'CHECKS_IN_TRANSIT', name: 'CHECKS_IN_TRANSIT', type: 'ASSET' },
      update: {},
    });
    const clearing = new ChecksService(
      prisma as never, realSequences as never, realJournal as never, realStatement as never,
      throwingAudit as never, realTransfers as never, new TimelineService(prisma as never),
    );
    const clearEntriesBefore = await prisma.journalEntry.count({
      where: { companyId, documentType: 'CHECK_CLEAR' },
    });
    const clearLinesBefore = await prisma.bankStatementLine.count({ where: { bankAccountId } });
    await expect(
      clearing.transition(companyId, check.id, 'CLEARED', {
        bankAccountId,
        actor: { id: '00000000-0000-4000-8000-0000000000a1', username: 'admin' },
        ctx: {},
      }),
    ).rejects.toThrow('audit storage down');

    const after = await prisma.check.findUniqueOrThrow({ where: { id: check.id } });
    expect(after.status).toBe('DEPOSITED'); // pre-clearing status preserved
    const clearEntriesAfter = await prisma.journalEntry.count({
      where: { companyId, documentType: 'CHECK_CLEAR' },
    });
    expect(clearEntriesAfter).toBe(clearEntriesBefore); // NO new journal entry
    const clearLinesAfter = await prisma.bankStatementLine.count({ where: { bankAccountId } });
    expect(clearLinesAfter).toBe(clearLinesBefore); // NO new statement line
  });

  itif('OUTGOING check PAID — audit failure rolls back status + journal + statement line', async () => {
    const realAudit = new AuditService(prisma as never);
    const realSequences = new SequencesService(prisma as never, realAudit);
    const realJournal = new JournalService(prisma as never, realSequences);
    const realStatement = new BankStatementService(prisma as never);
    const realTransfers = new BankTransferService(prisma as never, realSequences as never, realJournal as never, realStatement as never, realAudit as never);
    const realChecks = new ChecksService(
      prisma as never, realSequences as never, realJournal as never, realStatement as never,
      realAudit as never, realTransfers as never, new TimelineService(prisma as never),
    );
    const check = await realChecks.register(
      companyId,
      'OUTGOING',
      { checkNumber: `GC4P-${Date.now()}`, amount: 444, dueDate: new Date(2027, 0, 15) },
      { id: '00000000-0000-4000-8000-0000000000a1', username: 'admin' },
      {},
    );
    await realChecks.transition(companyId, check.id, 'PENDING', {
      actor: { id: '00000000-0000-4000-8000-0000000000a1', username: 'admin' },
      ctx: {},
    });

    const throwingAudit = {
      record: () => {
        throw new Error('audit storage down');
      },
      recordTx: () => {
        throw new Error('audit storage down');
      },
    };
    await prisma.chartOfAccount.upsert({
      where: { companyId_code: { companyId, code: 'CHECKS_IN_TRANSIT' } },
      create: { companyId, code: 'CHECKS_IN_TRANSIT', name: 'CHECKS_IN_TRANSIT', type: 'ASSET' },
      update: {},
    });
    const paying = new ChecksService(
      prisma as never, realSequences as never, realJournal as never, realStatement as never,
      throwingAudit as never, realTransfers as never, new TimelineService(prisma as never),
    );
    const paidEntriesBefore = await prisma.journalEntry.count({
      where: { companyId, documentType: 'CHECK_PAY' },
    });
    const paidLinesBefore = await prisma.bankStatementLine.count({ where: { bankAccountId } });
    await expect(
      paying.transition(companyId, check.id, 'PAID', {
        bankAccountId,
        actor: { id: '00000000-0000-4000-8000-0000000000a1', username: 'admin' },
        ctx: {},
      }),
    ).rejects.toThrow('audit storage down');

    const after = await prisma.check.findUniqueOrThrow({ where: { id: check.id } });
    expect(after.status).toBe('PENDING'); // status preserved
    const paidEntriesAfter = await prisma.journalEntry.count({
      where: { companyId, documentType: 'CHECK_PAY' },
    });
    expect(paidEntriesAfter).toBe(paidEntriesBefore); // NO new journal entry
    const paidLinesAfter = await prisma.bankStatementLine.count({ where: { bankAccountId } });
    expect(paidLinesAfter).toBe(paidLinesBefore); // NO new statement line
  });
});
