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

## منبع رسمی و نسخه (Official Source Retrieved — 2026-10-24)

- مرجع قطعی: «دستورالعمل فنی اتصال به سامانه مودیان» شناسه سند
  **RC_TICS.IS_v1.6، شهریور ۱۴۰۴** (۴۸ صفحه، دفتر توسعه خوداظهاری و تمکین
  داوطلبانه) — **دانلود مستقیم از پرتال رسمی**
  `www.intamedia.ir/Law-of-store-terminals-and-taxpayer-system` (پیوند صفحه
  «دستورالعمل فنی نحوه اتصال به سامانه مؤدیان1»). سند قدیمی‌تر رسمی
  RC_TICS.IS_v1.3 (مهر ۱۴۰۲) نیز از همان پرتال در دسترس است. اشکال آینه‌ای
  ثالث (rahrokh/HPM/BaseMax) فقط برای تاریخچه نگهداری می‌شوند و معادل منبع
  رسمی نیستند — پروتکل adapter مطابق v1.6 رسمی بازنویسی شد.
- **inty** (جدول ۷): نوع صورتحساب — 1=نوع اول، 2=نوع دوم، 3=نوع سوم —
  **مستقل از ins** (موضوع). در مدل ما ستون `sales_tax_invoices.inty`
  (migration `20241021110000_phase8_inty`): MAIN → 1. اصلاحی/ابطالی/برگشتی
  **inty را از صورتحساب مرجع به ارث می‌برند** (lookup با relatedTaxid؛ اگر
  مرجع در سیستم نباشد، از وضعیت اقتصادی خریدار مشتق می‌شود) — دیگر
  «اصلاحی→2 ثابت» نیست.
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
- **Base URL (سند رسمی v1.6):** `https://tp.tax.gov.ir/requestsmanager/api/v2` — `GET /nonce`، `GET /server-information`، `POST /invoice`، `GET /inquiry-by-uid`. (مسیرهای `/req/…` و `normal-enqueue` آینه‌ای — در سند رسمی وجود ندارند؛ historical.)

## ماتریس وضعیت پیاده‌سازی مودیان (Official v1.6 Conformance — 2026-10-24)

**منبع رسمی بازیابی‌شده مستقیماً**: سند «دستورالعمل فنی اتصال به سامانه مودیان»
شناسه **RC_TICS.IS_v1.6، شهریور ۱۴۰۴** (۴۸ صفحه) از پرتال رسمی
`www.intamedia.ir` → «پایانه‌های فروشگاهی و سامانه مودیان». هر سه دامنه رسمی
(tax.gov.ir / intamedia.ir / my.tax.gov.ir) در این جلسه پس از رفع مسیر شبکه
قابل‌دسترس شدند. **بازتاب‌های ثالث معادل منبع رسمی نیستند** — اشکال آینه‌ای
قبلی (normal-enqueue/normalize/XOR-whitening/5005) در سند رسمی وجود ندارند و
از adapter حذف شدند.

| بخش پروتکل (v1.6) | وضعیت | شواهد |
|---|---|---|
| §5 احراز هویت: nonce TTL 10..200 (پیش‌فرض 30) + JWS RS256/x5c/sigT/crit + payload {nonce, clientId}، توکن تک‌مصرف | **پیاده‌شده + offline-tested — انطباق کامل با سند رسمی** | adapter buildJws/getToken + protocol spec |
| §6 server-information: `{ serverTime, publicKeys: [{key base64 SPKI, id, algorithm:"RSA", purpose:1}] }` | **پیاده‌شده** (انتخاب کلید purpose=1، wrap به PEM) | adapter getServerInformation + mocks |
| §7 ارسال: `POST /api/v2/invoice` با `[{ payload: JWE, header: { requestTraceId, fiscalId } }]`؛ پاسخ `{ timestamp, result: [{ uid, packetType, referenceNumber, data }] }` — **uid پاسخ همان requestTraceId ماست** | **پیاده‌شده + round-trip tested** (mock مرجع، JWE را باز و JWS را می‌سنجد) | adapter enqueue + lifecycle mocks |
| §7.2 امضای صورتحساب: JWS روی JSON خام صورتحساب (بدون normalize — نرمال‌سازی در v1.3+ رسمی وجود ندارد) | **پیاده‌شده + tested** (verify با کلید عمومی گواهی) | protocol spec signInvoiceJws |
| §7.3 رمزنگاری: JWE {alg: RSA-OAEP-256, enc: A256GCM, kid}، CEK 256bit، IV 96bit، AAD=ASCII(Base64URL(header)) | **پیاده‌شده + round-trip tested** | protocol spec encryptInvoiceJwe |
| §8 استعلام: `GET /api/v2/inquiry-by-uid?uidList=…&fiscalId=…` (پارامتر تکراری)؛ وضعیت‌ها SUCCESS/FAILED/IN_PROGRESS/NOT_FOUND؛ خطاها در `data.error[]` | **پیاده‌شده** — IN_PROGRESS/NOT_FOUND → PENDING (نامقطی، هرگز resend) | adapter inquiryByUid |
| payments (آرایه سطح بالای صورتحساب) + inp (الگوی) در header | **پیاده‌شده** (payments ارسال خالی؛ inp=1) — نگاشت واقعی پرداخت gap | p8-10 |
| requestTraceId یکتا در هر درخواست + تکراری → خطا | پیاده‌شده (uid پایدار ما = requestTraceId) | p8-18/19/20/21 |
| sign پاسخ SUCCESS (JWS هسته روی {referenceNumber, clientId, taxId, receivedDate}) | ذخیره در taxResult — راستی‌آزمایی امضا: آینده | adapter |
| taxid (قالب شناسه یکتا + شماره منحصربه‌فرد مالیاتی) | **gap** — سند جداگانه + کلید حافظه مالیاتی | docs |
| sstid (کد کالا/خدمت) | **gap** — GET_SERVICE_STUFF_LIST + تصمیم داده‌ای | docs |
| payment (ساختار اقلام پرداخت) | **gap** — تصمیم داده‌ای | docs |
| اتصال واقعی sandbox/live | **نشده** — نیازمند اعتبارنامه Sharjh مجاز؛ runtime v1.6 UNVERIFIED | — |

**سابق/آینه‌ای (حذف از adapter):** normalize/dataSignature/XOR-whitening/
envelope-signature/normal-enqueue/INQUIRY_BY_UID (POST)/کد 5005 — این‌ها در
سند رسمی v1.6 نیستند؛ [HISTORICAL — historical] هیچ شاخه کد خطای آینه‌ای در
سرویس‌ها باقی نمانده است.

**دستگاه زمانی indatim/indati2m: میلی‌ثانیه** (نمونه رسمی 1655620821274 = ۱۳
رقم ms؛ «طول ۱۴» ظرفیت ذخیره‌سازی است). indatim=صدور (issueDate روزانه →
نیمه‌شب ms — محدودیت دقت مستند)، indati2m=ایجاد (createdAt لحظه‌ای). تست‌های
قطعی در p8-10/11. ادعای قبلی «epoch seconds» غلط بود و اصلاح شد.

## الزامات رسمی مودیان — منبع و وضعیت اعتبار

مرجع فنی: «دستورالعمل فنی نحوه اتصال به سامانه مودیان» (tax.gov.ir —
بازتاب: rahrokh.com). موارد به‌کاررفته در adapter:

- [HISTORICAL — mirror-era، دیگر پیاده‌سازی نیست] ارسال `POST /normal-enqueue`
  با packets/dataSignature/XOR-whitening و کدهای خطای 5000/5001/5002/5005/5006:
  این اشکال در سند رسمی v1.3/v1.6 وجود ندارند و از adapter حذف شدند.
- قرارداد جاری (سند رسمی v1.6): `POST /api/v2/invoice` با
  `[{payload: JWE, header: {requestTraceId, fiscalId}}]`؛ استعلام
  `GET /api/v2/inquiry-by-uid?uidList=…&fiscalId=…`؛ امضای صورتحساب JWS روی
  JSON خام؛ رمزنگاری JWE (RSA-OAEP-256 + A256GCM) با کلید عمومی سازمان از
  server-information (purpose=1).

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
- آزمون کامل sandbox — **state machine پایدار crash-safe دو سطحی**
  (migrationهای `20241022100000` + `20241022120000`): aggregate روزانه
  `MoadianDiagnosticRun` (یکتا روی شرکت/روز، fiscalId تغییرناپذیر) +
  مدل `MoadianDiagnosticAttempt` — **claim و هویت attempt (uid تغییرناپذیر +
  payload منجمد) در یک تراکنش کوتاه DB ثبت می‌شوند**؛ uid همیشه قبل از هر
  فراخوانی خارجی وجود دارد و هیچ تراکنشی روی درخواست HTTP نگه داشته نمی‌شود.
  توالی‌سازی claimants با `SELECT ... FOR UPDATE` روی ردیف aggregate؛
  constraintهای unique(runId, attempt) و unique(uid) پشتیبان سطح DB هستند.
- **بازیابی بدون resend کورکورانه**: attempt PREPARED (claim ثبت شده، enqueue
  قطعاً تکمیل نشده) با مهلت ۱۲۰ثانیه‌ای از createdAt — نمونه‌های دیگر تا
  انقضای مهلت عقب می‌کشند (p8-19c)؛ پس از انقضا با **همان uid و محتوای
  منجمد** از payload_snapshot ادامه می‌یابد — uid همان requestTraceId رسمی
  است (§7/§8 سند v1.6: «uid … همان requestTraceId») و response/استعلام با
  همان شناسه همبسته می‌شود (شواهد p8-14 بازنویسی‌شده؛ همگرایی روی sandbox
  واقعی تأیید نشده است). aggregate claimed بدون ردیف
  attempt (پنجره کرش قدیمی) → هیچ چیزی هرگز ارسال نشده و attempt 1 با uid
  تازه آغاز می‌شود (p8-19a)؛ aggregate در جریان/نهایی بدون ردیف attempt
  (هویت گم‌شده) → کاملاً مسدود با `SANDBOX_ATTEMPT_IDENTITY_LOST` (p8-19g).
  REJECTED قطعی → attempt جدید با `retry=true` و uid جدید؛ نتیجه نامشخص →
  reconcile با INQUIRY_BY_UID روی همان uid پایدار — **وضعیت UNKNOWN پیش از
  بازگشت persisted می‌شود** (p8-19e/f).
- **همگام‌سازی aggregate awaited است**: نتیجه نهایی فقط پس از ثبت وضعیت
  aggregate برگردانده می‌شود؛ شکست ثبت، overall را به FAIL با
  `SANDBOX_AGGREGATE_SYNC_FAILED` تنزل می‌دهد — موفقیت روی وضعیت گم‌شده
  گزارش نمی‌شود (p8-19d؛ سازگاری result/aggregate/attempt تست شده).
- **migration داده‌محور**: `20241022120000` هر ردیف run قدیمی (uid/مرجع/
  خطا/تأیید/نتیجه مالیاتی/timestamps) را **قبل از DROP ستون‌ها** به یک ردیف
  attempt معادل کپی می‌کند — تاریخچه تشخیصی حفظ می‌شود. شواهد بازپخش: ۶ ردیف
  legacy (هر ۶ وضعیت) با تطبیق کامل ۱۴ فیلدی و شمارش ۶=۶ روی tcerp_test.
  payload_snapshot مدل قدیمی وجود نداشت → snapshot خالی با anchor=uid.
- **تاریخچه استقرار migration (بازبینی پنجم)**: نسخهٔ اول این migration
  (کامیت db3c86b) ستون‌های قدیمی را بدون کپی DROP می‌کرد؛ در بازبینی چهارم
  همان فایل به نسخهٔ داده‌محور اصلاح شد. بررسی محیط‌ها: تنها محیط ماندگار
  `tcerp_test` است که پس از اصلاح **کاملاً بازپخش** شد (`_prisma_migrations`
  → applied 2026-10-24 05:07 UTC، نسخهٔ اصلاح‌شده، ۶ ردیف legacy حفظ‌شده)؛
  CI در هر اجرا یک DB اphemeral با postgres:16 می‌سازد و `prisma migrate
  deploy` + seed اجرا می‌کند (بدون ماندگاری بین ران‌ها)؛ dev/prod هرگز
  migrate نشده‌اند (قاعده پروژه). نتیجه: **هیچ محیط ماندگاری نسخهٔ
  data-losing را ندارد.** مسیر استقرار ایمن: Prisma یک migration ثبت‌شده را
  دوباره اجرا نمی‌کند — محیطی که نسخهٔ قدیمی را اعمال کرده باشد ستون‌هایش
  از قبل DROP شده و بازسازی از DB ناممکن است (این جدول فقط تاریخچهٔ تشخیصی
  است، بدون دادهٔ مالیاتی/کسب‌وکار؛ schema در هر حال یکسان می‌ماند). پرس‌وجوی
  تشخیصی اپراتور: مقایسهٔ `started_at` ردیف
  `20241022120000_phase8_attempt_model` در `_prisma_migrations` با تاریخ
  کامیت اصلاح (7daf814، 2026-10-24) — اگر قبل از آن باشد، محیط نسخهٔ
  drop-only را اجرا کرده است. قاعدهٔ آینده: ویرایش migration اعمال‌شده
  ممنوع؛ هر تغییر فقط با migration رو به جلو. ادعای بین-نمونه‌ای با دو نمونه سرویس مستقل روی DB مشترک تست شده است
  (p8-18c). payload آزمایشی **کامل** است (taxid/tins/sstid از env
  `MOADIAN_SANDBOX_*`)؛ اگر این envها تنظیم نشده باشند نتیجه
  NOT_CONFIGURED با راهنمای اقدام برمی‌گردد — payload ناقص هرگز ارسال
  نمی‌شود. پاسخ enqueue با همبستگی requestTraceId اعتبارسنجی می‌شود
  (MOADIAN_INVOICE_RESPONSE_MISMATCH → UNKNOWN، هرگز موفق تلقی نمی‌شود).
- **جدا‌سازی ادعاها از شواهد**: قرارداد ارسال/استعلام/رمزنگاری از سند رسمی
  RC_TICS.IS_v1.6 پیاده‌سازی شده اما **هیچ‌کدام از این رفتارها روی
  sandbox/live واقعی تأیید نشده‌اند** — همه شواهد runtime از تست‌های
  fetch-injected/mock روی tcerp_test است. تماس با سرویس واقعی بدون
  اعتبارنامه sandbox مجاز و بدون authorization ممنوع است.
- رکورد diagnostic history جدا از تراکنش‌های کسب‌وکار نگهداری نمی‌شود؛ فقط
  audit (بدون هیچ secret) ثبت می‌شود و نتایج به UI برمی‌گردد.
- امنیت: هر دو endpoint با زنجیره guard سراسری + requireCompanyId +
  rate-limit 15 ثانیه + gate تک‌نمونه‌ای؛ timeout شبکه ۱۰ ثانیه با
  AbortSignal؛ TLS verify غیرقابل‌غیرفعال‌سازی؛ هیچ secret/token/کلیدی در
  پاسخ یا لاگ برنمی‌گردد.
- سخت‌سازی مقصد (SSRF): فقط HTTPS/443، مسیر دقیق `/requestsmanager/api/v2`،
  allowlist میزبان؛ loopback/`.local`/`.internal`، بازه‌های خصوصی IPv4
  (10/8، 127/8، 172.16/12، 192.168/16، 169.254/16، 0/8) و **هر literal IPv6
  به هر شکلی** (loopback، link-local fe80::/10، unique-local fc00::/7،
  IPv4-mapped `::ffff:a.b.c.d`) قبل از allowlist رد می‌شوند. هر چهار
  فراخوانی HTTP آداپتر با `redirect: 'error'` ساخته می‌شوند — هیچ redirectی
  دنبال نمی‌شود؛ TLS verify دست‌نخورده است.
- شواهد چرخه attempt (p8-18a..e): retry دقیقاً یک‌بار پس از رد قطعی با
  retry=true و uid جدید؛ crash-after-claim با همان uid reconcile و بدون
  ارسال مجدد؛ دو نمونه مستقل → دقیقاً یک claim/یک enqueue؛ timeout → SUCCESS
  از استعلام بدون resend؛ UNKNOWN روی استعلام نامشخص مسدود می‌ماند.
- محدودیت: gate صدور/ارسال فاکتور و rate-limit درون-پردازشی‌اند؛ gate آزمون
  تشخیصی به UPDATE شرطی DB منتقل شده (چندنمونه‌ای امن)؛ محیط
  sandbox رسمی در دسترس نبود و هیچ درخواست واقعی به tp.tax.gov.ir ارسال یا
  تأیید نشده است — همه نتایج شبکه‌ای از mock/fetch-injected tests است.

## ماتریس شکاف قطعی (Final Gap Closure — 2026-10-24)

وضعیت دسترسی (به‌روزرسانی همین جلسه): دامنه‌های رسمی ابتدا با خطای SSL
غیرقابل‌دسترس بودند و سپس با تغییر مسیر شبکه **باز شدند** و سند رسمی v1.6
مستقیماً بازیابی شد. بازتاب‌های ثالث (rahrokh، HPM، BaseMax)
**معادل منبع رسمی تلقی نمی‌شوند**. طبقه‌بندی هر
حوزه در چهار رده: «پیاده‌سازی تأییدشده» (تست‌شده)، «پشتوانه مستند آینه‌ای»
(غيرمعادل رسمی)، «نیازمند Sandbox مجاز»، «تصمیم کسب‌وکار/اعتبارنامه ناموجود».

| حوزه | پیاده‌سازی تأییدشده | پشتوانه آینه‌ای | نیازمند Sandbox مجاز | تصمیم/اعتبارنامه ناموجود |
|---|---|---|---|---|
| taxid | فیلد و اعتبارسنجی قالب ۲۲ کاراکتری (p8-10) | قالب از آینه (جدول ۷) | درستی مقدار روی مرجع | تولید با کلید حافظه + سند «قالب شناسه یکتا» |
| sstid | ارسال مقدار پایدار ستون (nullable) | — | نگاشت از GET_SERVICE_STUFF_LIST | نگاشت هر کالا — تصمیم داده‌ای |
| payment | `payment: []` placeholder | ساختار پرداخت فقط در آینهٔ v1 | ساختار/رفتار واقعی | نگاشت ابزار پرداخت — تصمیم داده‌ای |
| payload conformance | header/body دقیق (p8-10) + inty/ins/ms (p8-11) | جدول ۷ آینه v2 | تطبیق نهایی با مرجع | — |
| authentication | nonce+JWS RS256/x5c/sigT/crit (تست محلی) | آینه v2 | پذیرش JWS توسط مرجع | اعتبارنامه Sharjh/حافظه مالیاتی |
| cryptography | XOR+AES-256-GCM+RSA-OAEP-SHA256+envelope (round-trip 11/11) | الگوریتم از آینه v1/v2 | کلید عمومی سازمان واقعی | — |
| multi-instance safety | claim اتمیک DB (tx+FOR UPDATE)، unique uid، reconcile فقط پاسخ قطعی (p8-07/16/18c/19c/17a-c) | — | — | — (گارانتی DB-enforced، مستقل از تعداد نمونه) |
| بازیابی/idempotency | 5005=قبول‌شده، transport=مبهم، never blind-resend (p8-06/06b/13/14/15/19/20/21) | کد 5005 از آینه | همگرایی real-5005 | — |

**جمع‌بندی پذیرش فاز ۸**: پیاده‌سازی و بازیابی محلی کامل و تست‌شده است؛
سه بلوک باقی است که هیچ‌کدام با تغییر کد حل نمی‌شوند: (۱) اعتبارنامه Sandbox
مجاز + یک اجرای واقعی خاتمه‌یافته، (۲) منبع رسمی سند (کارپوشه) برای
راستی‌آزمایی نهایی فیلدها، (۳) تصمیم‌های داده‌ای taxid/sstid/payment.
تا این سه، ادعای production-ready ممنوع است.

## نگاشت هویتی رسمی (Verified — 2026-10-24, RC_IITP.IS_V7.9)

منبع: سند رسمی «دستورالعمل صدور صورتحساب الکترونیکی» شناسه **RC_IITP.IS_V7.9،
تیر ماه ۱۴۰۵** (۱۱۶ صفحه) — دانلود مستقیم از پرتال رسمی
`www.intamedia.ir/The-regulation-of-store-terminals/id/37974` (جدول ۲ «جایگاه
اقلام صورتحساب الکترونیکی» و قواعد کنترل). تأیید مستقل با نسخه V7.5 عمومی:
**tins = شماره اقتصادی فروشنده** (نه خریدار) و مقادیر tob با ۱=حقیقی.

- **tins**: شماره اقتصادی **فروشنده** — الزامی، باید با شماره اقتصادی مودی
  (شرکت صادرکننده در پیکربندی) مطابق باشد. منبع داده: `Company.economicCode`.
  خالی <- `TAX_INVOICE_PAYLOAD_SELLER_TINS_UNAVAILABLE`.
- **tob**: نوع شخص خریدار — 1=حقیقی، 2=حقوقی، 3=مشارکت مدنی، 4=اتباع
  غیرایرانی (نقشه: COMPANY=2، PERSON=1).
- **inty وراثتی**: صورتحساب‌های اصلاحی/ابطالی/برگشتی inty را از **صورتحساب
  مرجع** به ارث می‌برند (lookup با relatedTaxid در همان شرکت؛ اگر مرجع
  موجود نباشد، از وضعیت اقتصادی خریدار مشتق می‌شود و اعتبارسنجی نهایی با
  سازمان است) — منطق پیاده‌شده در createFromSalesDocument.
- **bid**: شناسه/شماره ملی خریدار — tob=1 یعنی شماره ملی (nationalCode)؛
  tob=2 یعنی شناسه ملی (nationalId). خالی <- `TAX_INVOICE_PAYLOAD_BUYER_ID_MISSING`.
- **tinb**: شماره اقتصادی خریدار — برای tob=2 الزامی؛ برای اشخاص حقیقی
  اختیاری (در صورت وجود ارسال می‌شود).
- **irtaxid**: برای موضوعات غیراصلی (اصلاحی/ابطالی/برگشتی) الزامی <- 
  `TAX_INVOICE_PAYLOAD_IRTAXID_REQUIRED`.
- قاعده رسمی ردیف ۲ جدول قواعد: برای صورتحساب نوع اول صادرات/بورس، نوع دوم و
  سوم، ثبت اطلاعات خریدار الزامی نیست — خارج از دامنه فعلی (نوع اول داخلی
  پیاده شده؛ صادرات/نوع سوم پیاده نیست).
- **payments**: آرایه سطح بالا؛ مثال رسمی بخش 7 سند فنی آن را خالی می‌فرستد —
  نگاشت داده‌های تسویه واقعی (bank/receivable) gap مستند است و تا تصمیم
  داده‌ای، ارسال با payments خالی مطابق نمونه رسمی است.
- **taxid**: تولید آن نیازمند سند «قالب شناسه یکتا» + کلید حافظه مالیاتی
  است — در sandbox/live بدون آن، ارسال با
  `TAX_INVOICE_PAYLOAD_TAXID_UNAVAILABLE` مسدود می‌شود (هرگز جعل نمی‌شود).

## فرمول‌های رسمی اقلام (Verified — RC_IITP.IS_V7.9, فرمول‌های کنترلی سند صدور)

- **adis (Is)** = Es − Gs = **prdis − dis** (مبلغ بعد از تخفیف) — سند صدور:
  «Is=Es-Gs».
- **vam (Ks)** = adis × vra / 100 (نرخ مالیات بر ارزش افزوده ردیف).
- **tsstam (Os)** = Ks + Is = **vam + adis** (مبلغ کل کالا/خدمت؛ + Ks2/Ks3
  برای سایر مالیات‌ها/عوارض در الگوهای خاص) — نمونه رسمی: ۱۹۵۰۰ + ۱۷۵۵ = ۲۱۲۵۵.
- **سرآیند**: tprdis=ΣEs، tdis=ΣGs، tadis=ΣIs، tvam=ΣKs،
  tbill=ΣOs (= tadis+tvam+todam). همه با Decimal دقیق و بدون گردکردن.
- **setm (روش تسویه)**: 1=نقدی، 2=نسیه، 3=نقدی/نسیه؛ برای نوع دوم/سوم نقدی
  الزامی است؛ با setm=3 ثبت cap (مبلغ پرداختی نقدی) و insp (مبلغ نسیه) اجباری
  است (جدول ۲۴). منبع داده روش تسویه هنوز در ERP وجود ندارد <- ارسال واقعی با
  `TAX_INVOICE_PAYLOAD_SETM_UNAVAILABLE` مسدود می‌شود (gap مستند).
- **پرداخت‌ها**: گزارش پرداخت از طریق API مجزا
  `POST /api/v2/invoice-payment` (بخش ۱۱ سند فنی v1.6؛ taxid/paidAmount/
  paymentDate/paymentMethod) برای تسویه نسیه/نقدی-نسیه است — خارج از payload
  ارسال؛ تا طراحی داده‌ای، payments خالی مطابق مثال رسمی §7 ارسال می‌شود.
- **taxid**: قالب ۲۲ نویسه الفبایی-عددی (نمونه رسمی) — اعتبارسنجی
  `TAX_INVOICE_PAYLOAD_TAXID_INVALID`؛ تولید نیازمند سند جداگانه + کلید.

## قطع رسمی و تخصیص تخفیف (Verified — RC_IITP.IS_V7.9, پانزدهمین بازبینی)

- **قاعده قطع (سند صدور، صفحه مبانی)**: «تمامی مقادیر ریالی و ارزی می‌بایست،
  با احتساب رقم اعشار ذکرشده در سند و با روش **قطع کردن** محاسبه و در
  صورتحساب ثبت گردد». فیلدهای ریالی سرآیند/بدنه با **۱۸ رقم صحیح و ۰ رقم
  اعشار** تعریف شده‌اند — هر مقدار ریالی payload با `Decimal.truncated()`
  قطع می‌شود (نه گرد کردن).
- **تخصیص تخفیف در صدور جزئی/چندمرحله‌ای**: discountAmount خط فروش، تخفیف
  کل همان خط است. تخصیص **تجمعی**: هر مرحله
  `dis = TRUNC(discountAmount × cumulativeQty ÷ orderedQty) − Σ dis مراحل قبل`
  — هیچ مرحله‌ای تخفیف کامل را دوباره اعمال نمی‌کند و آخرین مرحله آن را دقیقاً
  تمام می‌کند (p8-28: ۵۰+۵۰=۱۰۰).
- **cfee** = Cf = Cs/Exr: مبلغ واحد به **ارز** — فقط برای الگوهای فروش ارز
  (۱۴ رقم صحیح/۴ اعشار). الگوهای داخلی ما آن را حمل نمی‌کنند (نمونه رسمی §7
  سند فنی هم بدون cfee است) — cfee هرگز کپی fee نیست.
- **mu** = کد رسمی واحد اندازه‌گیری از ضمیمه سازمان (نمونه رسمی: 164) — هرگز
  نماد داخلی UOM. ستون `Uom.moadianUnitCode` (migration
  `20241025100000`) نگاشت اپراتوری را نگه می‌دارد؛ UOM بدون نگاشت، ارسال را
  در sandbox/live مسدود می‌کند.
- **مرجع صورتحساب‌های غیراصلی**: relatedTaxid باید ۲۲ نویسه الفبایی-عددی
  باشد (`TAX_INVOICE_RELATED_TAXID_INVALID`)؛ اگر مرجع در سیستم ما باشد inty
  از آن به ارث می‌رسد و مرجع CANCELLED رد می‌شود
  (`TAX_INVOICE_REFERENCE_CANCELLED`)؛ مراجع خارجی پذیرفته می‌شوند و
  اعتبارسنجی نهایی با سازمان است.

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
# Sandbox full-test identity (REQUIRED for the sandbox full test — NO defaults)
MOADIAN_SANDBOX_TAXID=               شناسه یکتای مالیاتی ۲۲ کاراکتری صورتحساب آزمایشی
MOADIAN_SANDBOX_TINS=                شناسه ملی/کد اقتصادی خریدار آزمایشی
MOADIAN_SANDBOX_SSTID=               کد کالا/خدمت ثبت‌شده در سامانه
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
