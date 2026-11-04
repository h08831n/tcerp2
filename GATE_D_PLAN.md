# TCERP2 — Gate D Executive Implementation Plan (v2, revised)

> تأیید مالک برای هر فاز الزامی است. هیچ قابلیتی قبل از تأیید پیاده‌سازی نمی‌شود.
> تمرکز: تکمیل قابلیت‌های ناقص برای عملیاتی‌شدن واقعی ERP — نه بازنویسی معماری.
> این نسخه جایگزین v1 (که روی برنچ gate-c-final-security بود) می‌شود.

---

## CI روی Merge Commit

Merge PR #3 (Gate C): commit `1600741` روی main.

| Job | Status | URL |
|---|---|---|
| backend | ✓ success | https://github.com/h08831n/tcerp2/actions/runs/41899264673/job/126816993489 |
| frontend | ✓ success | https://github.com/h08831n/tcerp2/actions/runs/41899264673/job/126816993929 |

---

## پیش‌زمینه: وضعیت فعلی (تأییدشده روی کد واقعی)

- main HEAD: `1600741` — CI سبز هر دو job
- Integration: ۹۷۲/۹۷۲ (۲۰۹ سوییت) · Unit: ۴۷۳/۰ · Build هر دو سمت سبز
- Gate C بسته‌شده (۵ دور بازبینی، ۳۳+ عیب رفع‌شده، R6-S1 در JwtAuthGuard)
- ۵۳ کنترلر، ۲۰۸ سوییت تست، ۴۱ Migration (همگی روی DB خالی و موجود اعمال شده)

---

## فازهای Gate D (ترتیب اجرا)

| ترتیب | فاز | وضعیت | اولویت | وابستگی |
|---|---|---|---|---|
| ۱ | **D-1: مؤدیان sandbox** | 🔴 BLOCKED_BY_CREDENTIALS | P0 | اعتبارنامه مالک |
| ۲ | **D-2: پورتال مشتری** | 🟢 آماده برای طراحی → تأیید → implementation | P0 | ندارد |
| ۳ | **D-3: بستن سال مالی** | 🟡 نیازمند تأیید سیاست حسابداری | P1 | طرح حساب + تصمیم مالک |
| ۴ | **D-4: Import/Export تکمیلی** | 🟡 نیازمند فرمت فایل از مالک | P1 | فرمت CSV |
| ۵ | **D-5: بارگیری و فایل‌ها** | 🟢 آماده | P1 | ندارد |
| ۶ | **D-6: گزارش‌ها و خزانه تکمیلی** | 🟢 آماده | P2 | ندارد |

---

## D-1: مؤدیان Sandbox Connectivity

### وضعیت فعلی (کد واقعی)
- Adapter کامل روی `RC_TICS.IS_v1.6` + `RC_IITP.IS_V7.9`
- Durable state machine: `MoadianDiagnosticRun` + `MoadianDiagnosticAttempt`
- Payload validation: taxid 22-char، adis/tsstam، setm gap، tins/tob/bid/tinb، mu mapping
- Issuance cap، اصلاحی/cancel lifecycle، multi-stage با lineOverrides
- UI `/tax-invoices` + diagnostics panel
- **اتصال واقعی: 🔴 BLOCKED_BY_CREDENTIALS**

### چک‌لیست نیازمندی‌های Sandbox (مالک باید فراهم کند)

| # | مورد | متغیر env | توضیح |
|---|---|---|---|
| ۱ | کلید خصوصی X.509 (PKCS#8 PEM) | `MOADIAN_PRIVATE_KEY` | مطابق گواهی ثبت‌شده در سامانه |
| ۲ | گواهی X.509 عمومی | `MOADIAN_CERTIFICATE` | برای JWE encryption |
| ۳ | شناسهٔ مالیاتی (fiscalId) | `MOADIAN_FISCAL_ID` | از سامانه مودیان |
| ۴ | کد اقتصادی فروشنده | `MOADIAN_ECONOMIC_CODE` | برای tins در payload |
| ۵ | Client ID | `MOADIAN_CLIENT_ID` | از Sharjh/سامانه |
| ۶ | شناسهٔ یکتای مالیاتی (taxid) | `MOADIAN_SANDBOX_TAXID` | ۲۲ کاراکتر — قالب جداگانه |
| ۷ | کد SSTID برای کالاها | `MOADIAN_SANDBOX_SSTID` | شناسهٔ کالا و خدمت |
| ۸ | URL پایه sandbox | `MOADIAN_BASE_URL` | پیش‌فرض: `https://sandbox.tp.tax.gov.ir` |

⚠️ هیچ کلید خصوصی، Client Secret یا اعتبارنامه‌ای در کد، لاگ یا Git ذخیره نمی‌شود.

### اقدام پس از دریافت اعتبارنامه‌ها
1. `MOADIAN_MODE=sandbox` + env vars → boot
2. `POST /api/tax/diagnostics/sandbox-full-test` — non-mutating steps
3. `POST /api/tax/invoices` از سند فروش COMPLETED — real submission
4. `GET /api/tax/invoices/:id/status` — inquiry → SUCCESS

---

## D-2: پورتال مشتری — سند طراحی فنی

📄 **سند کامل: `docs/15-portal-design.md`** (در همین PR)

### خلاصهٔ طراحی

**هویت مشتری:** پورتال بر اساس `Party` (طرف‌حساب با نقش CUSTOMER) در یک شرکت مشخص است. یک موبایل می‌تواند به چند Party در چند شرکت مرتبط باشد — کاربر پس از تأیید OTP شرکت/پارتی را انتخاب می‌کند (اگر بیش از یکی باشد).

**OTP:** کد ۶ رقمی تصادفی (crypto.randomInt)، ذخیرهٔ hash در DB، TTL ۲ دقیقه، حداکثر ۳ تلاش، rate limit یک درخواست در دقیقه به‌ازای هر موبایل.

**Session:** پس از تأیید OTP، یک token تصادفی (۴۸ بایت hex) ساخته و hash آن در `PortalSession` ذخیره می‌شود. Session TTL: ۲۴ ساعت. Cookie HttpOnly + SameSite=Lax با path=/api/portal.

**جلوگیری از Enumeration:** پیام خطای OTP یکسان برای «شماره یافت نشد» و «کد اشتباه». Lookup نتیجهٔ {matched, linked} برمی‌گرداند — بدون نام، بدهی یا جزئیات.

**Company + Party Scope:** هر query در سرویس پورتال صراحتاً `companyId` و `partyId` را فیلتر می‌کند — IDOR غیرممکن است چون session به یک (companyId, partyId) مقید است.

**داده‌های قابل نمایش:** سفارش‌های فروش (وضعیت + ردیف‌ها)، بارگیری‌های مرتبط (وضعیت + تاریخ، بدون راننده)، ماندهٔ عملیاتی بدهی، فایل‌های متصل به سند فروش. **مخفی:** راننده، تأمین‌کننده، اسناد داخلی، حاشیه سود، قیمت خرید.

**Migration افزایشی:** `portal_sessions` جدول جدید + `portal_otp_codes` جدول جدید.

---

## D-3: بستن سال مالی — تحلیل سیاست حسابداری

### مشکل
الگوریتم Closing نیاز به تصمیم حسابداری دارد: ماندهٔ حساب‌های موقت (درآمد و هزینه) به کدام حساب منتقل شود؟

### گزینه‌ها

| گزینه | حساب مقصد | مزیت | عیب |
|---|---|---|---|
| A | OPENING_EQUITY (مستقیم) | ساده، بدون حساب واسطه | سود/زیان از سرمایه تفکیک نمی‌شود |
| B | RETAINED_EARNINGS (سود انباشته) | استاندارد حسابداری ایران | حساب جدید لازم است |
| C | PROFIT_SUMMARY / LOSS_SUMMARY (حساب واسطه) | تفکیک دوره‌ای و انباشته | حساب واسطهٔ اضافی |
| D | DIRECT_TO_CAPITAL (سرمایه) | ساده | سود انباشته با سرمایه اولیه مخلوط می‌شود |

### پیشنهاد: گزینهٔ B (RETAINED_EARNINGS)

حساب `RETAINED_EARNINGS` (کد: `RETAINED_EARNINGS`، نوع: EQUITY) اضافه شود. Closing entries:
- Dr حساب‌های درآمد (با ماندهٔ بستانکار)
- Cr حساب‌های هزینه (با ماندهٔ بدهکار)
- خالص → Dr/Cr RETAINED_EQUITY

افتتاحیهٔ سال بعد: فقط حساب‌های دائمی (ASSET/LIABILITY/EQUITY) — حساب‌های موقت صفر شده‌اند.

**این پیشنهاد نیازمند تأیید مالک است.** OPENING_EQUITY فقط برای افتتاحیهٔ اولیه (قبل از اولین دوره) استفاده می‌شود.

### Migration لازم
- حساب `RETAINED_EARNINGS` به chart هر شرکت اضافه شود (migration data-preserving با upsert)
- متد `close()` در FiscalYearService + endpoint `POST /api/accounting/fiscal-years/:id/close`
- انتقال مانده‌ها در `openingBalanceService.generate()` بر اساس closing entry

---

## D-4: Import/Export تکمیلی

**ناقص:** CONTACTS import، PRODUCTS import (categories/brands/templates)، GOODS_RECEIPTS import، EXPORT برای contacts/products/documents

**اقدام:** هر entity جدید یک slice import + یک export endpoint. فرمت سرستون‌ها از مالک گرفته شود.

---

## D-5: بارگیری و فایل‌ها

**ناقص:** اتصال file attachments به loading entity، گزارش اختلاف وزن باسکول

**اقدام:** اتصال `files.attachments` به `loading` + گزارش delta بر اساس loading lines

---

## D-6: گزارش‌ها و خزانه تکمیلی

**ناقص:** loadings report variations، supplier performance detail، bank reconciliation، multi-currency

**اقدام:** گزارش‌ها + پیشنهاد سیاست تطبیق بانکی → تأیید مالک

---

## ریسک‌ها و وابستگی‌های واقعی

| ریسک | شدت | وابستگی |
|---|---|---|
| Moadian: اعتبارنامه در دسترس نیست | 🔴 P0 | مالک باید از سامانه مودیان دریافت کند |
| Portal: امنیت OTP و IDOR | 🟡 P1 | طراحی دقیق + تست نفوذ |
| Closing: سیاست حسابداری تأیید نشده | 🟡 P1 | تصمیم مالک |
| Import: فرمت CSV از مالک نرسیده | 🟡 P1 | مالک |
| Shared company data accumulation | 🟢 P3 | تکرار اجرا — تست‌ها ایزوله شده‌اند |

---

## موارد تصمیم‌گیری مالک

1. **D-1:** تأمین اعتبارنامه‌های sandbox (چک‌لیست بالا)
2. **D-2:** تأیید طراحی پورتال (سند `docs/15-portal-design.md`)
3. **D-3:** تأیید گزینهٔ B (RETAINED_EARNINGS) برای Closing Entries
4. **D-4:** ارائهٔ فرمت CSV فایل‌های ورودی

---

## Backlog ثبت‌شده (خارج از Gate D)

| مورد | نوع |
|---|---|
| journal.reverse companyId guard | COVERAGE_GAP |
| UTC vs Asia/Tehran fiscal timezone | POLICY_DECISION |
| Access token ابطال هنگام reset password | POLICY_DECISION |
| Cookie/refresh flow tests | COVERAGE_GAP |
| gate-c-auth stale test descriptions | COVERAGE_GAP |
| Dead-letter UI | P3 |
| XLSX reader upgrade | P3 |
