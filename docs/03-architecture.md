# TCERP — Architecture

## Stack

| Layer | Choice |
|---|---|
| Frontend | Next.js 14 (App Router) + React 18 + TypeScript + Tailwind CSS, RTL-first (fa) |
| Backend | NestJS 10 + TypeScript, modular monolith (extractable services later) |
| Database | PostgreSQL 16 + Prisma ORM (migrations versioned in repo) |
| Cache / Lock | Redis 7 |
| Background jobs | BullMQ + Redis = runtime execution (queueing, scheduling, retries); PostgreSQL `QueueJob` + `JobExecution` = durable business history, status, audit, idempotency. `QUEUE_DRIVER=auto` falls back to DB polling (`FOR UPDATE SKIP LOCKED`) when Redis is unavailable |
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
│   │       ├── auth/         # login/refresh/logout/me, lockout, company context
│   │       ├── users/ roles/ teams/ settings/ sequences/
│   │       ├── files/        # S3 upload/download, dedupe, attachments
│   │       ├── queue/        # BullMQ workers (Redis) + DB job history, retries, DLQ
│   │       └── health/
│   └── frontend/             # Next.js (port 3000)
├── graphify-out/             # LOCAL ONLY (git-ignored): code knowledge graph artifacts
│                             # (graph.html/graph.json/GRAPH_REPORT.md), rebuilt by a git
│                             # post-commit hook (AST-only). Navigation aid — never a
│                             # substitute for tests or architecture review.
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
- **Sequences v2**: company-scoped `sequences` row per `(company_id, document_type)` with
  `prefix`, `padding`, `reset_cycle` (`NEVER | FISCAL_YEAR | JALALI_YEAR | MONTHLY`),
  `current_number`, `last_reset_marker`; allocation is concurrency-safe (`SELECT … FOR UPDATE`
  in the allocation transaction); history is never renumbered after a format change.
- **Jalali**: DB stores ISO dates; `common/utils/jalali.ts` converts for display/export.

## Multi-company (Correction Gate #1)

- **From day one**: `companies` + `user_companies` (M:N membership, `is_default`) exist in the
  schema; `users.default_company_id` resolves the user's active company.
- **Company context per request**: client sends `X-Company-Id`; the backend validates it
  against the authenticated user's `UserCompany` membership (403 when not a member, 422 when
  unknown/suspended) and falls back to `default_company_id` when the header is absent.
- **Mandatory company scope** (`company_id NOT NULL`): `teams`, `settings`
  (`UNIQUE(company_id, key)`), `sequences` (`UNIQUE(company_id, document_type)`),
  `integration_configs` (`UNIQUE(company_id, code)`), `notification_rules`
  (`UNIQUE(company_id, code)`), and all Phase 3+ domain tables.
- **Nullable company scope** (null = platform-level): `queue_jobs`, `audit_logs`.
- **System-level**: `roles` / `permissions` (and user overrides) are not company-scoped;
  company-specific role bindings are supported through `user_companies` (future role-scope
  columns on membership).

## Seed credentials & security

- The seed admin is created **only** from `SEED_ADMIN_USERNAME` / `SEED_ADMIN_PASSWORD`
  environment variables; there are **no default credentials** in code, README or seed.
  In development, if no password is provided, the seed generates one and prints it **once**.
- Production startup **rejects** known default/weak passwords (the seed refuses to run with
  e.g. `Admin@12345`-style defaults and the app fails fast when `NODE_ENV=production` sees one).

## Graphify (option B)

`graphify-out/` is git-ignored; graph artifacts (`graph.html`, `graph.json`, `GRAPH_REPORT.md`)
are local-only and auto-rebuilt by a git post-commit hook (AST-only, no API cost). The graph
supports navigation only — it never replaces tests or architecture review (rules live in
`AGENTS.md`).

## Phase plan

See PROJECT_PROGRESS.md. Phase 1+2 (this repo's current state) = architecture, Docker, DB schema,
auth, users/roles/permissions, audit, settings, sequences, files, queue, frontend shell with RTL + login.
