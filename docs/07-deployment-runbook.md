# Deployment Runbook — Prisma Migrations (TCERP)

This runbook covers the safe application of forward-only Prisma migrations
(current pending item at release time: `20241021000000_journal_source_event_id`
— adds `journal_entries.source_event_id UUID NULL` + a UNIQUE index).

## وضعیت محیط‌ها (Release Gate 2026-10-21)

| محیط | وضعیت migration | اقدام |
|---|---|---|
| `tcerp_test` (محلی + CI) | ✅ اعمال شده (migrate deploy در CI) | نیازی به اقدام نیست |
| `tcerp` (توسعه محلی) | ❌ اعمال نشده — عمداً (بدون مجوز) | گام ۱ زیر، پس از بکاپ |
| استقرار/production | — | گام‌های ۱–۶ پیش از اولین ریلیز |

⚠️ بک‌اندِ جدید `source_event_id` را در `journal.post` می‌نویسد؛ تا قبل از
اعمال migration روی یک محیط، emit رویدادها روی همان محیط خطا می‌دهد.
**اول migration، بعد کد جدید.**

## گام‌های امن اجرا

### ۱. بکاپ — نام فایل دقیق، بررسی پوشه، اعتبارسنجی همان فایل

```bash
BACKUP_DIR="backups"
BACKUP_FILE="$BACKUP_DIR/tcerp-backup-$(date +%F-%H%M%S).dump"
mkdir -p "$BACKUP_DIR" || { echo "ABORT: مسیر بکاپ ساخته نشد"; exit 1; }
docker exec tcerp-postgres pg_dump -U tcerp -d tcerp -Fc > "$BACKUP_FILE"
```

**اعتبارسنجی همان فایل — اجباری؛ در صورت نامعتبر بودن، ادامه ممنوع:**

```bash
[ -s "$BACKUP_FILE" ] || { echo "ABORT: بکاپ خالی است"; exit 1; }
docker exec -i tcerp-postgres pg_restore --list "$BACKUP_FILE" > /dev/null \
  || { echo "ABORT: آرشیو pg_restore قابل خواندن نیست — بکاپ نامعتبر"; exit 1; }
docker exec -i tcerp-postgres pg_restore --list "$BACKUP_FILE" | grep -cE "TABLE DATA (public\\.)(journal_entries|accounting_events|companies)" \
  || { echo "ABORT: جدول‌های کلیدی در آرشیو نیست — بکاپ ناقص"; exit 1; }
```

شرط ادامه: هر سه گام بدون ABORT — یعنی فایل نام‌برده، همین فایلِ تأییدشده است.
شمارش‌های قبل از migration را ثبت کنید:
`SELECT COUNT(*) FROM journal_entries;` و `SELECT COUNT(*) FROM accounting_events;`
برای محیط استقرار به‌جای docker از snapshot/ابزار بکاپ همان محیط استفاده شود —
اصل، اثبات خوانا بودن **همان فایل نام‌برده** است.

#### ۱-ب. drill تأییدشدهٔ Restore (فاز ۱۱ / Gate G — اجرا و تأیید ۲۰۲۶-۱۰-۳۱)

restor پذیرفته‌شدن بکاپ را با یک **رستور واقعی به دیتابیس scratch** اثبات می‌کند —
خوانا بودن فایل به‌تنهایی کافی نیست. دستورات تأییدشده (کالسل تست tcerp_test):

```bash
# ۱) dump (plain-SQL، بدون owner/privileges تا رستور مستقل از roleها باشد)
docker exec tcerp-postgres pg_dump -U tcerp -d tcerp_test --no-owner --no-privileges > drill.sql

# ۲) رستور به دیتابیس scratch تازه
psql -U tcerp -d postgres -c "DROP DATABASE IF EXISTS tcerp_restore_drill; CREATE DATABASE tcerp_restore_drill;"
psql -U tcerp -d tcerp_restore_drill -f drill.sql   # باید بدون ERROR تمام شود

# ۳) راستی‌آزمایی parity (هر چهار مورد باید برابر باشند)
#    - تعداد جدول‌های public (۱۱۳/۱۱۳ در drill ثبت‌شده)
#    - تعداد ردیف جداول کلیدی (companies/parties/journal_entries/audit_logs/…)
#    - _prisma_migrations: ۴۱ ردیف، همه finished_at NOT NULL
#    - pg_constraint (۳۳۲) و pg_indexes (۳۳۸)
#    - جمع مالی: SELECT SUM(debit) FROM journal_lines; (دقیقاً برابر — 3388.0000)
# ۴) پاک‌سازی: DROP DATABASE tcerp_restore_drill;
```

**نتیجهٔ ثبت‌شدهٔ drill**: ۱۱۳/۱۱۳ جدول، هر ۱۳ شمارش کلیدی برابر، ۴۱/۴۱ migration
تکمیل‌شده، جمع `SUM(debit)` journal_lines دقیقاً برابر (۳۳۸۸.۰۰۰۰)،
۳۳۲/۳۳۲ constraint و ۳۳۸/۳۳۸ index — بکاپ واقعاً قابل رستور است.

**نکات**: برای بکاپ‌های زمان‌بندی‌شده تولیدی از فرمت `-Fc` (custom) با
`pg_restore` استفاده شود (بخش ۱ بالا)؛ drill بالا با plain-SQL parity کامل را
قابل مقایسهٔ متنی می‌کند. رستور روی دیتابیس scratch اجرا شود، هرگز روی اصل.

### ۲. توقف ارسال رویداد

سرویس بک‌اند را موقتاً متوقف کنید تا بین migration و استارت بک‌اند جدید،
emit با کد قدیمی اجرا نشود.

### ۳. اعمال (افزایشی و non-destructive)

```bash
cd apps/backend && DATABASE_URL=... npx prisma migrate deploy
```
— فقط migrationهای اعمال‌نشده را به ترتیب اجرا می‌کند؛ `migrate reset` و
`migrate dev` روی این محیط‌ها **ممنوع** است.

### ۴. بررسی موفقیت

- خروجی deploy بدون error و `prisma migrate status` = "Database schema is up to date".
- `\d journal_entries` شامل `source_event_id uuid` و ایندکس
  `journal_entries_source_event_id_key UNIQUE` باشد.
- شمارش‌های گام ۱ برابر قبل باشند (هیچ حذفی رخ نمی‌دهد)؛ ستون جدید همه NULL.

### ۵. استارت بک‌اند جدید

و اجرای یک smoke عملیاتی (بارگیری → سند حسابداری → صفحه `/accounting/events`).

### ۶. برخورد با شکست migration — شواهد فنی و درخت تصمیم

**شواهد آزمایش (محدود به نسخه/شرایط ثبت‌شده — به نسخه‌ها و محیط‌های دیگر
تعمیم داده نشود):**
- نسخه دقیق: **Prisma CLI/Engine 5.22.0** (`npx prisma --version`؛
  `package.json`: `prisma ^5.18.0`، lockfile نصب‌شده 5.22.0)، PostgreSQL 16
  روی Docker محلی.
- دستور آزمایش: `npx prisma migrate deploy` با
  `DATABASE_URL=postgresql://…@localhost:5433/tcerp_shadow` (دیتابیس
  آزمایشی دورریختنی — پس از آزمایش DROP شد) پس از اعمال کامل تاریخچه واقعی.

**۱. محتوای واقعی فایل migration — بدون BEGIN/COMMIT صریح:**
```sql
-- apps/backend/prisma/migrations/20241021000000_journal_source_event_id/migration.sql
-- Durable idempotency key for event-driven postings: …
ALTER TABLE "journal_entries" ADD COLUMN "source_event_id" UUID;
CREATE UNIQUE INDEX "journal_entries_source_event_id_key" ON "journal_entries"("source_event_id");
```

**۱-الف. سازوکار دقیق (از منبع موتور، tag `5.22.0`):**
موتور Prisma **BEGIN/COMMIT صریح نمی‌فرستد** (راستی‌بخشی به نکته مستندات).
اتمیک بودن از پروتکل PostgreSQL می‌آید:
- `schema-engine/connectors/sql-schema-connector/src/flavour/postgres/connection.rs`
  (tag 5.22.0، متد `apply_migration_script`): **کل script فایل در یک فراخوانی
  `client.simple_query(script)`** ارسال می‌شود؛ هیچ دستکاری تراکنشی در کد
  وجود ندارد — خطا صرفاً به `ApplyMigrationError` تبدیل می‌شود.
- مستندات PostgreSQL 16 (§54.2.2.1، protocol-flow): «statements در یک
  multi-statement Query message در یک **implicit transaction block** اجرا
  می‌شوند مگر تراکنش صریحی وجود داشته باشد … implicit block در پایان Query
  message به‌طور خودکار بسته می‌شود — commit در نبود خطا، rollback در صورت
  خطا» و «اجرا از اولین خطا متوقف می‌شود».

**۲. اثبات تجربی مکانیزم (همه روی `tcerp_shadow`، Prisma 5.22.0):**
- **کنترل منفی — autocommit بدون بچ واحد:** اجرای مستقیم
  `ALTER TABLE … ADD COLUMN baseline_col` با psql (هر statement جدا و
  autocommit) و سپس `SELECT 1/0` → شکست، ولی **ستون PERSISTS**. یعنی بدون
  بچ واحد، PostgreSQL DDL را rollback نمی‌کند.
- **شکست در انتهای فایل (ساختار دقیقاً یکسان با فایل واقعی، شناسه‌های
  zzz-prefixed):** `ALTER … ADD COLUMN` + `CREATE UNIQUE INDEX` +
  `SELECT 1/0` → `P3018`، `finished_at = NULL`، **ستون و ایندکس هر دو
  ABSENT**.
- **شکست میانی بین دو دستور مستقل:** `ADD COLUMN zzz_mid_col` + `SELECT 1/0`
  + `CREATE UNIQUE INDEX …zzz…` → `P3018` و **ستون ABSENT و ایندکس ABSENT**
  (هر کدام با کوئری جداگانه بررسی شد) — دقیقاً مطابق پروتکل: اجرا از اولین
  خطا متوقف، کل بچ rollback.
- **کنترل مثبت:** همان migration واقعی بدون شکست در تاریخچه deploy → ستون و
  ایندکس EXIST (مسیر موفق عادی).
- **درس روش‌شناختی (ثبت‌شده):** نخستین تلاش آزمایش با نام‌های بدون پیشوند
  (`source_event_id`) false positive داد — ستون/ایندکس مشاهده‌شده متعلق به
  migration واقعیِ قبلاً-اعمال‌شده بود، نه باقی‌مانده فایل شکست‌خورده. آزمایش
  نهایی با شناسه‌های متمایز (`zzz_`) تکرار شد. همچنین تلاقی رکورد FAILED قبلی
  `P3009` داد که با `migrate resolve --rolled-back zzz_evidence3` حل و سپس
  deploy دوباره اجرا شد (مسیر (ب) زیر — عملاً تمرین شد).

**۳. مسیر بازیابی روی همان state آزمایش شد:**
`prisma migrate resolve --rolled-back zzz_evidence3` رکورد را resolved علامت
زد و `migrate deploy` بعدی کل migration را **از نو و کامل** اجرا کرد (در
آزمایش دوباره P3018 گرفت چون SQL عمداً خراب بود — رفتار صحیح؛ با SQL سالم،
تلاش مجدد موفق می‌شود).

**پیامد عملی برای این فایل: نیازی به BEGIN/COMMIT نیست** — یکتایی بچ
simple-query اتمیک بودن را در همین نسخه تضمین می‌کند. فایل migration
**عمداً بدون BEGIN/COMMIT حفظ می‌شود**: (۱) روی `tcerp_test` و CI قبلاً با
همین محتوا و checksum اعمال شده و تغییر فایلِ اعمال‌شده = mismatch و drift؛
(۲) اگر روزی اجرای صریح تراکنش لازم شد، migration جدیدی با `BEGIN; … COMMIT;`
اضافه شود نه دستکاری فایل قدیمی. **این شواهد فقط برای Prisma 5.22.0 +
PostgreSQL 16 این پروژه معتبر است؛ رفتار پروتکل یا موتور در نسخه‌های بعدی
ممکن است تغییر کند — پیش از ارتقا، آزمایش بالا را روی دیتابیس آزمایشی
تکرار کنید.**

**درخت تصمیم پس از شکست — قبل از هر `resolve` یا اصلاح دستی، دو بررسی
اجباری (واقعیت را تعیین می‌کنند، نه فرض):**
```sql
SELECT migration_name, finished_at, rolled_back_at, logs
FROM _prisma_migrations WHERE migration_name LIKE '%source_event_id%';
\d journal_entries   -- وجود/عدم وجود ستون و ایندکس
```
- **(الف) هیچ چیزی اعمال نشده** (ستون ABSENT، رکورد `finished_at = NULL`)
  → علت خطا (اتصال/قفل/disk) را برطرف کنید و **`prisma migrate deploy` را
  دوباره اجرا کنید** — تراکنش rollback شده از نو و کامل اعمال می‌شود. بدون
  اجرای resolve.
- **(ب) deploy همچنان P3018 می‌دهد و ردیف FAILED مانده** → فقط پس از تأیید
  بررسی بالا که چیزی از این migration اعمال نشده:
  `npx prisma migrate resolve --rolled-back <migration_name>` و سپس deploy
  مجدد (کل migration از نو اجرا می‌شود). هیچ داده‌ای حذف نمی‌شود.
- **(ج) در بررسی، ستون/ایندکس «وجود» دارد ولی رکورد `finished_at = NULL`**
  (فقط در صورت دستکاری دستی خارج از این runbook رخ می‌دهد): ابتدا با
  `information_schema.columns`/`pg_indexes` دقیقاً کدام بخش اعمال شده را
  ثبت کنید، سپس فقط statement باقی‌مانده را دستی و idempotent اجرا کنید
  (`CREATE UNIQUE INDEX IF NOT EXISTS …`) و سپس
  `npx prisma migrate resolve --applied <migration_name>` تا فقط ثبت شود —
  deploy دیگر آن را اجرا نمی‌کند.
- در هیچ شاخه‌ای از `migrate reset`، `DROP` یا حذف داده استفاده نشود؛
  شکست migration به‌خودی‌خود به rollback کامل می‌انجامد (شواهد بالا).

## Rollback

کد قبلی (قبل از `b83f693`) با ستون NULL سازگار است — در صورت نیاز به بازگشت
کد، ستون و ایندکس را حذف نکنید؛ بی‌ضرر است. حذف ستون/ایندکس فقط با تصمیم
صریح مالک محصول انجام شود.


### ۷. Live HTTP Smoke Test (فاز ۱۱ / Gate G — اجرا و تأیید ۲۰۲۶-۱۰-۳۱)

اولین smoke واقعی HTTP پروژه — سرور بوت، کوکی/گارد، CRUD و همهٔ endpointهای
فازهای ۹ تا ۱۱ از طریق HTTP واقعی آزموده شد (تا پیش از این همه‌چیز
service-level بود):

```
# ۱) دیتابیس dedicated: tcerp_shadow (مجاز در db-guard) + migrate + seed
# ۲) بوت: DATABASE_URL=...tcerp_shadow PORT=3001 npm run start
# ۳) نتایج:
#    GET  /api/health                -> 200 (queue counters present)
#    GET  /api/metrics               -> 200 (Prometheus families)
#    GET  /api/parties بدون کوکی     -> 401 (global guard)
#    POST /api/auth/login            -> 200 (کوکی)
#    GET  /api/auth/me               -> 200
#    GET  /api/reports/dashboard|debt-> 200
#    GET  /api/workflow/definitions  -> 200
#    GET  /api/imports               -> 200
#    POST /api/parties               -> 201، GET -> 200، DELETE -> 200
# ۴) پاک‌سازی: توقف سرور + DROP DATABASE tcerp_shadow
```

**Health Check اکنون سرویس‌های واقعی را می‌سنجد (Gate G — همین اسلایس):**
`GET /api/health` علاوه بر DB، **Redis** (ping از طریق اتصال BullMQ؛ وقتی
REDIS_URL تنظیم نشده = `disabled` چون صف روی DB-polling کار می‌کند) را می‌سنجد؛
payload شامل `degraded: true` است وقتی Redis پایین باشد (صف به polling برمی‌گردد —
برنامه 200 می‌ماند و مانیتور روی `redis: "down"` هشدار می‌دهد نه target-down).
Storage (MinIO) فعلاً `disabled` گزارش می‌شود — کلاینت S3 تا اولین عملیات فایل I/O
انجام نمی‌دهد و probe فعال به هر scrape تأخیر اضافه می‌کرد (مستند؛ در صورت نیاز
با HeadBucket سبک قابل افزودن است).

**دو یافتهٔ واقعی smoke (رفع‌شده در همین کامیت):**
1. `MoadianDiagnosticService(fetchImpl?)` — Nest نمی‌تواند `typeof fetch` را
   تزریق کند (metadata.Object)؛ از Phase 8 latent بود چون همهٔ تست‌ها دستی
   می‌ساختند. رفع: `@Optional()` روی پارامتر + fallback `?? fetch`.
2. `NotificationQueryDto.includePlatform` — boolean query-string رشته‌ای
   `@IsBoolean` را رد می‌کرد (تست‌های service-level object می‌فرستادند).
   رفع: `@Transform` به boolean.

درس: `npm run start` پس از هر فاز باید یک‌بار اجرا شود — DI/errors که فقط در
بوت ظاهر می‌شوند از تست‌های service-level پنهان می‌مانند.


### ۸. Redis-outage drill (فاز ۱۱ / Gate G — اجرا و تأیید ۲۰۲۶-۱۰-۳۱)

**سناریو**: قطع Redis بعد از بوت (bullmq driver فعال) — بند «تست بازیابی پس از
قطع Redis» فاز ۱. سه باگ واقعی پیدا و رفع شد:

1. **enqueue hang می‌کرد**: `bullmq.add` با `maxRetriesPerRequest: null` وقتی
   Redis پایین است بی‌نهایت retry می‌کند → HTTP request هیچ‌وقت برنمی‌گشت
   (ردیف در DB ساخته می‌شد ولی caller جواب نمی‌گرفت). رفع: race با timeout
   ۳٫۵ ثانیه + defer سینک‌ترو (bullmq.add روی connection بسته sync-throw
   می‌کند) + شروع worker polling به‌صورت on-demand از طریق
   `QueuePollingStarter` (cycle-breaker برای DI: WorkerService → QueueService
   → WorkerManager → WorkerService بود).
2. **crash در ioredis error event**: اتصال بدون 'error' listener، خطای
   ECONNREFUSED را unhandled پرتاب می‌کرد و process را می‌کشت. رفع: listener
   غیرمرگبار در `QueueBullmqService.getConnection`.
3. **unhandled rejection از ping**: ping بازندهٔ race (reject بعد از timeout)
   بدون catch → crash. رفع: `.catch(() => undefined)` روی هر دو ping
   (isAvailable و health).

**نتایج drill ثبت‌شده**: بوت با Redis DOWN → polling driver + health
`redis: down, degraded: true, status: ok`؛ enqueue بدون Redis → **۲۰۱ در
۰٫۱۱۵ ثانیه** (قبلاً hang بی‌نهایت) + fallback worker خودکار شروع شد؛ job از
طریق DB-polling پردازش شد (اعلان در DB ثبت شد)؛ Redis برگشت → health
`redis: up, degraded: false` بدون restart سرور. double-processing بین دو
worker توسط claim تراکنشی (SKIP LOCKED / status guard) جلوگیری می‌شود.

**یافتهٔ تستی جانبی**: p5-07 با کانفیگ‌های stale WhatsApp از اجراهای
خراب‌شده شکست خورد (handler کانال را با isPrimary/createdAt حل می‌کند) —
self-clean در beforeAll اضافه شد؛ الزام per-run unique data تقویت شد.
