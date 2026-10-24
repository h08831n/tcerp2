# 08 — Tax Invoices & Moadian Integration (Phase 8)

## دامنه و مرزها

- **SalesTaxInvoice**: صورتحساب فروش ما — لایه **گزارش/ارسال** روی سند فروش
  تکمیل‌شده. **هیچ سند حسابداری مستقل ندارد**: درآمد و مالیات هنگام رویدادهای
  حسابداری بارگیری ثبت شده‌اند (docs/05 §7 — مرز مصوب). فاکتور مالیاتی هرگز
  در محاسبه سود عملیاتی یا ثبت خودکار حسابداری وارد نمی‌شود (REQUIREMENTS).
- **PurchaseTaxInvoice**: فاکتور دریافتی از تامین‌کننده (ثبت حداقلی + M:N).
  ارسال آن به مودیان موضوعیت ندارد (گیرنده‌محور).
- تخصیص فاکتور↔سند همان جداول M:N موجود از Correction Gate قبلی است
  (`SalesTaxInvoiceOrderAllocation` / `Purchase…`)، حالا با FK واقعی.
- Salesperson به صورتحساب مالیاتی دسترسی ندارد (تست p8-03).

## منبع رسمی و نسخه (Mandatory Protocol Correction — 2026-10-22)

- مرجع: «دستورالعمل فنی نحوه اتصال به سامانه مودیان» سازمان امور مالیاتی —
  **نسخه دوم** (بازتاب rahrokh.com، انتشار 1402-01-06؛ بازتاب GitHub
  BaseMax/moadian-api-example با یادداشت نسخه دوم و تاریخ 2025-05-25).
  جدول ۷ همان سند فیلدهای header را تعریف می‌کند. PDF رسمی روی
  intamedia.ir/tax.gov.ir در این محیط مستقیماً قابل دانلود نبود —
  **محدودیت ثبت‌شده**.
- **inty** (جدول ۷): نوع صورتحساب — 1=نوع اول، 2=نوع دوم، 3=نوع سوم —
  **مستقل از ins** (موضوع). در مدل ما ستون `sales_tax_invoices.inty`
  (migration `20241021110000_phase8_inty`): MAIN→1،
  اصلاحی/ابطالی/برگشتی→2.
- **ins** (جدول ۷): موضوع — 1=اصلی، 2=اصلاحی، 3=ابطالی، 4=برگشت از فروش.
- **indatim / indati2m** (جدول ۷): Timestamp با طول ۱۴ رقمی؛ نمونه رسمی
  `1655620821274` = **میلی‌ثانیه** (ادعای قبلی ثانیه، غلط بود — اصلاح شد).
  indatim=صدور (issueDate روزانه → نیمه‌شب ms)، indati2m=ایجاد (createdAt).
- **taxid** (جدول ۷): رشته **۲۲ کاراکتری** (نمونه AA56CD0E0620002F2B4E78) —
  گزارش قبلی ۱۷ رقمی گفته بود؛ اصلاح شد. تولید آن بر اساس سند جداگانه
  «قالب شناسه یکتای حافظه مالیاتی و شماره منحصر به فرد مالیاتی» است و
  کلید حافظه مالیاتی می‌خواهد — gap مستند.
- **احراز هویت (نسخه دوم — پیاده‌شده در adapter):** `GET …/nonce?timeToLive`
  → JWS با header `{alg: RS256, x5c: [cert], sigT, crit: [sigT]}` و payload
  `{nonce, clientId}`، امضای RS256 با کلید خصوصی — **خود JWS همان Bearer
  است**. جریان GET_TOKEN/`/req/` نسخه اول منسوخ و حذف شده است.
  **UNVERIFIED روی سرویس واقعی.**
- **Base URL (نسخه دوم):** `https://tp.tax.gov.ir/requestsmanager/api/v2` — `GET /nonce`، `GET /server-information`، `POST /normal-enqueue`، `POST /INQUIRY_BY_UID`. (مسیرهای `/req/…` نسخه اول — منسوخ.)

## ماتریس وضعیت پیاده‌سازی مودیان (Adapter Audit — 2026-10-22)

| بخش پروتکل | وضعیت | شواهد |
|---|---|---|
| Normalization (Table 1, values-only) | **پیاده‌شده + offline-tested** با نمونه رسمی | `moadian-http.adapter.ts` normalize + p8a Table-1 test |
| آرایه index form (key.0 در C# appendix در برابر key.E0 در Java) | پیاده: key.0 — **تأییدنشده** (دو appendix دستورالعمل متفاوت‌اند) | docs همین بخش |
| null/empty → slot خالی بین جداکننده‌ها (### notation) | **پیاده‌شده** و منطبق با نمونه فاکتور رسمی (`0###32652362589632`) | p8a null-slot test |
| X.509 cert + تطبیق کلید عمومی با کلید خصوصی | **پیاده‌شده + offline-tested** (MOADIAN_CERT_INVALID / KEY_MISMATCH) | moadian-http.protocol.spec |
| JWS (RS256/x5c/sigT/crit) — نسخه دوم | **پیاده‌شده + offline-tested** (امضا با کلید عمومی verify می‌شود) | moadian-http.protocol.spec |
| packet crypto: XOR-whitening + AES-256-GCM + RSA-OAEP wrap + dataSignature | **پیاده‌شده + offline-tested** (round-trip کامل بازیابی می‌شود) | p8a preparePacket test |
| envelope.signature (RSA روی normalized packets) + signatureKeyId | **پیاده‌شده + offline-tested** | p8a envelopeSignature test |
| nonce endpoint (`/nonce?timeToLive`) | پیاده‌شده — **تأییدنشده** (شبکه‌ای) | adapter getNonce |
| server-information (`GET …/server-information`, Bearer JWS) | پیاده‌شده — **تأییدنشده** | adapter |
| normal-enqueue + INQUIRY_BY_UID (POST، Bearer JWS) | پیاده‌شده — **تأییدنشده** | adapter |
| GET_TOKEN (جریان نسخه اول) | **حذف شد** — نسخه دوم از nonce+JWS استفاده می‌کند | git history |
| taxid 22 کاراکتری (تولید با کلید حافظه) | **gap** — نیازمند سند «قالب شناسه یکتا» + کلید | docs همین بخش |
| sstid (کد کالا از GET_SERVICE_STUFF_LIST) | **gap** | docs |
| payment (اقلام پرداخت pym) | **gap** — ساختار تسویه تعریف نشده | docs |
| اتصال واقعی sandbox/live | **نشده** — نیازمند اعتبارنامه Sharjh مجاز | — |

**دستگاه زمانی indatim/indati2m: میلی‌ثانیه** (نمونه رسمی 1655620821274 = ۱۳
رقم ms؛ «طول ۱۴» ظرفیت ذخیره‌سازی است). indatim=صدور (issueDate روزانه →
نیمه‌شب ms — محدودیت دقت مستند)، indati2m=ایجاد (createdAt لحظه‌ای). تست‌های
قطعی در p8-10/11. ادعای قبلی «epoch seconds» غلط بود و اصلاح شد.

## الزامات رسمی مودیان — منبع و وضعیت اعتبار

مرجع فنی: «دستورالعمل فنی نحوه اتصال به سامانه مودیان» (tax.gov.ir —
بازتاب: rahrokh.com). موارد به‌کاررفته در adapter:

- Base (نسخه دوم): `https://tp.tax.gov.ir/requestsmanager/api/v2` — ارسال:
  `POST /normal-enqueue`، استعلام: `POST /INQUIRY_BY_UID`، توکن: JWS از
  `GET /nonce` (نسخه اول `/req/…`/GET_TOKEN — منسوخ).
- Packet: `uid` (یکتای کلاینت)، `packetType: INVOICE.V01`، `retry=true` در
  ارسال مجدد پس از FAILED، `data`، `fiscalId`، `dataSignature`.
- رمزنگاری (در adapter HTTP پیاده، **تأییدنشده روی سرویس واقعی**): نرمال‌سازی
  (جفت‌های کلید-مقدار مرتب‌شده با `#`)، امضا RSA2048-SHA256، بدنه AES-256-GCM
  با کلید wrapشده RSA-OAEP-SHA256.
- کدهای خطای رسمی: 5000/5001/5002/5005 (duplicate uid)/5006 (بیش از ۱۰۰
  packet)/5013/5015.

**وضعیت اعتبار:** فیلدها و جریان از مستند فنی برداشت شده‌اند؛ اتصال واقعی
نیازمند اعتبارنامه مودی (کلید خصوصی + fiscalId + کد اقتصادی) است که در
مخزن وجود ندارد و نبود آن عمدی است. حالت پیش‌فرض `MOADIAN_MODE=mock`
است؛ sandbox/live فقط با env اجرا می‌شوند و بدون اعتبارنامه با خطای صریح
می‌افتند. **هیچ ارسال واقعی تأییدنشده ادعا نشده است.**

## تشخیص اتصال (Test Moadian Connection) — Phase 8 hardening

- Endpointهای admin-only (`settings.edit` **و** `tax.submit` — هر دو الزامی):
  `GET /tax/diagnostics/connection` و `POST /tax/diagnostics/sandbox-full-test`.
- ترتیب گام‌های تشخیص: configuration → network (DNS/TLS/HTTP طبقه‌بندی
  می‌شود) → nonce → authentication (JWS محلی) → server_information →
  read-only. شکست هر گام، گام‌های وابسته را SKIPPED می‌کند.
- حالت mock: تمام گام‌های شبکه‌ای NOT_CONFIGURED — موفقیت mock هرگز اتصال
  واقعی نیست (تست‌شده).
- حالت live: فقط گام‌های غیرتغییردهنده؛ آزمون کامل sandbox در live مسدود.
- آزمون کامل sandbox: نیازمند MOADIAN_MODE=sandbox + fiscalId؛ packet
  آزمایشی با uid پایدار روزانه (بدون ارسال تکراری با timeout/restart)؛
  5005 = قبلاً پذیرفته‌شده؛ پاسخ PENDING → «بعداً استعلام بگیرید».
- رکورد diagnostic history جدا از تراکنش‌های کسب‌وکار نگهداری نمی‌شود؛ فقط
  audit (بدون هیچ secret) ثبت می‌شود و نتایج به UI برمی‌گردد.
- امنیت: هر دو endpoint با زنجیره guard سراسری + requireCompanyId +
  rate-limit 15 ثانیه + gate تک‌نمونه‌ای؛ timeout شبکه ۱۰ ثانیه با
  AbortSignal؛ TLS verify غیرقابل‌غیرفعال‌سازی؛ هیچ secret/token/کلیدی در
  پاسخ یا لاگ برنمی‌گردد.
- محدودیت: gate و rate-limit درون-پردازشی‌اند (استقرار تک‌نمونه‌ای)؛ محیط
  sandbox رسمی در دسترس نبود و هیچ درخواست واقعی به tp.tax.gov.ir ارسال یا
  تأیید نشده است — همه نتایج شبکه‌ای از mock/fetch-injected tests است.

## چرخه وضعیت و idempotency

```
DRAFT → READY → SENDING (claim اتمیک updateMany) → SUBMITTED → SUCCESS | FAILED
                                                    ↑______ retry (retry=true) ___|
```

- هر ارسال = یک ردیف `SalesTaxInvoiceSubmission` با `uid` یکتای DB-level؛
  payload دقیق در `payload_snapshot` ذخیره می‌شود (ردیابی کامل).
- claim اتمیک `READY/FAILED → SENDING` (الگوی allocation) → دو ارسال هم‌زمان
  فقط یک submission می‌سازند (p8-07).
- retry پس از FAILED ردیف جدید با `retry=true` و uid جدید می‌سازد (پیشنهاد
  رسمی) — تاریخچه تلاش‌ها حفظ می‌شود.
- استعلام فقط روی submissionهای PENDING؛ PENDING/SUCCESS/FAILED رسمی به
  وضعیت فاکتور نگاشت می‌شود.
- `taxid` یکتای DB روی فاکتور است (تولید آن با کلید مالیاتی در حالت واقعی
  اتفاق می‌افتد — در mock خالی می‌ماند).

## محاسبات

- مقدار هر ردیف = مجموع LoadingAllocationهای همان SalesLine
  (`tax_invoiced_quantity` ≠ `ordered_quantity` — REQUIREMENTS).
- مالیات ردیف = (prdis − dis) × نرخ snapshot سند / ۱۰۰ — همه Decimal دقیق.
- کنترل‌های پیش از صدور: سند COMPLETED، هویت مالیاتی مشتری
  (economicCode/nationalId/nationalCode)، مقدار بارگیری‌شده > ۰.

## دسترسی‌ها

`tax.view` خواندن؛ `tax.edit` صدور؛ **`tax.submit` (جدید Phase 8)** ارسال به
مودیان/ثبت فاکتور خرید. accountant این سه را دارد؛ salesperson هیچ‌کدام
(p8-03). همه backend-enforced با همان زنجیره guard سراسری.

## متغیرهای محیطی اتصال

```
MOADIAN_MODE=mock|sandbox|live       (پیش‌فرض mock)
MOADIAN_BASE_URL=                    (پیش‌فرض https://tp.tax.gov.ir/requestsmanager/api/v2)
MOADIAN_FISCAL_ID=                   شناسه یکتای حافظه مالیاتی
MOADIAN_ECONOMIC_CODE=               کد اقتصادی مودی
MOADIAN_CLIENT_ID=                   شناسه کلاینت (از Sharjh)
MOADIAN_PRIVATE_KEY=                 PEM کلید خصوصی (
 escape)
MOADIAN_CERTIFICATE=                 PEM گواهی X.509 (
 escape) — الزامی؛
                                     کلید عمومی آن باید با PRIVATE_KEY تطبیق کند
```

سیم‌کشی واقعی این متغیرها فقط در `moadian/adapter-factory.ts` انجام می‌شود
(`buildMoadianAdapter` — همان مسیری که Nest module مصرف می‌کند). sandbox/live
بدون همه پنج فیلد با `MoadianConfigError` فوری می‌افتد و **هرگز به mock
برنمی‌گردد** (adapter-factory.spec.ts).
MOADIAN_MODE=mock|sandbox|live   (پیش‌فرض mock)
MOADIAN_BASE_URL=                (پیش‌فرض https://tp.tax.gov.ir/req)
MOADIAN_FISCAL_ID=               شناسه یکتای حافظه مالیاتی
MOADIAN_ECONOMIC_CODE=           کد اقتصادی مودی
MOADIAN_PRIVATE_KEY=             PEM کلید خصوصی (\n escape)
```

## ممیزی تثبیت (Critical Tax Audit — p8a spec)

- **Payload audit (p8-10)**: همه فیلدهای header/body با مقادیر مورد انتظار
  دقیق assert می‌شوند؛ سازگاری درونی: Σ vam اقلام = tvam و prdis−dis = tadis.
- **نگاشت رسمی تصحیح شد**: `inty` بر اساس subject (MAIN=1، اصلاحی/ابطالی/
  برگشتی=2)، `ins` (1..4)، `tob` از نوع خریدار (حقوقی=1/حقیقی=2)،
  `irtaxid` اجباری برای non-MAIN (ستون `related_taxid` + migration
  `20241021100000`)، `indatim` = epoch seconds (⚠️ فرمت، تأییدنشده روی
  پاسخ واقعی — issueDate ما DATE است → نیمه‌شب).
- **جلوگیری از بیش‌صورتحسابی**: مقدار قابل صدور = بارگیری‌شده − قبلاً
  صورتحساب‌شده (به‌جز CANCELLED)؛ صدور جزئی/چندمرحله‌ای پشتیبانی می‌شود؛
  override بیش از باقیمانده رد می‌شود (p8-12)؛ gate هم‌زمانی creation
  (p8-16). برای صورتحساب‌های non-MAIN سقف اعمال نمی‌شود (اصلاحی سقف
  مصرف نمی‌کند).
- **وضعیت نامشخص**: ارسال مجدد کورکورانه ممنوع — recovery ابتدا
  INQUIRY_BY_UID می‌گیرد؛ PENDING → صبر (خطا SEND_IN_PROGRESS)، SUCCESS →
  ارتقای فاکتور، FAILED → retry امن با `retry=true` (p8-13).
- **5005 duplicate.request.uid** = قبلاً پذیرفته‌شده → FAILED نمی‌شود؛
  استعلام سرنوشت را روشن می‌کند (p8-14).
- **stale response**: پاسخ قدیمی هرگز وضعیت جدیدتر فاکتور را بازنویسی
  نمی‌کند — فقط newest attempt وضعیت فاکتور را تعیین می‌کند؛ ردیف‌های قدیمی
  صرفاً تاریخی به‌روز می‌شوند (p8-15).
- محدودیت چندنمونه‌ای: gate صدور/ارسال درون-پردازشی است؛ در استقرار
  چندنمونه‌ای باید قفل DB (کلید مبتنی بر salesLine/salesDocument) اضافه شود — مستند.

## شکاف‌های مستند (بدون حدس)

1. **sstid** (کد کالا/خدمت رسمی): نگاشت به `GET_SERVICE_STUFF_LIST`
   پیاده نشده — ستون nullable؛ نگاشت هر کالا تصمیم داده‌ای لازم دارد.
2. **تقویم/الگوی ارسال زمان‌دار** (بچ روزانه/ساعتی) — در صف نیست؛ ارسال
   دستی از UI/API انجام می‌شود.
3. **تأیید سمت مودیان روی محیط واقعی** — نیازمند اعتبارنامه؛ به‌عنوان
   قابلیت «نیازمند دسترسی بیرونی» علامت خورده.
4. **اشتراکی/hold فاکتور، امضای دیجیتال خریدار** — خارج از الزامات فعلی.

## نقاط تست (p8-01..09)

صدور صحیح (Decimal دقیق + مقدار بارگیری + allocation)، رد ورودی‌های
نامعتبر (۳ حالت)، ممنوعیت salesperson، ارسال→SUBMITTED با uid یکتا و
payload snapshot، چرخه استعلام PENDING/SUCCESS/FAILED + retry با
retry=true، شکست transport → FAILED + retry موفق، ارسال هم‌زمان → یک
submission، ثبت فاکتور خرید + M:N، وضعیت مودیان سند فروش
(Fully/Partially Registered + پوشش مبلغی).
