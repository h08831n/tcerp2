import { TemplatesService } from './templates.service';

/**
 * p3b-08 — no-duplicate-variant-combination: generating a combination that
 * already exists (same attributeId→valueId set under the template) SKIPS it
 * (skip-with-report) and never creates a duplicate ProductVariant row.
 */
describe('p3b-08 no-duplicate-variant-combination', () => {
  const COMPANY = 'company-1';
  const actor = { id: 'u1', username: 'admin' };

  const SPACE = [
    {
      attributeId: 'a-size',
      displayOrder: 1,
      attribute: { id: 'a-size', code: 'SIZE', nameFa: 'سایز', values: [{ id: 'v-s', code: 'S', valueFa: 'کوچک' }] },
    },
  ];

  function makeService(existingVariants: Record<string, unknown>[]) {
    const createdVariants: Record<string, unknown>[] = [];
    const trx = {
      productVariant: {
        findMany: jest.fn(async () => existingVariants),
        create: jest.fn(async (args: { data: Record<string, unknown> }) => {
          const row = { id: `var-${createdVariants.length + 1}`, ...args.data };
          createdVariants.push(row);
          return row;
        }),
      },
    };
    const prisma = {
      productTemplate: {
        findUnique: jest.fn(async () => ({
          id: 'tpl-1',
          companyId: COMPANY,
          internalCode: 'P-1',
          nameFa: 'قالب',
          active: true,
        })),
      },
      productTemplateAttribute: { findMany: jest.fn(async () => SPACE) },
      $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(trx)),
    };
    const audit = { record: jest.fn(), recordTx: jest.fn() };
    const service = new TemplatesService(prisma as never, audit as never);
    return { service, prisma, trx, createdVariants, audit };
  }

  const combo = {
    combinations: [{ selections: [{ attributeId: 'a-size', valueId: 'v-s' }] }],
  };

  it('a fresh combination is created; the exact same generation call is then skipped', async () => {
    // First run: nothing exists → created.
    const first = makeService([]);
    const r1 = (await first.service.generateVariants(COMPANY, 'tpl-1', combo, actor, {})) as {
      created: unknown[];
      skipped: unknown[];
    };
    expect(r1.created).toHaveLength(1);
    expect(r1.skipped).toHaveLength(0);
    expect(first.createdVariants[0]).toMatchObject({ sku: 'P-1-S' });

    // Second run: the tx sees the variant created by the first run
    // (same attributeId→valueId set) → skipped, no second row.
    const second = makeService([
      {
        sku: 'P-1-S',
        values: [{ attributeId: 'a-size', attributeValueId: 'v-s' }],
      },
    ]);
    const r2 = (await second.service.generateVariants(COMPANY, 'tpl-1', combo, actor, {})) as {
      created: unknown[];
      skipped: Array<{ reason: string }>;
    };
    expect(r2.created).toHaveLength(0);
    expect(r2.skipped).toHaveLength(1);
    expect(r2.skipped[0].reason).toBe('VARIANT_COMBINATION_EXISTS');
    expect(second.trx.productVariant.create).not.toHaveBeenCalled();
  });

  it('per-variant audit + one batch summary entry are written in the same tx', async () => {
    const first = makeService([]);
    await first.service.generateVariants(COMPANY, 'tpl-1', combo, actor, {});
    const entityTypes = (first.audit.recordTx as jest.Mock).mock.calls.map(
      (c) => (c[1] as { entityType: string }).entityType,
    );
    expect(entityTypes).toContain('product_variant');
    expect(entityTypes).toContain('product_template');
    // summary action
    const summary = (first.audit.recordTx as jest.Mock).mock.calls.find(
      (c) => (c[1] as { action: string }).action === 'VARIANTS_GENERATED',
    );
    expect(summary).toBeDefined();
    expect((summary![1] as { newValues: { createdCount: number } }).newValues.createdCount).toBe(1);
  });
});
