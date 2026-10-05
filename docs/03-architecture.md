# TCERP — Architecture

## Stack

| Layer | Choice |
|---|---|
| Frontend | Next.js 14 (App Router) + React 18 + TypeScript + Tailwind CSS, RTL-first (fa) |
| Backend | NestJS 10 + TypeScript, modular monolith (extractable services later) |
| Database | PostgreSQL 16 + Prisma ORM (migrations versioned in repo) |
| Cache / Lock | Redis 7 |
| Background jobs | Central DB-backed queue (`QueueJob` table, `SELECT … FOR UPDATE SKIP LOCKED`) + Redis/BullMQ for fan-out/scheduling where beneficial |
| Files | S3-compatible (MinIO locally) |
| Realtime | WebSocket/SSE push (list refresh, notifications, queue/import progress) |
| Auth | JWT access token (short-lived) + rotating refresh token (hashed in DB), HttpOnly cookies; 2FA-ready |

## Repository layout

```
tcerp/
├── docs/                     # requirements, domain map, ERD, architecture
├── apps/
│   ├── backend/              # NestJS API (port 3001, global prefix /api)
│   │   ├── prisma/           # schema.prisma + migrations + seed
│   │   └── src/
│   │       ├── common/       # errors, filters, guards, decorators, dto, utils
│   │       ├── config/       # env validation (zod)
│   │       ├── prisma/       # PrismaService (global)
│   │       ├── audit/        # AuditService + API
│   │       ├── auth/         # login/refresh/logout/me, lockout
│   │       ├── users/ roles/ teams/ settings/ sequences/
│   │       ├── files/        # S3 upload/download, dedupe, attachments
│   │       ├── queue/        # enqueue + worker (SKIP LOCKED, retries, DLQ)
│   │       └── health/
│   └── frontend/             # Next.js (port 3000)
├── docker-compose.yml        # postgres + redis + minio
└── PROJECT_PROGRESS.md
```

## Performance & stability principles (explicit priority)

1. **Lists**: cursor/offset pagination + server-side search/filter/sort only; never load full tables.
2. **Indexes**: defined together with every query pattern (see ERD doc); FKs always indexed.
3. **N+1 prevention**: Prisma `include`/`select` planned per endpoint; batched loads.
4. **Redis cache** for hot read-only data (today's prices, permission sets, settings) with
   explicit invalidation on write.
5. **Realtime**: status-critical changes (notifications, payment rejection, price updates,
   queue/import progress) are pushed over WebSocket/SSE instead of polling.
6. **Async everything heavy**: SMS, publishing, Moadian, import/export run in the queue; the UI
   never blocks on them.
7. **Optimistic locking** (`version`) on concurrently-edited documents; idempotency keys on
   automation/queue/booking paths; transactions around accounting postings.
8. **Stability**: global error envelope, structured logs, health checks, retry with backoff,
   dead-letter queue, connection resilience (Prisma + Redis reconnect).

## Cross-cutting rules

- **Permission enforcement is backend-side** (`PermissionsGuard` + `@RequirePermissions`);
  UI hiding is cosmetic only.
- **Audit** via `AuditService.record()` for every important change: who, when, old, new, action, reason.
- **Error model**: `{ statusCode, code, message, details, path, timestamp }` via a global filter;
  domain errors raise typed exceptions (ValidationError 422, NotFoundError 404, ForbiddenError 403,
  ConflictError 409, UnauthorizedError 401).
- **Validation**: DTO class-validator on every write endpoint (`ValidationPipe`, whitelist, forbidNonWhitelisted).
- **Sequences**: atomic `UPDATE … RETURNING` allocation; format `PREFIX-[JY-]NNNNN`; history never renumbered.
- **Jalali**: DB stores ISO dates; `common/utils/jalali.ts` converts for display/export.

## Phase plan

See PROJECT_PROGRESS.md. Phase 1+2 (this repo's current state) = architecture, Docker, DB schema,
auth, users/roles/permissions, audit, settings, sequences, files, queue, frontend shell with RTL + login.
