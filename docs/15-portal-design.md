# TCERP2 — مستند طراحی پورتال مشتری (Gate D-2)

> این سند برای تأیید مالک ارائه می‌شود — هیچ کدی پیاده‌سازی نمی‌شود تا تأیید دریافت شود.

---

## ۱. هویت مشتری و ارتباط با Party و Company

پورتال بر اساس `Party` (طرف‌حساب با نقش CUSTOMER) عمل می‌کند. یک موبایل تأییدشده ممکن است به چند `Party` در چند `Company` مرتبط باشد:

```
Party (companyId=X, mobile=0912..., role=CUSTOMER)
Party (companyId=Y, mobile=0912..., role=CUSTOMER)
```

پس از تأیید OTP، اگر بیش از یک (companyId, partyId) یافت شود، کاربر انتخاب می‌کند.
Session به یک جفت (companyId, partyId) مقید می‌شود — تغییر شرکت = login مجدد با همان OTP.

---

## ۲. شماره موبایل تأییدشده

- منبع: `PartyPhone` با `kind=MOBILE` و `isPrimary=true` — شماره نرمال‌شده (normalizeIranMobile)
- شرط: پارتی باید CUSTOMER باشد و `archivedAt IS NULL` و شرکت `ACTIVE`
- موبایل‌های تکراری بین پارتی‌ها: مجاز (هر پارتی مستقل است) — portal lookup هر دو را می‌یابد
- **جلوگیری از اتصال خودکار شمارهٔ مبهم:** اگر یک موبایل به چند پارتی متصل باشد، portal lookup تنها {matched, linked} را برمی‌گرداند و سشن بدون انتخاب صریح کاربر ساخته نمی‌شود

---

## ۳. OTP

| پارامتر | مقدار | توضیح |
|---|---|---|
| طول کد | ۶ رقم | `crypto.randomInt(100000, 999999)` |
| TTL | ۲ دقیقه | پس از انقضا رد می‌شود |
| حداکثر تلاش | ۳ | بعد از ۳ تلاش ناموفق، کد باطل و باید درخواست جدید |
| Rate limit | ۱ درخواست در دقیقه | به‌ازای هر شماره موبایل |
| ذخیره‌سازی | hash (sha256) در جدول `portal_otp_codes` | کد خام هرگز ذخیره نمی‌شود |
| Replay | کد مصرف‌شده بلافاصله حذف می‌شود | استفادهٔ مجدد → رد |
| حملات暴力 | Rate limit + max attempts | بریوت‌فورس ۶ رقم = ۱M حالت — با rate limit و ۳ تلاش عملاً غیرممکن |

### جریان
1. `POST /api/portal/request-otp` body: `{mobile, companyId?}` — نرمال‌سازی → lookup پارتی‌های CUSTOMER با این موبایل → اگر هیچ: **پیام یکسان** «کد ارسال شد» (بدون افشا) → تولید کد → ذخیرهٔ hash → ارسال SMS
2. `POST /api/portal/verify-otp` body: `{mobile, code}` — بررسی hash + TTL + تلاش → اگر موفق: ساخت session → Set-Cookie → بازگرداندن {companyId, partyId, companyName} (بدون دادهٔ مالی)

---

## ۴. Session

| پارامتر | مقدار |
|---|---|
| Token | ۴۸ بایت تصادفی (hex) |
| ذخیره‌سازی | `portal_sessions` جدول — `tokenHash` (sha256)، `companyId`، `partyId`، `expiresAt` |
| Cookie | `portal_session` HttpOnly + SameSite=Lax + path=/api/portal + TTL ۲۴ ساعت |
| Logout | `POST /api/portal/logout` → حذف session row + clearCookie |
| Revocation | حذف session → درخواست‌های بعدی 401 |

---

## ۵. جلوگیری از Enumeration شماره موبایل

- درخواست OTP و verify-OTP: پیام خطای **یکنواخت** برای «شماره یافت نشد»، «کد اشتباه»، «کد منقضی»
- `portalLookup` تنها {matched, linked} برمی‌گرداند — بدون نام، بدهی، شناسه
- اگر یک موبایل در هیچ شرکتی نباشد: همان پیام «کد ارسال شد» (بدون ساخت کد واقعی — یا با ساخت کد بی‌اثر)

---

## ۶. Company + Party Scope در هر Query

هر query سرویس پورتال صراحتاً `companyId` و `partyId` را از session می‌گیرد:

```typescript
const orders = await prisma.salesDocument.findMany({
  where: { companyId: session.companyId, customerPartyId: session.partyId },
});
```

IDOR غیرممکن است چون session به یک (companyId, partyId) مقید است و query از session می‌خواند نه از ورودی کاربر.

---

## ۷. سفارش‌ها، بارگیری‌ها و مانده بدهی قابل نمایش

| داده | منبع | فیلتر |
|---|---|---|
| سفارش‌های فروش | `salesDocument` + `salesLine` | `companyId + customerPartyId` |
| بارگیری‌های مرتبط | `loading` (via loadingLine → allocation → salesLine → salesDocument) | همان scope |
| ماندهٔ بدهی | `partyOperationalBalance` | `companyId + partyId` |
| فایل‌های سفارش | `file` + `fileEntity` | `entityType='sales_document'` + documentId |
| وضعیت فاکتور مؤدیان | `salesTaxInvoice` | documentId |

---

## ۸. حذف اطلاعات محرمانه

| داده | وضعیت در پورتال |
|---|---|
| نام راننده / شماره تماس | مخفی (`driverInfoRestricted` gate موجود) |
| نام تأمین‌کننده | مخفی (allocations فقط برای داخلی) |
| قیمت خرید / حاشیه سود | مخفی |
| اسناد حسابداری داخلی | مخفی |
| شناسهٔ پارتی‌های دیگر | مخفی |

---

## ۹. مدل داده (Migration افزایشی)

```sql
-- Migration: 20241104000000_portal_auth
CREATE TABLE portal_otp_codes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mobile      VARCHAR(20) NOT NULL,
  code_hash   CHAR(64) NOT NULL,  -- sha256 hex
  attempts    INT DEFAULT 0,
  expires_at  TIMESTAMPTZ(6) NOT NULL,
  created_at  TIMESTAMPTZ(6) DEFAULT now()
);
CREATE INDEX idx_portal_otp_mobile ON portal_otp_codes(mobile, expires_at);

CREATE TABLE portal_sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash  CHAR(64) NOT NULL UNIQUE,
  company_id  UUID NOT NULL REFERENCES companies(id),
  party_id    UUID NOT NULL REFERENCES parties(id),
  created_at  TIMESTAMPTZ(6) DEFAULT now(),
  expires_at  TIMESTAMPTZ(6) NOT NULL
);
CREATE INDEX idx_portal_sessions_party ON portal_sessions(party_id, expires_at);
```

هر دو جدول جدید — بدون تغییر جدول‌های موجود. تست Rollback: `prisma migrate deploy` روی DB خالی و DB موجود.

---

## ۱۰. API Contract

| Method | Path | Auth | Body/Query | Response |
|---|---|---|---|---|
| POST | /api/portal/request-otp | @Public | {mobile, companyId?} | {sent: true} |
| POST | /api/portal/verify-otp | @Public | {mobile, code} | {token, companies: [{companyId, partyId, nameFa}]} |
| POST | /api/portal/select-company | @Public (session) | {companyId} | {companyId, partyId} |
| GET | /api/portal/me | portal session | — | {partyId, companyId, companyName} |
| GET | /api/portal/orders | portal session | ?status=&limit= | {items} |
| GET | /api/portal/loadings | portal session | ?salesDocumentId= | {items} |
| GET | /api/portal/debt | portal session | — | {balance, currency} |
| POST | /api/portal/logout | portal session | — | {success: true} |

---

## ۱۱. تست HTTP واقعی و IDOR

- **دو شرکت مستقل:** مشتری A و مشتری B — session شرکت A نمی‌تواند دادهٔ شرکت B را ببیند
- **دو مشتری در یک شرکت:** session مشتری ۱ نمی‌تواند سفارش مشتری ۲ را ببیند
- **OTP enumeration:** درخواست OTP برای موبایل ناموجود → همان پیام «کد ارسال شد»
- **OTP replay:** استفادهٔ مجدد کد مصرف‌شده → رد
- **OTP brute force:** ۴ تلاش ناموفق → کد باطل
- **Session revocation:** logout → درخواست‌های بعدی 401
- **Driver info:** پاسخ پورتال شامل نام/شمارهٔ راننده نیست

---

## ۱۲. UI واکنش‌گرا

صفحهٔ `/portal` — Next.js mobile-first:
- صفحهٔ ورود: فیلد موبایل → دکمهٔ دریافت کد → فیلد کد → دکمهٔ ورود
- اگر چند شرکت: dropdown انتخاب شرکت
- فهرست سفارش‌ها: کارت با وضعیت، تاریخ، مبلغ کل
- جزئیات سفارش: ردیف‌ها + بارگیری‌های مرتبط + فایل‌ها
- بدهی: ماندهٔ عملیاتی
- RTL + فارسی + responsive (breakpoints مشترک با اپ اصلی)

---

## ۱۳. Migration Rollback

Migration افزایشی (۲ جدول جدید). تست: `prisma migrate deploy` روی DB خالی → apply؛ روی DB موجود → apply بدون خطا؛ rollback = `DROP TABLE portal_otp_codes, portal_sessions` — دادهٔ موجود حفظ می‌شود.
