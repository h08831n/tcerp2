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
  { code: 'accounting.posting.manage', module: 'accounting', action: 'manage', description: 'Manage posting rules and retry accounting events' },
  { code: 'accounting.fiscal.manage', module: 'accounting', action: 'manage', description: 'Manage fiscal years and periods' },
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
  { code: 'accounting.fiscal.manage', module: 'accounting', action: 'manage', description: 'Manage fiscal years and periods' },
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
  // loading (Phase 6: full lifecycle + driver-info release + list scope)
  { code: 'loading.view', module: 'loading', action: 'view', description: 'View loadings' },
  { code: 'loading.create', module: 'loading', action: 'create', description: 'Register loadings' },
  { code: 'loading.edit', module: 'loading', action: 'edit', description: 'Edit DRAFT loadings' },
  { code: 'loading.confirm', module: 'loading', action: 'confirm', description: 'Confirm loadings (generates OUT stock movements + operational amounts)' },
  { code: 'loading.cancel', module: 'loading', action: 'cancel', description: 'Cancel / delete DRAFT loadings' },
  { code: 'loading.driver_info.release', module: 'loading', action: 'driver_info.release', description: 'Release restricted driver/carrier info (manager approval)' },
  { code: 'loading.reverse', module: 'loading', action: 'reverse', description: 'Reverse CONFIRMED loadings (compensating stock movements, required reason)' },
  // goods receipts (Phase 6 Integrity Gate #9: real partial receipts drive stock)
  { code: 'goods_receipt.view', module: 'goods_receipt', action: 'view', description: 'View goods receipts (GRN)' },
  { code: 'goods_receipt.create', module: 'goods_receipt', action: 'create', description: 'Register goods receipts (DRAFT)' },
  { code: 'goods_receipt.edit', module: 'goods_receipt', action: 'edit', description: 'Edit / cancel DRAFT goods receipts' },
  { code: 'goods_receipt.confirm', module: 'goods_receipt', action: 'confirm', description: 'Confirm goods receipts (IN stock movements + purchase amounts)' },
  { code: 'goods_receipt.reverse', module: 'goods_receipt', action: 'reverse', description: 'Reverse CONFIRMED goods receipts (compensating movements, required reason)' },
  { code: 'loading.view_all', module: 'loading', action: 'view_all', description: 'View all loadings regardless of creator (list scope ALL)' },
  // inventory (Phase 6)
  { code: 'inventory.view', module: 'inventory', action: 'view', description: 'View computed stock, stock movements and warehouses' },
  { code: 'inventory.warehouses.manage', module: 'inventory', action: 'warehouses.manage', description: 'Manage warehouses (at most one default per company)' },
  // approvals (Phase 6 lean approval engine — loading debt gate)
  { code: 'approvals.decide', module: 'approvals', action: 'decide', description: 'Decide approval requests (approve / reject)' },
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
  // parties / CRM core (Phase 3A). Record scope: parties.scope.all → ALL,
  // parties.scope.team → TEAM, neither → OWN (own records only).
  { code: 'parties.view', module: 'parties', action: 'view', description: 'View parties (within record scope)' },
  { code: 'parties.create', module: 'parties', action: 'create', description: 'Create parties' },
  { code: 'parties.edit', module: 'parties', action: 'edit', description: 'Edit parties (within record scope)' },
  { code: 'parties.delete', module: 'parties', action: 'delete', description: 'Delete parties' },
  { code: 'parties.archive', module: 'parties', action: 'archive', description: 'Archive / restore parties' },
  { code: 'parties.phone.manage', module: 'parties', action: 'phone.manage', description: 'Add / remove party phones' },
  { code: 'parties.contact.manage', module: 'parties', action: 'contact.manage', description: 'Manage party contacts' },
  { code: 'parties.address.manage', module: 'parties', action: 'address.manage', description: 'Manage party addresses' },
  { code: 'parties.role.manage', module: 'parties', action: 'role.manage', description: 'Grant / remove party roles' },
  { code: 'parties.owner.change', module: 'parties', action: 'owner.change', description: 'Reassign party owner' },
  { code: 'parties.score.compute', module: 'parties', action: 'score.compute', description: 'Recompute customer scores' },
  { code: 'parties.scope.team', module: 'parties', action: 'scope.team', description: 'Record scope: see parties owned by the whole team' },
  { code: 'parties.scope.all', module: 'parties', action: 'scope.all', description: 'Record scope: see all parties' },
  { code: 'financialresponsibility.manage', module: 'financialresponsibility', action: 'manage', description: 'Manage financial responsibility groups' },
  { code: 'timeline.view', module: 'timeline', action: 'view', description: 'View party timeline (incl. hidden events with audit rights)' },
  // product catalog (Phase 3B)
  { code: 'products.view', module: 'products', action: 'view', description: 'View product catalog (categories, brands, UOMs, attributes, templates, variants)' },
  { code: 'products.create', module: 'products', action: 'create', description: 'Create categories, brands and product templates' },
  { code: 'products.edit', module: 'products', action: 'edit', description: 'Edit categories, brands and product templates' },
  { code: 'products.archive', module: 'products', action: 'archive', description: 'Archive product catalog entries' },
  { code: 'products.attributes.manage', module: 'products', action: 'attributes.manage', description: 'Manage product attributes and values' },
  { code: 'products.variants.manage', module: 'products', action: 'variants.manage', description: 'Manage template attributes and generate variants' },
  { code: 'products.uom.manage', module: 'products', action: 'uom.manage', description: 'Manage UOM categories and units' },
  { code: 'products.supplier_mapping.manage', module: 'products', action: 'supplier_mapping.manage', description: 'Manage supplier ↔ product mappings' },
  // sales (Phase 4). Record scope: sales.scope.all / sales.scope.team /
  // neither → OWN, keyed on the document's salesperson. sales.view_all also
  // implies ALL visibility (read-everything without the scope grant).
  { code: 'sales.view', module: 'sales', action: 'view', description: 'View sales documents (within record scope)' },
  { code: 'sales.create', module: 'sales', action: 'create', description: 'Create sales documents' },
  { code: 'sales.edit', module: 'sales', action: 'edit', description: 'Edit sales documents and lines (within record scope)' },
  { code: 'sales.confirm', module: 'sales', action: 'confirm', description: 'Confirm quotations / activate sales orders' },
  { code: 'sales.cancel', module: 'sales', action: 'cancel', description: 'Cancel sales documents' },
  { code: 'sales.override_confirmed_order', module: 'sales', action: 'override_confirmed_order', description: 'Override locked fields of a confirmed order (reason REQUIRED, audited)' },
  { code: 'sales.view_all', module: 'sales', action: 'view_all', description: 'View all sales documents regardless of record scope' },
  { code: 'sales.export', module: 'sales', action: 'export', description: 'Export sales documents' },
  { code: 'sales.scope.team', module: 'sales', action: 'scope.team', description: 'Record scope: see documents of the whole team' },
  { code: 'sales.scope.all', module: 'sales', action: 'scope.all', description: 'Record scope: see all sales documents' },
  // purchase (Phase 4) — company-wide for buyers, no record scope
  { code: 'purchase.view', module: 'purchase', action: 'view', description: 'View purchase documents' },
  { code: 'purchase.create', module: 'purchase', action: 'create', description: 'Create purchase documents' },
  { code: 'purchase.edit', module: 'purchase', action: 'edit', description: 'Edit purchase documents, lines and transitions' },
  { code: 'purchase.cancel', module: 'purchase', action: 'cancel', description: 'Cancel purchase documents' },
  // price requests + supplier offers (Phase 4)
  { code: 'price_request.view', module: 'price_request', action: 'view', description: 'View price requests, worklist and daily-lowest reports' },
  { code: 'price_request.create', module: 'price_request', action: 'create', description: 'Create/edit price requests and convert/close them' },
  { code: 'price_request.manage_offers', module: 'price_request', action: 'manage_offers', description: 'Add/update/delete supplier offers' },
  // sales ↔ purchase allocations (Phase 4)
  { code: 'allocations.manage', module: 'allocations', action: 'manage', description: 'Manage sales ↔ purchase line allocations' },
  // CRM funnel (Phase 4): leads, opportunities, lost reasons
  { code: 'crm.view', module: 'crm', action: 'view', description: 'View leads, opportunities, lost reasons and payment terms' },
  { code: 'crm.manage', module: 'crm', action: 'manage', description: 'Manage leads, opportunities and lost reasons' },
  // payment terms (Phase 4)
  { code: 'paymentterm.manage', module: 'paymentterm', action: 'manage', description: 'Manage payment terms' },
  // daily pricing engine (Phase 5, REQUIREMENTS §17)
  { code: 'pricing.view', module: 'pricing', action: 'view', description: 'View daily prices, price grid/history and cheapest-supplier reports' },
  { code: 'pricing.create', module: 'pricing', action: 'create', description: 'Enter today\'s daily prices (upsert)' },
  { code: 'pricing.edit', module: 'pricing', action: 'edit', description: 'Bulk daily-price update (percent/fixed)' },
  { code: 'pricing.edit_history', module: 'pricing', action: 'edit_history', description: 'Edit PAST daily prices (audited; history is immutable without it)' },
  { code: 'pricing.publish', module: 'pricing', action: 'publish', description: 'Create price publish batches' },
  // publishing engine (Phase 5, REQUIREMENTS §18, §72-73)
  { code: 'publishing.view', module: 'publishing', action: 'view', description: 'View publish batches/items (incl. failure details) and templates' },
  { code: 'publishing.retry', module: 'publishing', action: 'retry', description: 'Retry failed publish items' },
  { code: 'publishing.cancel', module: 'publishing', action: 'cancel', description: 'Cancel pending/failed publish items' },
  { code: 'publishing.templates.manage', module: 'publishing', action: 'templates.manage', description: 'Manage per-channel publishing templates' },
  // automation engine (Phase 5, REQUIREMENTS §52 lean subset)
  { code: 'automation.view', module: 'automation', action: 'view', description: 'View automation rules and their runs' },
  { code: 'automation.manage', module: 'automation', action: 'manage', description: 'Create/edit/enable automation rules and trigger manual runs' },
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
    // Record scope: OWN implied (no parties.scope.* / sales.scope.* held).
    permissions: [
      'files.view', 'files.upload', 'files.download', 'queue.view',
      'claims.view', 'claims.create', 'loading.view', 'loading.create', 'loading.edit',
      'parties.view', 'parties.create', 'parties.edit',
      'parties.phone.manage', 'parties.contact.manage', 'timeline.view',
      'products.view',
      'crm.view', 'crm.manage',
      'sales.view', 'sales.create', 'sales.edit',
      'price_request.view', 'price_request.create',
      'pricing.view',
    ],
  },
  {
    code: 'sales_manager',
    nameFa: 'مدیر فروش',
    nameEn: 'Sales Manager',
    // Record scope: TEAM via sales.scope.team.
    permissions: [
      'teams.view', 'files.view', 'files.upload', 'files.download', 'queue.view', 'audit.view',
      'claims.view', 'claims.create', 'claims.edit',
      // Phase 6: managers confirm loadings, release restricted driver info and
      // decide approval requests (debt gate); loading.view_all → list scope ALL.
      'loading.view', 'loading.create', 'loading.edit', 'loading.confirm', 'loading.cancel',
      'loading.reverse',
      'loading.driver_info.release', 'loading.view_all', 'approvals.decide',
      'inventory.view',
      'parties.view', 'parties.create', 'parties.edit',
      'parties.phone.manage', 'parties.contact.manage', 'timeline.view',
      'parties.archive', 'parties.owner.change', 'parties.score.compute', 'parties.scope.team',
      'crm.view', 'crm.manage',
      'sales.view', 'sales.create', 'sales.edit', 'sales.confirm', 'sales.cancel',
      'sales.override_confirmed_order', 'sales.scope.team', 'sales.export',
      'price_request.view', 'price_request.create', 'price_request.manage_offers',
      'allocations.manage', 'paymentterm.manage',
    ],
  },
  {
    code: 'buyer',
    nameFa: 'کارمند خرید',
    nameEn: 'Buyer',
    permissions: ['files.view', 'files.upload', 'files.download', 'queue.view', 'claims.view', 'claims.create', 'loading.view', 'loading.create', 'products.view',
      'purchase.view', 'purchase.create', 'purchase.edit',
      'goods_receipt.view', 'goods_receipt.create', 'goods_receipt.edit',
      'price_request.view', 'price_request.create'],
  },
  {
    code: 'purchase_manager',
    nameFa: 'مدیر خرید',
    nameEn: 'Purchase Manager',
    permissions: ['teams.view', 'files.view', 'files.upload', 'files.download', 'queue.view', 'audit.view', 'claims.view', 'claims.create', 'claims.edit',
      'loading.view', 'loading.create', 'loading.reverse',
      'purchase.view', 'purchase.create', 'purchase.edit', 'purchase.cancel',
      'goods_receipt.view', 'goods_receipt.create', 'goods_receipt.edit', 'goods_receipt.confirm', 'goods_receipt.reverse',
      'inventory.view',
      'price_request.view', 'price_request.create', 'price_request.manage_offers',
      'allocations.manage'],
  },
  {
    code: 'accountant',
    nameFa: 'حسابدار',
    nameEn: 'Accountant',
    permissions: ['files.view', 'files.download', 'queue.view', 'treasury.view', 'treasury.create', 'treasury.edit', 'claims.view', 'claims.edit', 'tax.view', 'tax.create', 'tax.edit',
      'sales.view', 'purchase.view'],
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
    // Phase 5: full pricing stack — daily prices (incl. audited history edits
    // and bulk update), publishing (batches/items/templates) and read-only
    // automation visibility.
    permissions: ['files.view', 'files.download', 'queue.view',
      'price_request.view', 'price_request.create', 'price_request.manage_offers',
      'pricing.view', 'pricing.create', 'pricing.edit', 'pricing.edit_history', 'pricing.publish',
      'publishing.view', 'publishing.retry', 'publishing.cancel', 'publishing.templates.manage',
      'automation.view'],
  },
];

const SEQUENCE_DEFS = [
  { documentType: 'SALES_DOCUMENT', name: 'Sales document', prefix: 'SD' },
  { documentType: 'PURCHASE', name: 'Purchase', prefix: 'PO' },
  { documentType: 'PRICE_REQUEST', name: 'Price request', prefix: 'PRQ' },
  { documentType: 'SALES_TAX_INVOICE', name: 'Sales tax invoice', prefix: 'STI' },
  { documentType: 'PURCHASE_TAX_INVOICE', name: 'Purchase tax invoice', prefix: 'PTI' },
  { documentType: 'RECEIPT', name: 'Receipt', prefix: 'REC' },
  { documentType: 'PAYMENT', name: 'Payment', prefix: 'PAY' },
  { documentType: 'JOURNAL_ENTRY', name: 'Journal entry', prefix: 'JE' },
  { documentType: 'CHECK', name: 'Check', prefix: 'CHK' },
  { documentType: 'BANK_TRANSFER', name: 'Bank transfer', prefix: 'BT' },
  // Phase 5
  { documentType: 'PUBLISH_BATCH', name: 'Publish batch', prefix: 'PB' },
  // Phase 6 Integrity Gate #9
  { documentType: 'GOODS_RECEIPT', name: 'Goods receipt', prefix: 'GRN' },
];

const CHART_OF_ACCOUNTS = [
  { code: 'BANK', name: 'بانک', type: 'ASSET' as const },
  { code: 'RECEIVABLE', name: 'حساب‌های دریافتنی', type: 'ASSET' as const },
  { code: 'CHECKS_IN_TRANSIT', name: 'چک‌های در جریان وصول', type: 'ASSET' as const },
  { code: 'PAYABLE', name: 'حساب‌های پرداختنی', type: 'LIABILITY' as const },
  { code: 'VAT_PAYABLE', name: 'مالیات بر ارزش افزوده پرداختنی', type: 'LIABILITY' as const },
  { code: 'SALES_REVENUE', name: 'درآمد فروش', type: 'REVENUE' as const },
  { code: 'BANK_FEE_EXPENSE', name: 'کارمزد بانکی', type: 'EXPENSE' as const },
  { code: 'PURCHASE_EXPENSE', name: 'هزینه خرید', type: 'EXPENSE' as const },
];

/**
 * Reference UOM categories (3B correction #3/#4): the category CODE is the
 * canonical contract — a product's weight UOM must sit in the company's
 * `WEIGHT` category. Bases (kg / m / pcs, ratio exactly 1) unblock
 * conversions per category. Idempotent: upsert on (companyId, code) /
 * (companyId, symbol); existing rows are never modified on re-seed.
 */
const UOM_CATEGORY_SEEDS = [
  {
    code: 'WEIGHT',
    nameFa: 'وزن',
    nameEn: 'Weight',
    uoms: [
      { symbol: 'kg', nameFa: 'کیلوگرم', conversionRatio: '1', isBaseUnit: true },
      { symbol: 'g', nameFa: 'گرم', conversionRatio: '0.001', isBaseUnit: false },
      { symbol: 'ton', nameFa: 'تن', conversionRatio: '1000', isBaseUnit: false },
    ],
  },
  {
    code: 'LENGTH',
    nameFa: 'طول',
    nameEn: 'Length',
    uoms: [
      { symbol: 'm', nameFa: 'متر', conversionRatio: '1', isBaseUnit: true },
      { symbol: 'cm', nameFa: 'سانتی‌متر', conversionRatio: '0.01', isBaseUnit: false },
    ],
  },
  {
    code: 'UNIT',
    nameFa: 'شمارش',
    nameEn: 'Count',
    uoms: [
      { symbol: 'pcs', nameFa: 'عدد', conversionRatio: '1', isBaseUnit: true },
      { symbol: 'dozen', nameFa: 'دوجین', conversionRatio: '12', isBaseUnit: false },
    ],
  },
];

async function seedUomCategories(companyId: string): Promise<void> {
  for (const category of UOM_CATEGORY_SEEDS) {
    const row = await prisma.uomCategory.upsert({
      where: { companyId_code: { companyId, code: category.code } },
      create: {
        companyId,
        code: category.code,
        nameFa: category.nameFa,
        nameEn: category.nameEn,
      },
      update: {},
    });
    for (const uom of category.uoms) {
      await prisma.uom.upsert({
        where: { companyId_symbol: { companyId, symbol: uom.symbol } },
        create: { companyId, categoryId: row.id, ...uom },
        update: {},
      });
    }
  }
}

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

/**
 * Phase 6: one DEFAULT warehouse per company (REQUIREMENTS §21, domain
 * boundaries §6 — `Warehouse` is first-class from Phase 6, nullable warehouse
 * references mean "the company default"). Idempotent: upsert on
 * (companyId, code); an existing MAIN warehouse is never modified.
 */
async function seedDefaultWarehouse(companyId: string): Promise<void> {
  await prisma.warehouse.upsert({
    where: { companyId_code: { companyId, code: 'MAIN' } },
    create: { companyId, code: 'MAIN', nameFa: 'انبار مرکزی', nameEn: 'Main warehouse', isDefault: true },
    update: {},
  });
}

/**
 * Lost reasons (REQUIREMENTS §10) — configurable, reportable; never
 * hard-coded strings. Persian defaults per company.
 */
const LOST_REASON_SEEDS = [
  { code: 'PRICE_HIGH', nameFa: 'قیمت بالا', nameEn: 'Price too high', sortOrder: 1 },
  { code: 'COMPETITOR', nameFa: 'خرید از رقیب', nameEn: 'Bought from competitor', sortOrder: 2 },
  { code: 'NO_NEED', nameFa: 'عدم نیاز', nameEn: 'No longer needed', sortOrder: 3 },
  { code: 'DELAY', nameFa: 'تاخیر', nameEn: 'Delay', sortOrder: 4 },
  { code: 'PAYMENT_TERMS', nameFa: 'عدم توافق شرایط پرداخت', nameEn: 'Payment terms disagreement', sortOrder: 5 },
  { code: 'OTHER', nameFa: 'سایر', nameEn: 'Other', sortOrder: 6 },
];

async function seedLostReasons(companyId: string): Promise<void> {
  for (const reason of LOST_REASON_SEEDS) {
    await prisma.lostReason.upsert({
      where: { companyId_code: { companyId, code: reason.code } },
      create: { companyId, ...reason },
      update: {},
    });
  }
}

/**
 * Payment terms (REQUIREMENTS §9 field list) — Persian defaults per company.
 */
const PAYMENT_TERM_SEEDS = [
  { code: 'CASH', nameFa: 'نقدی', nameEn: 'Cash', daysOffset: 0 },
  { code: 'PRE_LOADING', nameFa: 'تسویه قبل از بارگیری', nameEn: 'Settled before loading', daysOffset: 0 },
  { code: '7DAYS', nameFa: 'تسویه ۷ روزه', nameEn: '7 days', daysOffset: 7 },
  { code: '30DAYS', nameFa: 'تسویه ۳۰ روزه', nameEn: '30 days', daysOffset: 30 },
];

async function seedPaymentTerms(companyId: string): Promise<void> {
  for (const term of PAYMENT_TERM_SEEDS) {
    await prisma.paymentTerm.upsert({
      where: { companyId_code: { companyId, code: term.code } },
      create: { companyId, ...term },
      update: {},
    });
  }
}

/**
 * Phase 5 sample publishing templates (REQUIREMENTS §18) — one DEFAULT body
 * per major channel. Placeholders: {product} {variantSku} {size} {grade}
 * {brand} {price} {date} {uom}. Upserts are idempotent; existing bodies are
 * never modified on re-seed.
 */
const PUBLISHING_TEMPLATE_SEEDS: { channel: 'WEBSITE' | 'TELEGRAM' | 'WHATSAPP' | 'SMS'; code: string; nameFa: string; bodyTemplate: string }[] = [
  {
    channel: 'WEBSITE',
    code: 'DEFAULT',
    nameFa: 'قالب پیش‌فرض وب‌سایت',
    bodyTemplate: '{product} {size} {grade} {brand} — {price} {uom} ({date})',
  },
  {
    channel: 'TELEGRAM',
    code: 'DEFAULT',
    nameFa: 'قیمت روزانه تلگرام',
    bodyTemplate: '📍 قیمت امروز {date}\n{product} {size} {grade} {brand}: {price} {uom}',
  },
  {
    channel: 'WHATSAPP',
    code: 'DEFAULT',
    nameFa: 'قیمت روزانه واتساپ',
    bodyTemplate: 'قیمت {date}: {product} {size} {grade} {brand} = {price} {uom}',
  },
  {
    channel: 'SMS',
    code: 'DEFAULT',
    nameFa: 'پیامک قیمت روز',
    bodyTemplate: '{product} {size} {brand}: {price} {uom}',
  },
];

async function seedPublishingTemplates(companyId: string): Promise<void> {
  for (const template of PUBLISHING_TEMPLATE_SEEDS) {
    await prisma.publishingTemplate.upsert({
      where: { companyId_channel_code: { companyId, channel: template.channel, code: template.code } },
      create: { companyId, channel: template.channel, code: template.code, nameFa: template.nameFa, bodyTemplate: template.bodyTemplate },
      update: {},
    });
  }
}

/**
 * Phase 5 sample automation rules (REQUIREMENTS §52 lean subset) — both
 * DISABLED so enabling is an explicit operator decision. Upserts are
 * idempotent (existing rows untouched on re-seed).
 */
async function seedAutomationRules(companyId: string): Promise<void> {
  await prisma.automationRule.upsert({
    where: { companyId_code: { companyId, code: 'AUTO-PUBLISH-PRICE' } },
    create: {
      companyId,
      code: 'AUTO-PUBLISH-PRICE',
      nameFa: 'انتشار خودکار قیمت روز',
      triggerType: 'PRICE_UPDATED',
      triggerConfig: { channels: ['WEBSITE', 'TELEGRAM'] },
      conditionConfig: { all: [{ field: 'priceChanged', equals: true }] },
      actionType: 'PUBLISH_PRICE',
      actionConfig: { channels: ['WEBSITE', 'TELEGRAM'] },
      enabled: false,
    },
    update: {},
  });
  await prisma.automationRule.upsert({
    where: { companyId_code: { companyId, code: 'AUTO-INACTIVE-CUSTOMER' } },
    create: {
      companyId,
      code: 'AUTO-INACTIVE-CUSTOMER',
      nameFa: 'یادآوری مشتری راکد (۶۰ روز)',
      triggerType: 'CUSTOMER_INACTIVE_DAYS',
      triggerConfig: { days: 60 },
      conditionConfig: undefined,
      actionType: 'CREATE_NOTIFICATION',
      actionConfig: {
        title: 'مشتری راکد',
        body: 'مشتری {partyName} بیش از ۶۰ روز خرید نداشته است.',
        recipients: [{ type: 'RECORD_OWNER', value: '' }],
      },
      enabled: false,
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

  console.log('Seeding posting rules…');
  const defaultRules = [
    { code: 'SALE_POSTING', nameFa: 'ثبت فروش', eventType: 'SALES_COMPLETED_LOADING' as const, lines: [
      { side: 'DEBIT' as const, accountCode: 'RECEIVABLE', measure: 'RECEIVABLE' as const, memo: 'بدهکار حساب دریافتنی', order: 1 },
      { side: 'CREDIT' as const, accountCode: 'SALES_REVENUE', measure: 'REVENUE' as const, memo: 'بستانکار درآمد فروش', order: 2 },
      { side: 'DEBIT' as const, accountCode: 'PURCHASE_EXPENSE', measure: 'COGS' as const, memo: 'بدهکار بهای تمام‌شده', order: 3 },
      { side: 'CREDIT' as const, accountCode: 'INVENTORY', measure: 'INVENTORY' as const, memo: 'بستانکار موجودی', order: 4 },
    ] },
    { code: 'PURCHASE_POSTING', nameFa: 'ثبت خرید', eventType: 'PURCHASE_FULFILLED' as const, lines: [
      { side: 'DEBIT' as const, accountCode: 'INVENTORY', measure: 'INVENTORY' as const, memo: 'بدهکار موجودی', order: 1 },
      { side: 'CREDIT' as const, accountCode: 'PAYABLE', measure: 'PAYABLE' as const, memo: 'بستانکار پرداختنی', order: 2 },
    ] },
    { code: 'GRN_POSTING', nameFa: 'ثبت رسید انبار', eventType: 'GOODS_RECEIPT_CONFIRMED' as const, lines: [
      { side: 'DEBIT' as const, accountCode: 'INVENTORY', measure: 'INVENTORY' as const, memo: 'بدهکار موجودی', order: 1 },
      { side: 'CREDIT' as const, accountCode: 'PAYABLE', measure: 'PAYABLE' as const, memo: 'بستانکار پرداختنی', order: 2 },
    ] },
    { code: 'REVERSAL_POSTING', nameFa: 'ثبت معکوس برگشت‌ها', eventType: 'INVENTORY_REVERSAL' as const, lines: [
      { side: 'DEBIT' as const, accountCode: 'REVENUE', measure: 'REVENUE' as const, memo: 'معکوس درآمد', order: 1 },
      { side: 'CREDIT' as const, accountCode: 'RECEIVABLE', measure: 'RECEIVABLE' as const, memo: 'معکوس دریافتنی', order: 2 },
      { side: 'DEBIT' as const, accountCode: 'INVENTORY', measure: 'INVENTORY' as const, memo: 'معکوس موجودی', order: 3 },
      { side: 'CREDIT' as const, accountCode: 'COGS', measure: 'COGS' as const, memo: 'معکوس بهای تمام‌شده', order: 4 },
    ] },
  ] as Array<{ code: string; nameFa: string; eventType: 'SALES_COMPLETED_LOADING' | 'PURCHASE_FULFILLED' | 'GOODS_RECEIPT_CONFIRMED' | 'INVENTORY_REVERSAL'; lines: Array<{ side: 'DEBIT' | 'CREDIT'; accountCode: string; measure: 'RECEIVABLE' | 'PAYABLE' | 'REVENUE' | 'COGS' | 'INVENTORY'; memo: string; order: number }> }>;
  for (const r of defaultRules) {
    const rule = await prisma.postingRule.upsert({
      where: { companyId_code: { companyId, code: r.code } },
      create: { companyId, code: r.code, nameFa: r.nameFa, eventType: r.eventType, enabled: true },
      update: {},
    });
    if ((await prisma.postingRuleLine.count({ where: { ruleId: rule.id } })) === 0) {
      await prisma.postingRuleLine.createMany({ data: r.lines.map((l) => ({ ...l, ruleId: rule.id })) });
    }
  }
  console.log('  4 default rules');
  console.log(`  ${CHART_OF_ACCOUNTS.length} accounts`);

  console.log('Seeding sequences…');
  await seedSequences(companyId);
  console.log(`  ${SEQUENCE_DEFS.length} sequences`);

  console.log('Seeding sample integration config…');
  await seedIntegrationConfig(companyId);

  console.log('Seeding reference UOM categories (WEIGHT/LENGTH/UNIT + bases)…');
  await seedUomCategories(companyId);

  console.log('Seeding lost reasons (Phase 4)…');
  await seedLostReasons(companyId);
  console.log(`  ${LOST_REASON_SEEDS.length} lost reasons`);

  console.log('Seeding payment terms (Phase 4)…');
  await seedPaymentTerms(companyId);
  console.log(`  ${PAYMENT_TERM_SEEDS.length} payment terms`);

  console.log('Seeding publishing templates (Phase 5)…');
  await seedPublishingTemplates(companyId);
  console.log(`  ${PUBLISHING_TEMPLATE_SEEDS.length} templates`);

  console.log('Seeding sample automation rules (Phase 5, disabled)…');
  await seedAutomationRules(companyId);

  console.log('Seeding default warehouse MAIN / انبار مرکزی (Phase 6)…');
  await seedDefaultWarehouse(companyId);

  console.log('Phase 6 stock-movement source FK adjustment…');
  await fixStockMovementSourceFk();
}

/**
 * The Phase 6 migration adds `stock_movements_source_entity_id_fkey` with a
 * single-table target (`loadings.id`), but `source_entity_id` is POLYMORPHIC
 * by design (domain boundaries §4): every movement carries
 * (source_entity_type, source_entity_id) — LOADING **and** PURCHASE (goods
 * receipt). With the single-table FK every PURCHASE movement violates the
 * constraint, so the seed drops it (idempotent). Migrations stay untouched
 * (schema frozen); the (company_id, source_entity_type, source_entity_id)
 * index remains and application code always writes both columns together.
 */
async function fixStockMovementSourceFk(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_source_entity_id_fkey',
  );
  console.log('  stock_movements_source_entity_id_fkey dropped (polymorphic source).');
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
