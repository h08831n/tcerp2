import {
  describeIntegration,
  disconnectIntegrationPrisma,
  INTEGRATION_COMPANY_ID,
  integrationPrisma,
  testUuid,
} from '../testing/integration';
import { adminUserId, createParty } from '../testing/p5-fixtures';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SequencesService } from '../sequences/sequences.service';
import { JournalService } from '../accounting/journal.service';
import { BankStatementService } from './bank-statement.service';
import { BankTransferService } from './bank-transfer.service';
import { ReceiptService, PaymentService } from './receipt-payment.service';
import { ChecksService } from './checks.service';
import { TimelineService } from '../parties/timeline.service';

/**
 * Treasury ↔ party timeline: every receipt / payment / check lifecycle change
 * that carries a partyId writes a PARTY timeline event atomically (same
 * transaction as the mutation); the same operations WITHOUT a partyId write
 * none. These are the events the always-visible party timeline sidebar renders.
 */
describeIntegration('treasury party-timeline events', () => {
  const prisma = integrationPrisma();
  const marker = `ttl-${Date.now()}`;
  let receipts: ReceiptService;
  let payments: PaymentService;
  let checks: ChecksService;
  let bankAccountId: string;
  let partyId: string;
  let actorId: string;
  const ctx = {};
  const createdReceiptIds: string[] = [];
  const createdPaymentIds: string[] = [];
  const createdCheckIds: string[] = [];

  beforeAll(async () => {
    const audit = new AuditService(prisma as unknown as PrismaService);
    const sequences = new SequencesService(prisma as unknown as PrismaService, audit);
    const journal = new JournalService(prisma as unknown as PrismaService, sequences);
    const statement = new BankStatementService(prisma as unknown as PrismaService);
    const transfers = new BankTransferService(
      prisma as never,
      sequences as never,
      journal as never,
      statement as never,
      audit as never,
    );
    const timeline = new TimelineService(prisma as unknown as PrismaService);
    receipts = new ReceiptService(
      prisma as never,
      sequences as never,
      journal as never,
      statement as never,
      audit as never,
      transfers as never,
      timeline,
    );
    payments = new PaymentService(
      prisma as never,
      sequences as never,
      journal as never,
      statement as never,
      audit as never,
      transfers as never,
      timeline,
    );
    checks = new ChecksService(
      prisma as never,
      sequences as never,
      journal as never,
      statement as never,
      audit as never,
      transfers as never,
      timeline,
    );

    actorId = await adminUserId(prisma);
    const party = await createParty(prisma, ['CUSTOMER'], marker);
    partyId = party.id;
    const account = await prisma.bankAccount.create({
      data: {
        companyId: INTEGRATION_COMPANY_ID,
        name: `ttl-bank-${marker}`,
        bankName: 'Test Bank',
      },
    });
    bankAccountId = account.id;

    // Defensive: the seed provides these, but the spec must not depend on
    // having run after a fresh seed.
    for (const code of ['BANK', 'RECEIVABLE', 'PAYABLE']) {
      await prisma.chartOfAccount.upsert({
        where: { companyId_code: { companyId: INTEGRATION_COMPANY_ID, code } },
        create: {
          companyId: INTEGRATION_COMPANY_ID,
          code,
          name: code,
          type: code === 'PAYABLE' ? 'LIABILITY' : 'ASSET',
        },
        update: {},
      });
    }
    for (const documentType of ['RECEIPT', 'PAYMENT', 'JOURNAL_ENTRY']) {
      await prisma.sequence.upsert({
        where: {
          companyId_documentType: { companyId: INTEGRATION_COMPANY_ID, documentType },
        },
        create: {
          companyId: INTEGRATION_COMPANY_ID,
          documentType,
          name: documentType,
          prefix: documentType.slice(0, 3),
          padding: 5,
        },
        update: {},
      });
    }
  });

  it('a receipt with partyId writes RECEIPT_CREATED on the party timeline', async () => {
    const receipt = await receipts.create(
      INTEGRATION_COMPANY_ID,
      { bankAccountId, partyId, amount: 50_000, description: `ttl ${marker}` },
      { id: actorId, username: 'admin' },
      ctx,
    );
    createdReceiptIds.push(receipt.id);

    const event = await prisma.timelineEvent.findFirstOrThrow({
      where: {
        companyId: INTEGRATION_COMPANY_ID,
        entityType: 'PARTY',
        entityId: partyId,
        type: 'RECEIPT_CREATED',
      },
    });
    expect(event.actorUserId).toBe(actorId);
    const data = event.data as { receiptId: string; receiptNumber: string; amount: number };
    expect(data.receiptId).toBe(receipt.id);
    expect(data.receiptNumber).toBe(receipt.receiptNumber);
    expect(data.amount).toBe(50_000);
  });

  it('a payment with partyId writes PAYMENT_CREATED on the party timeline', async () => {
    const payment = await payments.create(
      INTEGRATION_COMPANY_ID,
      { bankAccountId, partyId, amount: 20_000 },
      { id: actorId, username: 'admin' },
      ctx,
    );
    createdPaymentIds.push(payment.id);

    const event = await prisma.timelineEvent.findFirstOrThrow({
      where: {
        companyId: INTEGRATION_COMPANY_ID,
        entityType: 'PARTY',
        entityId: partyId,
        type: 'PAYMENT_CREATED',
      },
    });
    const data = event.data as { paymentId: string; paymentNumber: string; amount: number };
    expect(data.paymentId).toBe(payment.id);
    expect(data.paymentNumber).toBe(payment.paymentNumber);
    expect(data.amount).toBe(20_000);
  });

  it('check register + transition write CHECK_REGISTERED and CHECK_STATUS_CHANGED', async () => {
    const check = await checks.register(
      INTEGRATION_COMPANY_ID,
      'INCOMING',
      {
        checkNumber: `TTL-${testUuid().slice(0, 8)}`,
        partyId,
        amount: 75_000,
        dueDate: new Date(2027, 0, 15),
        description: `ttl check ${marker}`,
      },
      { id: actorId, username: 'admin' },
      ctx,
    );
    createdCheckIds.push(check.id);

    const registered = await prisma.timelineEvent.findFirstOrThrow({
      where: {
        companyId: INTEGRATION_COMPANY_ID,
        entityType: 'PARTY',
        entityId: partyId,
        type: 'CHECK_REGISTERED',
        data: { path: ['checkId'], equals: check.id },
      },
    });
    expect(registered.title).toContain('دریافتی');

    await checks.transition(INTEGRATION_COMPANY_ID, check.id, 'PENDING', {
      actor: { id: actorId, username: 'admin' },
      ctx,
    });

    const changed = await prisma.timelineEvent.findFirstOrThrow({
      where: {
        companyId: INTEGRATION_COMPANY_ID,
        entityType: 'PARTY',
        entityId: partyId,
        type: 'CHECK_STATUS_CHANGED',
        data: { path: ['checkId'], equals: check.id },
      },
    });
    const data = changed.data as { from: string; to: string };
    expect(data.from).toBe('REGISTERED');
    expect(data.to).toBe('PENDING');
  });

  it('a receipt WITHOUT partyId writes no party timeline event', async () => {
    const before = await prisma.timelineEvent.count({
      where: { companyId: INTEGRATION_COMPANY_ID, entityType: 'PARTY', entityId: partyId },
    });
    await receipts.create(
      INTEGRATION_COMPANY_ID,
      { bankAccountId, amount: 10_000 },
      { id: actorId, username: 'admin' },
      ctx,
    ).then((r) => createdReceiptIds.push(r.id));
    const after = await prisma.timelineEvent.count({
      where: { companyId: INTEGRATION_COMPANY_ID, entityType: 'PARTY', entityId: partyId },
    });
    expect(after).toBe(before);
  });

  afterAll(async () => {
    const receiptsRows = await prisma.receipt.findMany({
      where: { id: { in: createdReceiptIds } },
    });
    const paymentsRows = await prisma.payment.findMany({
      where: { id: { in: createdPaymentIds } },
    });
    const entryIds = [...receiptsRows, ...paymentsRows]
      .map((r) => r.journalEntryId)
      .filter((v): v is string => Boolean(v));
    const sourceIds = [...receiptsRows.map((r) => r.id), ...paymentsRows.map((p) => p.id)];

    await prisma.check.deleteMany({ where: { id: { in: createdCheckIds } } });
    await prisma.bankStatementLine.deleteMany({
      where: { sourceEntityId: { in: sourceIds } },
    });
    await prisma.journalEntry.deleteMany({ where: { id: { in: entryIds } } });
    await prisma.receipt.deleteMany({ where: { id: { in: createdReceiptIds } } });
    await prisma.payment.deleteMany({ where: { id: { in: createdPaymentIds } } });
    await prisma.timelineEvent.deleteMany({
      where: { companyId: INTEGRATION_COMPANY_ID, entityType: 'PARTY', entityId: partyId },
    });
    await prisma.bankAccount.deleteMany({ where: { id: bankAccountId } });
    await prisma.party.deleteMany({ where: { id: partyId } });
    await disconnectIntegrationPrisma();
  });
});
