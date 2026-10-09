import { PrismaClient } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { TimelineService } from '../parties/timeline.service';
import { DocumentRelationService } from '../document-flow/document-relation.service';
import { InventoryService } from '../inventory/inventory.service';
import { LoadingService } from '../loading/loading.service';
import { ApprovalRequestService } from '../approvals/approvals.service';
import { NotificationService } from '../notifications/notifications.service';
import { StockQueryDto, MovementQueryDto } from '../inventory/inventory.dto';
import { LoadingQueryDto } from '../loading/loading.dto';
import { makeQueueService } from './p5-fixtures';
import { INTEGRATION_COMPANY_ID } from './integration';

/**
 * Phase 6 integration fixtures: real services over the shared integration
 * PrismaClient (loading lifecycle, inventory, approvals). Business-row
 * cleanup helpers keep the live DB clean — audit/timeline rows are
 * append-only history and stay.
 */

/** Query DTO factory (class fields carry required sortDir/skip/take). */
export function stockQuery(input: Partial<StockQueryDto> = {}): StockQueryDto {
  return Object.assign(new StockQueryDto(), input);
}

export function movementQuery(input: Partial<MovementQueryDto> = {}): MovementQueryDto {
  return Object.assign(new MovementQueryDto(), input);
}

export function loadingQuery(input: Partial<LoadingQueryDto> = {}): LoadingQueryDto {
  return Object.assign(new LoadingQueryDto(), input);
}

export function inventoryService(prisma: PrismaClient): InventoryService {
  return new InventoryService(prisma as never, new AuditService(prisma as never));
}

export function loadingService(prisma: PrismaClient): LoadingService {
  const audit = new AuditService(prisma as never);
  const timeline = new TimelineService(prisma as never);
  const relations = new DocumentRelationService(prisma as never, audit);
  return new LoadingService(
    prisma as never,
    audit,
    timeline,
    relations,
    inventoryService(prisma),
    approvalRequestService(prisma),
  );
}

export function approvalRequestService(prisma: PrismaClient): ApprovalRequestService {
  const audit = new AuditService(prisma as never);
  const timeline = new TimelineService(prisma as never);
  const notifications = new NotificationService(prisma as never, makeQueueService(prisma));
  return new ApprovalRequestService(prisma as never, audit, timeline, notifications);
}

export function relationService(prisma: PrismaClient): DocumentRelationService {
  return new DocumentRelationService(prisma as never, new AuditService(prisma as never));
}

/** Direct balance row (the debt-gate input the claims service maintains). */
export async function setPartyBalance(
  prisma: PrismaClient,
  companyId: string,
  partyId: string,
  balance: number,
): Promise<void> {
  await prisma.partyOperationalBalance.upsert({
    where: { companyId_partyId: { companyId, partyId } },
    create: { companyId, partyId, balance },
    update: { balance },
  });
}

/** Default warehouse for the seeded integration company (MAIN). */
export async function mainWarehouse(prisma: PrismaClient, companyId = INTEGRATION_COMPANY_ID) {
  return prisma.warehouse.upsert({
    where: { companyId_code: { companyId, code: 'MAIN' } },
    create: { companyId, code: 'MAIN', nameFa: 'انبار مرکزی', isDefault: true },
    update: {},
  });
}

/**
 * Cleanup for one company's Phase 6 rows (order matters — FKs). Delete
 * per-id first for shared-company tests, or the company-wide variant for
 * isolated test companies.
 */
export async function cleanupLoading(prisma: PrismaClient, loadingId: string): Promise<void> {
  if (!loadingId) return; // a failed beforeAll/beforeEach can leave '' — never clean up with it
  await prisma.approvalRequest.deleteMany({ where: { entityType: 'loading', entityId: loadingId } });
  await prisma.documentRelation.deleteMany({
    where: { OR: [{ fromType: 'loading', fromId: loadingId }, { toType: 'loading', toId: loadingId }] },
  });
  await prisma.stockMovement.deleteMany({ where: { sourceEntityId: loadingId } });
  await prisma.loading.deleteMany({ where: { id: loadingId } }).catch(() => undefined);
}

export async function cleanupPurchaseReceive(prisma: PrismaClient, purchaseDocumentId: string): Promise<void> {
  if (!purchaseDocumentId) return;
  await prisma.stockMovement.deleteMany({ where: { sourceEntityId: purchaseDocumentId } });
}

/**
 * Company-wide cleanup used by the isolated-company isolation test: removes
 * every Phase 6 (and earlier) business row of the company, then the company.
 */
export async function cleanupCompanyPhase6(prisma: PrismaClient, companyId: string): Promise<void> {
  await prisma.notification.deleteMany({ where: { companyId } });
  await prisma.approvalRequest.deleteMany({ where: { companyId } });
  await prisma.documentRelation.deleteMany({ where: { companyId } });
  await prisma.stockMovement.deleteMany({ where: { companyId } });
  await prisma.loadingAllocation.deleteMany({ where: { companyId } });
  await prisma.loadingLine.deleteMany({ where: { loading: { companyId } } });
  await prisma.loading.deleteMany({ where: { companyId } });
  await prisma.partyOperationalBalance.deleteMany({ where: { companyId } });
  await prisma.salesPurchaseAllocation.deleteMany({ where: { companyId } });
  await prisma.salesDocument.deleteMany({ where: { companyId } });
  await prisma.purchaseDocument.deleteMany({ where: { companyId } });
  await prisma.warehouse.deleteMany({ where: { companyId } });
  await prisma.productVariant.deleteMany({ where: { companyId } });
  await prisma.productTemplate.deleteMany({ where: { companyId } });
  await prisma.productCategory.deleteMany({ where: { companyId } });
  await prisma.uom.deleteMany({ where: { companyId } });
  await prisma.uomCategory.deleteMany({ where: { companyId } });
  await prisma.party.deleteMany({ where: { companyId } });
  await prisma.sequence.deleteMany({ where: { companyId } });
  await prisma.company.deleteMany({ where: { id: companyId } }).catch(() => undefined);
}
