import { PurchaseDocumentsService } from './purchase-documents.service';
import { ValidationError } from '../common/errors';
import { AuditService } from '../audit/audit.service';
import { TimelineService } from '../parties/timeline.service';
import { DocumentRelationService } from '../document-flow/document-relation.service';

/**
 * p4-06 buyer-company-membership: a buyerUserId that is not an active
 * member of the company is rejected with BUYER_NOT_COMPANY_MEMBER —
 * globally existing users are never accepted.
 */
describe('p4-06 buyer-company-membership', () => {
  const COMPANY = 'company-1';

  function makeService(userCompanyMember: unknown) {
    const prisma: Record<string, unknown> = {
      party: { findFirst: jest.fn(async () => ({ id: 'sup1', roles: [{ id: 'r1' }] })) },
      userCompany: { findFirst: jest.fn(async () => userCompanyMember) },
      sequence: { findUniqueOrThrow: jest.fn() },
      $queryRaw: jest.fn(async () => [{ current_number: 1, last_reset_marker: null }]),
      setting: { findUnique: jest.fn(async () => null) },
      productVariant: { findMany: jest.fn(async () => []) },
      uom: { findMany: jest.fn(async () => []) },
      $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(prisma)),
    };
    const audit = { recordTx: jest.fn(async () => undefined), record: jest.fn(async () => undefined) };
    const service = new PurchaseDocumentsService(
      prisma as never,
      { allocate: jest.fn(async () => ({ companyId: COMPANY, documentType: 'PURCHASE', number: 'PO-1', value: 1 })) } as never,
      audit as unknown as AuditService,
      new TimelineService(prisma as never),
      new DocumentRelationService(prisma as never, audit as unknown as AuditService),
      { ensureDefaultWarehouse: jest.fn() } as never, // Phase 6 receive seam (unused here)
    );
    return { service, prisma, audit };
  }

  it('a non-member buyer is rejected with BUYER_NOT_COMPANY_MEMBER', async () => {
    const { service, prisma } = makeService(null);
    await expect(
      service.create(
        COMPANY,
        { supplierPartyId: 'sup1', buyerUserId: 'outsider' },
        { id: 'actor', username: 'admin' },
        {},
      ),
    ).rejects.toMatchObject({ statusCode: 422, message: 'BUYER_NOT_COMPANY_MEMBER' });
    expect((prisma.userCompany as { findFirst: jest.Mock }).findFirst).toHaveBeenCalled();
  });

  it('an active member buyer passes the membership check', async () => {
    const { service } = makeService({ userId: 'buyer-1' });
    // The transaction continues past membership; the (mocked) sequence and
    // line normalization complete without a membership error.
    await expect(
      service.create(
        COMPANY,
        { supplierPartyId: 'sup1', buyerUserId: 'buyer-1' },
        { id: 'actor', username: 'admin' },
        {},
      ),
    ).rejects.not.toMatchObject({ message: 'BUYER_NOT_COMPANY_MEMBER' });
  });
});
