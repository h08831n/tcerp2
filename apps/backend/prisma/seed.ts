/**
 * Idempotent seed: permission catalog, system roles, admin user, sequences.
 * Run with `npm run db:seed`. Safe to re-run — everything is an upsert and
 * existing counters/roles/users are left untouched.
 */
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { loadEnvFile } from '../src/config/configuration';

loadEnvFile();

const prisma = new PrismaClient();

interface PermissionSeed {
  code: string;
  module: string;
  action: string;
  description: string;
}

const PERMISSIONS: PermissionSeed[] = [
  // users
  { code: 'users.view', module: 'users', action: 'view', description: 'View user list and details' },
  { code: 'users.create', module: 'users', action: 'create', description: 'Create users' },
  { code: 'users.edit', module: 'users', action: 'edit', description: 'Edit users and assign roles' },
  { code: 'users.delete', module: 'users', action: 'delete', description: 'Disable users (soft delete)' },
  { code: 'users.reset_password', module: 'users', action: 'reset_password', description: "Reset other users' passwords" },
  // roles
  { code: 'roles.view', module: 'roles', action: 'view', description: 'View roles and the permission catalog' },
  { code: 'roles.create', module: 'roles', action: 'create', description: 'Create roles' },
  { code: 'roles.edit', module: 'roles', action: 'edit', description: 'Edit roles and their permissions' },
  { code: 'roles.delete', module: 'roles', action: 'delete', description: 'Delete non-system roles' },
  // teams
  { code: 'teams.view', module: 'teams', action: 'view', description: 'View teams and members' },
  { code: 'teams.create', module: 'teams', action: 'create', description: 'Create teams' },
  { code: 'teams.edit', module: 'teams', action: 'edit', description: 'Edit teams and membership' },
  { code: 'teams.delete', module: 'teams', action: 'delete', description: 'Delete teams' },
  // settings
  { code: 'settings.view', module: 'settings', action: 'view', description: 'View settings' },
  { code: 'settings.edit', module: 'settings', action: 'edit', description: 'Change settings (audited)' },
  // sequences
  { code: 'sequences.view', module: 'sequences', action: 'view', description: 'View sequence configurations' },
  { code: 'sequences.edit', module: 'sequences', action: 'edit', description: 'Change sequence config (prospective only)' },
  // audit
  { code: 'audit.view', module: 'audit', action: 'view', description: 'View the audit trail' },
  // files
  { code: 'files.view', module: 'files', action: 'view', description: 'View file metadata and attachments' },
  { code: 'files.upload', module: 'files', action: 'upload', description: 'Upload files and create attachments' },
  { code: 'files.download', module: 'files', action: 'download', description: 'Download files' },
  { code: 'files.delete', module: 'files', action: 'delete', description: 'Remove attachments' },
  // queue
  { code: 'queue.view', module: 'queue', action: 'view', description: 'View queue jobs (incl. error center)' },
  { code: 'queue.retry', module: 'queue', action: 'retry', description: 'Retry / cancel failed queue jobs' },
  { code: 'queue.enqueue', module: 'queue', action: 'enqueue', description: 'Manually enqueue a queue job' },
];

const ROLE_DEFS: {
  code: string;
  nameFa: string;
  nameEn: string;
  permissions: string[] | 'ALL';
}[] = [
  { code: 'admin', nameFa: 'مدیر سیستم', nameEn: 'Administrator', permissions: 'ALL' },
  {
    code: 'salesperson',
    nameFa: 'کارمند فروش',
    nameEn: 'Salesperson',
    permissions: ['files.view', 'files.upload', 'files.download', 'queue.view'],
  },
  {
    code: 'sales_manager',
    nameFa: 'مدیر فروش',
    nameEn: 'Sales Manager',
    permissions: ['teams.view', 'files.view', 'files.upload', 'files.download', 'queue.view', 'audit.view'],
  },
  {
    code: 'buyer',
    nameFa: 'کارمند خرید',
    nameEn: 'Buyer',
    permissions: ['files.view', 'files.upload', 'files.download', 'queue.view'],
  },
  {
    code: 'purchase_manager',
    nameFa: 'مدیر خرید',
    nameEn: 'Purchase Manager',
    permissions: ['teams.view', 'files.view', 'files.upload', 'files.download', 'queue.view', 'audit.view'],
  },
  {
    code: 'accountant',
    nameFa: 'حسابدار',
    nameEn: 'Accountant',
    permissions: ['files.view', 'files.download', 'queue.view'],
  },
  {
    code: 'financial_manager',
    nameFa: 'مدیر مالی',
    nameEn: 'Financial Manager',
    permissions: ['settings.view', 'files.view', 'files.download', 'queue.view', 'audit.view'],
  },
  {
    code: 'pricing_user',
    nameFa: 'کارمند قیمت‌گذاری',
    nameEn: 'Pricing User',
    permissions: ['files.view', 'files.download', 'queue.view'],
  },
];

const SEQUENCE_DEFS = [
  { code: 'SALES_DOCUMENT', name: 'Sales document', prefix: 'SD', padding: 5, includeJalaliYear: true, resetYearly: true },
  { code: 'PURCHASE', name: 'Purchase', prefix: 'PO', padding: 5, includeJalaliYear: true, resetYearly: true },
  { code: 'SALES_TAX_INVOICE', name: 'Sales tax invoice', prefix: 'STI', padding: 5, includeJalaliYear: true, resetYearly: true },
  { code: 'PURCHASE_TAX_INVOICE', name: 'Purchase tax invoice', prefix: 'PTI', padding: 5, includeJalaliYear: true, resetYearly: true },
  { code: 'RECEIPT', name: 'Receipt', prefix: 'REC', padding: 5, includeJalaliYear: true, resetYearly: true },
  { code: 'PAYMENT', name: 'Payment', prefix: 'PAY', padding: 5, includeJalaliYear: true, resetYearly: true },
  { code: 'JOURNAL_ENTRY', name: 'Journal entry', prefix: 'JE', padding: 5, includeJalaliYear: true, resetYearly: true },
  { code: 'CHECK', name: 'Check', prefix: 'CHK', padding: 5, includeJalaliYear: true, resetYearly: true },
];

async function seedPermissions(): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const permission of PERMISSIONS) {
    const row = await prisma.permission.upsert({
      where: { code: permission.code },
      create: permission,
      update: { module: permission.module, action: permission.action, description: permission.description },
    });
    ids.set(permission.code, row.id);
  }
  return ids;
}

async function seedRoles(permissionIds: Map<string, string>): Promise<Map<string, string>> {
  const roleIds = new Map<string, string>();
  for (const def of ROLE_DEFS) {
    const role = await prisma.role.upsert({
      where: { code: def.code },
      create: { code: def.code, nameFa: def.nameFa, nameEn: def.nameEn, isSystem: true },
      update: { nameFa: def.nameFa, nameEn: def.nameEn, isSystem: true },
    });
    roleIds.set(def.code, role.id);

    const codes = def.permissions === 'ALL' ? [...permissionIds.keys()] : def.permissions;
    const links = codes
      .map((code) => permissionIds.get(code))
      .filter((id): id is string => !!id)
      .map((permissionId) => ({ roleId: role.id, permissionId }));

    // Idempotent: add missing links, never remove existing ones here
    // (an admin may have customized system roles).
    await prisma.rolePermission.createMany({ data: links, skipDuplicates: true });
  }
  return roleIds;
}

async function seedAdmin(roleIds: Map<string, string>): Promise<void> {
  const username = process.env.ADMIN_USERNAME ?? 'admin';
  const password = process.env.ADMIN_PASSWORD ?? 'Admin@12345';
  const adminRoleId = roleIds.get('admin');
  if (!adminRoleId) throw new Error('admin role missing after role seed');

  const existing = await prisma.user.findUnique({ where: { username }, select: { id: true } });
  if (existing) {
    // Do not reset an existing admin's password on re-seed.
    await prisma.userRole.upsert({
      where: { userId_roleId: { userId: existing.id, roleId: adminRoleId } },
      create: { userId: existing.id, roleId: adminRoleId },
      update: {},
    });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 10);
  await prisma.user.create({
    data: {
      username,
      passwordHash,
      mustChangePassword: true,
      roles: { create: [{ roleId: adminRoleId }] },
    },
  });
}

async function seedSequences(): Promise<void> {
  for (const def of SEQUENCE_DEFS) {
    await prisma.sequence.upsert({
      where: { code: def.code },
      create: { ...def },
      // Never touch currentNumber/lastResetYear on re-seed (history rule).
      update: { name: def.name, prefix: def.prefix, padding: def.padding, includeJalaliYear: def.includeJalaliYear, resetYearly: def.resetYearly },
    });
  }
}

async function main(): Promise<void> {
  console.log('Seeding permissions…');
  const permissionIds = await seedPermissions();
  console.log(`  ${permissionIds.size} permissions`);

  console.log('Seeding system roles…');
  const roleIds = await seedRoles(permissionIds);
  console.log(`  ${roleIds.size} roles`);

  console.log('Seeding admin user…');
  await seedAdmin(roleIds);
  console.log(`  admin="${process.env.ADMIN_USERNAME ?? 'admin'}"`);

  console.log('Seeding sequences…');
  await seedSequences();
  console.log(`  ${SEQUENCE_DEFS.length} sequences`);
}

main()
  .then(() => {
    console.log('Seed completed.');
  })
  .catch((error) => {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
