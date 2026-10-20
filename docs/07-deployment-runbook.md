# Deployment Runbook — Prisma Migrations (TCERP)

This runbook covers the safe application of forward-only Prisma migrations
(current pending item at release time: `20241021000000_journal_source_event_id`
— adds `journal_entries.source_event_id UUID NULL` + a UNIQUE index).

## وضعیت محیط‌ها (Release Gate 2026-10-21)

| محیط | وضعیت migration | اقدام |
|---|---|---|
| `tcerp_test` (محلی + CI) | ✅ اعمال شده (migrate deploy در CI) | نیازی به اقدام نیست |
| `tcerp` (توسعه محلی) | ❌ اعمال نشده — عمداً (بدون مجوز) | گام ۱ زیر، پس از بکاپ |
| استقرار/production | — | گام‌های ۱–۵ پیش از اولین ریلیز |

⚠️ بک‌اندِ جدید `source_event_id` را در `journal.post` می‌نویسد؛ تا قبل از
اعمال migration روی یک محیط، emit رویدادها روی همان محیط خطا می‌دهد.
**اول migration، بعد کد جدید.**

## گام‌های امن اجرا

1. **بکاپ**: `docker exec tcerp-postgres pg_dump -U tcerp -d tcerp -Fc -f /tmp/tcerp-backup.dump`
   (و برای محیط استقرار: snapshot دیسک/بکاپ ابزار مدیریت دیتابیس). بدون بکاپ موفق جلو نرو.
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
   - شمارش رکوردها قبل و بعد برابر باشد (هیچ حذفی رخ نمی‌دهد):
     `SELECT COUNT(*) FROM journal_entries;` — ستون جدید همه NULL خواهد بود.
5. **استارت بک‌اند جدید** و اجرای یک smoke عملیاتی (بارگیری → سند حسابداری →
   صفحه `/accounting/events`).
6. **برخورد با شکست migration**: تراکنش failed به‌خودی‌خود rollback می‌شود و
   دیتابیس در همان وضعیت قبل می‌ماند. ریستور بکاپ گام ۱ فقط در صورت
   نیمه‌کاره ماندن (که با migrate deploy رخ نمی‌دهد). علت خطا (اتصال، قفل،
   disk) را برطرف و deploy را مجدد اجرا کنید — migration انجام‌شده در
   `_prisma_migrations` ثبت می‌شود و دوباره اجرا نمی‌شود.

## Rollback

کد قبلی (قبل از `b83f693`) با ستون NULL سازگار است — در صورت نیاز به بازگشت
کد، ستون و ایندکس را حذف نکنید؛ بی‌ضرر است. حذف ستون/ایندکس فقط با تصمیم
صریح مالک محصول انجام شود.
