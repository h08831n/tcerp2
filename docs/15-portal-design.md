# TCERP2 — مستند طراحی پورتال مشتری (Gate D-2) — v2 revised

> این سند برای تأیید مالک ارائه می‌شود — هیچ کدی پیاده‌سازی نمی‌شود تا تأیید دریافت شود.
> v2: اصلاح Session state machine، HMAC OTP، تطبیق با PortalAccount/PartyPhone/FileBlob موجود، API contract بازنگری‌شده، Migration بازنگری‌شده.

---

## ۱. هویت مشتری و ارتباط با PortalAccount

پورتال بر اساس **PortalAccount** (مدل موجود در schema — company_id + party_id + verified_mobile + status) عمل می‌کند. PortalAccount Status enum: `PENDING | ACTIVE | SUSPENDED`.

- PENDING: ثبت‌شده ولی موبایل تأیید نشده → نمی‌تواند session بسازد
- ACTIVE: موبایل تأیید شده → مجاز به login
- SUSPENDED: توسط admin مسدود → login رد می‌شود

**جریان تأیید:** PortalAccount به‌صورت PENDING توسط admin ساخته می‌شود (users.reset_password pattern) → OTP verify → status → ACTIVE.

**چند-شرکتی:** یک موبایل می‌تواند در چند PortalAccount (هر کدام با companyId متفاوت) باشد — constraint `@@unique([companyId, verifiedMobile])` تضمین می‌کند در هر شرکت فقط یک PortalAccount برای هر موبایل وجود دارد.

**isPrimary در PartyPhone ≠ verified:** PortalAccount.verifiedMobile مستقل است و توسط admin تنظیم می‌شود — نه از PartyPhone.isPrimary.

---

## ۲. State Machine دقیق

```
REQUEST_OTP → VERIFY_OTP → [single account] → ACTIVE_SESSION
                            → [multiple accounts] → PENDING_SELECTION → (select) → ACTIVE_SESSION
```

| State | توضیح |
|---|---|
| REQUEST_OTP | کاربر شماره موبایل می‌دهد؛ کد ارسال می‌شود |
| VERIFY_OTP | کاربر کد را ارسال می‌کند؛ درستی بررسی می‌شود |
| PENDING_SELECTION | بیش از یک PortalAccount فعال با این موبایل — کاربر باید انتخاب کند |
| ACTIVE_SESSION | session نهایی به (companyId, partyId) مقید شده |

- اگر فقط یک PortalAccount ACTIVE با این موبایل باشد → پرش مستقیم به ACTIVE_SESSION
- اگر هیچ PortalAccount ACTIVE وجود نداشته باشد (PENDING/SUSPENDED/نبودن) → پیام یکنواخت «کد ارسال شد» (بدون افشا) — ولی session ساخته نمی‌شود

---

## ۳. OTP امن

| پارامتر | مقدار | توضیح |
|---|---|---|
| طول کد | ۶ رقم | `crypto.randomInt(100000, 999999)` |
| TTL | ۲ دقیقه | |
| حداکثر تلاش | ۳ | اتمیک: `updateMany({ where: { attempts: { lt: 3 } } })` — اگر count=0، کد باطل شده |
| HMAC | `HMAC-SHA256(serverSecret, challengeId + code)` | به‌جای sha256 ساده — secret سرور از config |
| Challenge ID | UUID تصادفی | در response ارسال می‌شود؛ verify-otp نیاز به challengeId دارد |
| مصرف اتمیک | `updateMany({ where: { consumed: false, attempts: { lt: 3 } }, data: { consumed: true } })` | اگر count=0 → قبلاً مصرف شده یا باطل |
| Rate limit | ۱ درخواست OTP در دقیقه به‌ازای هر موبایل + ۱۰ در ساعت به‌ازای هر IP | |
| Replay | کد مصرف‌شده → consumed=true → رد | |
| Resend | کد قبلی باطل (consumed=true) + کد جدید با challengeId جدید | |
| ذخیره‌سازی | HMAC hash در DB؛ **کد خام هرگز** | |

### جلوگیری از Enumeration
پیام خطای **یکنواخت** برای: موبایل ناموجود، کد اشتباه، کد منقضی، تلاش بیش از حد. response: `{error: 'INVALID_OTP'}` — بدون تفکیک علت.

---

## ۴. Session

| پارامتر | مقدار |
|---|---|
| Token | ۴۸ بایت تصادفی (hex) |
| ذخیره‌سازی | hash (HMAC-SHA256 با serverSecret) در `portal_sessions.tokenHash` |
| Cookie | `portal_session` HttpOnly + SameSite=Lax + path=/api/portal + TTL ۲۴ ساعت |
| Secure | در production (`NODE_ENV=production` → `secure: true`) |
| Logout | حذف session row + clearCookie |
| CSRF | SameSite=Lax + JSON-only API + Content-Type check — فرم HTML cross-site نمی‌تواند JSON با Content-Type درست بفرستد |

**Token خام هرگز در response JSON برنمی‌گردد** — فقط از طریق Set-Cookie header.

---

## ۵. CSRF برای مسیرهای Cookie-based

- SameSite=Lax: مرورگر cookie را فقط در درخواست‌های same-site و top-level GET navigation می‌فرستد
- JSON-only API: `Content-Type: application/json` از فرم HTML cross-site قابل ارسال نیست
- Refresh/login از مسیر cookie-scoped (/api/auth و /api/portal) — خطر CSRF محدود به همان مسیرها
- **تصمیم:** CSRF token اضافی لازم نیست (SameSite=Lax کافی برای JSON API)؛ اگر در آینده فرم HTML اضافه شود، reconsider شود

---

## ۶. Company + Party Scope

هر query از session می‌خواند (نه از ورودی کاربر):

```typescript
const session = await prisma.portalSession.findUnique({
  where: { tokenHash: hash },
  include: { portalAccount: { include: { party: true, company: true } } },
});
if (!session || session.expiresAt < new Date()) throw new UnauthorizedError('Session expired');
// session.portalAccount.companyId و session.portalAccount.partyId از DB می‌آیند
```

---

## ۷. داده‌های قابل نمایش

| داده | منبع (روابط Prisma واقعی) |
|---|---|
| سفارش‌های فروش | `salesDocument.findMany({ where: { companyId: pa.companyId, customerPartyId: pa.partyId } })` |
| بارگیری‌های مرتبط | `loading.findMany({ where: { companyId: pa.companyId, customerPartyId: pa.partyId } })` |
| ماندهٔ بدهی | `partyOperationalBalance.findUnique({ where: { companyId_partyId: { companyId: pa.companyId, partyId: pa.partyId } } })` |
| فایل‌های متصل | `fileAttachment.findMany({ where: { companyId: pa.companyId, entityType: 'sales_document', entityId: { in: salesDocIds } } })` + `fileBlob.findMany` |

**مخفی:** راننده (driverInfoRestricted gate موجود)، تأمین‌کننده، قیمت خرید، حاشیه سود، اسناد حسابداری، شناسهٔ پارتی‌های دیگر

---

## ۸. مدل داده (Migration افزایشی — بازنگری‌شده)

تغییرات فقط **جدول‌های جدید** هستند. `PortalAccount` موجود استفاده می‌شود.

```sql
-- Migration: 20241105000000_portal_auth
CREATE TABLE portal_otp_codes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mobile        VARCHAR(20) NOT NULL,       -- نرمال‌شده
  challenge_id  UUID NOT NULL UNIQUE,       -- هر challenge یک کد
  code_hmac     CHAR(64) NOT NULL,          -- HMAC-SHA256(secret, challengeId + code)
  attempts      INT DEFAULT 0,
  consumed      BOOLEAN DEFAULT FALSE,
  expires_at    TIMESTAMPTZ(6) NOT NULL,
  created_at    TIMESTAMPTZ(6) DEFAULT now()
);
CREATE INDEX idx_portal_otp_mobile ON portal_otp_codes(mobile, expires_at);

CREATE TABLE portal_sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash   CHAR(64) NOT NULL UNIQUE,   -- HMAC-SHA256(secret, token)
  portal_account_id UUID NOT NULL REFERENCES portal_accounts(id),
  created_at   TIMESTAMPTZ(6) DEFAULT now(),
  expires_at   TIMESTAMPTZ(6) NOT NULL
);
CREATE INDEX idx_portal_sessions_account ON portal_sessions(portal_account_id, expires_at);
```

---

## ۹. API Contract (بازنگری‌شده)

| Method | Path | Auth | Body/Query | Response |
|---|---|---|---|---|
| POST | /api/portal/request-otp | @Public | {mobile} | {challengeId, sent: true} |
| POST | /api/portal/verify-otp | @Public | {mobile, challengeId, code} | single: Set-Cookie + {portalAccountId} — multi: {pendingSelection: [{portalAccountId, companyName}]} |
| POST | /api/portal/select-company | @Public + PENDING_SELECTION cookie | {portalAccountId} | Set-Cookie (ACTIVE_SESSION) + {companyId, partyId} |
| GET | /api/portal/me | ACTIVE_SESSION | — | {partyId, companyId, companyName} |
| GET | /api/portal/orders | ACTIVE_SESSION | ?status=&limit= | {items} |
| GET | /api/portal/loadings | ACTIVE_SESSION | ?salesDocumentId= | {items} |
| GET | /api/portal/debt | ACTIVE_SESSION | — | {balance, currency} |
| POST | /api/portal/logout | ACTIVE_SESSION | — | {success: true} |

---

## ۱۰. تست HTTP واقعی و IDOR (acceptance criteria)

- **دو شرکت مستقل:** session شرکت A نمی‌تواند دادهٔ شرکت B را ببیند (x-company-id forgery هم)
- **دو مشتری در یک شرکت:** session مشتری ۱ نمی‌تواند سفارش مشتری ۲ را ببیند
- **OTP enumeration:** درخواست OTP برای موبایل ناموجود → همان پیام
- **OTP replay:** کد مصرف‌شده → رد
- **OTP brute force:** ۴ تلاش ناموفق → کد باطل
- **Session revocation:** logout → درخواست‌های بعدی 401
- **Driver info:** پاسخ پورتال شامل نام/شمارهٔ راننده نیست
- **DISABLED PortalAccount (SUSPENDED):** login رد می‌شود
- **Concurrent verify:** دو درخواست verify هم‌زمان با یک challengeId → فقط یکی موفق

---

## ۱۱. Migration Rollback

| سناریو | اقدام |
|---|---|
| DB خالی | `migrate deploy` → apply؛ rollback = `DROP TABLE portal_otp_codes, portal_sessions` |
| DB دارای داده (قبل از ورود اطلاعات عملیاتی) | `migrate deploy` → apply؛ rollback = `DROP TABLE` (فقط جداول جدید — دادهٔ عملیاتی حفظ) |
| DB دارای دادهٔ عملیاتی (پس از portal go-live) | rollback = `DROP TABLE` → sessionها و OTPهای فعال حذف می‌شوند ولی دادهٔ عملیاتی (parties/sales/documents) حفظ می‌شود. کاربران باید دوباره OTP بگیرند. |

**DROP TABLE هرگز به‌عنوان Rollback ایمن بعد از ورود اطلاعات واقعی معرفی نمی‌شود** — فقط فقدان دادهٔ عملیاتی آن را مجاز می‌کند.
