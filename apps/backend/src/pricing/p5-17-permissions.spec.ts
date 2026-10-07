import {
  describeIntegration,
  integrationPrisma,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { PERMISSIONS_KEY } from '../common/decorators/permissions.decorator';
import { PricingController } from './pricing.controller';
import { PublishingController } from '../publishing/publishing.controller';
import { AutomationController } from '../automation/automation.controller';

/**
 * p5-17 permissions: the Phase 5 permission catalog exists (seed is
 * idempotent), the seeded roles carry the right grants (salesperson →
 * pricing.view only; pricing_user → full pricing stack) and every Phase 5
 * route declares its @RequirePermissions metadata (enforced by the global
 * PermissionsGuard).
 */
describeIntegration('p5-17 permissions', () => {
  const prisma = integrationPrisma();

  it('the Phase 5 permission catalog is seeded', async () => {
    const codes = (
      await prisma.permission.findMany({
        where: { code: { in: [
          'pricing.view', 'pricing.create', 'pricing.edit', 'pricing.edit_history', 'pricing.publish',
          'publishing.view', 'publishing.retry', 'publishing.cancel', 'publishing.templates.manage',
          'automation.view', 'automation.manage',
        ] } },
        select: { code: true },
      })
    ).map((p) => p.code);
    expect(codes).toHaveLength(11);
  });

  it('salesperson gets pricing.view but NOT write permissions', async () => {
    const salesperson = await prisma.role.findUniqueOrThrow({ where: { code: 'salesperson' }, select: { id: true } });
    const codes = (
      await prisma.rolePermission.findMany({
        where: { roleId: salesperson.id, permission: { code: { startsWith: 'pricing.' } } },
        select: { permission: { select: { code: true } } },
      })
    ).map((rp) => rp.permission.code);
    expect(codes).toEqual(['pricing.view']);
  });

  it('pricing_user gets the FULL pricing stack (+ publishing + automation.view)', async () => {
    const pricingUser = await prisma.role.findUniqueOrThrow({ where: { code: 'pricing_user' }, select: { id: true } });
    const codes = (
      await prisma.rolePermission.findMany({
        where: { roleId: pricingUser.id },
        select: { permission: { select: { code: true } } },
      })
    ).map((rp) => rp.permission.code);
    for (const code of [
      'pricing.view', 'pricing.create', 'pricing.edit', 'pricing.edit_history', 'pricing.publish',
      'publishing.view', 'publishing.retry', 'publishing.cancel', 'publishing.templates.manage',
      'automation.view',
    ]) {
      expect(codes).toContain(code);
    }
    // Reads pricing, but does not manage automation rules.
    expect(codes).not.toContain('automation.manage');
  });

  it('every Phase 5 route declares its required permissions', () => {
    const requiredOf = (target: object, method: string): string[] =>
      Reflect.getMetadata(PERMISSIONS_KEY, target[method as keyof typeof target] as object) ?? [];

    // Pricing
    expect(requiredOf(PricingController.prototype, 'upsert')).toEqual(['pricing.create']);
    expect(requiredOf(PricingController.prototype, 'grid')).toEqual(['pricing.view']);
    expect(requiredOf(PricingController.prototype, 'today')).toEqual(['pricing.view']);
    expect(requiredOf(PricingController.prototype, 'history')).toEqual(['pricing.view']);
    expect(requiredOf(PricingController.prototype, 'bulkUpdate')).toEqual(['pricing.edit']);
    expect(requiredOf(PricingController.prototype, 'cheapestReport')).toEqual(['pricing.view']);

    // Publishing
    expect(requiredOf(PublishingController.prototype, 'createBatch')).toEqual(['pricing.publish']);
    expect(requiredOf(PublishingController.prototype, 'retryItem')).toEqual(['publishing.retry']);
    expect(requiredOf(PublishingController.prototype, 'cancelItem')).toEqual(['publishing.cancel']);
    expect(requiredOf(PublishingController.prototype, 'listBatches')).toEqual(['publishing.view']);
    expect(requiredOf(PublishingController.prototype, 'getBatch')).toEqual(['publishing.view']);
    expect(requiredOf(PublishingController.prototype, 'createTemplate')).toEqual(['publishing.templates.manage']);
    expect(requiredOf(PublishingController.prototype, 'updateTemplate')).toEqual(['publishing.templates.manage']);
    expect(requiredOf(PublishingController.prototype, 'deleteTemplate')).toEqual(['publishing.templates.manage']);
    expect(requiredOf(PublishingController.prototype, 'renderPreview')).toEqual(['publishing.view']);

    // Automation
    expect(requiredOf(AutomationController.prototype, 'listRules')).toEqual(['automation.view']);
    expect(requiredOf(AutomationController.prototype, 'createRule')).toEqual(['automation.manage']);
    expect(requiredOf(AutomationController.prototype, 'updateRule')).toEqual(['automation.manage']);
    expect(requiredOf(AutomationController.prototype, 'deleteRule')).toEqual(['automation.manage']);
    expect(requiredOf(AutomationController.prototype, 'runRule')).toEqual(['automation.manage']);
    expect(requiredOf(AutomationController.prototype, 'runDailyScan')).toEqual(['automation.manage']);
  });

  afterAll(async () => {
    await disconnectIntegrationPrisma();
  });
});
