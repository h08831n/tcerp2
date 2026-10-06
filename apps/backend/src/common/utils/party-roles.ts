import { PartyRoleType, Prisma } from '@prisma/client';
import { ValidationError } from '../errors';

/**
 * A party acting as customer/supplier must hold the corresponding role
 * (REQUIREMENTS §8: "Customer با Lead یکی نیست", §11). Cross-company parties
 * are treated as missing (404-style semantics upstream).
 */
export async function assertPartyHasRole(
  prisma: Prisma.TransactionClient | { party: { findFirst: (args: unknown) => Promise<unknown> } },
  companyId: string,
  partyId: string,
  role: PartyRoleType,
  message = 'PARTY_ROLE_REQUIRED',
): Promise<void> {
  const party = await (prisma as Prisma.TransactionClient).party.findFirst({
    where: { id: partyId, companyId },
    select: { id: true, roles: { where: { role }, select: { id: true } } },
  });
  if (!party || party.roles.length === 0) {
    throw new ValidationError(message, { companyId, partyId, role });
  }
}

/** Customer check (sales side) — stable message token NOT_A_CUSTOMER. */
export function assertCustomer(
  prisma: Prisma.TransactionClient,
  companyId: string,
  partyId: string,
): Promise<void> {
  return assertPartyHasRole(prisma, companyId, partyId, PartyRoleType.CUSTOMER, 'NOT_A_CUSTOMER');
}

/** Supplier check (purchase side) — stable message token NOT_A_SUPPLIER. */
export function assertSupplier(
  prisma: Prisma.TransactionClient,
  companyId: string,
  partyId: string,
): Promise<void> {
  return assertPartyHasRole(prisma, companyId, partyId, PartyRoleType.SUPPLIER, 'NOT_A_SUPPLIER');
}
