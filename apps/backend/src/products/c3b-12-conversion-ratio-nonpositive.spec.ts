import {
  describeIntegration,
  INTEGRATION_COMPANY_ID,
  integrationPrisma,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { AuditService } from '../audit/audit.service';
import { UomsService, UOM_RATIO_POSITIVE } from './uoms.service';

/**
 * c3b-12 — conversion-ratio-nonpositive blocked (live DB): a UOM whose
 * conversion ratio is ≤ 0 violates the DB CHECK
 * `uoms_conversion_ratio_positive_chk`; the service maps the Postgres 23514
 * onto the stable domain code UOM_RATIO_POSITIVE (422). There is no
 * service-side duplicate of the constraint on purpose — the DB is the
 * authority (create AND patch paths).
 */
describeIntegration('c3b-12 conversion-ratio-nonpositive (live DB)', () => {
  const prisma = integrationPrisma();
  const marker = Date.now();
  const audit = new AuditService(prisma as never);
  const admin = { id: '', username: 'admin' };
  const uoms = new UomsService(prisma as never, audit);

  let categoryId: string;
  let uomId: string;

  beforeAll(async () => {
    const user = await prisma.user.findFirstOrThrow({ where: { username: 'admin' } });
    admin.id = user.id;
    categoryId = (
      (await uoms.createCategory(
        INTEGRATION_COMPANY_ID,
        { code: `RATIO-${marker}`, nameFa: 'نسبت' },
        admin,
        {},
      )) as { id: string }
    ).id;
  });

  it('creating a UOM with ratio 0 → DB CHECK mapped to UOM_RATIO_POSITIVE', async () => {
    await expect(
      uoms.createUom(
        INTEGRATION_COMPANY_ID,
        { categoryId, nameFa: 'صفر', symbol: `z-${marker}`, conversionRatio: '0' },
        admin,
        {},
      ),
    ).rejects.toMatchObject({ statusCode: 422, message: UOM_RATIO_POSITIVE });
    const rows = await prisma.uom.count({ where: { categoryId, symbol: `z-${marker}` } });
    expect(rows).toBe(0);
  });

  it('creating a UOM with a negative ratio → UOM_RATIO_POSITIVE', async () => {
    await expect(
      uoms.createUom(
        INTEGRATION_COMPANY_ID,
        { categoryId, nameFa: 'منفی', symbol: `n-${marker}`, conversionRatio: '-2.5' },
        admin,
        {},
      ),
    ).rejects.toMatchObject({ statusCode: 422, message: UOM_RATIO_POSITIVE });
  });

  it('the base-ratio CHECK also holds: base unit with ratio 2 → UOM_RATIO_POSITIVE via DB', async () => {
    // The service pre-validates base ratio = 1 (c3b-13), so to reach the DB
    // CHECK for the base case we bypass the service and violate the constraint
    // directly — proving uoms_base_ratio_one_chk exists and fires.
    await expect(
      prisma.uom.create({
        data: {
          companyId: INTEGRATION_COMPANY_ID,
          categoryId,
          nameFa: 'پایه بد',
          symbol: `bb-${marker}`,
          conversionRatio: 2,
          isBaseUnit: true,
        },
      }),
    ).rejects.toThrow(/uoms_base_ratio_one_chk/);
  });

  it('a positive ratio is accepted (the guard only blocks ≤ 0)', async () => {
    const row = (await uoms.createUom(
      INTEGRATION_COMPANY_ID,
      { categoryId, nameFa: 'نیم', symbol: `h-${marker}`, conversionRatio: '0.5' },
      admin,
      {},
    )) as { id: string };
    expect(row.id).toBeDefined();
    uomId = row.id;
  });

  it('patching a UOM to ratio 0 → UOM_RATIO_POSITIVE (DB CHECK on update)', async () => {
    await expect(
      uoms.updateUom(INTEGRATION_COMPANY_ID, uomId, { conversionRatio: '0' }, admin, {}),
    ).rejects.toMatchObject({ statusCode: 422, message: UOM_RATIO_POSITIVE });
    const row = await prisma.uom.findUniqueOrThrow({ where: { id: uomId } });
    expect(row.conversionRatio.toString()).toBe('0.5'); // unchanged
  });

  afterAll(async () => {
    await prisma.uom.deleteMany({ where: { categoryId } });
    await prisma.uomCategory.deleteMany({ where: { id: categoryId } });
    await prisma.auditLog
      .deleteMany({
        where: { entityType: { in: ['uom', 'uom_category'] }, entityId: { in: [categoryId, uomId] } },
      })
      .catch(() => undefined);
    await disconnectIntegrationPrisma();
  });
});
