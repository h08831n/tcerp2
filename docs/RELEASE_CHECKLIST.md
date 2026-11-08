# TCERP2 — RELEASE CHECKLIST

> متناسب با این Repository. نه Template عمومی.

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
