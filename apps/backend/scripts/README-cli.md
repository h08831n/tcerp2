# TCERP Operator CLI

ابزار خط فرمان عملیاتی — روی همان دیتابیس backend اجرا می‌شود. هر mutation **درون یک تراکنش
Prisma** با ردیف AuditLog آن انجام می‌شود (`actorName='cli:<operator>'`) — شکست هر بخش =
rollback کامل، هیچ تغییر ناقصی باقی نمی‌ماند (CLI-01).

## اجرا

```bash
cd apps/backend
npm run cli -- <command> [args] [flags]
```

پیکربندی مثل خود backend از `apps/backend/.env` / `DATABASE_URL` خوانده می‌شود.

## فرمان‌ها

| فرمان | کار |
|---|---|
| `reset-password <username> [--stdin] [--yes] [--reason "..."] [--no-force-change] [--confirm-db <db>] [--operator <name>]` | ریست پسورد — **اتمیک**: bcrypt (همان `BCRYPT_ROUNDS` سرویس؛ hash قبل از تراکنش)، `mustChangePassword=true`، پاک‌کردن پنجرهٔ قفل، ابطال همهٔ refresh tokenها، audit `PASSWORD_RESET` + self-verify با `bcrypt.compare` |
| `unlock <username> [...]` | پاک‌کردن هر دو مکانیزم قفل — اتمیک با audit؛ **حساب DISABLED فعال نمی‌شود** (فعال‌سازی = `set-status ACTIVE`) |
| `set-status <username> <ACTIVE\|DISABLED> [...]` | فعال/غیرفعال‌سازی — اتمیک با audit (اثر از درخواست بعدی، R6-S1) |
| `list-users [--status <s>]` | جدول فقط‌خواندنی |

## ورودی پسورد (CLI-02)

- **پیش‌فرض**: پرامپت تعاملی مخفی، دوبار (سازگار با Windows)
- **Automation**: `pwgen -s 16 1 | npm run cli -- reset-password <user> --stdin --yes`
- **فلگ `--password` عمداً وجود ندارد** — رمز خام در command-line از طریق تاریخچهٔ shell و
  لیست processها نشت می‌کند. فلگ ناشناخته → exit 2.
- رمز، hash، connection string و token هرگز در خروجی/خطا چاپ نمی‌شوند.

## ایمنی (CLI-03)

- بنر هدف قبل از هر دستور مخرب: `db=<host>:<port>/<db>  user=<u> (status=...)`
- **Production**: علاوه بر موارد بالا، هدف باید **صریح** تأیید شود —
  `--confirm-db <dbname>` (مطابق دیتابیسِ `DATABASE_URL`)؛ `--yes` به‌تنهایی کافی نیست و
  `--reason` الزامی است.
- `--yes` فقط تأیید عمومی را رد می‌کند؛ اجرای غیرتعاملی بدون آن → exit 2.
- **هویت اپراتور**: `--operator <name>` (پیش‌فرض: کاربر سیستم‌عامل) → `actorName='cli:<operator>'`.
- فلگ ناشناخته یا مقدار نامعتبر → exit 2.

### رفتار reset-password برای حساب LOCKED

ریست پسورد **پنجرهٔ قفل زمانی** را پاک می‌کند (`failedLoginCount=0`, `lockedUntil=null`) ولی
**وضعیت اداری `LOCKED` را تغییر نمی‌دهد** — حساب LOCKED همچنان ورود را رد می‌کند چون این دو
مکانیزم مستقل‌اند (auth.service: `status==='LOCKED'` یک گیت جداست). خروجی فرمان این را صریح
می‌گوید و به `cli unlock <user>` ارجاع می‌دهد (که `LOCKED → ACTIVE` می‌کند). فعال‌سازی حساب
DISABLED هم عمداً با unlock انجام نمی‌شود.

## تست‌ها (CLI-04)

`src/ops-cli.spec.ts` — ۱۵ سناریو فقط روی دیتابیس آزمایشی (هیچ حساب واقعی تغییر نمی‌کند):
موفقیت reset + bcrypt.compare، رد پسورد ضعیف بدون تغییر DB، ابطال کامل tokenها، **rollback
کامل با شکست audit و شکست ابطال token** (تزریق شکست در کلاینت تراکنش)، unlock ‏LOCKED/DISABLED،
set-status، audit صحیح هر فرمان، کاربر ناموجود، اجرای غیرتعاملی بدون تأیید، تأیید
`--confirm-db` در production، عدم چاپ رمز، self-verify، اجرای تکراری.

## افزودن فرمان جدید

۱. فایل `scripts/cli-commands/<name>.ts` با `export async function run(prisma, args, ctx): Promise<number>`
۲. ثبت در `COMMANDS` داخل `scripts/cli.ts` (با `allowedFlags`)
