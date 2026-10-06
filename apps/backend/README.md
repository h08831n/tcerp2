# TCERP Backend

NestJS 10 + Prisma 5 + PostgreSQL backend for the TCERP steel-trading ERP
(modular monolith, port **3001**, global prefix **/api**).

Foundation: auth (JWT access + rotating refresh in HttpOnly cookies, failed-login
lockout), users/roles/permissions (effective = roles − REVOKE + GRANT
overrides), audit trail, S3/MinIO files with content-addressed dedupe, health
check. Multi-company (Architecture Correction Gate): companies, company context
per request, company-scoped settings/teams/sequences/integrations/notification
rules, sequences v2 (Jalali reset cycles), hybrid BullMQ queue, treasury
(bank accounts / transfers / receipts / payments / checks / statement ledger),
operational settlement claims, tax definitions + invoice↔order allocations,
supplier product mappings, loadings, workflow timers, notification rules.

## Setup

```bash
npm install
cp .env.example .env               # adjust DATABASE_URL / JWT secrets / SEED_*
npx prisma generate
npx prisma migrate deploy          # needs a running Postgres
npm run db:seed                    # permissions, roles, admin, COA, sequences
npm run start:dev
```

### Credentials (no defaults)

- `SEED_ADMIN_USERNAME` (default `admin`) and `SEED_ADMIN_PASSWORD` configure
  the seeded admin. There is **no default password**. In development, if
  `SEED_ADMIN_PASSWORD` is unset the seed generates a random one and prints it
  **once**. In production an unset password aborts the seed.
- **Startup guard**: with `NODE_ENV=production` the backend refuses to boot
  when `SEED_ADMIN_PASSWORD` (or legacy `ADMIN_PASSWORD`) equals a well-known
  default (`Admin@12345`, `admin`, `password`, `123456`).
- `mustChangePassword=true` is set on the seeded admin; re-seeding never
  resets an existing admin's password.

### Queue driver (`QUEUE_DRIVER`)

`auto` (default) uses BullMQ/Redis for runtime execution and falls back to
DB polling (one-time warning) when Redis is unreachable; `bullmq` is
Redis-only; `db` is polling-only. PostgreSQL (`queue_jobs` + `job_executions`)
always stays the durable source of truth for history, status, retries and
idempotency; BullMQ jobs use `jobId = queue_jobs.id` and a custom backoff
(60s ×4^n capped at 6h, same curve as the DB fallback).

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run build` | Compile (nest build) |
| `npm run start:dev` | Dev server with watch |
| `npm test` | Jest unit tests (no DB/Redis required — Prisma/BullMQ mocked) |
| `TEST_INTEGRATION=1 npm test` | Also run integration tests against the live DB |
| `npm run prisma:generate` | Generate the Prisma client |
| `npm run prisma:migrate` | `prisma migrate deploy` |
| `npm run db:seed` | Idempotent seed (ts-node prisma/seed.ts) |

## Layout

```
prisma/            schema.prisma, migrations/, seed.ts
src/
  common/          errors, exception filter, guards, decorators, DTOs, utils (jalali, phone)
  config/          zod-validated env (CONFIG token, global) + production password guard
  prisma/          PrismaService (global)
  permissions/     effective-permission resolution (global)
  audit/           audit trail (company-scoped) + GET /api/audit
  companies/       Company CRUD + CompanyContextService (x-company-id resolution)  [global]
  queue/           hybrid queue: QueueService, BullMQ producer/worker, DB-polling fallback  [global]
  auth/            login/refresh/logout/me (me returns companies[]), lockout
  users/ roles/ teams/ settings/ sequences/ files/ health/
  accounting/      JournalService (balanced posting, reversal)
  treasury/        bank accounts, transfers, receipts, payments, checks, statement ledger
  claims/          operational settlement claims + party operational balance
  tax/             tax definitions (immutable after first use) + M:N allocations
  supplierproduct/ supplier ↔ product 3-level mapping (exactly-one CHECK)
  loading/         loading header + lines + allocations
  workflow-timer/  durable timers executed by the queue (action registry)
  notifications/   notification rules (condition engine) + dispatch service
  integrations/    integration adapter configs (SMS/…)
```

Company context: scoped controllers resolve the active company via
`CompanyContextService.requireCompanyId(user, headers)` — the `x-company-id`
header when the user is a member (else 403), else the default membership.
`GET /api/auth/me` returns `companies[]` (`id`, `nameFa`, `isDefault`).

Conventions: typed `AppError` subclasses → `{ statusCode, code, message, details, path, timestamp }`
error envelope; `@RequirePermissions(...)` enforced server-side by
`PermissionsGuard`; every write audited via `AuditService.record` (with
company scope); optimistic locking (`version`) where history matters; sequence
counters and posted journal entries are never rewritten.

## API endpoints

All routes require a valid access token (Bearer header or `access_token`
cookie) except `POST /api/auth/*` and `GET /api/health`. Company-scoped
routes accept `x-company-id`.

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/api/auth/me` (now incl. `companies[]`, `defaultCompanyId`) | authenticated |
| GET | `/api/companies` | `companies.view` |
| POST | `/api/companies` (grants creator membership + default) | `companies.create` |
| GET/PATCH/DELETE | `/api/companies/:id` | `companies.view` / `edit` / `delete` |
| GET | `/api/settings` (`?category=`) — company scoped | `settings.view` |
| PUT | `/api/settings` `{key, value, category?}` (upsert, audited old/new) | `settings.edit` |
| GET | `/api/sequences` — company scoped | `sequences.view` |
| POST | `/api/sequences` (create config) | `sequences.edit` |
| POST | `/api/sequences/allocate` `{documentType}` | `sequences.edit` |
| PUT | `/api/sequences/:id` (prospective config only; counters never rewritten) | `sequences.edit` |
| GET | `/api/queue/jobs` (`?status=&jobType=`; incl. `executionsCount`) | `queue.view` |
| POST | `/api/queue/jobs` (companyId from context; null = platform job) | `queue.enqueue` |
| POST | `/api/queue/jobs/:id/retry` / `:id/cancel` | `queue.retry` |
| GET | `/api/treasury/bank-accounts` | `treasury.view` |
| POST | `/api/treasury/bank-accounts` | `treasury.create` |
| GET/PATCH/DELETE | `/api/treasury/bank-accounts/:id` | `treasury.view` / `edit` / `delete` |
| GET | `/api/treasury/bank-accounts/:id/statement?from&to` (ordered, running balance) | `treasury.view` |
| POST | `/api/treasury/transfers` `{sourceBankAccountId, destinationBankAccountId, amount, fee?}` | `treasury.create` |
| POST | `/api/treasury/receipts` `{bankAccountId, partyId?, amount, date?}` | `treasury.create` |
| POST | `/api/treasury/payments` | `treasury.create` |
| GET | `/api/treasury/checks?status&direction` | `treasury.view` |
| POST | `/api/treasury/checks/incoming` / `outgoing` (no bank effect) | `treasury.create` |
| POST | `/api/treasury/checks/:id/pending` / `:id/deposit` / `:id/bounce` / `:id/cancel` | `treasury.edit` |
| POST | `/api/treasury/checks/:id/clear` `{bankAccountId}` (incoming; bank effect) | `treasury.edit` |
| POST | `/api/treasury/checks/:id/pay` `{bankAccountId}` (outgoing; bank effect) | `treasury.edit` |
| GET | `/api/claims?status&partyId` | `claims.view` |
| POST | `/api/claims` `{direction, partyId, salesDocumentId?, purchaseDocumentId?, amount}` | `claims.create` |
| POST | `/api/claims/:id/reject` `{reason}` (restores balance, audits, notifies) | `claims.edit` |
| POST | `/api/claims/:id/match` `{receiptId?|paymentId?}` | `claims.edit` |
| GET/POST/PATCH | `/api/tax/definitions`, `PATCH /api/tax/definitions/:id` | `tax.view` / `create` / `edit` |
| POST | `/api/tax/definitions/:id/mark-used` (one-way) | `tax.edit` |
| GET/POST | `/api/tax/allocations/sales`, `/api/tax/allocations/purchase` | `tax.view` / `edit` |
| GET/POST/PATCH | `/api/supplier-products` | `supplierproduct.view` / `create` / `edit` |
| GET/POST | `/api/loadings`, `GET /api/loadings/:id` (lines + allocations) | `loading.view` / `create` |
| GET/POST | `/api/workflow-timers`, `POST /api/workflow-timers/:id/cancel` | `workflowtimer.view` / `edit` |
| GET/POST/PATCH/DELETE | `/api/notifications/rules` | `notifications.view` / `edit` |
| GET/POST/PATCH/DELETE | `/api/integrations` | `integrations.view` / `create` / `edit` / `delete` |

### Parties / CRM core (Phase 3A)

All party routes are record-scope filtered (backend-enforced): users with
`parties.scope.all` see every party in the company (`sales_manager` via
`parties.scope.team` sees their teams'), everyone else only parties they own
(`ownerUserId`). Out-of-scope reads/writes → 403. Party PATCH/owner/archive
are optimistic-locked on `version` (`VERSION_CONFLICT` on mismatch).

| Method | Path | Permission |
| --- | --- | --- |
| POST | `/api/parties/check-duplicate` `{mobile?, nameFa?, excludePartyId?}` → `{exact?, similar[]}` (pg_trgm ≥ 0.85, warning only) | `parties.view` |
| POST | `/api/parties` `{type, nameFa, …, phones?, roles?, ownerUserId?}` → 201 `{party, warnings?}` (duplicate normalized MOBILE → 409 `DUPLICATE_PHONE`) | `parties.create` |
| GET | `/api/parties` `?page&pageSize&search&type&role&ownerUserId&archived&scoreLevel&sortBy&sortDir` | `parties.view` |
| GET | `/api/parties/:id` (roles, phones, contacts+phones, addresses, owner, score) | `parties.view` |
| PATCH | `/api/parties/:id` (version-checked; `ownerUserId` change needs `parties.owner.change` + `OWNER_CHANGED` audit/timeline) | `parties.edit` |
| DELETE | `/api/parties/:id` (soft archive) / POST `/api/parties/:id/restore` | `parties.archive` |
| POST/DELETE | `/api/parties/:id/roles` `{role}` · `/api/parties/:id/roles/:role` | `parties.role.manage` |
| POST/DELETE | `/api/parties/:id/phones` `{kind, value, isPrimary?}` · `/api/parties/:id/phones/:phoneId` | `parties.phone.manage` |
| POST/PATCH/DELETE | `/api/parties/:id/contacts` (+`phones[]`) · `/:id/contacts/:contactId` | `parties.contact.manage` |
| POST/PATCH/DELETE | `/api/parties/:id/addresses` · `/:id/addresses/:addressId` | `parties.address.manage` |
| POST | `/api/parties/:id/owner` `{userId}` | `parties.owner.change` |
| GET | `/api/parties/:id/timeline` `?limit&includeHidden` (hidden rows only for scope-ALL / `audit.view` holders) | `timeline.view` |
| POST/DELETE/GET | `/api/parties/:id/financial-responsibility` `{responsiblePartyId}` (member uniqueness; GET returns group + consolidated balance from `party_operational_balances`) | `financialresponsibility.manage` |
| POST | `/api/parties/:id/score/recompute` (rules from Setting `crm.score_rules`; writes `CustomerScoreHistory` + caches `Party.score/scoreLevel`) | `parties.score.compute` |
| GET | `/api/parties/:id/score` → `{score, level, metrics, history[]}` | `parties.view` |

Pre-existing groups (users, roles + `GET /api/permissions` catalog, teams,
files, audit — now with optional `?companyId=`) are unchanged; see git history
for their full tables.

### Parties — corrective pass notes (corr-01…corr-06)

- **Search (`?search=`)** ORs every identifier: `nameFa` (ilike over the
  `parties_name_fa_trgm_idx` GIN trigram index), `nameEn`, `internalCode`,
  `economicCode`, `registrationNumber` (all ilike contains — code-ish fields),
  `nationalId` / `nationalCode` (exact equals — unique identity numbers), and
  phones: a search input that normalizes as an Iranian mobile is matched
  exactly against `party_phones.normalized_value` AND
  `contact_phones.normalized_value` (via the party's contacts); any other
  digit-ish input (≥ 4 digits) is matched as a substring of the normalized
  values.
- **List projection** returns exactly the grid fields: `id, type, nameFa,
  nameEn, internalCode, primaryPhone {kind, normalizedValue} | null, roles[]
  (codes), owner {id, name} | null (firstName+lastName, else username), score,
  scoreLevel, archived (bool), version, createdAt, updatedAt` — relations are
  resolved in the SAME `findMany` (≤ 2 queries per page, no N+1).
- **Owner assignment** (create / PATCH `ownerUserId` / POST `:id/owner`)
  requires the target user to be an ACTIVE member of the party's company
  (`user_companies` ⋈ `users.status='ACTIVE'`); otherwise 422
  `OWNER_NOT_COMPANY_MEMBER`.
- **TEAM scope is company-scoped**: `teamUserIds(userId, companyId)` only lets
  teams of THAT company contribute members (membership or team-manager).
- **Audit atomicity**: business mutation + TimelineEvent + AuditLog run in ONE
  transaction. `AuditService.recordTx(tx, entry)` writes with the caller's
  transaction client and propagates failures so the mutation rolls back when
  the audit write fails (the legacy `record()` keeps its swallow-and-log
  behavior for non-transactional callers).
- **Queue idempotency** is DB-enforced with no race-prone pre-check:
  `enqueue` inserts first; on P2002 company jobs re-fetch by
  `(companyId, idempotencyKey)` and platform jobs by the partial unique index
  `queue_jobs_platform_idempotency_uniq` (idempotency_key WHERE company_id IS
  NULL), so platform-level dedupe no longer has a concurrency gap. The same
  migration's `user_permission_overrides_platform_uniq` enforces a single
  platform-wide (user, permission) override.

## Seeded data (idempotent, `npm run db:seed`)

- Company `00000000-0000-4000-8000-000000000001` (`SEED_COMPANY_NAME`,
  default «شرکت پیش‌فرض»).
- 70-permission catalog: `users.*`, `roles.*`, `teams.*`, `settings.*`,
  `sequences.*`, `audit.view`, `files.*`, `queue.*`, `companies.*`,
  `claims.*`, `treasury.*`, `tax.*`, `supplierproduct.*`, `loading.*`,
  `workflowtimer.*`, `notifications.*`, `integrations.*`, `parties.*`
  (incl. `parties.scope.all` / `parties.scope.team` record scopes),
  `financialresponsibility.manage`, `timeline.view`.
- System roles: `admin` (all), `salesperson`, `sales_manager`, `buyer`,
  `purchase_manager`, `accountant`, `financial_manager`, `pricing_user`.
- Chart of accounts: `BANK`, `RECEIVABLE`, `CHECKS_IN_TRANSIT`, `PAYABLE`,
  `VAT_PAYABLE`, `SALES_REVENUE`, `BANK_FEE_EXPENSE`, `PURCHASE_EXPENSE`.
- Sequences per company (JALALI_YEAR reset, padding 5): `SALES_DOCUMENT(SD)`,
  `PURCHASE(PO)`, `SALES_TAX_INVOICE(STI)`, `PURCHASE_TAX_INVOICE(PTI)`,
  `RECEIPT(REC)`, `PAYMENT(PAY)`, `JOURNAL_ENTRY(JE)`, `CHECK(CHK)`,
  `BANK_TRANSFER(BT)` → e.g. `SD-1405-00001`.
- One inactive sample `IntegrationConfig` (SMS).

## Tests

`npm test` — 249 tests across 41 suites (the live-DB integration tests
auto-skip without `TEST_INTEGRATION=1`; with it, 251 tests run against
Postgres and clean up after themselves). Coverage includes the 15
architecture-gate scenarios (greppable as `01 company-scoped-sequence-uniqueness` …
`15 outgoing-check-paid-bank-effect`), the Phase 3A party/CRM acceptance
tests (`p3a-01` duplicate normalized phone … `p3a-12` score rules from
settings) plus Jalali conversion, phone
normalization, login lockout, permissions, sequence v2 format/reset/allocate,
queue backoff/priority/idempotency. Integration tests clean up after
themselves; unit tests need neither Postgres nor Redis.

Known schema-vs-code note: the frozen schema has no `usedAt` column on
`tax_definitions`; first-use immutability is tracked in a company-scoped
Setting (`tax.definition.used`). Adding the real column is recommended for the
next schema change.
