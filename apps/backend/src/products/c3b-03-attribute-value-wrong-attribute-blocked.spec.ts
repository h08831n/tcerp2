import { TemplatesService } from './templates.service';

/**
 * c3b-03 — attribute-value-wrong-attribute-blocked: selecting an
 * AttributeValue whose attribute_id differs from the ProductTemplateAttribute's
 * attribute_id → ValidationError ATTRIBUTE_VALUE_MISMATCH (replace and
 * single-add modes). Cross-company values are invisible first (404).
 */
describe('c3b-03 attribute-value-wrong-attribute-blocked', () => {
  const COMPANY = '00000000-0000-4000-8000-000000000001';
  const TEMPLATE = '11111111-1111-4111-8111-111111111111';
  const ATTR_SIZE = '22222222-2222-4222-8222-222222222222';
  const ATTR_COLOR = '33333333-3333-4333-8333-333333333333';
  const VALUE_M = '44444444-4444-4444-8444-444444444444'; // belongs to SIZE
  const VALUE_RED = '55555555-5555-4555-8555-555555555555'; // belongs to COLOR
  const VALUE_FOREIGN = '66666666-6666-4666-8666-666666666666'; // other company

  const TEMPLATE_ATTRIBUTE = {
    id: 'pta-1',
    templateId: TEMPLATE,
    attributeId: ATTR_SIZE,
  };

  function makeService(valueRows: Record<string, unknown>[]) {
    const audit = { recordTx: jest.fn(), record: jest.fn() };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prisma: any = {
      productTemplate: {
        findUnique: jest.fn(async () => ({
          id: TEMPLATE,
          companyId: COMPANY,
          active: true,
        })),
      },
      productTemplateAttribute: {
        findUnique: jest.fn(async () => TEMPLATE_ATTRIBUTE),
      },
      attributeValue: {
        findUnique: jest.fn(async (args: { where: { id: string } }) =>
          valueRows.find((v) => v.id === args.where.id) ?? null,
        ),
      },
      productTemplateAttributeValue: {
        findUnique: jest.fn(async () => null),
        findFirst: jest.fn(async () => null),
        create: jest.fn(),
      },
      $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(prisma)),
    };
    return { service: new TemplatesService(prisma as never, audit as never), prisma, audit };
  }

  const VALUE_PROJECTION = (row: { id: string; attributeId: string; attribute: { companyId: string } }) => row;

  it('single-add with a value of ANOTHER attribute → ATTRIBUTE_VALUE_MISMATCH', async () => {
    const { service } = makeService([
      VALUE_PROJECTION({
        id: VALUE_RED,
        attributeId: ATTR_COLOR,
        attribute: { companyId: COMPANY },
      }),
    ]);
    await expect(
      service.setTemplateAttributeValues(
        COMPANY,
        TEMPLATE,
        ATTR_SIZE,
        { valueId: VALUE_RED },
        { id: 'u1', username: 'admin' },
        {},
      ),
    ).rejects.toMatchObject({ message: 'ATTRIBUTE_VALUE_MISMATCH' });
  });

  it('replace-set validates every value — one foreign-attribute value poisons the batch', async () => {
    const { service, prisma } = makeService([
      { id: VALUE_M, attributeId: ATTR_SIZE, attribute: { companyId: COMPANY } },
      { id: VALUE_RED, attributeId: ATTR_COLOR, attribute: { companyId: COMPANY } },
    ]);
    await expect(
      service.setTemplateAttributeValues(
        COMPANY,
        TEMPLATE,
        ATTR_SIZE,
        { valueIds: [VALUE_M, VALUE_RED] },
        { id: 'u1', username: 'admin' },
        {},
      ),
    ).rejects.toMatchObject({
      message: 'ATTRIBUTE_VALUE_MISMATCH',
      details: { valueId: VALUE_RED, attributeId: ATTR_SIZE },
    });
    expect(prisma.productTemplateAttributeValue.create).not.toHaveBeenCalled();
  });

  it('a value of another company is invisible (404), never ATTRIBUTE_VALUE_MISMATCH', async () => {
    const { service } = makeService([
      { id: VALUE_FOREIGN, attributeId: ATTR_SIZE, attribute: { companyId: 'company-OTHER' } },
    ]);
    await expect(
      service.setTemplateAttributeValues(
        COMPANY,
        TEMPLATE,
        ATTR_SIZE,
        { valueId: VALUE_FOREIGN },
        { id: 'u1', username: 'admin' },
        {},
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('a matching value passes the gate and gets selected', async () => {
    const { service, prisma } = makeService([
      { id: VALUE_M, attributeId: ATTR_SIZE, attribute: { companyId: COMPANY } },
    ]);
    (prisma.productTemplateAttributeValue.create as jest.Mock).mockResolvedValue({
      id: 'sel-1',
      templateAttributeId: 'pta-1',
      attributeValueId: VALUE_M,
      displayOrder: 0,
      active: true,
    });
    const row = (await service.setTemplateAttributeValues(
      COMPANY,
      TEMPLATE,
      ATTR_SIZE,
      { valueId: VALUE_M },
      { id: 'u1', username: 'admin' },
      {},
    )) as { attributeValueId: string };
    expect(row.attributeValueId).toBe(VALUE_M);
    expect(prisma.productTemplateAttributeValue.create).toHaveBeenCalled();
  });
});
