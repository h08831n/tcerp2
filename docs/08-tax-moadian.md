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

## الزامات رسمی مودیان — منبع و وضعیت اعتبار

مرجع فنی: «دستورالعمل فنی نحوه اتصال به سامانه مودیان» (tax.gov.ir —
بازتاب: rahrokh.com). موارد به‌کاررفته در adapter:

- Base: `https://tp.tax.gov.ir/req` — ارسال: `…/api/self-tsp/async/normal-enqueue/`
  استعلام: `…/sync/INQUIRY_BY_UID/` توکن: `…/sync/GET_TOKEN/`
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
MOADIAN_MODE=mock|sandbox|live   (پیش‌فرض mock)
MOADIAN_BASE_URL=                (پیش‌فرض https://tp.tax.gov.ir/req)
MOADIAN_FISCAL_ID=               شناسه یکتای حافظه مالیاتی
MOADIAN_ECONOMIC_CODE=           کد اقتصادی مودی
MOADIAN_PRIVATE_KEY=             PEM کلید خصوصی (\n escape)
```

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
