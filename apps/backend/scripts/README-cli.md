# TCERP Operator CLI

ابزار خط فرمان عملیاتی — روی همان دیتابیس backend اجرا می‌شود. هر mutation یک ردیف
AuditLog با `actorName='cli'` می‌نویسد (همان شکل `AuditService.record`).

## اجرا

```bash
cd apps/backend
npm run cli -- <command> [args] [flags]
```

پیکربندی مثل خود backend از `apps/backend/.env` / `DATABASE_URL` خوانده می‌شود
(هدف واقعی قبل از هر دستور مخرب روی بنر نمایش داده می‌شود).

## فرمان‌ها

| فرمان | کار |
|---|---|
| `reset-password <username> [--password <pw>\|--stdin] [--yes] [--reason "..."] [--no-force-change]` | ریست پسورد: bcrypt با همان `BCRYPT_ROUNDS` سرویس، `mustChangePassword=true`، پاک‌شدن قفل، **ابطال همهٔ refresh tokenها**، audit `PASSWORD_RESET` + self-verify با `bcrypt.compare` |
| `unlock <username> [--yes] [--reason "..."]` | پاک‌کردن هر دو مکانیزم قفل: پنجرهٔ failed-login (`failedLoginCount=0`, `lockedUntil=null`) و قفل اداری (`status LOCKED → ACTIVE`)؛ حساب DISABLED دست‌نخورده می‌ماند |
| `set-status <username> <ACTIVE\|DISABLED> [--yes] [--reason "..."]` | فعال/غیرفعال‌کردن کاربر (اثر از درخواست بعدی — R6-S1) |
| `list-users [--status <s>]` | جدول فقط‌خواندنی: username، status، قفل مؤثر، تعداد خطا، باید-پسورد-عوض‌شود، آخرین ورود |

## ورودی پسورد

- تعاملی: بدون فلگ — دو بار با echo مخفی پرسیده می‌شود (Windows سازگار)
- اسکریپتی: `--password '<pw>'` یا `pwgen ... | npm run cli -- reset-password <user> --stdin --yes`

## ایمنی

- دستورهای مخرب بنر هدف (db + user) را چاپ می‌کنند و بدون `--yes` تأیید تعاملی می‌خواهند؛
  اجرای غیرتعاملی (بدون TTY) **بدون `--yes` متوقف می‌شود** (exit 2).
- سیاست پسورد با `ResetPasswordDto` یکی است (۸ تا ۱۲۸ کاراکتر) + لیست
  forbidden-for-production در `NODE_ENV=production`.
- پسورد هرگز چاپ نمی‌شود؛ خروجی فقط نتیجه را نشان می‌دهد.

## افزودن فرمان جدید

۱. فایل `scripts/cli-commands/<name>.ts` با `export async function run(prisma, args, ctx): Promise<number>`
۲. ثبت در `COMMANDS` داخل `scripts/cli.ts`
