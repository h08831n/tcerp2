# CR-001 — CRM Pipeline (سرنخ → فرصت → مشتری) + DatePicker سراسری

> قرارداد مرجع این ماژول. با REQUIREMENTS §8 سازگار؛ قوانین تبدیل بر اساس
> درخواست اجرایی CR-001 (بازطراحی CRM مشابه Odoo از نظر UX، با قوانین
> اختصاصی TCERP2) قطعی و backend-enforced است.

## ۱. معماری Party / Lead / Opportunity / Customer

- **Party موجودیت هویتی یکتاست.** سرنخ، فرصت و مشتری هرگز ردیف Party جدید
  نمی‌سازند؛ همه چیز به `party.id` ثابت گره خورده است.
- **Lead** همیشه به یک Party متصل است (`CreateLeadDto.partyId` الزامی — هم در
  DTO و هم به‌صورت گارد قطعی در سرویس). وضعیت‌ها: `NEW → CONTACTED →
  QUALIFIED/LOST` + `CONVERTED` (فقط با عملیات تبدیل؛ PATCH وضعیت معمولی
  هرگز به CONVERTED نمی‌رسد — `LEAD_CONVERT_REQUIRES_CONVERT_OPERATION`).
- **Opportunity** به همان Party متصل است؛ **الزام نقش CUSTOMER برداشته شد**
  (رفتار قبلی p4-03 که ساخت فرصت را منوط به مشتری بودن می‌کرد، با CR-001
  جایگزین شد). چند فرصت مستقل برای یک Party مجاز است.
- **Customer یک نقش تجاری مستقل از Pipeline است** (`PartyRole.role=CUSTOMER`)
  — نه یک Enum انحصاری. یک Party هم‌زمان می‌تواند مشتری + تأمین‌کننده +
  دارای فرصت فعال باشد.

## ۲. قانون تبدیل (فقط Backend — محدودیت UI نیست)

| رویداد | اثر بر نقش Customer |
|---|---|
| ثبت Lead / فعالیت / پیگیری | هیچ |
| تبدیل Lead → Opportunity (`POST /api/leads/:id/convert`) | هیچ — Party هنوز مشتری نیست |
| ایجاد پیش‌فاکتور (`POST /api/sales` با `opportunityId`) | هیچ |
| تأیید مشتری (`confirm` → CUSTOMER_CONFIRMED) | هیچ |
| **قطعی‌شدن سفارش (`activate` → SALES_ORDER)** | **اعطای نقش CUSTOMER — همان‌جا، در همان تراکنش** |
| لغو سفارش بعدی | **معکوس نمی‌شود** (سیاست معکوس‌سازی به تصمیم آینده مالک؛ سابقه می‌ماند) |

- اعطا **idempotent** است: Party مشتریِ موجود دست‌نخورده می‌ماند (همان ردیف
  نقش با همان `since`، بدون رویداد/audit تکراری)؛ اجرای هم‌زمان/مجدد هم
  Customer تکراری نمی‌سازد.
- هر اعطا: `party_roles` + Timeline «مشتری شد» (ROLE_ADDED) + Audit
  (`ROLE_ADDED` با `via=SALES_ORDER`) — همه در یک تراکنش با تغییر وضعیت سند.
- پیش‌فاکتور برای Lead مجاز است؛ فقط «وجود Party در همان شرکت» چک می‌شود
  (404 یکنواخت — بدون نشت وجود بین شرکت‌ها؛ جایگزین گارد قبلی assertCustomer).

## ۳. تبدیل Lead → Opportunity

- `POST /api/leads/:id/convert` (مجوز `crm.manage`) — صریح و با تأیید کاربر؛
  ثبت فعالیت به‌تنهایی هرگز تبدیل نمی‌کند.
- همان Party، همان مسئول (قابل تغییر در تبدیل)، حفظ تاریخچه فعالیت‌ها و
  یادداشت‌ها؛ ثبت سابقه تبدیل (Timeline `LEAD_CONVERTED` + `OPPORTUNITY_CREATED`
  + Audit).
- **Idempotent:** `opportunities.lead_id UNIQUE` — اجرای مجدد همان درخواست،
  همان فرصت را برمی‌گرداند (`alreadyConverted: true`)؛ رقابت هم‌زمان با CAS
  وضعیت Lead + این ایندکس حل می‌شود.
- Lead با وضعیت LOST قابل تبدیل نیست (`LEAD_LOST_CANNOT_CONVERT`).
- فیلد جدید: `opportunities.expected_close_date` (فقط تاریخ، بدون شیفت
  Timezone) + `opportunities.lead_id`.

## ۴. پیگیری‌ها و فعالیت‌ها

- فعالیت‌های Lead/Opportunity از **همان سیستم عمومی Activity** استفاده
  می‌کنند (`relatedEntityType='lead'|'opportunity'`) — بدون سیستم موازی.
- خلاصهٔ فعالیت (چیپ Odoo) در سرویس‌ها محاسبه می‌شود: `activity.nextActivityAt`
  + `overdueCount` + `openCount`.
- چرتر/Timeline: `GET /api/leads/:id/timeline` و
  `GET /api/opportunities/:id/timeline` (مجوز `crm.view`) — همان
  TimelineEvent مکانیزم Partyها.

## ۵. Pipeline (Kanban)

- ستون‌ها = زنجیرهٔ وضعیت backend-enforced: `OPEN → QUALIFIED → QUOTED →
  WON/LOST` (LOST نیازمند LostReason). مهاجرت غیرمجاز در UI هم پیشنهاد
  نمی‌شود و backend هم 422 می‌دهد.
- نمای کانبان + فهرست هر دو در `/crm/opportunities` (بدون کتابخانه DnD —
  HTML5 drag & drop مطابق رویه بدون‌وابستگی پروژه).
- جزئیات: `/crm/leads/[id]` و `/crm/opportunities/[id]` — کارت هویت، وضعیت،
  فعالیت‌ها، چرتر، پیش‌فاکتورها (لیست از ماژول فروش با فیلتر `opportunityId`).

## ۶. مجوزها

بدون کد مجوز جدید: خواندن `crm.view`، نوشتن/تبدیل `crm.manage`، فعالیت‌ها
`activities.*`، فروش `sales.*` (confirm/activate = `sales.confirm`).
رنگ‌آمیزی نقش‌ها از seed موجود.

## ۷. DatePicker / DateTimePicker / TimePicker سراسری

- کامپوننت‌های استاندارد: `components/ui/date-picker.tsx` (تقویم جلالی
  پاپ‌آپ، RTL، کیبورد، nullable، min/max)، `date-time-picker.tsx` (ساعت و
  دقیقه با گام ۱ دقیقه)، `time-picker.tsx`.
- قرارداد DatePicker: مقدار ISO «YYYY-MM-DD» — فیلد Date هرگز روز شیفت
  نمی‌خورد (سیاست R5-P1). DateTimePicker: ISO لحظهٔ UTC با نمایش ساعت محلی —
  همان رفتار datetime-local قبلی و سازگار با `jalaliDateTime()`.
- **پوشش سراسری:** `JalaliDateInput` به wrapper نازک روی DatePicker تبدیل شد
  → تمام فراخوانی‌های موجود (۳۰+ فایل: حسابداری، فروش، خرید، قیمت‌گذاری،
  انتشار، فعالیت‌ها، طرف‌حساب‌ها، مالیات، …) اکنون تقویم پاپ‌آپ دارند.
  Outlierهای خامGregorian مهاجرت شدند: گزارش‌ها (2×)، خزانه (3×)،
  approvals (1× datetime-local → DateTimePicker).
- فرمت ذخیره‌سازی Backend تغییر نکرده است؛ هیچ Secret وارد Git نشده.

## ۸. پوشش تست

- `src/crm/cr-001-crm-acceptance.spec.ts` — سناریوی ۱۳ مرحله‌ای مالک + موارد
  مرزی (مشتری موجود، فرصت بدون نقش مشتری، Lead بدون Party، نشت بین‌شرکتی،
  عدم‌تطابق Party فرصت، Lead باخته، دسترسی غیرمجاز) — ۱۰/۱۰.
- کل Integration: 216/216 suites، 1074/1074 — بدون رگرسیون. Unit: 482/0.
