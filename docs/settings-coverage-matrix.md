# CORE-003 — ماتریس پوشش کامل تنظیمات و داده‌های مرجع

> نتیجهٔ ممیزی جامع تمام ماژول‌های Backend، Frontend، Database، Seed و Config.
> هر مورد در یکی از ۵ گروه تعیین تکلیف شده است. هیچ موردی بدون تکلیف نمانده.

**گروه‌ها:**
- **گروه ۱** — پارامترهای قابل تغییر از UI (مرکز تنظیمات؛ consumer واقعی)
- **گروه ۲** — داده‌های مرجع قابل مدیریت از UI (صفحات CRUD واقعی موجود یا جدید)
- **گروه ۳** — تنظیمات امنیتی/زیرساختی فقط از محیط امن (ENV؛ عمداً خارج از UI)
- **گروه ۴** — ثابت‌های فنی که نباید قابل تنظیم باشند (قوانین دامنه/یکپارچگی)
- **گروه ۵** — قابلیت‌های هنوز موجود نیست (به فازهای بعدی ثبت شد)

---

## گروه ۱ — پارامترهای قابل تغییر از UI (کاتالوگ تنظیمات)

| کلید | ماژول | ذخیره | Consumer واقعی | پیش‌فرض | نوع | Scope | مجوز مشاهده/ویرایش | UI | اثر تغییر |
|---|---|---|---|---|---|---|---|---|---|
| sales.quotation_expiration_days | فروش | settings table | sales-documents.service.readExpirationDays | 14 | number | Company | settings.view / settings.edit | ✓ مرکز | انقضای پیش‌فاکتور جدید |
| sales.lost_reason_required | فروش | settings table | sales-documents.service.lost | true | boolean | Company | settings.view / settings.edit | ✓ مرکز | الزام دلیل باخت |
| crm.lead_sources | CRM | settings table | GET /leads/source-options → فرم سرنخ | ۵ منبع | select(list) | Company | settings.view / settings.edit | ✓ مرکز | فهرست منبع در فرم سرنخ |
| inventory.negative_stock_policy | انبار | settings table | inventory/normalization.service | WARN | select(ALLOW/WARN/BLOCK) | Company | settings.view / settings.edit | ✓ مرکز | رد/هشدار خروج با موجودی منفی |
| accounting.fiscal_year_start_mmdd | حسابداری | settings table | sequences.service | 01-01 | string(MM-DD) | Company | settings.view / settings.edit | ✓ مرکز | ریست سالانهٔ شماره اسناد |
| files.max_upload_mb | فایل‌ها | settings table | files.service.upload (قبل از S3؛ سقف زیرساختی ۵۰MB جدا) | 50 (clamp ≤50) | number | Company | settings.view / settings.edit | ✓ مرکز | رد آپلود بزرگ‌تر |
| publicapi.visibility | یکپارچه‌سازی | settings table | public-api.service | ALL | select | Company | settings.view / settings.edit | ✓ مرکز | سطح نمایش عمومی |
| publicapi.website_only_published | یکپارچه‌سازی | settings table | public-api.service | false | boolean | Company | settings.view / settings.edit | ✓ مرکز | فیلتر منتشرشده‌ها |

تست اثر واقعی: core-003-settings.spec (۷ روز → انقضای پیش‌فاکتور؛ سقف ۱MB → رد آپلود).

---

## گروه ۲ — داده‌های مرجع قابل مدیریت از UI

| مرجع | ماژول | API | صفحه UI | مجوز ویرایش | یادداشت |
|---|---|---|---|---|---|
| دسته‌بندی کالا | محصولات | /products/categories | /products/categories (موجود) | products.view/… | لینک از مرکز |
| برندها | محصولات | /products/brands | /products/brands (موجود) | products.* | لینک از مرکز |
| واحدهای اندازه‌گیری | محصولات | /products/uom | /products/uom (موجود) | products.* | تبدیل با ضریب + دسته |
| ویژگی‌ها (Attributes) | محصولات | /products/attributes | /products/attributes (موجود) | products.* | برای Variantها |
| نگاشت تامین‌کنندگان | محصولات | /products/supplier-mappings | موجود | products.* | قیمت خرید per supplier |
| دلایل باخت | CRM | /lost-reasons | **/settings/lost-reasons (جدید)** | crm.manage | الزامی هنگام باخت |
| شرایط پرداخت | فروش | /payment-terms | **/settings/payment-terms (جدید)** | paymentterm.manage | مصرف در سند فروش |
| انواع فعالیت | فعالیت‌ها | /activities/types | /activities (مودال موجود) | activities.override | مدیریت از همان صفحه |

حذف فیزیکی این مرجع‌ها عمداً وجود ندارد؛ **غیرفعال‌سازی** (active=false) راهکار اصلی است.

---

## گروه ۳ — تنظیمات امنیتی/زیرساختی فقط از محیط امن (ENV — عمداً خارج از UI)

| پارامتر | محل | مصرف |
|---|---|---|
| JWT_SECRET / JWT_REFRESH_SECRET | ENV | امضای توکن‌ها |
| DATABASE_URL | ENV | اتصال DB |
| REDIS_URL / BullMQ | ENV | صف |
| S3_ENDPOINT/KEY/SECRET/BUCKET | ENV | MinIO/S3 |
| SEED_ADMIN_USERNAME/PASSWORD | ENV | فقط bootstrap seed (رمز در Git نیست) |
| LOGIN_MAX_ATTEMPTS / LOGIN_LOCK_MINUTES | ENV | قفل حساب ورود |
| PORTAL_OTP_MOBILE_PER_MINUTE / IP_PER_HOUR | ENV | نرخ OTP |
| CORS_ORIGINS | ENV | whitelist CORS |
| MOADIAN_* (کلیدها/fiscalId/timeouts) | ENV | سامانه مودیان |
| access/refresh TTL | ENV | طول عمر توکن‌ها |
| NODE_ENV | ENV | رفتار production گاردها |

دلیل خروج از UI: افشای Secret در API/Log، ضرب‌الاجل چرخش مجدد کلیدها، و ممنوعیت §3 (Secretها به رابط عمومی منتقل نشوند).

---

## گروه ۴ — ثابت‌های فنی (نباید قابل تنظیم باشند)

| ثابت | محل | دلیل |
|---|---|---|
| سقف سخت آپلود ۵۰MB (multer limits) | files.controller | زیرساخت؛ تنظیم per-company زیر سقف در گروه ۱ |
| حساب سیستم OPENING_EQUITY / نحوهٔ auto-balance | accounting service | قاعدهٔ دفترداری، نه سلیقه |
| وضوح/min حروف، الگوریتم hash (bcrypt) | users.service | استاندارد امنیتی |
| قوانین CHECK دیتابیس (mismatch حواله، سالادی/وزن ≥ ۰) | migrations | یکپارچگی داده |
| سقف pageSize=100 (PaginationDto) | common/dto | محافظت از DB — FE رعایت می‌کند |
| حداکثر ۵۰ ردیف ماتریس/لیست‌های کپ‌شده | جاهای مستند | محافظت حافظه |
| Reject cross-site / Sec-Fetch / Origin گاردها | portal middleware | امنیت، نه سلیقه |

---

## گروه ۵ — قابلیت‌های موجود نیست (ثبت برای فازهای بعدی)

| قابلیت | ثبت |
|---|---|
| ارزها و نرخ تبدیل چندارزی | ممنوع تا سیاست ارز مالک (D-6 blocked) |
| HR: قرارداد/پرسنل | ماژول HR وجود ندارد |
| Email channel | فقط SMS پیاده شده |
| درگاه پرداخت / eCommerce / POS | وجود ندارد |
| Lot/Serial/انقضا | زیرساخت انبار فعلی پشتیبانی نمی‌کند |
| Pricelist چندسطحی | سیستم قیمت روز موجود است؛ Pricelist Odoo نیازمند طراحی جدا |

---

## امنیت و Scope

- GET/PUT/DELETE تنظیمات: `settings.view` / `settings.edit` (تست 403 در core-003 spec).
- مسیر قدیمی PUT /settings: **فقط کلیدهای رجیستری + typed validation** — کلید خارج از کاتالوگ → 422 `SETTING_KEY_NOT_IN_REGISTRY`.
- Scope: همهٔ reads/writes با `companyId` از `requireCompanyId` — تنظیم شرکت دیگر بدون عضویت قابل دسترس نیست (membership guard).
- Secret ماسک: رجیستری Secret ندارد؛ سازوکار `isSecret`+mask در سرویس حاضر است برای آینده.
- Audit: upsert (old+new) و restore در audit_logs — توسط کاربر عادی قابل تغییر نیست (جدول بدون API نوشتن).
