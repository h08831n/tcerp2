# TCERP2 — Gate D Executive Implementation Plan

> تأیید مالک برای هر بخش الزامی است. هیچ قابلیتی قبل از تأیید پیاده‌سازی نمی‌شود.
> تمرکز: تکمیل قابلیت‌های ناقص برای عملیاتی‌شدن واقعی ERP — نه بازنویسی معماری.

---

## پیش‌زمینه: وضعیت فعلی (تأییدشده روی کد واقعی)

- main HEAD: `1600741` (merge PR #3) — CI سبز هر دو job
- Integration: ۹۷۲/۹۷۲ (۲۰۹ سوییت) · Unit: ۴۷۳/۰ · Build هر دو سمت سبز
- Gate C بسته‌شده (۵ دور بازبینی، ۳۳+ عیب رفع‌شده، R6-S1 در JwtAuthGuard)
- ۵۳ کنترلر، ۲۰۸ سوییت تست، ۴۱ Migration (همگی روی DB خالی و موجود اعمال شده)
- ماژول‌های موجود: auth، companies، users/roles/teams، parties (CRM)، products (3B)，
  sales/purchase/RFQ/allocations (4) ، pricing/publishing (5)، loading/inventory/goods-receipt (6)，
  accounting/claims/treasury (7)، tax/moadian (8)، activities/calendar/timeline (9A)،
  workflow/approvals (9B)، automation (9C)، notifications/SMS (9D)، reports (F)،
  imports/exports (G)، files (3B)، health/metrics، public-api

---

## اولویت‌بندی کسب‌وکار (بر اساس اثر مالی/عملیاتی)

| اولویت | ماژول | وضعیت فعلی (کد) | آنچه ناقص است | اثر |
|---|---|---|---|---|
| P0 | مؤدیان (Moadian) | Adapter کامل + sandbox state machine + validation + UI — **sandbox UNVERIFIED** | اتصال واقعی به `tp.tax.gov.ir` + اعتبارنامه + taxid/sstid/payments mapping | بدون آن فروش رسمی انجام نمی‌شود |
| P0 | پورتال مشتری | `@Public /api/public/*` (prices, portal-lookup) — API-key placeholder | احراز هویت واقعی مشتری با موبایل تأییدشده، سفارش‌های مجاز، وضعیت بارگیری، بدهی، فایل‌ها | مشتری به سیستم دسترسی ندارد |
| P1 | Import/Export | PARTIES, DAILY_PRICE, PRODUCT_VARIANT, SALES_DOCUMENT + CSV/XLSX + export parties.csv | CONTACTS, PRODUCTS (categories/brands), GOODS_RECEIPTS, TAX_INVOICES import; EXPORT برای contacts/products/documents | ورود داده اولیه ناقص |
| P1 | بستن سال مالی | FiscalYear/Period + assertOpenPeriod + closingEntryId column — **closing entries logic NOT built** | قفل دوره، انتقال حساب‌های موقت به سود/زیان، تولید افتتاحیه سال بعد از سند بسته | چرخهٔ مالی ناقص |
| P1 | انبار و بارگیری | Loading/GRN/inventory/operations + Serialisable + Integrity Gate — کاملاً پیاده‌شده | اختلاف وزن باسکول (weighbridge-delta) + آپلود تصویر باسکول + فایل مرتبط با مشتری در بارگیری | داده‌های عملیاتی بارگیری ناقص |
| P2 | گزارش‌های مدیریتی | dashboard + sales/purchase-performance + debt + offers win/loss + negative-stock + turnover + saved views (localStorage) | گزارش‌های loadings (variations)، عملکرد تأمین‌کنندگان تفصیلی، Export خودکار گزارش‌ها | گزارش‌های مدیریتی ناقص |
| P2 | Treasury | Bank accounts, receipts/payments, checks lifecycle, transfers, statement — کامل + audit atomicity | Bank reconciliation (تطبیق گردش بانکی با صورتحساب), multi-currency | تطبیق بانکی ناقص |
| P2 | Tax Invoicing (non-Moadian) | SalesTaxInvoice + PurchaseTaxInvoice + M:N + line SSTID + issuance cap + correction/cancel lifecycle | Purchase tax invoice UI integration در صفحهٔ خرید، linkage نمایش در سفارش | مالیات خرید کمتر ملموس |
| P3 | Session/Auth | JWT + refresh rotation + reuse-detection + lockout + cookie — کامل (Gate C verified) | Access token ابطال هنگام reset password (فقط refresh لغو می‌شود؛ access تا انقضا معتبر) | پنجرهٔ ≤15m |
| P3 | Queue | BullMQ + Postgres fallback + durable SMS + automation + accounting events + idempotency + monitoring | Dead-letter UI برای operator، Backoff tuning | عملیاتی |
| P3 | Backlog از بازبینی‌ها | — | journal.reverse companyId guard، UTC/Tehran fiscal policy، cookie/refresh flow tests | تصمیم مالک |

---

## Gate D — برنامهٔ اجرایی مرحله‌ای

### مرحله ۱ — Moadian Sandbox Connectivity (P0)

**وضعیت فعلی (کد واقعی):**
- Adapter کامل روی `RC_TICS.IS_v1.6` + `RC_IITP.IS_V7.9` — JWE/JWS، login، server info، inquiry، send
- Durable state machine: `MoadianDiagnosticRun` + `MoadianDiagnosticAttempt` (uid قبل از enqueue، UNIQUE uid، claim via updateMany)
- Payload validation: taxid 22-char، adis/tsstam، setm gap، tins/tob/bid/tinb، mu mapping، FIELD_MISSING
- Issuance cap، اصلاحی/cancel lifecycle، multi-stage با lineOverrides
- UI `/tax-invoices` + diagnostics panel + `users.reset_password` جدا
- **انچه نیست:** اتصال واقعی — `MOADIAN_MODE=mock` در test/dev؛ اعتبارنامه‌ها (کلید خصوصی X.509 + fiscalId + economic code + clientId) وجود ندارند؛ taxid generation از doc جدا؛ sstid list و payments ساختار مشخص ولی داده‌گیری نشده

**اقدام:** ارائهٔ اعتبارنامه توسط مالک → تنظیم `MOADIAN_MODE=sandbox` + env vars → اجرای `POST /api/tax/diagnostics/sandbox-full-test` → ثبت درخواست واقعی روی sandbox → استعلام → تأیید پاسخ

**معیار پذیرش:** یک فاکتور واقعی روی sandbox ارسال و SUCCESS دریافت شود؛ uid در DB ثبت شود؛ inquiry وضعیت مؤید باشد.

**وابستگی:** اعتبارنامه (مالک) + taxid format doc + sstid list + payments data

**تست‌ها:** mock round-trip موجود؛ E2E واقعی فقط در sandbox با credential. Integration mockها برای regression حفظ می‌شوند.

---

### مرحله ۲ — پورتال مشتری (P0)

**وضعیت فعلی:**
- `@Public /api/public/prices` + `/prices/:id/history` + `/portal/lookup` — فقط {matched, linked}
- API-key placeholder (Setting `publicapi.key`)
- **انچه نیست:** لاگین مشتری با موبایل + OTP، مشاهدهٔ سفارش‌ها/بارگیری‌ها/بدهی، rate limit واقعی، audit برای lookup

**اقدام (ترتیب):**
1. OTP send/verify با SmsService موجود (rate limit: 1/minute/party)
2. `PortalCustomer` session model (migration جدید — token + partyId + companyId + expiresAt)
3. Endpoints: GET /api/portal/orders، /api/portal/loadings، /api/portal/debt — هرکدام company+party-scoped
4. Rate limit: throttler بر اساس partyId (نه IP)
5. Audit: portal_lookup و order_view ثبت شوند
6. Driver/carrier info: مخفی برای پورتال (gate موجود driverInfoRestricted)
7. Frontend: `/portal` — موبایل + OTP + فهرست سفارش‌ها

**معیار پذیرش:** مشتری با موبایل OTP را دریافت و وارد کند؛ سفارش‌های شرکتِ مرتبط با همان شمارهٔ موبایل نمایش داده شود؛ دادهٔ شرکت دیگر هرگز برگردانده نشود؛ driver info مخفی باشد.

**تست‌ها:** integration برای هر endpoint (دو شرکت + دو مشتری)، IDOR بین مشتری‌ها، rate limit، OTP expiry، replay OTP، driver info حذف، company scope.

---

### مرحله ۳ — Import/Export تکمیلی (P1)

**وضعیت فعلی:** PARTIES، DAILY_PRICE، PRODUCT_VARIANT، SALES_DOCUMENT import + parties.csv export
**ناقص:** CONTACTS import، PRODUCTS import (categories/brands/templates)، GOODS_RECEIPTS import، EXPORT برای contacts/products/documents

**اقدام (ترتیب):**
1. CONTACTS import (per-party contacts — natural key: party phone + contact name)
2. EXPORT: contacts.csv، products.csv (templates+variants)، documents.csv
3. GOODS_RECEIPTS import (ورود انبار اولیه — بدون allocation، stock-only)
4. همه از resolveGrid مشترک (CSV+XLSX) و cleanup by-ID الگو

**تست‌ها:** هر entity دو تست (import + validation errors)، company isolation، load test ۵۰۰۰ ردیف برای بزرگ‌ترین entity جدید.

**وابستگی:** ندارد — فرمت CSV از مالک گرفته شود (سرستون‌ها).

---

### مرحله ۴ — بستن سال مالی (P1)

**وضعیت فعلی:**
- FiscalYear/Period + CLOSED status + assertOpenPeriod + opening-balance generate + closingEntryId column در FiscalYear
- **انچه نیست:** Closing Entries (انتقال درآمد/هزینه به سود/زیان)، انتقال سود به سرمایه، تولید خودکار افتتاحیه از سند بسته، قفل دوره پس از بستن

**اقدام (ترتیب):**
1. `POST /api/accounting/fiscal-years/:id/close` — Generate closing entry (Dr REVENUE / Cr INCOME_SUMMARY / Dr EXPENSE_SUMMARY / Cr EXPENSE + net to OPENING_EQUITY) + fiscal-year status → CLOSED + closingEntryId set
2. Reopening: `POST /reopen` (admin-only + reason + audit) — فقط اگر سند مالی جدید در سال بسته نشده
3. Next-year opening: pre-populated از closing (staged rows خودکار از ماندهٔ حساب‌ها)
4. اعتبارسنجی: ماندهٔ همهٔ حساب‌ها در سند بسته متوازن

**معیار پذیرش:** بعد از بستن، posting به هر تاریخی در آن سال → FISCAL_YEAR_CLOSED؛ افتتاحیهٔ سال بعد از مانده‌های حساب‌ها تولید شود؛ reopen با reason ثبت شود.

**تست‌ها:** close→lock→reopen→re-close؛ open-period در سال بسته رد شود؛ ماندهٔ حساب‌ها به افتتاحیهٔ بعد منتقل شود؛ audit بستن ثبت شود.

**وابستگی:** تصمیم مالک — الگوی حساب‌های INCOME_SUMMARY/EXPENSE_SUMMARY به chart اضافه شود یا مستقیم به OPENING_EQUITY.

---

### مرحله ۵ — انبار و بارگیری (P1)

**وضعیت فعلی:** کامل (Phase 6) — تنها ناقص:
1. آپلود تصویر باسکول و اسناد (files.controller موجود ولی به loading وصل نیست)
2. اختلاف وزن باسکول (weighbridge-delta) — actualQuantity از باسکول؛ delta گزارش شود

**اقدام:**
1. اتصال file attachments به loading entity (Post :id/attachments موجود — اتصال به loading + permission loading.edit)
2. گزارش اختلاف وزن: report بر اساس loading lines (ordered vs actual)

**تست‌ها:** integration probe برای attachment-to-loading isolation؛ گزارش اختلاف وزن.

---

### مرحله ۶ — گزارش‌های مدیریتی تکمیلی (P2)

**ناقص:** loadings report variations (weighbridge-delta, incomplete), supplier performance detail, report export

**اقدام:** هر گزارش یک endpoint در ReportsController + تست + UI tab

---

### مرحله ۷ — Treasury تکمیلی (P2)

**ناقص:** bank reconciliation (تطبیق statement با صورتحساب کاغذی)، multi-currency conversion

**اقدام:** پیشنهاد سیاست + تأیید مالک → سپس implementation

---

### مرحله ۸ — Backlog از بازبینی‌ها (P3، بدون تغییر رفتار بدون تأیید)

| مورد | نوع | اقدام |
|---|---|---|
| journal.reverse companyId guard | COVERAGE_GAP | قلم‌گذاری برای hardening بعدی |
| UTC vs Asia/Tehran fiscal day | POLICY_DECISION | مالک تصمیم می‌گیرد |
| Access token ابطال هنگام reset password | POLICY_DECISION | refresh revoked ✓؛ access تا انقضا — مالک تأیید کند |
| Cookie/refresh flow tests | COVERAGE_GAP | تست‌های cookie در Gate C نوشته شد؛ refresh cookie path تست شد |
| gate-c-auth stale test descriptions | COVERAGE_GAP | اصلاح متن تست‌ها |
| gate-c-http minor cleanup | COVERAGE_GAP | بهبود جزئی afterAll |

---

## ترتیب پیاده‌سازی پیشنهادی (Phase ordering)

```
Gate D-1: Moadian Sandbox (نیاز: اعتبارنامه مالک)          ← P0
Gate D-2: Portal مشتری (OTP + session + 3 endpoints + UI)    ← P0
Gate D-3: بستن سال مالی (closing + reopen + next-opening)    ← P1
Gate D-4: Import/Export تکمیلی (contacts + export + GRN)    ← P1
Gate D-5: انبار تکمیلی (attachments + weighbridge-delta)    ← P1
Gate D-6: گزارش‌های تکمیلی + Treasury تکمیلی                ← P2
```

---

## Backlog ثبت‌شده (بدون اقدام در Gate D)

- journal.reverse companyId guard — COVERAGE_GAP
- UTC vs Asia/Tehran fiscal timezone — POLICY_DECISION (مالک)
- Access token ابطال هنگام reset password — POLICY_DECISION (مالک)
- Cookie/refresh flow tests — COVERAGE_GAP (Bearer path covered)
- gate-c-auth stale test descriptions — COVERAGE_GAP (cosmetic)
- Dead-letter UI برای operator — P3
- XLSX reader upgrade — P3

---

## خروجی مورد انتظار پس از Gate D

پس از تکمیل همهٔ مرحله‌ها:
- مشتری می‌تواند از پورتال وارد شود و سفارش/بارگیری/بدهی خود را ببیند
- فاکتور رسمی روی sandbox مودیان ارسال و تأیید شود
- سال مالی بسته و افتتاحیهٔ سال بعد تولید شود
- داده‌های اولیه از CSV/XLSX وارد شوند
- اختلاف وزن و فایل‌های بارگیری در سیستم ثبت و گزارش شوند
- همهٔ ۵۰+ کنترلر تست‌شده و تاییدشده باشند
