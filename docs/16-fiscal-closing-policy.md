# TCERP2 — تحلیل سیاست حسابداری بستن سال مالی (Gate D-3)

> این سند برای تأیید مالک ارائه می‌شود — هیچ الگوریتمی پیاده‌سازی نمی‌شود تا تأیید دریافت شود.

---

## مسئله

در پایان سال مالی، ماندهٔ حساب‌های موقت (درآمد و هزینه) باید صفر شوند و خالص به یک حساب دائمی منتقل شود. انتخاب حساب مقصد، سیاست حسابداری است و نیاز به تصمیم مالک دارد.

---

## حساب‌های فعلی chart (تأییدشده از seed)

| کد | نوع | نقش |
|---|---|---|
| BANK | ASSET | حساب بانک |
| RECEIVABLE | ASSET | دریافتنی |
| PAYABLE | LIABILITY | پرداختنی |
| SALES_REVENUE | REVENUE | درآمد فروش |
| PURCHASE_EXPENSE | EXPENSE | بهای تمام‌شده |
| INVENTORY | ASSET | موجودی کالا |
| OPENING_EQUITY | EQUITY | سرمایهٔ افتتاحیه |
| CHECKS_IN_TRANSIT | ASSET | چک‌های در جریان وصول |

---

## گزینه‌های Closing

### گزینهٔ A — مستقیم به OPENING_EQUITY

```text
Dr SALES_REVENUE        (بستانکارِ مانده)
Cr PURCHASE_EXPENSE     (بدهکارِ مانده)
خالص → Dr/Cr OPENING_EQUITY
```

- **مزیت:** ساده، بدون حساب جدید
- **عیب:** سود/زیان دوره از سرمایهٔ اولیه تفکیک نمی‌شود — در سال‌های بعد، تشخیص «سود انباشته» از «سرمایهٔ اولیه» غیرممکن است

### گزینهٔ B — RETAINED_EARNINGS (سود انباشته) — **پیشنهادی**

```text
Dr SALES_REVENUE        (بستانکارِ مانده)
Cr PURCHASE_EXPENSE     (بدهکارِ مانده)
خالص → Dr/Cr RETAINED_EARNINGS
```

- **مزیت:** استاندارد حسابداری — سود انباشته از سرمایهٔ اولیه تفکیک می‌شود. مراجع: مادهٔ ۲۳۸ قانون تجارت (اندوختهٔ قانونی) و مادهٔ ۲۴۰ (سود قابل تقسیم) — شرایط تقسیم و اندوخته را تعیین می‌کنند ولی هدف closing entries صرفاً انتقال ماندهٔ حساب‌های موقت به حساب دائمی است
- **عیب:** حساب جدید در chart لازم است (migration افزایشی، data-preserving)
- **افتتاحیهٔ سال بعد:** فقط حساب‌های دائمی (ASSET/LIABILITY/EQUITY) — موقتی‌ها صفر شده‌اند

### گزینهٔ C — حساب واسطه (PROFIT_SUMMARY / LOSS_SUMMARY)

```text
Dr SALES_REVENUE → Cr PROFIT_SUMMARY
Cr PURCHASE_EXPENSE → Dr LOSS_SUMMARY
خالص → Dr/Cr RETAINED_EARNINGS (از PROFIT_SUMMARY/LOSS_SUMMARY)
```

- **مزیت:** تفکیک سود دوره از سود انباشته — گزارش سود و زیان دقیق‌تر
- **عیب:** پیچیدگی بیشتر — دو حساب واسطهٔ اضافی
- **مناسب برای:** شرکت‌هایی که گزارش تفصیلی سود دوره‌ای می‌خواهند

---

## پیشنهاد

**گزینهٔ B (RETAINED_EARNINGS)** — استاندارد، ساده، و قابلیت گزارش سود انباشته را دارد.

OPENING_EQUITY فقط برای افتتاحیهٔ اولیه (سال مالی اول) استفاده می‌شود.

---

## Migration لازم (اگر گزینهٔ B تأیید شود)

1. حساب `RETAINED_EARNINGS` (EQUITY) به chart هر شرکت ACTIVE اضافه شود (data-preserving upsert)
2. متد `close()` در FiscalYearService
3. Endpoint `POST /api/accounting/fiscal-years/:id/close` با permission `accounting.fiscal.manage`
4. `POST /api/accounting/fiscal-years/:id/reopen` (admin-only + reason + audit)

---

## سناریوی تست (پیشنهادی)

1. ثبت سند فروش و خرید در سال ۱۴۰۴
2. بستن سال ۱۴۰۴ → سند closing متوازن → status → CLOSED
3. posting به سال بسته → FISCAL_YEAR_CLOSED
4. افتتاحیهٔ ۱۴۰۵ از ماندهٔ حساب‌های دائمی → تولید خودکار
5. reopen سال ۱۴۰۴ (admin + reason) → posting مجاز → re-close
6. ماندهٔ RETAINED_EARNINGS در ۱۴۰۵ = سود ۱۴۰۴
