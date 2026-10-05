# PROJECT_PROGRESS

## Completed

### Phase 1 — Architecture & Repository Setup
- [x] Requirements captured: `docs/REQUIREMENTS.md`
- [x] Domain map (bounded contexts, module boundaries, exclusions): `docs/01-domain-map.md`
- [x] Initial ERD (all target entities, cardinalities, indexes/uniques): `docs/02-erd.md`
- [x] Architecture doc incl. performance/realtime/stability principles: `docs/03-architecture.md`
- [x] Monorepo layout: `apps/backend`, `apps/frontend`, root scripts
- [x] Docker Compose: PostgreSQL 16, Redis 7, MinIO
- [x] Environment configuration: `.env.example`
- [x] Prisma schema (Phase 1+2 foundation): users, roles, permissions (+user overrides),
      teams, refresh tokens, audit logs, settings, sequences, files (content-hash dedupe),
      queue jobs (idempotency, retries, DLQ statuses), integration configs,
      notifications + notification rules

### Phase 2 — Foundation (in progress this iteration)
- [x] NestJS backend scaffold: config validation (zod), global error envelope filter,
      structured logging, `/api` prefix, cookie-based JWT auth (access 15m + rotating
      hashed refresh token), login lockout, permissions guard (backend-enforced)
- [x] Modules: auth, users, roles/permissions, teams, settings, audit, sequences
      (atomic allocation, Jalali-year numbering), files (S3/MinIO, sha256 dedupe,
      attachments), queue (SKIP LOCKED claim, backoff retries, dead-letter), health
- [x] Prisma migration SQL (generated without live DB via `migrate diff`) + seed
      (permission catalog, system roles, admin user)
- [x] Unit tests: jalali conversion, phone normalization, sequence allocation,
      login lockout, permissions guard logic
- [x] Next.js frontend shell: RTL fa layout, Vazirmatn font, login page (real API),
      app shell (sidebar/header/notifications placeholder), dashboard, API client
      with automatic refresh-token retry

## Current module
- Phase 2 verified end-to-end on live local stack (see Verification below). Ready to start Phase 3 (Party/CRM + Product).

## Verification log (2026-10-05, live local stack)
- Docker: `tcerp-postgres` (host port **5433** — 5432 occupied by a local Windows PostgreSQL
  service), `tcerp-redis` (6379), `tcerp-minio` (host port **9100** — 9000 occupied by PhpStorm;
  image pulled via ArvanCloud mirror because Docker Hub blocks minio on this network).
- `prisma migrate deploy` + `db:seed` successful (idempotent re-run verified).
- Backend smoke tests (dev server on :3001): health OK; login `admin` OK (cookies set);
  wrong password → 401 + `LOGIN_FAILED` audit row; `/auth/me` returns roles+permissions;
  unauthenticated `/users` → 401; sequence allocate → `SD-1405-00001`, `SD-1405-00002`
  (Jalali year + padding correct); queue enqueue → worker processed → `SUCCEEDED` with
  retained history; audit list API works.
- Frontend smoke test (production build on :3000): RTL `lang="fa" dir="rtl"`, Persian login
  form rendered.
- Fixes made during verification: `AuditModule` made `@Global` (DI error at bootstrap that
  `nest build` cannot catch), `migration_lock.toml` rewritten in Prisma's expected bare-key
  format, `queue.enqueue` permission + `POST /api/queue/jobs` admin endpoint added.

## Pending modules (phases 3–12 per REQUIREMENTS §111)
- Phase 3: CRM (Party/Contacts/Addresses/Customer Score) + Product (templates, variants,
  attributes, UOM, brands, categories, supplier mapping)
- Phase 4: Sales (Lead/Opportunity/SalesDocument), Purchase, Price Request, Supplier Offers,
  Document Flow, Sales↔Purchase allocation
- Phase 5: Daily Pricing + Publishing (channel adapters, per-channel jobs)
- Phase 6: Loading + allocations + inventory (auto stock movements)
- Phase 7: Accounting core (CoA, fiscal years, journals, receipts/payments, payment claims,
  bank ledger with running balance, checks, reconciliation, opening balances,
  financial responsibility)
- Phase 8: Tax invoices (Sales/Purchase, M:N with orders, tax products) + Moadian module
- Phase 9: Activities, Calendar, Workflow engine, Approval engine, Automation engine,
  Notification rules, SMS engine
- Phase 10: Reporting/saved views, dashboards, global search + command palette
- Phase 11: Portal API, import/export engine (chunked, resumable)
- Phase 12: Hardening (security review, perf, index review, backup, monitoring)

## Architectural decisions (log)
1. **Modular monolith** (NestJS) — one deployable, strict module boundaries; services can be
   extracted later without API redesign.
2. **Queue source of truth = PostgreSQL `queue_jobs`** with `FOR UPDATE SKIP LOCKED` claiming:
   reliable without extra infra, Redis/BullMQ can be layered on for scheduling later.
3. **JWT access (15m) in HttpOnly cookie + rotating refresh tokens (sha256-hashed in DB)** —
   supports portal + API clients; 2FA-ready.
4. **Permissions**: catalog table + role bindings + per-user GRANT/REVOKE overrides; enforced by
   `PermissionsGuard` server-side; record scopes (OWN/TEAM/ALL) planned per-module in Phase 3+.
5. **Foundation tables omit `company_id`**; domain tables (Phase 3+) carry it from birth
   (multi-company readiness without premature complexity).
6. **Tax rate snapshotting** and **append-only Moadian attempts** are schema-level invariants
   (to be enforced when Phase 8 tables land).
7. **Audit** = explicit `AuditService.record()` calls (typed events) rather than magic ORM
   middleware — keeps reasons and actor names accurate.
8. Performance: pagination + composite indexes from day one, Redis planned for hot reads
   (today's price, permission sets), WebSocket/SSE planned for realtime UI (Phase 9+ wiring,
   envelope already in place).

## Known issues
- Ports: DB exposed on host **5433** and MinIO on **9100** (already reflected in
  `docker-compose.yml`, `.env.example`, `apps/backend/.env`) because 5432/9000 are taken by
  the user's local PostgreSQL service and PhpStorm.
- Docker Hub blocks `minio/minio` on this network — `docker-compose.yml` still references the
  official name; if the image is missing, pull via mirror and retag:
  `docker pull docker.arvancloud.ir/minio/minio:latest && docker tag docker.arvancloud.ir/minio/minio:latest minio/minio:latest`.
- Frontend dashboard is a shell; widgets arrive in Phase 10. Auth gate is client-side in the
  shell (fine for now; server middleware can be added later).

## Next steps
1. Apply migrations + seed against local Docker Postgres; smoke-test login → dashboard.
2. Phase 3: Party/CRM + Product schema, services, APIs, permissions, audit, list/form UIs.
