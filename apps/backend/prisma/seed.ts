/**
 * Idempotent seed (v2 — company model): permission catalog, system roles,
 * admin user with company membership, chart of accounts, sequences,
 * sample integration config. Run with `npm run db:seed`. Safe to re-run —
 * everything is an upsert and existing counters/roles/users are untouched.
 */
import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { isForbiddenSeedPassword, loadEnvFile } from '../src/config/configuration';

loadEnvFile();

const NODE_ENV = process.env.NODE_ENV ?? 'development';
const DEFAULT_COMPANY_ID = '00000000-0000-4000-8000-000000000001';

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
  // companies (multi-company)
  { code: 'companies.view', module: 'companies', action: 'view', description: 'View companies' },
  { code: 'companies.create', module: 'companies', action: 'create', description: 'Create companies (grants creator membership)' },
  { code: 'companies.edit', module: 'companies', action: 'edit', description: 'Edit companies' },
  { code: 'companies.delete', module: 'companies', action: 'delete', description: 'Delete companies' },
  // claims (operational settlement)
  { code: 'claims.view', module: 'claims', action: 'view', description: 'View settlement claims' },
  { code: 'claims.create', module: 'claims', action: 'create', description: 'Declare settlement claims' },
  { code: 'claims.edit', module: 'claims', action: 'edit', description: 'Match / reject settlement claims' },
  // treasury
  { code: 'treasury.view', module: 'treasury', action: 'view', description: 'View bank accounts, statements and checks' },
  { code: 'treasury.create', module: 'treasury', action: 'create', description: 'Register bank accounts, transfers, receipts, payments and checks' },
  { code: 'treasury.edit', module: 'treasury', action: 'edit', description: 'Clear / pay / bounce checks and edit bank accounts' },
  { code: 'treasury.delete', module: 'treasury', action: 'delete', description: 'Delete bank accounts' },
  // tax
  { code: 'tax.view', module: 'tax', action: 'view', description: 'View tax definitions and allocations' },
  { code: 'tax.create', module: 'tax', action: 'create', description: 'Create tax definitions' },
  { code: 'tax.edit', module: 'tax', action: 'edit', description: 'Edit tax definitions / create allocations' },
  // supplier product mapping
  { code: 'supplierproduct.view', module: 'supplierproduct', action: 'view', description: 'View supplier product mappings' },
  { code: 'supplierproduct.create', module: 'supplierproduct', action: 'create', description: 'Create supplier product mappings' },
  { code: 'supplierproduct.edit', module: 'supplierproduct', action: 'edit', description: 'Edit supplier product mappings' },
  { code: 'supplierproduct.delete', module: 'supplierproduct', action: 'delete', description: 'Delete supplier product mappings' },
  // loading
  { code: 'loading.view', module: 'loading', action: 'view', description: 'View loadings' },
  { code: 'loading.create', module: 'loading', action: 'create', description: 'Register loadings' },
  // workflow timers
  { code: 'workflowtimer.view', module: 'workflowtimer', action: 'view', description: 'View workflow timers' },
  { code: 'workflowtimer.edit', module: 'workflowtimer', action: 'edit', description: 'Schedule / cancel workflow timers' },
  // notifications
  { code: 'notifications.view', module: 'notifications', action: 'view', description: 'View notifications and rules' },
  { code: 'notifications.edit', module: 'notifications', action: 'edit', description: 'Edit notification rules' },
  // integrations
  { code: 'integrations.view', module: 'integrations', action: 'view', description: 'View integration configs' },
  { code: 'integrations.create', module: 'integrations', action: 'create', description: 'Create integration configs' },
  { code: 'integrations.edit', module: 'integrations', action: 'edit', description: 'Edit integration configs' },
  { code: 'integrations.delete', module: 'integrations', action: 'delete', description: 'Delete integration configs' },
  // portal accounts (Mini-Gate: customer website links)
  { code: 'portalaccounts.view', module: 'portalaccounts', action: 'view', description: 'View portal accounts' },
  { code: 'portalaccounts.create', module: 'portalaccounts', action: 'create', description: 'Create / remove portal accounts' },
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
    permissions: ['files.view', 'files.upload', 'files.download', 'queue.view', 'claims.view', 'claims.create', 'loading.view'],
  },
  {
    code: 'sales_manager',
    nameFa: 'مدیر فروش',
    nameEn: 'Sales Manager',
    permissions: ['teams.view', 'files.view', 'files.upload', 'files.download', 'queue.view', 'audit.view', 'claims.view', 'claims.create', 'claims.edit', 'loading.view', 'loading.create'],
  },
  {
    code: 'buyer',
    nameFa: 'کارمند خرید',
    nameEn: 'Buyer',
    permissions: ['files.view', 'files.upload', 'files.download', 'queue.view', 'claims.view', 'claims.create', 'loading.view'],
  },
  {
    code: 'purchase_manager',
    nameFa: 'مدیر خرید',
    nameEn: 'Purchase Manager',
    permissions: ['teams.view', 'files.view', 'files.upload', 'files.download', 'queue.view', 'audit.view', 'claims.view', 'claims.create', 'claims.edit', 'loading.view', 'loading.create'],
  },
  {
    code: 'accountant',
    nameFa: 'حسابدار',
    nameEn: 'Accountant',
    permissions: ['files.view', 'files.download', 'queue.view', 'treasury.view', 'treasury.create', 'treasury.edit', 'claims.view', 'claims.edit', 'tax.view', 'tax.create', 'tax.edit'],
  },
  {
    code: 'financial_manager',
    nameFa: 'مدیر مالی',
    nameEn: 'Financial Manager',
    permissions: ['settings.view', 'files.view', 'files.download', 'queue.view', 'audit.view', 'treasury.view', 'treasury.create', 'treasury.edit', 'tax.view', 'notifications.view', 'notifications.edit'],
  },
  {
    code: 'pricing_user',
    nameFa: 'کارمند قیمت‌گذاری',
    nameEn: 'Pricing User',
    permissions: ['files.view', 'files.download', 'queue.view'],
  },
];

const SEQUENCE_DEFS = [
  { documentType: 'SALES_DOCUMENT', name: 'Sales document', prefix: 'SD' },
  { documentType: 'PURCHASE', name: 'Purchase', prefix: 'PO' },
  { documentType: 'SALES_TAX_INVOICE', name: 'Sales tax invoice', prefix: 'STI' },
  { documentType: 'PURCHASE_TAX_INVOICE', name: 'Purchase tax invoice', prefix: 'PTI' },
  { documentType: 'RECEIPT', name: 'Receipt', prefix: 'REC' },
  { documentType: 'PAYMENT', name: 'Payment', prefix: 'PAY' },
  { documentType: 'JOURNAL_ENTRY', name: 'Journal entry', prefix: 'JE' },
  { documentType: 'CHECK', name: 'Check', prefix: 'CHK' },
  { documentType: 'BANK_TRANSFER', name: 'Bank transfer', prefix: 'BT' },
];

const CHART_OF_ACCOUNTS = [
  { code: 'BANK', name: 'بانک', type: 'ASSET' as const },
  { code: 'RECEIVABLE', name: 'حساب‌های دریافتنی', type: 'ASSET' as const },
  { code: 'CHECKS_IN_TRANSIT', name: 'چک‌های در جریان وصول', type: 'ASSET' as const },
  { code: 'PAYABLE', name: 'حساب‌های پرداختنی', type: 'LIABILITY' as const },
  { code: 'VAT_PAYABLE', name: 'مالیات بر ارزش افزوده پرداختنی', type: 'LIABILITY' as const },
  { code: 'SALES_REVENUE', name: 'درآمد فروش', type: 'INCOME' as const },
  { code: 'BANK_FEE_EXPENSE', name: 'کارمزد بانکی', type: 'EXPENSE' as const },
  { code: 'PURCHASE_EXPENSE', name: 'هزینه خرید', type: 'EXPENSE' as const },
];

async function seedCompany(): Promise<string> {
  const name = process.env.SEED_COMPANY_NAME ?? 'شرکت پیش‌فرض';
  const company = await prisma.company.upsert({
    where: { id: DEFAULT_COMPANY_ID },
    create: { id: DEFAULT_COMPANY_ID, nameFa: name },
    update: { nameFa: name },
  });
  return company.id;
}

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

async function seedAdmin(roleIds: Map<string, string>, companyId: string): Promise<void> {
  const username = process.env.SEED_ADMIN_USERNAME ?? 'admin';
  let password = process.env.SEED_ADMIN_PASSWORD;

  if (!password) {
    if (NODE_ENV === 'production') {
      throw new Error('SEED_ADMIN_PASSWORD is required in production (no default is provided)');
    }
    // Dev convenience: generate a random password ONCE and print it.
    password = randomBytes(12).toString('base64url') + '!Aa1';
    console.log(`\n  Generated SEED_ADMIN_PASSWORD for dev: ${password}\n`);
  }
  if (isForbiddenSeedPassword(password) && NODE_ENV === 'production') {
    throw new Error('SEED_ADMIN_PASSWORD must not be a well-known default in production');
  }

  const adminRoleId = roleIds.get('admin');
  if (!adminRoleId) throw new Error('admin role missing after role seed');

  const existing = await prisma.user.findUnique({
    where: { username },
    select: { id: true },
  });
  if (existing) {
    // Do not reset an existing admin's password on re-seed; just make sure the
    // company membership, company-scoped role and default company exist.
    await prisma.userCompany.upsert({
      where: { userId_companyId: { userId: existing.id, companyId } },
      create: { userId: existing.id, companyId },
      update: {},
    });
    // Mini-Gate: roles live in user_company_roles (per company).
    await prisma.userCompanyRole.upsert({
      where: {
        userId_companyId_roleId: { userId: existing.id, companyId, roleId: adminRoleId },
      },
      create: { userId: existing.id, companyId, roleId: adminRoleId, assignedBy: null },
      update: {},
    });
    const user = await prisma.user.findUnique({
      where: { id: existing.id },
      select: { defaultCompanyId: true },
    });
    if (user && !user.defaultCompanyId) {
      await prisma.user.update({
        where: { id: existing.id },
        data: { defaultCompanyId: companyId },
      });
    }
    return;
  }

  const passwordHash = await bcrypt.hash(password, 10);
  await prisma.user.create({
    data: {
      username,
      passwordHash,
      mustChangePassword: true,
      defaultCompanyId: companyId,
      // Mini-Gate: admin's role is a company-scoped assignment; the membership
      // and role live in user_companies / user_company_roles respectively.
      companies: { create: [{ companyId }] },
      companyRoles: { create: [{ roleId: adminRoleId, companyId, assignedBy: null }] },
    },
  });
}

async function seedChartOfAccounts(companyId: string): Promise<void> {
  for (const account of CHART_OF_ACCOUNTS) {
    await prisma.chartOfAccount.upsert({
      where: { companyId_code: { companyId, code: account.code } },
      create: { companyId, ...account },
      update: { name: account.name, type: account.type },
    });
  }
}

async function seedSequences(companyId: string): Promise<void> {
  for (const def of SEQUENCE_DEFS) {
    await prisma.sequence.upsert({
      where: { companyId_documentType: { companyId, documentType: def.documentType } },
      create: {
        companyId,
        documentType: def.documentType,
        name: def.name,
        prefix: def.prefix,
        padding: 5,
        resetCycle: 'JALALI_YEAR',
      },
      // Never touch currentNumber/lastResetMarker on re-seed (history rule).
      update: { name: def.name, prefix: def.prefix, padding: 5 },
    });
  }
}

async function seedIntegrationConfig(companyId: string): Promise<void> {
  await prisma.integrationConfig.upsert({
    where: { companyId_code: { companyId, code: 'sample-sms' } },
    create: {
      companyId,
      code: 'sample-sms',
      name: 'SMS (نمونه، غیرفعال)',
      type: 'SMS',
      isActive: false,
      config: { provider: 'example', from: 'TCERP' },
    },
    update: {},
  });
}

async function main(): Promise<void> {
  console.log('Seeding company…');
  const companyId = await seedCompany();
  console.log(`  company ${companyId}`);

  console.log('Seeding permissions…');
  const permissionIds = await seedPermissions();
  console.log(`  ${permissionIds.size} permissions`);

  console.log('Seeding system roles…');
  const roleIds = await seedRoles(permissionIds);
  console.log(`  ${roleIds.size} roles`);

  console.log('Seeding admin user…');
  await seedAdmin(roleIds, companyId);
  console.log(`  admin="${process.env.SEED_ADMIN_USERNAME ?? 'admin'}"`);

  console.log('Seeding chart of accounts…');
  await seedChartOfAccounts(companyId);
  console.log(`  ${CHART_OF_ACCOUNTS.length} accounts`);

  console.log('Seeding sequences…');
  await seedSequences(companyId);
  console.log(`  ${SEQUENCE_DEFS.length} sequences`);

  console.log('Seeding sample integration config…');
  await seedIntegrationConfig(companyId);
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
