# TCERP2 — Portal Design Addendum (D-2 Final Contract)

> این سند پنج نقطهٔ باقی‌مانده از طراحی D-2 را نهایی می‌کند.
> تأیید مالک پیش از پیاده‌سازی الزامی است.

---

## ۱. PENDING_SELECTION — مدل امن

### مشکل
پس از verify-otp، اگر بیش از یک PortalAccount ACTIVE با همان موبایل وجود داشته باشد، کاربر باید انتخاب کند. یک توکن موقت کوتاه‌عمر لازم است که:
- فقط به portalAccountIds تأییدشده محدود باشد
- یک‌بار مصرف باشد (انتخاب → مصرف → session نهایی)
- انقضای کوتاه داشته باشد (۵ دقیقه)

### مدل داده

**جدول `portal_pending_selections`** (Migration جدید):

```sql
CREATE TABLE portal_pending_selections (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash   CHAR(64) NOT NULL UNIQUE,   -- HMAC-SHA256(secret, rawToken)
  portal_account_ids UUID[] NOT NULL,      -- آرایهٔ IDهای مجاز (تأییدشده)
  consumed     BOOLEAN DEFAULT FALSE,       -- یک‌بار مصرف
  expires_at   TIMESTAMPTZ(6) NOT NULL,     -- now + 5 minutes
  created_at   TIMESTAMPTZ(6) DEFAULT now()
);
```

### API Contract

| Method | Path | Request | Response |
|---|---|---|---|
| — | (verify-otp → multi) | — | Set-Cookie: `portal_pending=<rawToken>` + JSON `{pendingSelection: [{portalAccountId, companyName}]}` |
| POST | /api/portal/select-company | Cookie: `portal_pending=<raw>` + Body: `{portalAccountId}` | Set-Cookie: `portal_session=<raw>` (ACTIVE_SESSION) + JSON `{companyId, partyId}` |

### جریان اتمیک select-company

```typescript
await prisma.$transaction(async (trx) => {
  // 1. CAS: pending selection را یک‌بار مصرف کن
  const pending = await trx.portalPendingSelection.updateMany({
    where: { tokenHash: hash(rawPending), consumed: false, expiresAt: { gt: new Date() } },
    data: { consumed: true },
  });
  if (pending.count === 0) throw new UnauthorizedError('Selection expired or already used');

  // 2. بررسی اینکه portalAccountId انتخابی در لیست مجاز است
  const account = await trx.portalAccount.findFirstOrThrow({
    where: { id: selectedAccountId, status: 'ACTIVE', companyId: { not: null } },
  });
  if (!pendingRow.portalAccountIds.includes(account.id)) {
    throw new ForbiddenError('Portal account not in selection list');
  }

  // 3. Session نهایی بساز
  const sessionToken = randomBytes(48).toString('hex');
  await trx.portalSession.create({
    data: {
      portalAccountId: account.id,
      tokenHash: hmac(sessionToken),
      expiresAt: new Date(Date.now() + 24 * 86_400_000),
    },
  });
  return sessionToken;
});
```

### حالت‌های خطا

| خطا | Status | شرط |
|---|---|---|
| SELECTION_EXPIRED | 401 | pending token منقضی یا مصرف‌شده |
| PORTAL_ACCOUNT_NOT_ALLOWED | 403 | portalAccountId خارج از لیست مجاز |
| PORTAL_ACCOUNT_SUSPENDED | 403 | status=SUSPENDED پس از verify |

---

## ۲. فعال‌سازی اولیه PortalAccount (PENDING → ACTIVE)

### تناقض رفع‌شده

PortalAccount با status=PENDING ساخته می‌شود (توسط admin) اما OTP فقط برای ACTIVE accounts ارسال می‌شود — پس چگونه PENDING → ACTIVE می‌شود؟

**طرح:** فعال‌سازی **دو مرحله‌ایِ admin-driven** است (نه OTP-driven):

1. Admin یک PortalAccount می‌سازد (PENDING) با verifiedMobile مشخص
2. Admin وضعیت را ACTIVE می‌کند (`PATCH /api/portal-accounts/:id/status` — permission: `portal.manage`)
3. حالا مشتری می‌تواند OTP بگیرد و login کند

**OTP فقط برای ACTIVE accounts کار می‌کند** — PENDING accounts نمی‌توانند OTP بگیرند. این تناقض رفع شد: OTP مسیر login است، نه فعال‌سازی.

### API Contract

| Method | Path | Permission | Body | Response |
|---|---|---|---|---|
| POST | /api/portal-accounts | portal.manage | {companyId, partyId, verifiedMobile} | PortalAccount (PENDING) |
| PATCH | /api/portal-accounts/:id/status | portal.manage | {status: 'ACTIVE' \| 'SUSPENDED'} | PortalAccount |

### تست پذیرش
- PENDING account → verify-otp → رد (پیام یکنواخت)
- Admin → ACTIVE → verify-otp → موفق
- Admin → SUSPENDED → session قبلی بلافاصله رد

---

## ۳. بررسی Per-Request: PortalAccount.status و Company/Party

### مشکل
JwtAuthGuard وضعیت کاربر (User.status) را بررسی می‌کند، ولی PortalAccount.status (ACTIVE/SUSPENDED) و شرکت/پارتی را در هر درخواست بررسی نمی‌کند. SUSPENDED شدن بعد از login باید دسترسی نشست قبلی را فوراً رد کند.

### راه‌حل: PortalAuthGuard (جدید، غیر-Public مسیرهای /api/portal)

```typescript
@Injectable()
export class PortalAuthGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const token = request.cookies?.['portal_session'];
    if (!token) throw new UnauthorizedError('Portal session required');

    const tokenHash = hmac(token);
    const session = await this.prisma.portalSession.findUnique({
      where: { tokenHash },
      include: { portalAccount: { include: { party: { include: { company: true } }, company: true } } },
    });

    // Session expiry
    if (!session || session.expiresAt < new Date()) throw new UnauthorizedError('Portal session expired');

    // R6-S3: PortalAccount.status — SUSPENDED/PENDING بلافاصله رد می‌کند
    if (session.portalAccount.status !== 'ACTIVE') {
      throw new ForbiddenError('Portal account is not active');
    }

    // User.status نیز بررسی شود (JWT guard را دور می‌زنیم — portal از cookie استفاده می‌کند)
    if (session.portalAccount.company.status !== 'ACTIVE') {
      throw new ForbiddenError('Company is not active');
    }

    request.portalSession = session;
    return true;
  }
}
```

این گارد به **هر endpoint /api/portal/** (به‌جز request-otp و verify-otp) متصل می‌شود و در هر درخواست:
- PortalAccount.status چک می‌شود
- Company.status چک می‌شود
- Party وجود و ARCHIVED نبودن چک می‌شود

**SUSPENDED شدن → از همان درخواست بعدی 403.**

---

## ۴. OTP Validation دقیق

### جریان verify-otp (اتمیک)

```typescript
async verifyOtp(mobile: string, challengeId: string, code: string): Promise<void> {
  const codeHmac = hmac(challengeId + code);
  const now = new Date();

  // اتمیک: مصرف کد (فقط اگر معتبر، منقضی نشده، مصرف نشده، تلاش < ۳)
  const consumed = await this.prisma.portalOtpCode.updateMany({
    where: {
      mobile,
      challengeId,
      codeHmac,
      consumed: false,
      attempts: { lt: 3 },
      expiresAt: { gt: now },
    },
    data: { consumed: true },
  });
  if (consumed.count === 0) throw new UnauthorizedError('INVALID_OTP');

  // اگر موفق → session selection شروع می‌شود
}
```

### تلاش ناموفق (کد اشتباه)

```typescript
// کد HMAC مطابقت ندارد → attempts را اتمیک increment کن
const failed = await this.prisma.portalOtpCode.updateMany({
  where: { mobile, challengeId, consumed: false, attempts: { lt: 3 } },
  data: { attempts: { increment: 1 } },
});
if (failed.count === 0) throw new UnauthorizedError('INVALID_OTP');
```

### Resend

```typescript
// کد قبلی باطل (اتمیک) + کد جدید با challengeId جدید
await this.prisma.portalOtpCode.updateMany({
  where: { mobile, challengeId: oldChallengeId, consumed: false },
  data: { consumed: true }, // یا حذف فیزیکی
});
// سپس challengeId جدید + کد جدید
```

### تست دو Verify هم‌زمان

دو درخواست verify-otp هم‌زمان با یک challengeId و یک کد صحیح:
- `updateMany` در PostgreSQL اتمیک است — فقط یکی count=1 می‌گیرد
- دیگری count=0 → 'INVALID_OTP'
- تست: دو Promise.allSettled → دقیقاً یکی resolve

---

## ۵. CSRF و CORS

### SameSite=Lax کافی است؟

**برای JSON API بله**، اما نه به‌تنهایی:
- SameSite=Lax: مرورگر cookie را فقط در same-site requests می‌فرستد (cross-site POST → cookie ارسال نمی‌شود)
- JSON-only: فرم HTML cross-site نمی‌تواند `Content-Type: application/json` بفرستد
- ولی: cross-site fetch با `credentials: 'include'` ممکن است (اگر CORS اجازه دهد)

### CORS Configuration

```typescript
app.enableCors({
  origin: ['https://erp.company.com'], // فقط دامنهٔ مجاز
  credentials: true,                    // برای cookie-based auth
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-company-id'],
});
```

- **origin wildcard ممنوع** (`*` با `credentials: true` کار نمی‌کند)
- Portal origin جداگانه (اگر پورتال روی دامنهٔ متفاوت باشد): اضافه به whitelist

### Fetch Metadata (Sec-Fetch-Site)

```typescript
// در یک middleware قبل از guards:
const fetchSite = request.headers['sec-fetch-site'];
if (fetchSite && !['same-origin', 'same-site', 'none'].includes(fetchSite)) {
  throw new ForbiddenError('Cross-site request rejected');
}
```

این لایهٔ دفاعی دوم است — مرورگرهای مدرن `Sec-Fetch-Site` می‌فرستند.

### تست پذیرش CSRF

1. درخواست cross-origin با `Origin: https://evil.com` → رد (CORS)
2. درخواست بدون `Sec-Fetch-Site` header (مرورگر قدیمی) → SameSite=Lax جلوی cookie را می‌گیرد
3. درخواست JSON با `Content-Type: text/plain` → رد (NestJS JSON body parser)

---

## ۶. Migration نهایی (بازنگری‌شده)

```sql
-- Migration: 20241105000000_portal_auth
CREATE TABLE portal_otp_codes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mobile        VARCHAR(20) NOT NULL,
  challenge_id  UUID NOT NULL UNIQUE,
  code_hmac     CHAR(64) NOT NULL,
  attempts      INT DEFAULT 0,
  consumed      BOOLEAN DEFAULT FALSE,
  expires_at    TIMESTAMPTZ(6) NOT NULL,
  created_at    TIMESTAMPTZ(6) DEFAULT now()
);
CREATE INDEX idx_portal_otp_mobile ON portal_otp_codes(mobile, expires_at);

CREATE TABLE portal_pending_selections (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash          CHAR(64) NOT NULL UNIQUE,
  portal_account_ids  UUID[] NOT NULL,
  consumed            BOOLEAN DEFAULT FALSE,
  expires_at          TIMESTAMPTZ(6) NOT NULL,
  created_at          TIMESTAMPTZ(6) DEFAULT now()
);

CREATE TABLE portal_sessions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash         CHAR(64) NOT NULL UNIQUE,
  portal_account_id  UUID NOT NULL REFERENCES portal_accounts(id),
  created_at         TIMESTAMPTZ(6) DEFAULT now(),
  expires_at         TIMESTAMPTZ(6) NOT NULL
);
CREATE INDEX idx_portal_sessions_account ON portal_sessions(portal_account_id, expires_at);
```

سه جدول جدید — بدون تغییر جدول‌های موجود.
