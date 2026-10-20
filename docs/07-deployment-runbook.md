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

1. **بکاپ (فایل روی میزبان، نه داخل کانتینر)** — خروجی `pg_dump` را به shell
   میزبان هدایت کنید:
   ```bash
   docker exec tcerp-postgres pg_dump -U tcerp -d tcerp -Fc > backups/tcerp-$(date +%F).dump
   ```
   **تأیید بکاپ (اجباری قبل از هر اقدام):**
   ```bash
   ls -l backups/tcerp-*.dump                      # حجم > 0
   docker exec -i tcerp-postgres pg_restore --list < backups/tcerp-*.dump | head
   # → باید فهرست جدول‌ها (journal_entries, accounting_events, …) را نشان دهد؛
   #   خواندن‌پذیر نبودن آرشیو = بکاپ معتبر نیست و جلو نروید.
   ```
   شمارش‌های قبل از migration را ثبت کنید تا بعداً مقایسه شود:
   `SELECT COUNT(*) FROM journal_entries;` و `SELECT COUNT(*) FROM accounting_events;`
   برای محیط استقرار به‌جای docker از snapshot/ابزار بکاپ همان محیط استفاده
   شود — اصل، اثبات خوانا بودن آرشیو است.

2. **توقف ارسال رویداد**: سرویس بک‌اند را موقتاً متوقف کنید تا بین migration و
   استارت بک‌اند جدید، emit با کد قدیمی اجرا نشود.

3. **اعمال (افزایشی و non-destructive)**:
   `cd apps/backend && DATABASE_URL=... npx prisma migrate deploy`
   — فقط migrationهای اعمال‌نشده را به ترتیب اجرا می‌کند؛ `migrate reset` و
   `migrate dev` روی این محیط‌ها **ممنوع** است.

4. **بررسی موفقیت**:
   - خروجی deploy بدون error و `prisma migrate status` = "Database schema is up to date".
   - `\d journal_entries` شامل `source_event_id uuid` و ایندکس
     `journal_entries_source_event_id_key UNIQUE` باشد.
   - شمارش‌های گام ۱ برابر قبل باشند (هیچ حذفی رخ نمی‌دهد)؛ ستون جدید همه NULL.

5. **استارت بک‌اند جدید** و اجرای یک smoke عملیاتی (بارگیری → سند حسابداری →
   صفحه `/accounting/events`).

6. **برخورد با شکست migration — با شواهد موتور واقعی (اثبات‌شده روی دیتابیس
   آزمایشی دورریختنی `tcerp_shadow`، نه توسعه):**

   **واقعیت تراکنشی (اثبات‌شده، فرض نکنید):** PostgreSQL DDL را کاملاً
   تراکنشی اجرا می‌کند — آزمایش با دو جدول اثباتی + `SELECT 1/0` نشان داد
   statementهای قبلی یک تراکنش، با شکست statement بعدی **rollback** می‌شوند.
   **Prisma Migrate هم هر فایل migration را در یک تراکنش واحد اجرا می‌کند**
   (اثبات: روی `tcerp_shadow` یک migration آزمایشی دو-statement‌ای
   (`ALTER … ADD COLUMN` سپس `SELECT 1/0`) deploy شد → خطای `P3018`،
   رکورد migration در `_prisma_migrations` با `finished_at = NULL` و
   **ستون statement اول هم ABSENT بود — یعنی کل migration یکجا rollback
   شد**). بنابراین حالت «ALTER اعمال شده ولی ایندکس نه» با `migrate deploy`
   رخ نمی‌دهد؛ با این حال **فرض نکنید — همیشه واقعیت را با دو بررسی زیر
   تأیید کنید:**
   ```sql
   SELECT migration_name, finished_at, rolled_back_at, logs
   FROM _prisma_migrations WHERE migration_name LIKE '%source_event_id%';
   \d journal_entries   -- وجود/عدم وجود ستون و ایندکس
   ```
   **درخت تصمیم پس از شکست:**
   - **(الف) هیچ چیزی اعمال نشده** (ستون ABSENT، رکورد `finished_at = NULL`)
     → علت خطا (اتصال/قفل/disk — کد 22012 در آزمایش ما خطای منطقی بود) را
     برطرف کنید و **`prisma migrate deploy` را دوباره اجرا کنید**؛ تراکنش
     rollback شده، از نو و کامل اعمال می‌شود.
   - **(ب) deploy همچنان P3018 می‌دهد و ردیف FAILED مانده** → بعد از رفع علت:
     `npx prisma migrate resolve --rolled-back <migration_name>`
     (اثبات‌شده: رکورد را resolved علامت می‌زند) و سپس deploy مجدد — دوباره
     و کامل اجرا می‌شود. هیچ داده‌ای حذف نمی‌شود.
   - **(ج) در بررسی، ستون/ایندکس «وجود» دارد ولی رکورد migration
     `finished_at = NULL` است** (فقط در صورت دستکاری دستی خارج از این
     runbook رخ می‌دهد): statement باقی‌مانده را دستی و idempotent اجرا
     کنید (`CREATE UNIQUE INDEX IF NOT EXISTS …`) و سپس
     `npx prisma migrate resolve --applied <migration_name>` تا فقط ثبت
     شود — deploy دیگر آن را اجرا نمی‌کند.
   - در هیچ شاخه‌ای از `migrate reset`، `DROP` یا حذف داده استفاده نشود؛
     شکست migration به‌خودی‌خود به rollback کامل می‌انجامد (اثبات بالا).

## Rollback

کد قبلی (قبل از `b83f693`) با ستون NULL سازگار است — در صورت نیاز به بازگشت
کد، ستون و ایندکس را حذف نکنید؛ بی‌ضرر است. حذف ستون/ایندکس فقط با تصمیم
صریح مالک محصول انجام شود.
