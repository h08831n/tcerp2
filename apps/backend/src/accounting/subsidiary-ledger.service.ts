import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Subsidiary ledger (docs/06 §3): per-party balances from accounting lines
 * (partyId + CUSTOMER/SUPPLIER analytics), with financial-responsibility
 * group view (individual rows preserved + group total) and reconciliation
 * delta vs the operational PartyOperationalBalance.
 */
@Injectable()
export class SubsidiaryLedgerService {
  constructor(private readonly prisma: PrismaService) {}

  async partyBalances(
    companyId: string,
    opts: { role: 'CUSTOMER' | 'SUPPLIER'; accountCode: string; asOf?: Date; search?: string; page?: number; pageSize?: number },
  ) {
    const page = Math.max(1, opts.page ?? 1);
    const pageSize = Math.min(Math.max(opts.pageSize ?? 25, 1), 200);
    const asOf = opts.asOf ?? new Date();
    const sign = opts.role === 'CUSTOMER' ? 1 : -1;

    const rows = await this.prisma.$queryRaw<
      Array<{
        party_id: string;
        name_fa: string;
        debit: Prisma.Decimal | null;
        credit: Prisma.Decimal | null;
        last_activity: Date | null;
        total: bigint;
      }>
    >`
      SELECT p.id AS party_id, p.name_fa AS name_fa,
             SUM(l.debit) AS debit, SUM(l.credit) AS credit,
             MAX(je.entry_date) AS last_activity,
             COUNT(*) OVER() AS total
      FROM parties p
      JOIN party_roles pr ON pr.party_id = p.id AND pr.role = ${opts.role}::"PartyRoleType"
      JOIN journal_lines l ON l.party_id = p.id
      JOIN journal_entries je ON je.id = l.journal_entry_id AND je.status IN ('POSTED', 'REVERSED')
      JOIN chart_of_accounts a ON a.id = l.account_id AND a.code = ${opts.accountCode}
      WHERE p.company_id = ${companyId}::uuid AND p.archived_at IS NULL
        AND je.entry_date <= ${asOf}
        ${opts.search ? Prisma.sql`AND p.name_fa ILIKE ${'%' + opts.search + '%'}` : Prisma.empty}
      GROUP BY p.id, p.name_fa
      ORDER BY SUM(l.debit) - SUM(l.credit) DESC
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`;

    const total = rows.length > 0 ? Number(rows[0].total) : 0;
    const partyIds = rows.map((r) => r.party_id);
    const opBalances = partyIds.length
      ? await this.prisma.partyOperationalBalance.findMany({
          where: { companyId, partyId: { in: partyIds } },
          select: { partyId: true, balance: true },
        })
      : [];
    const opMap = new Map(opBalances.map((b) => [b.partyId, b.balance]));

    const items = rows.map((r) => {
      const accountingBalance = new Prisma.Decimal(r.debit ?? 0)
        .minus(new Prisma.Decimal(r.credit ?? 0))
        .times(sign);
      const operational = opMap.get(r.party_id) ?? null;
      return {
        partyId: r.party_id,
        nameFa: r.name_fa,
        debit: r.debit ?? new Prisma.Decimal(0),
        credit: r.credit ?? new Prisma.Decimal(0),
        accountingBalance,
        operationalBalance: operational,
        reconciliationDelta: operational ? accountingBalance.minus(operational) : null,
        lastActivity: r.last_activity,
      };
    });

    const groupTotal = items.reduce((s, i) => s.plus(i.accountingBalance), new Prisma.Decimal(0));
    return { items, groupTotal, page, pageSize, total };
  }

  /** Per-party movement lines (drill-down). */
  async partyLedger(
    companyId: string,
    partyId: string,
    opts: { accountCode: string; from?: Date; to?: Date },
  ) {
    const lines = await this.prisma.journalLine.findMany({
      where: {
        companyId,
        partyId,
        entry: {
          companyId,
          status: { in: ['POSTED', 'REVERSED'] as ('POSTED' | 'REVERSED')[] },
          ...(opts.from || opts.to
            ? {
                entryDate: {
                  ...(opts.from ? { gte: opts.from } : {}),
                  ...(opts.to ? { lte: opts.to } : {}),
                },
              }
            : {}),
        },
        account: { code: opts.accountCode },
      },
      orderBy: [{ entry: { entryDate: 'asc' } }, { id: 'asc' }],
      select: {
        id: true,
        debit: true,
        credit: true,
        description: true,
        entry: {
          select: { id: true, entryNumber: true, entryDate: true, documentType: true, status: true },
        },
      },
    });
    const sign = opts.accountCode === 'RECEIVABLE' ? 1 : -1;
    let running = new Prisma.Decimal(0);
    const rows = lines.map((l) => {
      running = running.plus(
        new Prisma.Decimal(l.debit).minus(new Prisma.Decimal(l.credit)).times(sign),
      );
      return {
        entryId: l.entry.id,
        entryNumber: l.entry.entryNumber,
        entryDate: l.entry.entryDate,
        documentType: l.entry.documentType,
        description: l.description,
        debit: l.debit,
        credit: l.credit,
        runningBalance: running,
      };
    });
    return { partyId, rows, closingBalance: running };
  }

  /**
   * Financial responsibility group view (REQUIREMENTS §38/§100): responsible
   * party's own balance + members', individual rows preserved + group total.
   */
  async responsibilityGroup(companyId: string, responsiblePartyId: string, accountCode = 'RECEIVABLE') {
    const memberships = await this.prisma.financialResponsibility.findMany({
      where: { companyId, responsiblePartyId },
      select: { memberPartyId: true },
    });
    const memberIds = memberships.map((m) => m.memberPartyId);
    const parties = await this.prisma.party.findMany({
      where: { companyId, id: { in: [responsiblePartyId, ...memberIds] } },
      select: { id: true, nameFa: true },
    });
    const nameMap = new Map(parties.map((p) => [p.id, p.nameFa]));

    const agg = await this.prisma.journalLine.groupBy({
      by: ['partyId'],
      where: {
        companyId,
        partyId: { in: [responsiblePartyId, ...memberIds] },
        entry: { companyId, status: { in: ['POSTED', 'REVERSED'] as ('POSTED' | 'REVERSED')[] } },
        account: { code: accountCode },
      },
      _sum: { debit: true, credit: true },
    });
    const balances = new Map(
      agg.map((r) => [
        r.partyId,
        new Prisma.Decimal(r._sum.debit ?? 0)
          .minus(new Prisma.Decimal(r._sum.credit ?? 0))
          .times(accountCode === 'RECEIVABLE' ? 1 : -1),
      ]),
    );

    const members = memberIds.map((id) => ({
      partyId: id,
      nameFa: nameMap.get(id) ?? id,
      balance: balances.get(id) ?? new Prisma.Decimal(0),
    }));
    const ownBalance = balances.get(responsiblePartyId) ?? new Prisma.Decimal(0);
    const groupTotal = members.reduce((s, m) => s.plus(m.balance), ownBalance);
    return {
      group: { responsiblePartyId, nameFa: nameMap.get(responsiblePartyId) ?? responsiblePartyId },
      members,
      ownBalance,
      groupTotal,
      consolidatedNote: 'individual balances preserved — group total is additive only',
    };
  }
}

// Small helper for exact types.
export type PrismaDecimal = Prisma.Decimal;
export type PrismaClientType = PrismaClient;
