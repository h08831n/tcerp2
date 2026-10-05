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

### Phase 2 — Foundation (completed in the previous iteration)
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

### Correction Gate (2026-10-06) — COMPLETED
Architecture review ratified 15 corrections; all are implemented in
`apps/backend/prisma/schema.prisma` and migrations
`20241006000000_correction_gate` + `20241006120000_party_operational_balance`:

1. **Multi-company from day one**: `Company` + `UserCompany` (membership with `is_default`),
   `users.default_company_id`; mandatory company scope on Team, Setting
   (`UNIQUE(company_id, key)`), Sequence (`UNIQUE(company_id, document_type)`),
   IntegrationConfig (`UNIQUE(company_id, code)`), NotificationRule
   (`UNIQUE(company_id, code)`); nullable scope (null = platform) on QueueJob and AuditLog;
   Roles/Permissions stay system-level (company role bindings via UserCompany).
2. **No standalone `BankTransaction` source of truth**: treasury sources = Receipt, Payment,
   BankTransfer, incoming-check clearing, outgoing-check payment, Bank Adjustment (later,
   permission-sensitive). `BankStatementLine` is a NON-source ordered ledger
   (`sequence_no`, `running_balance`, reconciliation + source links;
   `UNIQUE(company_id, bank_account_id, entry_date, sequence_no)`). Gapless numbering NOT
   required; deterministic ordering is.
3. **`OperationalSettlementClaim`** (direction-aware) replaces the sale-only
   `OperationalPaymentClaim`: `CUSTOMER_RECEIPT` requires `sales_document_id`,
   `SUPPLIER_PAYMENT` requires `purchase_document_id`; party always set; statuses
   `UNMATCHED/MATCHED/REJECTED`; no bank effect until matched; `REJECTED` restores the
   operational balance (`PartyOperationalBalance`, optimistic `version`) + audit + timeline
   + notification.
4. **Split tax-invoice allocation tables**: `SalesTaxInvoiceOrderAllocation` and
   `PurchaseTaxInvoiceOrderAllocation` (UNIQUE invoice/document pair) — no generic
   polymorphic allocation.
5. **Loading = header + `LoadingLine`** (product_variant_id, actual_quantity, uom_id) +
   **`LoadingAllocation`** (loading_line_id → sales_line_id/purchase_line_id,
   allocated_quantity). One loading registered once, shown on both sale and purchase sides.
6. **SupplierProduct genuinely three-level**: `mapping_level VARIANT|TEMPLATE|CATEGORY` with
   exactly-one FK set (DB CHECK `supplier_products_exactly_one_level_chk`).
7. **`WorkflowTimer` runtime entity** (workflow_instance_id, state_id, timer_type
   ESCALATION/REMINDER/TIMEOUT, due_at, status SCHEDULED/EXECUTED/CANCELLED/FAILED,
   action_config, executed_at) — owned by the Workflow engine, executed via the queue;
   minimal WorkflowDefinition/WorkflowState/WorkflowInstance tables exist now.
8. **NotificationRule completed**: company_id, code, event, conditions (nested JSON all/any),
   recipient_config, channels, delay_config, priority, enabled.
9. **Queue architecture**: BullMQ/Redis = runtime queue/scheduling/retry; PostgreSQL
   QueueJob + JobExecution = durable business history, status, audit, idempotency;
   `QUEUE_DRIVER=auto` falls back to DB polling when Redis is unavailable.
10. **Sequence engine v2**: company_id, document_type, prefix, padding, reset_cycle
    (NEVER/FISCAL_YEAR/JALALI_YEAR/MONTHLY), current_number, last_reset_marker;
    concurrency-safe `FOR UPDATE` allocation; history never renumbered.
11. **TaxDefinition**: company-scoped, immutable after first use (rate change = new row);
    invoice lines will carry `tax_definition_id` + `tax_rate_snapshot` (Phase 8 columns).
12. **Accounting foundation**: ChartOfAccount, JournalEntry (DRAFT/POSTED/REVERSED/CANCELLED;
    posted entries never edited/deleted — reversed instead), JournalLine (CHECK
    `journal_lines_debit_credit_chk`: debit>=0, credit>=0, never both positive;
    SUM(debit)==SUM(credit) enforced inside the POST transaction), BankAccount, Check
    (direction-specific lifecycle; bank effect ONLY on incoming CLEARED / outgoing PAID),
    BankTransfer rule (Dr Destination X, Dr Bank Fee Expense F, Cr Source X+F; statement
    lines source WITHDRAWAL X+F + destination DEPOSIT X). Invoices NEVER touch bank directly.
13. **PortalAccount**: company_id, party_id, website_user_id, verified_mobile, status —
    verified mobile used ONLY for initial linking; ambiguous mobile exposes nothing
    automatically (`UNIQUE(company_id, verified_mobile)`).
14. **Security**: seed admin password comes only from `SEED_ADMIN_USERNAME` /
    `SEED_ADMIN_PASSWORD`; no default credentials in README; production startup rejects
    known default passwords.
15. **Graphify decision (option B)**: `graphify-out/` is git-ignored; graph artifacts
    (`graph.html`, `graph.json`, `GRAPH_REPORT.md`) are local-only and auto-rebuilt by a git
    post-commit hook (AST-only). Graphify supports navigation but never replaces tests or
    architecture review; rules kept in `AGENTS.md`.

Docs synced with the post-gate schema: `docs/01-domain-map.md`, `docs/02-erd.md`,
`docs/03-architecture.md`, `docs/REQUIREMENTS.md` (Correction Log appendix), `README.md`,
`AGENTS.md`.

## Current module
- **Phase 3 is BLOCKED pending owner review** after the Architecture Correction Gate
  (2026-10-06) — see the Correction Gate section below. Phase 2 was previously verified
  end-to-end on the live local stack (see Verification below).

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
> **Note:** the Correction Gate partially landed Phases 7/8 as *foundation* — schema tables
> (`ChartOfAccount`, `JournalEntry`, `JournalLine`, `BankAccount`, `BankStatementLine`,
> `Receipt`, `Payment`, `BankTransfer`, `Check`, `TaxDefinition`,
> `SalesTaxInvoiceOrderAllocation`, `PurchaseTaxInvoiceOrderAllocation`,
> `OperationalSettlementClaim`, `PartyOperationalBalance`) plus core schema-level
> constraints exist now. Phases 3/4 must **wire the FKs for the bare-UUID columns** already
> present (`party_id`, `product_variant_id`/`product_template_id`/`category_id`,
> `sales_document_id`/`purchase_document_id`, `sales_line_id`/`purchase_line_id`,
> `sales_tax_invoice_id`/`purchase_tax_invoice_id`) — the columns exist precisely so the
> corrected relations never need renumbering.

- Phase 3: CRM (Party/Contacts/Addresses/Customer Score) + Product (templates, variants,
  attributes, UOM, brands, categories, supplier mapping) — **blocked pending owner review**
- Phase 4: Sales (Lead/Opportunity/SalesDocument), Purchase, Price Request, Supplier Offers,
  Document Flow, Sales↔Purchase allocation
- Phase 5: Daily Pricing + Publishing (channel adapters, per-channel jobs)
- Phase 6: Loading + allocations + inventory (auto stock movements)
- Phase 7: Accounting core services (CoA, fiscal years, journals, receipts/payments, settlement
  claims, bank statement ordering, checks, reconciliation, opening balances,
  financial responsibility) — schema foundation already landed (see note above)
- Phase 8: Tax invoices (Sales/Purchase, explicit M:N allocations, tax products) + Moadian
  module — schema foundation already landed (see note above)
- Phase 9: Activities, Calendar, Workflow engine, Approval engine, Automation engine,
  Notification rules, SMS engine
- Phase 10: Reporting/saved views, dashboards, global search + command palette
- Phase 11: Portal API, import/export engine (chunked, resumable)
- Phase 12: Hardening (security review, perf, index review, backup, monitoring)

## Architectural decisions (log)
1. **Modular monolith** (NestJS) — one deployable, strict module boundaries; services can be
   extracted later without API redesign.
2. **Queue** (superseded by Correction Gate #9): BullMQ/Redis = runtime queue/scheduling/retry;
   PostgreSQL `QueueJob` + `JobExecution` = durable business history, status, audit,
   idempotency. `QUEUE_DRIVER=auto` falls back to DB polling (`FOR UPDATE SKIP LOCKED`)
   when Redis is unavailable.
3. **JWT access (15m) in HttpOnly cookie + rotating refresh tokens (sha256-hashed in DB)** —
   supports portal + API clients; 2FA-ready.
4. **Permissions**: catalog table + role bindings + per-user GRANT/REVOKE overrides; enforced by
   `PermissionsGuard` server-side; record scopes (OWN/TEAM/ALL) planned per-module in Phase 3+.
5. **Multi-company from day one** (supersedes the earlier "foundation tables omit
   `company_id`" note — Correction Gate #1): `Company`/`UserCompany` exist in the schema;
   company-scoped uniques are in place; queue/audit carry nullable `company_id`
   (null = platform).
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
1. Owner review of the Correction Gate outcome → unblock Phase 3.
2. Phase 3: Party/CRM + Product schema, services, APIs, permissions, audit, list/form UIs —
   including the FK migrations for the bare-UUID columns noted above.
