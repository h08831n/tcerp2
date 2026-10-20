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
- فایل آزمایش شامل **دقیقاً همان دو statement فایل واقعی
  `20241021000000_journal_source_event_id`** (ALTER TABLE … ADD COLUMN +
  CREATE UNIQUE INDEX) به‌علاوه statement سوم همیشه-شکننده (`SELECT 1/0`).
- نتیجه: خطای `P3018`، رکورد در `_prisma_migrations` با `finished_at = NULL`
  و **هم ستون و هم ایندکس ABSENT** — یعنی هر دو statement واقعی با هم
  rollback شدند (PostgreSQL DDL تراکنشی است و Prisma 5.22.0 هر فایل migration
  را در یک تراکنش واحد اجرا می‌کند).
- مسیر بازیابی نیز روی همان state آزمایش شد:
  `prisma migrate resolve --rolled-back zzz_evidence2` رکورد را resolved
  علامت زد و `migrate deploy` بعدی کل migration را **از نو و کامل** اجرا کرد
  (در آزمایش دوباره P3018 گرفت چون SQL عمداً خراب بود — رفتار صحیح؛ با SQL
  سالم، تلاش مجدد موفق می‌شود).

**این شواهد فقط برای Prisma 5.22.0 + PostgreSQL 16 این پروژه معتبر است؛ قبل
از ارتقای Prisma/Postgres، آزمایش بالا را روی دیتابیس آزمایشی تکرار کنید.**

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
