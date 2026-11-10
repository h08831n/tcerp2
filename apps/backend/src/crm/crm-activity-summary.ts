import { PrismaService } from '../prisma/prisma.service';

/**
 * CR-001 — shared «فعالیت‌های CRM» summary for a Lead or Opportunity detail
 * (Odoo-style next-activity chip + overdue badge).
 *
 * Reuses the GENERIC Activity model (relatedEntityType/relatedEntityId) —
 * NO parallel activity system and NO schema change: Lead and Opportunity
 * activities are the SAME machinery every other party entity already uses.
 *
 * Definitions (kept consistent with activities.service.withDerived):
 *   - overdue  = PENDING && dueDate < now
 *   - next     = earliest PENDING by effective date (scheduledDate ?? dueDate)
 */
export interface CrmActivitySummary {
  /** ISO datetime of the next pending follow-up (null = nothing scheduled). */
  nextActivityAt: string | null;
  nextActivityTitle: string | null;
  overdueCount: number;
  /** All not-yet-completed activities (PENDING). */
  openCount: number;
}

export async function crmActivitySummary(
  prisma: PrismaService,
  companyId: string,
  relatedEntityType: 'lead' | 'opportunity',
  relatedEntityId: string,
): Promise<CrmActivitySummary> {
  const pending = await prisma.activity.findMany({
    where: { companyId, relatedEntityType, relatedEntityId, status: 'PENDING' },
    select: { title: true, scheduledDate: true, dueDate: true },
    orderBy: { dueDate: 'asc' },
    take: 200,
  });
  const now = Date.now();
  const effective = (a: { scheduledDate: Date | null; dueDate: Date | null }): number =>
    (a.scheduledDate ?? a.dueDate ?? new Date('9999-12-31T00:00:00Z')).getTime();
  const sorted = [...pending].sort((a, b) => effective(a) - effective(b));
  const next = sorted[0] ?? null;
  return {
    nextActivityAt: next ? (next.scheduledDate ?? next.dueDate)?.toISOString() ?? null : null,
    nextActivityTitle: next?.title ?? null,
    overdueCount: pending.filter((a) => a.dueDate !== null && a.dueDate.getTime() < now).length,
    openCount: pending.length,
  };
}
