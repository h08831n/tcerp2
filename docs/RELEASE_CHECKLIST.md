# TCERP2 — RELEASE CHECKLIST

> متناسب با این Repository. نه Template عمومی.

## وضعیت Git واقعی پیش از merge (تأییدشده با git + GitHub API — 2026-11-08)

- `main` = `603aaeb` (CI سبز)
- **۶ PR باز** — همگی `mergeable: true`، بدون auto-merge. PR #12 قبلاً به شاخهٔ
  `feature/d2-portal-business-api` merge شده و PR #7 آن را به main می‌آورد.

| PR | HEAD | Base | CI |
|---|---|---|---|
| #7 (D-2 کامل: Phase 2+3) | `54cc6f7` | main | ✅ run #140 — هر دو job |
| #10 (backlog امنیتی) | `eb85307` | main | ✅ |
| #11 (CLI hardening — stacked روی #10) | `533605d` | feature/backlog-security | پس از merge #10 روی main اجرا می‌شود |
| #13 (D-4 exports) | `3d9d50e` | main | ✅ |
| #14 (D-5 weighbridge) | `52cb34d` | main | ✅ (S3 NOT_TESTED) |
| #15 (D-3 fiscal tests) | `1d08291` | main | ✅ |

- **ترتیب merge:** #7 → #10 → #11 → #13 → #15 → #14 (آخر — NOT_TESTED)
- **NOT_TESTED در CI:** تست‌های S3/MinIO. هر ۴ رجیستری عمومی gated است
  (Docker Hub حذف دائمی 2025، quay 401، ECR 404، dl.min.io 403)؛ تست‌ها در CI
  با دلیل چاپ‌شده SKIP می‌شوند و هرگز PASS خاموش نیستند. اثبات Storage =
  اجرای محلی با MinIO واقعی (UP: 10/10؛ DOWN: 2 pass + 8 skip با تفکیک خطای
  اتصال واقعی) + آیتم‌های بخش Storage زیر روی سرور مقصد.

## Environment

- [ ] `apps/backend/.env` — DATABASE_URL, JWT_SECRET (≥16 chars), JWT_REFRESH_SECRET, S3_* (MinIO), REDIS_URL
- [ ] `apps/frontend/.env` — NEXT_PUBLIC_API_URL
- [ ] `NODE_ENV=production` → secure cookies فعال
- [ ] `SEED_ADMIN_PASSWORD` قوی و متفاوت از dev

## Secrets

- [ ] JWT_SECRET ≥ 32 کاراکتر تصادفی
- [ ] JWT_REFRESH_SECRET متفاوت از JWT_SECRET
- [ ] S3_ACCESS_KEY/S3_SECRET_KEY از MinIO production
- [ ] Moadian credentials (MOADIAN_* env) — فقط اگر D-1 فعال می‌شود
- [ ] هیچ Secret در .env.example یا کد

## Database

- [ ] Backup: `pg_dump -Fc tcerp > backup.dump`
- [ ] Migration: `npx prisma migrate deploy` (فقط deploy — نه dev)
- [ ] Migration روی DB خالی تست شده (CI: ۴۱+ migration)
- [ ] Seed: `npm run db:seed` (فقط بار اول)
- [ ] Performance: `ANALYZE` بعد از restore

## Build

- [ ] `cd apps/backend && npm run build` → dist/
- [ ] `cd apps/frontend && npm run build` → .next/
- [ ] Typecheck: `npx tsc --noEmit -p tsconfig.json`

## Tests

- [ ] Unit: `npx jest --ci` → ۰ FAIL
- [ ] Integration: `npm run test:integration -- --ci` → ۰ FAIL
- [ ] Security: gate-c specs → سبز
- [ ] Isolation: cross-company specs → سبز
- [ ] Concurrency: p8 concurrent specs → سبز
- [ ] Idempotency: queue/import/idempotency specs → سبز

## Auth

- [ ] Login admin کار می‌کند
- [ ] Password reset از CLI کار می‌کند
- [ ] tokenVersion: توکن قدیمی پس از reset → 401
- [ ] Refresh rotation: هر refresh → token جدید
- [ ] Reuse detection: token تکراری → ابطال همه

## Permissions

- [ ] seed: همه Permissionها ثبت شده
- [ ] Admin: دسترسی کامل
- [ ] Salesperson: محدود به فروش
- [ ] Accountant: دسترسی حسابداری بدون settings.edit

## Storage

- [ ] MinIO reachable: `curl http://localhost:9100/minio/health/live`
- [ ] Bucket: `tcerp-files` (files.service خودکار می‌سازد)
- [ ] Portal file download: آپلود → دانلود → محتوا درست
- [ ] Customer visibility: فایل internal → portal 404

## Queue

- [ ] Redis: `redis-cli ping` → PONG
- [ ] Queue jobs: FAILED jobs قابل retry
- [ ] Dead letter: jobs بیش از ۳ retry → FAILED status

## Logging

- [ ] NestJS Logger فعال (بدون debug)
- [ ] Correlation ID در RequestLogger
- [ ] هیچ password/hash/token در log
- [ ] Prometheus `/api/metrics` فعال (aggregate-only)

## Deployment

- [ ] `NODE_ENV=production`
- [ ] HTTPS فعال (reverse proxy)
- [ ] CORS origin: دامنه واقعی (نه localhost)
- [ ] Firewall: فقط پورت‌های 80/443 عمومی
- [ ] Database: فقط از backend قابل دسترسی

## Rollback

- [ ] Backup قبل از migration
- [ ] `npx prisma migrate resolve --rolled-back <migration>` (در صورت نیاز)
- [ ] Docker image قبلی برای rollback سریع

## Smoke Test

- [ ] `GET /api/health` → 200
- [ ] `POST /api/auth/login` → 200 + cookies
- [ ] `GET /api/parties` → 200 (با auth)
- [ ] Portal: request-otp → verify-otp → me → 200
- [ ] `GET /api/metrics` → 200 (aggregate)
