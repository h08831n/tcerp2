import { Prisma } from '@prisma/client';
import { ValidationError } from '../errors';

type Client = Prisma.TransactionClient | { userCompany: { findFirst: (args: unknown) => Promise<unknown> } };

/**
 * corr-03 pattern generalized (Phase 4): an assigned user (party owner,
 * lead salesperson, opportunity salesperson, sales salesperson, purchase
 * buyer) must be an ACTIVE member of the entity's company
 * (`user_companies` ⋈ `users.status = 'ACTIVE'`). A globally existing but
 * non-member (or inactive) user is NEVER accepted.
 */
export async function assertActiveCompanyMember(
  client: Client,
  companyId: string,
  userId: string,
  message = 'USER_NOT_COMPANY_MEMBER',
): Promise<void> {
  const member = await (client as Prisma.TransactionClient).userCompany.findFirst({
    where: { userId, companyId, user: { status: 'ACTIVE' } },
    select: { userId: true },
  });
  if (!member) {
    throw new ValidationError(message, { companyId, userId });
  }
}
