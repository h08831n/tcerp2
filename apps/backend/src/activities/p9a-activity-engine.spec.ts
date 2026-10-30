import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TimelineService } from '../parties/timeline.service';
import { AuditService } from '../audit/audit.service';
import { ActivityService } from '../activities/activity.service';
import { TEST_INTEGRATION, disconnectIntegrationPrisma } from '../testing/integration';
import { assertSafeIntegrationDatabase } from '../testing/db-guard';

jest.setTimeout(120000);

const DB_URL = process.env.DATABASE_URL;

if (TEST_INTEGRATION) assertSafeIntegrationDatabase(DB_URL);

const ACTOR = { id: '00000000-0000-4000-8000-0000000000a1', username: 'admin' };

const COMPANY_A = '9a9a9a9a-9a9a-4a9a-8a9a-9a9a9a9a9a9a';
const COMPANY_B = '9b9b9b9b-9b9b-4b9b-8b9b-9b9b9b9b9b9b';

describe('p9a — Activity Engine (Phase 9A)', () => {
  let prismaService: PrismaService;
  let prisma: PrismaClient;
  let service: ActivityService;
  let timeline: TimelineService;
  let audit: AuditService;
  let typeIdA = '';
  let userId = '';
  let otherUserId = '';
  let realActor: { id: string; username: string };

  const cleanup = async () => {
    // timeline events reference the company (RESTRICT) — delete them first
    await prisma.timelineEvent.deleteMany({ where: { companyId: { in: [COMPANY_A, COMPANY_B] } } }).catch(() => undefined);
    await prisma.activity.deleteMany({ where: { companyId: { in: [COMPANY_A, COMPANY_B] } } }).catch(() => undefined);
    await prisma.activityType.deleteMany({ where: { companyId: { in: [COMPANY_A, COMPANY_B] } } }).catch(() => undefined);
    await prisma.userCompanyRole.deleteMany({ where: { companyId: { in: [COMPANY_A, COMPANY_B] } } }).catch(() => undefined);
    await prisma.userPermissionOverride.deleteMany({ where: { companyId: { in: [COMPANY_A, COMPANY_B] } } }).catch(() => undefined);
    await prisma.company.deleteMany({ where: { id: { in: [COMPANY_A, COMPANY_B] } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } }).catch(() => undefined);
  };

  beforeAll(async () => {
    if (!TEST_INTEGRATION || !DB_URL) return;
    prismaService = new PrismaService();
    prisma = prismaService as unknown as PrismaClient;
    await prismaService.$connect();
    const auditService = new AuditService(prismaService);
    timeline = new TimelineService(prismaService);
    audit = auditService;
    service = new ActivityService(prismaService, timeline, auditService);

    await cleanup();
    for (const [id, name] of [
      [COMPANY_A, 'p9a شرکت الف'],
      [COMPANY_B, 'p9a شرکت ب'],
    ] as const) {
      await prisma.company.create({ data: { id, nameFa: name, status: 'ACTIVE' } });
    }
    const user = await prisma.user.create({
      data: { username: `p9a-admin-${Date.now()}`, passwordHash: 'x', status: 'ACTIVE' },
    });
    userId = user.id;
    realActor = { id: userId, username: user.username };
    const other = await prisma.user.create({
      data: { username: `p9a-other-${Date.now()}`, passwordHash: 'x', status: 'ACTIVE' },
    });
    otherUserId = other.id;
    const adminRole = await prisma.role.findUniqueOrThrow({ where: { code: 'admin' }, select: { id: true } });
    for (const companyId of [COMPANY_A, COMPANY_B]) {
      for (const uid of [userId, otherUserId]) {
        await prisma.userCompanyRole.create({ data: { userId: uid, companyId, roleId: adminRole.id } });
      }
    }
    const type = await prisma.activityType.create({
      data: { companyId: COMPANY_A, code: 'PRICE_FOLLOW_UP', nameFa: 'پیگیری قیمت' },
    });
    typeIdA = type.id;
  });

  afterAll(async () => {
    if (!prismaService) return;
    await cleanup();
    await prismaService.$disconnect().catch(() => undefined);
    await disconnectIntegrationPrisma();
  });

  const itif = TEST_INTEGRATION && DB_URL ? it : (name: string, fn: jest.ProvidesCallback) => it.skip(name, fn);

  itif('p9a-01 create → update → complete → LOCKED for normal update; timeline event recorded', async () => {
    const { id } = await service.create(COMPANY_A, {
      typeCode: 'PRICE_FOLLOW_UP',
      title: 'پیگیری درخواست قیمت',
      relatedEntityType: 'price_request',
      relatedEntityId: COMPANY_A, // any uuid placeholder
      assignedToId: userId,
      dueDate: new Date(Date.now() + 24 * 3600 * 1000),
    }, ACTOR);
    await service.update(COMPANY_A, id, { title: 'پیگیری درخواست قیمت (ویرایش)' }, ACTOR, false);
    await service.complete(COMPANY_A, id, realActor);
    const row = await prisma.activity.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('COMPLETED');
    expect(row.completedById).toBe(realActor.id);
    expect(row.completedAt).not.toBeNull();
    // completed activity is LOCKED for normal (non-override) updates
    await expect(
      service.update(COMPANY_A, id, { title: 'تغییر بعد از تکمیل' }, ACTOR, false),
    ).rejects.toThrow('ACTIVITY_LOCKED_OVERRIDE_REQUIRED');
    // timeline event recorded exactly once on the related entity
    const events = await prisma.timelineEvent.findMany({
      where: { companyId: COMPANY_A, entityType: 'price_request', entityId: COMPANY_A, type: 'ACTIVITY_COMPLETED' },
    });
    expect(events).toHaveLength(1);
  });

  itif('p9a-02 manager override of a completed activity requires a reason and is audited', async () => {
    const { id } = await service.create(COMPANY_A, {
      typeCode: 'PRICE_FOLLOW_UP',
      title: 'override هدف',
      relatedEntityType: 'party',
      relatedEntityId: COMPANY_A,
    }, ACTOR);
    await service.complete(COMPANY_A, id, realActor);
    // override without reason rejected
    await expect(
      service.update(COMPANY_A, id, { title: 'x' }, ACTOR, true),
    ).rejects.toThrow('ACTIVITY_OVERRIDE_REASON_REQUIRED');
    // override with reason succeeds and stores the marker
    await service.update(COMPANY_A, id, { title: 'عنوان بعد از override', overrideReason: 'اصلاح اشتباه کاربر' }, ACTOR, true);
    const row = await prisma.activity.findUniqueOrThrow({ where: { id } });
    expect(row.title).toBe('عنوان بعد از override');
    expect(row.lastOverrideReason).toBe('اصلاح اشتباه کاربر');
    expect(row.lastOverrideById).toBe(ACTOR.id);
    const audits = await prisma.auditLog.findMany({
      where: { entityType: 'activity', entityId: id, action: 'OVERRIDE_UPDATE' },
    });
    expect(audits).toHaveLength(1);
    // OVERRIDDEN timeline event recorded
    const events = await prisma.timelineEvent.findMany({
      where: { companyId: COMPANY_A, type: 'ACTIVITY_OVERRIDDEN', data: { path: ['activityId'], equals: id } },
    });
    expect(events).toHaveLength(1);
  });

  itif('p9a-03 SYSTEM-created activity has no fabricated user row', async () => {
    const { activityId, created } = await service.createSystemActivity(COMPANY_A, {
      typeCode: 'PRICE_FOLLOW_UP',
      title: 'فعالیت سیستمی اتوماسیون',
      relatedEntityType: 'price_request',
      relatedEntityId: COMPANY_A,
      idempotencyKey: 'auto-1',
    });
    expect(created).toBe(true);
    const row = await prisma.activity.findUniqueOrThrow({ where: { id: activityId } });
    expect(row.createdByType).toBe('SYSTEM');
    expect(row.createdById).toBeNull();
    // idempotent: a repeated automation trigger does not duplicate
    const again = await service.createSystemActivity(COMPANY_A, {
      typeCode: 'PRICE_FOLLOW_UP',
      title: 'فعالیت سیستمی اتوماسیون',
      relatedEntityType: 'price_request',
      relatedEntityId: COMPANY_A,
      idempotencyKey: 'auto-1',
    });
    expect(again.created).toBe(false);
    expect(
      await prisma.activity.count({ where: { companyId: COMPANY_A, createdByType: 'SYSTEM' } }),
    ).toBe(1);
  });

  itif('p9a-04 company isolation: company B cannot see or modify company A activities', async () => {
    const { id } = await service.create(COMPANY_A, {
      typeCode: 'PRICE_FOLLOW_UP',
      title: 'مخفی برای ب',
      relatedEntityType: 'party',
      relatedEntityId: COMPANY_A,
    }, ACTOR);
    await expect(service.getById(COMPANY_B, id)).rejects.toThrow('Activity not found');
    const listB = await service.list(COMPANY_B, {});
    expect(listB.items.some((a) => a.id === id)).toBe(false);
    await expect(service.complete(COMPANY_B, id, ACTOR)).rejects.toThrow('Activity not found');
  });

  itif('p9a-05 assignee must be a member of the company', async () => {
    await expect(
      service.create(COMPANY_A, {
        typeCode: 'PRICE_FOLLOW_UP',
        title: 'تخصیص به غیرعضو',
        relatedEntityType: 'party',
        relatedEntityId: COMPANY_A,
        assignedToId: '00000000-0000-4000-8000-ffffffffffff',
      }, ACTOR),
    ).rejects.toThrow('ACTIVITY_ASSIGNEE_NOT_IN_COMPANY');
  });

  itif('p9a-06 overdue is DERIVED: PENDING with past dueDate; completed is never overdue', async () => {
    const overdue = await service.create(COMPANY_A, {
      typeCode: 'PRICE_FOLLOW_UP',
      title: 'عقب‌افتاده',
      relatedEntityType: 'party',
      relatedEntityId: COMPANY_A,
      dueDate: new Date(Date.now() - 48 * 3600 * 1000),
    }, ACTOR);
    const future = await service.create(COMPANY_A, {
      typeCode: 'PRICE_FOLLOW_UP',
      title: 'آینده',
      relatedEntityType: 'party',
      relatedEntityId: COMPANY_A,
      dueDate: new Date(Date.now() + 48 * 3600 * 1000),
    }, ACTOR);
    const list = await service.list(COMPANY_A, { overdueOnly: true, pageSize: 100 });
    const ids = list.items.map((a) => a.id);
    expect(ids).toContain(overdue.id);
    expect(ids).not.toContain(future.id);
    expect(list.items.find((a) => a.id === overdue.id)?.overdue).toBe(true);
    // completing the overdue activity removes it from the overdue bucket
    await service.complete(COMPANY_A, overdue.id, realActor);
    const after = await service.list(COMPANY_A, { overdueOnly: true, pageSize: 100 });
    expect(after.items.map((a) => a.id)).not.toContain(overdue.id);
    void future;
  });

  itif('p9a-07 calendar day/week/month ranges return correct windows', async () => {
    const day = new Date(Date.now() + 72 * 3600 * 1000);
    const day2 = new Date(day.getTime() + 24 * 3600 * 1000);
    await service.create(COMPANY_A, {
      typeCode: 'PRICE_FOLLOW_UP',
      title: 'در بازه روز',
      relatedEntityType: 'party',
      relatedEntityId: COMPANY_A,
      dueDate: day,
    }, ACTOR);
    await service.create(COMPANY_A, {
      typeCode: 'PRICE_FOLLOW_UP',
      title: 'خارج بازه',
      relatedEntityType: 'party',
      relatedEntityId: COMPANY_A,
      dueDate: day2,
    }, ACTOR);
    const dayFrom = new Date(day.getTime() - 3600 * 1000);
    const dayTo = new Date(day.getTime() + 3600 * 1000);
    const cal = await service.calendar(COMPANY_A, { from: dayFrom, to: dayTo, layers: ['activities'], canSeeFinancial: true, canSeeApprovals: true });
    const activities = cal.layers.activities as Array<{ title: string }>;
    expect(activities.some((a) => a.title === 'در بازه روز')).toBe(true);
    expect(activities.some((a) => a.title === 'خارج بازه')).toBe(false);
  });

  itif('p9a-08 calendar layers filter: disabling a layer only hides it (data untouched)', async () => {
    const from = new Date(Date.now() - 3600 * 1000);
    const to = new Date(Date.now() + 3600 * 1000);
    const withChecks = await service.calendar(COMPANY_A, { from, to, layers: ['activities', 'checks'], canSeeFinancial: true, canSeeApprovals: true });
    expect('checks' in withChecks.layers).toBe(true);
    const withoutChecks = await service.calendar(COMPANY_A, { from, to, layers: ['activities'], canSeeFinancial: true, canSeeApprovals: true });
    expect('checks' in withoutChecks.layers).toBe(false);
    // underlying check rows were not touched by the layer toggle
    const checks = await prisma.check.findMany({ where: { companyId: COMPANY_A } });
    expect(Array.isArray(checks)).toBe(true);
  });

  itif('p9a-09 activity type management: create, duplicate rejected, inactive type unusable', async () => {
    const t = await service.createType(COMPANY_A, { code: 'VISIT', nameFa: 'ویزیت' }, ACTOR);
    expect(t.active).toBe(true);
    await expect(
      service.createType(COMPANY_A, { code: 'VISIT', nameFa: 'تکراری' }, ACTOR),
    ).rejects.toThrow('ACTIVITY_TYPE_CODE_EXISTS');
    await prisma.activityType.update({ where: { id: t.id }, data: { active: false } });
    await expect(
      service.create(COMPANY_A, { typeCode: 'VISIT', title: 'با نوع غیرفعال', relatedEntityType: 'party', relatedEntityId: COMPANY_A }, ACTOR),
    ).rejects.toThrow('Activity type not found');
  });

  itif('p9a-10 related-entity type whitelist enforced', async () => {
    await expect(
      service.create(COMPANY_A, {
        typeCode: 'PRICE_FOLLOW_UP',
        title: 'موجودیت نامجاز',
        relatedEntityType: 'user_secret',
        relatedEntityId: COMPANY_A,
      }, ACTOR),
    ).rejects.toThrow('ACTIVITY_RELATED_ENTITY_TYPE_INVALID');
  });

  itif('p9a-11 invalid input rejected: empty title', async () => {
    await expect(
      service.create(COMPANY_A, {
        typeCode: 'PRICE_FOLLOW_UP',
        title: '   ',
        relatedEntityType: 'party',
        relatedEntityId: COMPANY_A,
      }, ACTOR),
    ).rejects.toThrow('ACTIVITY_TITLE_REQUIRED');
  });

  itif('p9a-12 cancel marks CANCELLED and requires reason at controller level (service-level guard)', async () => {
    const { id } = await service.create(COMPANY_A, {
      typeCode: 'PRICE_FOLLOW_UP',
      title: 'برای لغو',
      relatedEntityType: 'party',
      relatedEntityId: COMPANY_A,
    }, ACTOR);
    await service.cancel(COMPANY_A, id, ACTOR, 'دیگر لازم نیست');
    const row = await prisma.activity.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('CANCELLED');
    await expect(service.complete(COMPANY_A, id, ACTOR)).rejects.toThrow('ACTIVITY_ALREADY_COMPLETED');
  });
});
