import { Injectable } from '@nestjs/common';
import { Prisma, JournalEntry } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SequencesService } from '../sequences/sequences.service';
import { ForbiddenError, NotFoundError, ValidationError } from '../common/errors';

export interface JournalLineInput {
  accountCode: string;
  partyId?: string | null;
  debit: number;
  credit: number;
  description?: string;
}

export interface PostJournalInput {
  companyId: string;
  entryDate: Date;
  journalCode?: string;
  documentType?: string;
  description?: string;
  createdBy?: string;
  lines: JournalLineInput[];
}

type Tx = Prisma.TransactionClient;

/**
 * Double-entry journal service. Invariants (mirrored by DB CHECKs):
 *   - a line carries exactly one of debit/credit (positive, XOR);
 *   - SUM(debit) == SUM(credit) inside the POST transaction;
 *   - a POSTED entry is never edited/deleted — corrected via `reverse()`
 *     which creates a mirrored entry and marks the original REVERSED.
 */
@Injectable()
export class JournalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sequences: SequencesService,
  ) {}

  /** Validates line semantics; returns normalized lines. */
  static validateLines(lines: JournalLineInput[]): void {
    if (!Array.isArray(lines) || lines.length === 0) {
      throw new ValidationError('Journal entry requires at least one line', { lines });
    }
    for (const [index, line] of lines.entries()) {
      const debit = Number(line.debit ?? 0);
      const credit = Number(line.credit ?? 0);
      if (debit < 0 || credit < 0) {
        throw new ValidationError('Journal line amounts must be non-negative', { index });
      }
      if (debit > 0 && credit > 0) {
        throw new ValidationError('A journal line cannot carry both debit and credit', { index });
      }
      if (debit === 0 && credit === 0) {
        throw new ValidationError('A journal line must carry a debit or a credit', { index });
      }
    }
    const totalDebit = lines.reduce((sum, l) => sum + Number(l.debit ?? 0), 0);
    const totalCredit = lines.reduce((sum, l) => sum + Number(l.credit ?? 0), 0);
    // Compare rounded to 4 decimals to dodge float noise.
    if (Math.round(totalDebit * 10000) !== Math.round(totalCredit * 10000)) {
      throw new ValidationError('JOURNAL_UNBALANCED', {
        totalDebit,
        totalCredit,
      });
    }
  }

  /**
   * Post a balanced journal entry inside `tx` (caller owns the transaction).
   * Entry is created DRAFT with lines, then atomically set POSTED — a crash
   * leaves a DRAFT, never a half-posted entry.
   */
  async post(tx: Tx, input: PostJournalInput): Promise<JournalEntry & { lines: unknown[] }> {
    JournalService.validateLines(input.lines);

    const codes = [...new Set(input.lines.map((l) => l.accountCode))];
    const accounts = await tx.chartOfAccount.findMany({
      where: { companyId: input.companyId, code: { in: codes } },
      select: { id: true, code: true },
    });
    const byCode = new Map(accounts.map((a) => [a.code, a.id]));
    const missing = codes.filter((c) => !byCode.has(c));
    if (missing.length > 0) {
      throw new ValidationError('Unknown account code(s)', { missing });
    }

    const { number: entryNumber } = await this.sequences.allocate(
      input.companyId,
      'JOURNAL_ENTRY',
      tx,
      input.entryDate,
    );

    const entry = await tx.journalEntry.create({
      data: {
        companyId: input.companyId,
        entryNumber,
        entryDate: input.entryDate,
        journalCode: input.journalCode ?? 'GENERAL',
        documentType: input.documentType,
        description: input.description,
        status: 'DRAFT',
        createdBy: input.createdBy,
        lines: {
          create: input.lines.map((line) => ({
            companyId: input.companyId,
            accountId: byCode.get(line.accountCode)!,
            partyId: line.partyId ?? null,
            description: line.description,
            debit: line.debit,
            credit: line.credit,
          })),
        },
      },
      include: { lines: true },
    });

    return tx.journalEntry.update({
      where: { id: entry.id },
      data: { status: 'POSTED', postedAt: new Date() },
      include: { lines: true },
    }) as Promise<JournalEntry & { lines: unknown[] }>;
  }

  /**
   * Reverse a POSTED entry: creates a mirrored POSTED entry (debit ↔ credit)
   * and marks the original REVERSED with reversedByEntryId. Idempotency
   * guard: an already REVERSED entry cannot be reversed again.
   */
  async reverse(
    entryId: string,
    actor?: { id?: string },
  ): Promise<{ original: JournalEntry; reversal: JournalEntry & { lines: unknown[] } }> {
    return this.prisma.$transaction(async (trx) => {
      const original = await trx.journalEntry.findUnique({
        where: { id: entryId },
        include: { lines: true },
      });
      if (!original) throw new NotFoundError('Journal entry not found', { entryId });
      if (original.status === 'REVERSED') {
        throw new ValidationError('Journal entry is already reversed', { entryId });
      }
      if (original.status !== 'POSTED') {
        throw new ValidationError('Only POSTED journal entries can be reversed', {
          status: original.status,
        });
      }

      const accountIds = [...new Set(original.lines.map((l) => l.accountId))];
      const accounts = await trx.chartOfAccount.findMany({
        where: { id: { in: accountIds } },
        select: { id: true, code: true },
      });
      const codeById = new Map(accounts.map((a) => [a.id, a.code]));

      const reversal = await this.post(trx, {
        companyId: original.companyId,
        entryDate: new Date(),
        journalCode: original.journalCode,
        documentType: original.documentType ?? undefined,
        description: `Reversal of ${original.entryNumber}`,
        createdBy: actor?.id,
        lines: original.lines.map((line) => ({
          accountCode: codeById.get(line.accountId)!,
          partyId: line.partyId,
          debit: Number(line.credit),
          credit: Number(line.debit),
          description: line.description ?? undefined,
        })),
      });

      const updatedOriginal = await trx.journalEntry.update({
        where: { id: original.id },
        data: { status: 'REVERSED', reversedByEntryId: reversal.id },
      });
      return { original: updatedOriginal, reversal };
    });
  }

  /** POSTED entries are immutable — guards any future edit/delete path. */
  static assertMutable(entry: Pick<JournalEntry, 'status'>): void {
    if (entry.status === 'POSTED' || entry.status === 'REVERSED') {
      throw new ForbiddenError('POSTED journal entries cannot be modified; reverse instead', {
        status: entry.status,
      });
    }
  }

  async getById(companyId: string, id: string) {
    const entry = await this.prisma.journalEntry.findUnique({
      where: { id },
      include: { lines: { include: { account: { select: { code: true, name: true } } } } },
    });
    if (!entry || entry.companyId !== companyId) {
      throw new NotFoundError('Journal entry not found', { id });
    }
    return entry;
  }

  async list(companyId: string, limit = 50) {
    return this.prisma.journalEntry.findMany({
      where: { companyId },
      orderBy: [{ entryDate: 'desc' }, { createdAt: 'desc' }],
      take: limit,
      include: { lines: true },
    });
  }
}
