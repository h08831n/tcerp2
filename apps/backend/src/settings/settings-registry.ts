/**
 * CORE-003 — THE settings registry: the single source of truth for every
 * business parameter an administrator may manage from the settings center.
 *
 * LAWS:
 *  - Every entry has a REAL consumer in the backend (or, for `crm.lead_sources`,
 *    a real consumer in the leads UI) — no display-only settings.
 *  - Consumers FALL BACK to `defaultValue` when the company has no row —
 *    restoring a default = deleting the override row.
 *  - Secrets/infrastructure (JWT keys, DB/Redis URLs, Moadian keys, SMTP
 *    credentials) deliberately stay in ENV — they are NOT exposed here.
 *  - `type` drives backend validation (upsert) and the FE editor widget.
 */

export type SettingType = 'number' | 'string' | 'boolean' | 'select';

export interface SettingDefinition {
  key: string;
  category:
    | 'sales'
    | 'crm'
    | 'inventory'
    | 'accounting'
    | 'files'
    | 'integrations';
  type: SettingType;
  labelFa: string;
  descriptionFa: string;
  defaultValue: unknown;
  /** For type=select — the allowed values. */
  options?: string[];
  /** For type=number — inclusive bounds enforced on upsert. */
  min?: number;
  max?: number;
  /** Reject non-integer numbers (default: integers allowed). */
  integerOnly?: boolean;
  /** Secret values are masked in list/read endpoints. */
  isSecret?: boolean;
  /** The backend consumer that enforces this setting (documentation/traceability). */
  consumer: string;
}

export const SETTING_DEFINITIONS: SettingDefinition[] = [
  // ── Sales ────────────────────────────────────────────────────────────────
  {
    key: 'sales.quotation_expiration_days',
    category: 'sales',
    type: 'number',
    labelFa: 'اعتبار پیش‌فاکتور (روز)',
    descriptionFa: 'تعداد روز اعتبار پیش‌فاکتور پس از تاریخ سند (پیش‌فرض ۱۴ روز).',
    defaultValue: 14,
    consumer: 'sales-documents.service.readExpirationDays — تاریخ انقضای پیش‌فاکتور',
  },
  {
    key: 'sales.lost_reason_required',
    category: 'sales',
    type: 'boolean',
    labelFa: 'دلیل باخت اجباری',
    descriptionFa: 'هنگام باختن پیش‌فاکتور، انتخاب دلیل از فهرست الزامی باشد.',
    defaultValue: true,
    consumer: 'sales-documents.service.lost — الزام دلیل باخت',
  },
  // ── CRM ──────────────────────────────────────────────────────────────────
  {
    key: 'crm.lead_sources',
    category: 'crm',
    type: 'select',
    labelFa: 'منابع جذب سرنخ',
    descriptionFa: 'فهرست منابع جذب سرنخ در فرم ثبت سرنخ (با کاما جدا شود).',
    defaultValue: ['WEB_SITE', 'REFERRAL', 'EXHIBITION', 'GOOGLE_ADS', 'COLD_CALL'],
    options: ['WEB_SITE', 'REFERRAL', 'EXHIBITION', 'GOOGLE_ADS', 'COLD_CALL'],
    consumer: 'leads UI — فهرست منبع جذب سرنخ',
  },
  // ── Inventory ────────────────────────────────────────────────────────────
  {
    key: 'inventory.negative_stock_policy',
    category: 'inventory',
    type: 'select',
    labelFa: 'سیاست موجودی منفی',
    descriptionFa: 'BLOCK: خروج از انبار داخلی با موجودی منفی رد می‌شود. WARN (پیش‌فرض): با هشدار ثبت می‌شود. ALLOW: آزاد.',
    defaultValue: 'WARN',
    options: ['ALLOW', 'WARN', 'BLOCK'],
    consumer: 'inventory/normalization.service — اعتبارسنجی خروج از انبار داخلی',
  },
  // ── Accounting ───────────────────────────────────────────────────────────
  {
    key: 'accounting.fiscal_year_start_mmdd',
    category: 'accounting',
    type: 'string',
    labelFa: 'شروع سال مالی (MM-DD)',
    descriptionFa: 'تاریخ شروع سال مالی برای شماره‌گذاری اسناد با ریست سالانه (مثلاً 01-01).',
    defaultValue: '01-01',
    consumer: 'sequences.service — ریست سالانهٔ شماره اسناد',
  },
  // ── Files ────────────────────────────────────────────────────────────────
  {
    key: 'files.max_upload_mb',
    category: 'files',
    type: 'number',
    labelFa: 'حداکثر حجم هر فایل (مگابایت)',
    descriptionFa: 'سقف حجم هر فایل آپلودی — عدد صحیح ۱ تا ۵۰ (سقف زیرساختی Multer).',
    defaultValue: 50,
    min: 1,
    max: 50,
    integerOnly: true,
    consumer: 'files.service.upload — اعتبارسنجی حجم فایل',
  },
  // ── Integrations (public API) ───────────────────────────────────────────
  {
    key: 'publicapi.visibility',
    category: 'integrations',
    type: 'select',
    labelFa: 'سطح انتشار Public API',
    descriptionFa: 'کنترل نمایش اطلاعات عمومی سایت از طریق Public API.',
    defaultValue: 'ALL',
    options: ['ALL', 'WEBSITE_ONLY', 'HIDDEN'],
    consumer: 'public-api.service — سطح نمایش عمومی',
  },
  {
    key: 'publicapi.website_only_published',
    category: 'integrations',
    type: 'boolean',
    labelFa: 'فقط محصولات منتشرشده در سایت',
    descriptionFa: 'در حالت WEBSITE_ONLY، فقط محصولات منتشرشده نمایش داده شوند.',
    defaultValue: false,
    consumer: 'public-api.service — فیلتر محصولات منتشرشده',
  },
];

export const SETTING_DEFINITIONS_BY_KEY = new Map(
  SETTING_DEFINITIONS.map((def) => [def.key, def]),
);

/** Validation + coercion by registry type. Returns {ok, value, error}. */
export function validateSettingValue(
  def: SettingDefinition,
  raw: unknown,
): { ok: true; value: unknown } | { ok: false; error: string } {
  switch (def.type) {
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(n)) return { ok: false, error: 'مقدار باید عدد باشد' };
      if (def.integerOnly && !Number.isInteger(n)) {
        return { ok: false, error: 'مقدار باید عدد صحیح باشد' };
      }
      if (def.min !== undefined && n < def.min) {
        return { ok: false, error: `حداقل مجاز ${def.min} است` };
      }
      if (def.max !== undefined && n > def.max) {
        return { ok: false, error: `حداکثر مجاز ${def.max} است` };
      }
      if (n < 0) return { ok: false, error: 'مقدار نمی‌تواند منفی باشد' };
      return { ok: true, value: n };
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return { ok: true, value: raw };
      if (raw === 'true') return { ok: true, value: true };
      if (raw === 'false') return { ok: true, value: false };
      return { ok: false, error: 'مقدار باید true یا false باشد' };
    }
    case 'select': {
      const allowed = def.options ?? [];
      if (typeof raw !== 'string' || !allowed.includes(raw)) {
        return { ok: false, error: `مقدار باید یکی از باشد: ${allowed.join(', ')}` };
      }
      return { ok: true, value: raw };
    }
    case 'string':
    default: {
      if (typeof raw !== 'string' || raw.trim().length === 0) {
        return { ok: false, error: 'مقدار باید متن غیرخالی باشد' };
      }
      if (def.key === 'accounting.fiscal_year_start_mmdd' && !/^\d{2}-\d{2}$/.test(raw.trim())) {
        return { ok: false, error: 'قالب صحیح: MM-DD (مثلاً 01-01)' };
      }
      return { ok: true, value: raw.trim() };
    }
  }
}
