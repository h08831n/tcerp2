import { Controller, Get, Param, ParseUUIDPipe, Req } from '@nestjs/common';
import { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { NotFoundError } from '../common/errors';
import { CompanyContextService } from '../companies/company-context.service';

/**
 * GET /api/parties/:id/operational-balance (Phase 6, REQUIREMENTS §20): the
 * operational (non-accounting) balance the claims service maintains in
 * `party_operational_balances`. Positive = the party owes the company. This
 * is the exact value the Loading debt gate reads; a party with no balance row
 * reads as 0 (never in debt). Operational settlement only — the accounting
 * ledger is a different source of truth.
 */
@Controller('parties')
export class PartyOperationalBalanceController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly companyContext: CompanyContextService,
  ) {}

  @Get(':id/operational-balance')
  @RequirePermissions('claims.view')
  async getBalance(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    const party = await this.prisma.party.findFirst({
      where: { id, companyId },
      select: { id: true, nameFa: true },
    });
    if (!party) throw new NotFoundError('Party not found', { id });
    const row = await this.prisma.partyOperationalBalance.findUnique({
      where: { companyId_partyId: { companyId, partyId: id } },
      select: { balance: true, version: true, updatedAt: true },
    });
    return {
      partyId: party.id,
      partyNameFa: party.nameFa,
      balance: row?.balance ?? 0,
      hasDebt: row ? Number(row.balance) > 0 : false,
      updatedAt: row?.updatedAt ?? null,
    };
  }
}
