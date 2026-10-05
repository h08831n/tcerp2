import { Injectable } from '@nestjs/common';
import { PartyOperationalBalance, Prisma } from '@prisma/client';
import { AppError } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';

type Tx = Prisma.TransactionClient;

/**
 * Cached operational (non-accounting) balance per party. Positive = the party
 * owes the company. UNMATCHED claims move it temporarily:
 *   CUSTOMER_RECEIPT  → balance −= amount (customer declared paying us)
 *   SUPPLIER_PAYMENT  → balance += amount (we declared paying the supplier;
 *                       symmetric: what the party owes us increases)
 * Rejecting a claim reverses its delta. Updates use the optimistic `version`
 * column so concurrent claim operations cannot lose a delta.
 */
@Injectable()
export class PartyOperationalBalanceService {
  constructor(private readonly prisma: PrismaService) {}

  /** Sign of the balance delta for a claim direction. */
  static deltaFor(direction: 'CUSTOMER_RECEIPT' | 'SUPPLIER_PAYMENT', amount: number): number {
    return direction === 'CUSTOMER_RECEIPT' ? -amount : amount;
  }

  /**
   * Apply a balance delta with optimistic locking (bounded retries inside
   * `tx`; caller owns the transaction).
   */
  async applyDelta(tx: Tx, companyId: string, partyId: string, delta: number, retries = 3): Promise<PartyOperationalBalance> {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const existing = await tx.partyOperationalBalance.findUnique({
        where: { companyId_partyId: { companyId, partyId } },
      });
      if (!existing) {
        try {
          return await tx.partyOperationalBalance.create({
            data: { companyId, partyId, balance: delta },
          });
        } catch (error) {
          // Lost the create race — fall through to an update on retry.
          if (
            !(error instanceof Prisma.PrismaClientKnownRequestError) ||
            error.code !== 'P2002'
          ) {
            throw error;
          }
          continue;
        }
      }
      const updated = await tx.partyOperationalBalance.updateMany({
        where: { id: existing.id, version: existing.version },
        data: { balance: Number(existing.balance) + delta, version: existing.version + 1 },
      });
      if (updated.count === 1) {
        return {
          ...existing,
          // Numeric return for callers/tests; the DB stores Decimal.
          balance: (Number(existing.balance) + delta) as unknown as Prisma.Decimal,
          version: existing.version + 1,
        };
      }
    }
    throw new AppError(
      409,
      'VERSION_CONFLICT',
      'Concurrent balance update conflict; retry the operation',
      { companyId, partyId },
    );
  }
}
