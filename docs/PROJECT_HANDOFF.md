# TCERP2 — PROJECT HANDOFF

> راهنمای عملیاتی برای شروع توسعه اختصاصی روی TCERP2.

## معماری

- **Backend:** NestJS 10 + Prisma 5.22 + PostgreSQL 16 (پورت 5433) + Redis/BullMQ + MinIO (پورت 9100)
- **Frontend:** Next.js 14 (RTL, Vazirmatn) روی پورت 3000
- **Auth:** JWT (access 15m + refresh 30d) با refresh rotation و reuse detection
- **Multi-company:** همه کوئری‌ها company-scoped از CompanyContextService
- **Portal:** Cookie-authenticated (portal_session) با OTP، جدا از JWT کارمندان

## راه‌اندازی

```bash
# ۱. Docker Desktop را روشن کنید
run-local.bat          # از ریشه پروژه — همه‌چیز را خودکار بالا می‌آورد
# یا دستی:
docker compose up -d   # postgres:5433, redis:6379, minio:9100
cd apps/backend && npm ci && npx prisma generate && npx prisma migrate deploy && npm run db:seed
npm run start:dev      # backend on :3001
cd ../frontend && npm ci && npm run dev  # frontend on :3000
```

## ورود ادمین

رمز ادمین در `apps/backend/.env` (متغیر `ADMIN_INITIAL_PASSWORD`) تنظیم می‌شود —
**مقدار پیش‌فرض را قبل از هر استقرار واقعی عوض کنید** و آن را در این سند یا هر
مستند متنی ذخیره نکنید. در صورت گم‌شدن، با Ops CLI زیر آن را بازنشانی کنید.

## Ops CLI

> هر فرمان جهشی که وضعیت DB را تغییر می‌دهد، ابتدا مقصد را با
> `--confirm-target "postgresql://<user>@<host>:<port>/<db>"` تأیید می‌کند
> (نام‌محور کافی نیست — host:port/db کامل باید مطابقت داشته باشد).

```bash
cd apps/backend
npm run cli -- reset-password <username>          # تعاملی (پرامپت مخفی)
npm run cli -- unlock <username> --yes --confirm-target "postgresql://...@localhost:5433/tcerp"
npm run cli -- set-status <username> DISABLED --yes --confirm-target "postgresql://...@localhost:5433/tcerp"
npm run cli -- list-users
```

## اجرای تست‌ها

```bash
cd apps/backend
npm test                          # unit (بدون DB)
npm run test:integration          # integration (با tcerp_test)
```

## ساختار ماژول‌ها

```
apps/backend/src/
├── auth/           # JWT + refresh + lockout
├── accounting/     # journal, fiscal year, opening balance, reports
├── activities/     # فعالیت‌ها و تقویم
├── approvals/      # گردش تأیید
├── automation/     # قواعد اتومیشن
├── companies/      # CompanyContextService
├── files/          # FileBlob + FileAttachment (MinIO)
├── goods-receipt/  # رسید کالا
├── imports/        # CSV import engine + exports
├── loading/        # بارگیری + allocations
├── notifications/  # SMS center + notification rules
├── portal/         # پورتال مشتری (OTP, session, business API, files)
├── pricing/        # قیمت‌گذاری روزانه
├── products/       # کاتالوگ محصول
├── purchase/       # خرید
├── queue/          # BullMQ + polling fallback
├── sales/          # فروش + allocations
├── tax/            # مودیان (Phase 8)
├── treasury/       # خزانه‌داری
├── users/          # مدیریت کاربران
├── workflow/       # موتور workflow
└── common/         # guards, filters, interceptors, errors
```

## افزودن قابلیت جدید

۱. ماژول در `src/<module>/` با `module.ts`, `service.ts`, `controller.ts`, `dto.ts`
۲. ثبت در `app.module.ts`
۳. Permission در `permissions.service.ts` + seed
۴. Migration: `npx prisma migrate dev --name <description>`
۵. Company scope: از `CompanyContextService.requireCompanyId()` استفاده کنید
۶. Audit: `AuditService.record()` (non-critical) یا `recordTx()` (atomic)

## Company Scope

هر Query باید `companyId` از session/context داشته باشد. برای پورتال مشتری از `PortalAuthGuard` استفاده کنید که `ctx.companyId` و `ctx.partyId` را فراهم می‌کند.

## Migration

```bash
npx prisma migrate dev --name <description>   # dev
npx prisma migrate deploy                      # production (فقط deploy)
```

## تست‌ها

- Integration: `node scripts/test-integration.js` (tcerp_test DB)
- Unit: `npx jest` (بدون DB)
- هر spec فایل از `assertSafeIntegrationDatabase` برای اطمینان از DB تستی استفاده می‌کند
