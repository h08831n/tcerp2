# 09 — Activity Engine, Calendar & Timeline (Phase 9A)

## منبع رسمی

REQUIREMENTS §49 (Activity Engine)، §56 (Central Calendar)، §57 (Unified
Timeline). وضعیت: **پیاده‌سازی‌شده (9A)**.

## مدل داده

- `ActivityType` (company-scoped، کد یکتا در شرکت، فعال/غیرفعال) — انواع
  داینامیک طبق §49.
- `Activity` — type/title/description/relatedEntityType+Id/createdByType
  (USER|SYSTEM)/assignedTo/priority/scheduledDate/dueDate/status/
  completedAt/completedBy. اندیس‌های پوشش‌دهنده برای فهرست و تقویم.
- `TimelineEvent` (Phase 3A موجود) — موتور تایم‌لاین عمومی؛ رویدادهای
  ACTIVITY_CREATED / ACTIVITY_COMPLETED / ACTIVITY_OVERRIDDEN / ACTIVITY_UPDATED
  روی موجودیت مرتبط نوشته می‌شوند.

## قواعد کلیدی

- Completed activity برای کاربر عادی **LOCKED** است؛ ویرایش نیازمند مجوز
  `activities.override` + دلیل (>=۳ نویسه) است و روی ردیف
  lastOverrideById/Reason ثبت و audit می‌شود (ACTIVITY_LOCKED_OVERRIDE_REQUIRED /
  ACTIVITY_OVERRIDE_REASON_REQUIRED).
- Overdue مشتق‌شده است (status=PENDING && dueDate<now) — ستون ذخیره‌شده ندارد.
- ایجاد SYSTEM (Workflow/Automation) با createdByType='SYSTEM' و بدون ردیف
  کاربر جعلی؛ تکرار trigger با همان (type, title, relatedEntity) idempotent است.
- تکمیل فعالیت دقیقاً **یک** رویداد ACTIVITY_COMPLETED در تایم‌لاین موجودیت
  می‌سازد (dedup با کوئری data->activityId).
- assignee باید عضو همان شرکت باشد (ACTIVITY_ASSIGNEE_NOT_IN_COMPANY).
- انواع فعالیت داینامیک‌اند: create کاربر با کد ناموجود/غیرفعال رد می‌شود
  (پیام اقدام‌پذیر)؛ فقط جریان SYSTEM auto-provision می‌کند.

## تقویم مرکزی

`POST /activities/calendar` با from/to UTC و لایه‌های
activities/checks/payments/approvals. هر لایه فقط خواندنی است (projection از
ماژول‌های موجود)؛ حذف لایه داده را تغییر نمی‌دهد. سقف ۵۰۰ ردیف در هر لایه.

## مجوزها

activities.view / view_all / create / edit / delete / override. بدون
view_all کاربر فقط فعالیت‌های خودش را می‌بیند (OWN scope). admin = ALL.
