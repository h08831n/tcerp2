# PROJECT_PROGRESS

## Phase 9 — Activities, Workflow & Automation (IN PROGRESS)

- **9A (DONE — pending review)**: Activity Engine + Central Calendar +
  Unified Timeline hooks. `ActivityType`/`Activity` models (migration
  `20241028000000_phase9a_activities`), permissions activities.view/view_all/
  create/edit/delete/override seeded into roles, ActivitiesModule wired into
  AppModule. Endpoints: POST /activities/calendar (layers
  activities/checks/payments/approvals), CRUD + complete/cancel + types
  management. Completed activities LOCKED for normal users; override requires
  activities.override + reason, audited. SYSTEM creation idempotent. Timeline
  events ACTIVITY_CREATED/COMPLETED/OVERRIDDEN/UPDATED written on the related
  entity (dedup for completion). Frontend: /activities + /calendar (Jalali
  month grid, layer toggles, create-from-calendar). Tests p9a-01..12 + correction gate p9a-correction/p9c-01..04: OWN-scope
  record authz (stranger UUID access = NotFound), financial calendar layers
  gated by treasury.view, SYSTEM idempotency DB-enforced via unique(companyId,
  idempotency_key) migration 20241029000000 (concurrent same-key test), audit/
  timeline rollback on failure, PATCH/DELETE routes implemented, completed
  activities not deletable.
  Migration applied to tcerp_test and CI only.
- **9B (DONE — pending review)**: Workflow State Machine + generalized
  Approval Engine (Gate E core). Migration `20241030100000_phase9b_workflow_engine`
  (workflow_transitions, workflow_execution_logs, approval_events, instance
  version/context, state initial/final/slaHours, approval dueAt/escalation/
  source/workflowInstanceId, PARTIAL UNIQUE one-PENDING-per-entity) and
  `20241030102000_phase9b_allocation_fk_alignment` (backfills the two
  allocation→invoice FKs the schema declared; p8 spec cleanups reordered).
  Engine: definitions with nested states/transitions (exactly-one-initial,
  ≥1 final, no self-loops, validated condition trees; structure immutable,
  PATCH only name/entityType/isActive); instances idempotent per
  unique(definition, entityType, entityId); per-transition requiredPermission
  checked server-side; structured conditions (all/any, eq ne gt gte lt lte in
  notIn contains, dot paths, numeric-only ordering); optimistic-concurrency
  state flips (two concurrent transitions → exactly one wins, loser 409);
  final states complete atomically; append-only execution log; audit-failure
  rolls the whole flip back. Approval-gated transitions PARK the instance
  (PENDING ApprovalRequest source=WORKFLOW + escalation timer with slaHours)
  and RESUME through the one-way ApprovalDecisionBus after the decision
  commits (APPROVED applies the parked transition idempotently with durable
  workflow.resume retry; REJECTED keeps the instance ACTIVE; a moved-on
  instance skips cleanly). Escalation timer bumps level + notifies roles +
  TIMER_FIRED log via the real processDue path. Approvals generalized:
  generic create (registry loading/goods_receipt; workflow_instance
  engine-internal), cancel (requester or decide-holder), OWN/ALL list scope
  (approvals.view_all), concurrent-decide reconciliation via conditional
  updateMany, append-only approval_events history, Phase 6 loading release
  effect preserved (regression-tested). Permissions workflow.view/start/admin
  + approvals.request/view_all seeded. Frontend: /workflow (definitions
  create dialog, instances, detail modal with transitions/logs/cancel,
  start-instance dialog) + /approvals extended (filter, note on decision,
  cancel, history, create-request modal). Tests: p9b-workflow-engine
  (w9b-01..14), p9b-approval-engine (a-01..06), workflow-conditions unit (7);
  full integration 827/827 green, unit 455 pass/0 fail. Doc:
  docs/10-workflow-approvals.md. Local only: pre-existing schema/migration
  misalignments repaired (sentAt Timestamptz map, attempt default,
  allocation FKs); stock_movements source FK stays seed-dropped
  (polymorphic source by design).
- **9C (DONE — pending review)**: Automation Engine hardening on the Phase 5
  foundation (audited: nested all/any conditions, audiences, idempotency keys,
  versioning and run history already present). Migration
  `20241031100000_phase9c_automation_retry` (automation_runs.attempts).
  Bounded DURABLE retry: attempts counter on the run row (counted on every
  execution), policy actionConfig.retry {maxAttempts<=10, delayMinutes},
  failed runs reset PENDING + `automation-retry:{runId}:{attempt}` queue
  delivery (automation.run jobs now maxAttempts:1 — retries owned by the
  durable row, visible in history; exhausted budget = terminal FAILED).
  Execution delay: triggerConfig.delayMinutes parks PENDING runs with a
  SCHEDULED delivery on all three paths (event / manual / scans). Dry run:
  POST /automation/rules/:id/dry-run builds the real event, evaluates
  conditions and previews wouldDo per action — strictly side-effect-free
  (audience preview capped at 20 with presence flags, no mobile numbers).
  CREATE_ACTIVITY now creates a REAL activity via the 9A engine
  (createSystemActivity, idempotent activity:{runKey}, party/document
  related-entity derivation, AUTOMATION_ACTIVITY_NO_RELATED_ENTITY for bare
  events). P1 fix: removed leftover DEBUG console.log leaking party IDs +
  mobiles in the SMS audience action; manualRun returns the final row.
  Frontend /automation: dry-run modal (eval + wouldDo JSON + policy) +
  attempts badge on runs. Tests: p9c-01..06; p5-13 updated to the real-
  activity contract; automation suites 16/16 green. Doc:
  docs/11-automation.md.
- **9D (DONE — pending review)**: Notification Center + SMS. Migration
  `20241101100000_phase9d_notification_sms` (sms_templates, sms_messages with
  durable QUEUED/SENT/FAILED log + unique idempotency_key,
  notification_rules.sms_config). The rules' SMS channel now WORKS:
  dispatchRulesForEvent honors channels — IN_APP as before + SMS via
  SmsService.dispatchForRule (party mobiles from payload.partyId +
  smsConfig.partyIds, templateCode/literal text render, eventKey dedup
  `notification-sms:{rule}:{party}:{eventKey}`, rule delay on the sms.send
  delivery). SmsService.enqueueSend canonicalizes mobiles
  (normalizeIranMobile), persists the QUEUED row first (P2002 = existing row
  is the authority — no second job), one sms.send delivery (maxAttempts 3)
  flips the SAME row SENT/FAILED with provider response (SmsSendHandler
  write-back). Manual send (opt-in client dedup key) + resend of FAILED rows
  as fresh rows + send report GET /notifications/sms + templates CRUD.
  Inbox: POST /:id/read + /read-all (ownership-guarded), GET list resolves
  the caller's company server-side. Automation SEND_SMS switched to the
  logged path (source AUTOMATION, same dedup keys). Frontend /notifications
  page (inbox + SMS center + rules tabs) + nav. Tests p9d-01..06; p5c-05
  updated to the durable-log contract; automation suites 22/22; full
  integration green. Doc: docs/12-notifications-sms.md.
- **Backlog (unchanged)**: real Moadian sandbox connection + credentials.


## Phase 10 — Management Reports & Dashboard (Gate F, FIRST SLICE DONE — pending review)

- **Dashboard + reports + global search (DONE)**: ReportsModule with
  SQL-aggregated read-only endpoints, all company-scoped and gated by the new
  `reports.view` permission (admin + 4 manager roles; NOT operational roles):
  /reports/dashboard (sales open/completed, purchase open/completed, loadings
  today + pending-driver-release + reversed, inactive-60d count, negative-
  stock variant count — all over the OPERATIONAL sources of truth, never tax
  invoices); /reports/sales-performance (per salesperson incl. delivered qty
  via CONFIRMED loading allocations → sales lines);
  /reports/purchase-performance (per supplier incl. received qty from
  CONFIRMED GRN lines); /reports/inactive-customers (60-day window, capped
  200, never-purchased first); /reports/pending-orders?olderThanDays (whole-
  set totals + 50-item preview); /reports/negative-stock (internal-balance
  CASE identical to the inventory module); /reports/search (global, LIMIT 5
  per entity, LIKE-escaped, parameterized). Day-boundary fix: dashboard
  «today» uses LOCAL midnight (UTC-midnight day-keys pushed the Iranian
  afternoon into yesterday — caught by g10-01). Frontend: dashboard rebuilt
  from the shell (6 KPI cards, pending-orders + inactive tables, graceful
  degradation without reports.view) + Ctrl+K command palette (debounced
  global search, grouped results, navigation). Tests g10-01..08 (delta
  assertions on the shared company, isolated company for the capped inactive
  list, cross-company search isolation, seed contract). Doc:
  docs/13-management-reports.md. Deferred: debt report, win/loss offers,
  per-warehouse drill-down, saved views (documented).

- **Gate F slice 2 (DONE — pending review)**: debt report
  (`/reports/debt`, accounting.report-gated: per-party accounting balance via the
  7C subsidiary formula with LEFT-join semantics — op-balance-without-journals
  parties appear with accounting 0 — + operational cache + reconciliation delta +
  UNMATCHED claims + unsettled checks with nearest due), win/loss offers
  (SupplierOffer.outcome WON/LOST migration 20241101110000 + audited decide
  endpoint POST /price-requests/offers/:offerId/outcome + report aggregating
  EXPLICIT decisions only — undecided suppliers absent), per-warehouse negative
  stock (internal-side warehouse attribution, transfers net within warehouse) +
  warehouse turnover (period flows + full-history ending balance, local-calendar
  boundaries). Frontend: /reports page (debt/offers/stock tabs) with localStorage
  Saved Views (≤10/scope, best-effort) + palette keyboard navigation (arrows +
  Enter, listbox roles). Tests g10-09..12 (LEFT-join gap case, offer winRate
  aggregation, per-warehouse attribution on an isolated variant, turnover
  relationships + invalid-period rejection). Deferred: loadings report variations
  (weighbridge-delta, incomplete).



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

### Phase 3A — Party/CRM core (commit `1f57758`) + corrective pass (`f32fe7f`) — COMPLETED
- Party/Contact/Address/PartyRole/PartyPhone/CustomerScoreHistory/FinancialResponsibility/
  TimelineEvent schema + services + APIs + record-scope-filtered permissions
  (OWN/TEAM/ALL, backend-enforced) + RTL frontend.
- **Corrective pass (`f32fe7f`)**:
  - Party search (pg_trgm) + lightweight grid projection for lists.
  - Company-member owners; company-scoped team record scopes.
  - **Audit atomicity**: `AuditService.recordTx(tx)` writes audit rows inside the same
    transaction as the mutation; failure propagates and rolls back both (propagated-failure
    pattern).
  - **Platform-level dedupe** via partial unique indexes
    (`user_permission_overrides_platform_uniq`, `queue_jobs_platform_idempotency_uniq` —
    migration `20241007000000_p3a_corrections`): PostgreSQL NULL-distinct semantics mean a
    plain composite unique cannot enforce a single platform-wide row when `company_id IS NULL`.

### Phase 3B — Product Catalog (commit `2989f4f`, migration `20241007100000_phase3b_product_catalog`) — COMPLETED
- **Endpoint families**: `/api/categories`, `/api/brands`, `/api/uoms/categories`,
  `/api/uoms`, `/api/products/uom/convert`, `/api/products/attributes`,
  `/api/products/attribute-values`, `/api/products/templates` (+ nested
  `/:id/attributes`, `/:id/variants/preview`, `/:id/variants/generate`, `/:id/matrix`),
  `/api/products/supplier-mappings`. All company-scoped, permission-guarded, audited in the
  mutation transaction, paginated lists with archive filtering (`active` flag).
- **UOM engine**: `UomCategory`/`Uom` with Decimal(20,6) `conversion_ratio` vs the category's
  single base unit (partial unique `uoms_base_unit_uniq` + service `UOM_BASE_UNIT_EXISTS`);
  cross-category conversion blocked (422 `UOM_CATEGORY_MISMATCH`); KG↔TON conversion tested;
  `convertWithProductWeight` path for `weight_per_unit`-carrying variants.
- **Variant generation engine**: deterministic cartesian preview (`skuSuggestion`,
  `existsAlready` markers) restricted to `createsVariants` attributes; generate runs in ONE
  transaction with **skip-with-report** semantics (`{created[], skipped[]}` — existing
  identical combinations are skipped, never duplicated or mutated); SKU collisions
  auto-suffix `-2`, `-3` then 409 `VARIANT_SKU_COLLISION`; SKU unique per company.
- **Matrix API**: `GET /api/products/templates/:id/matrix` → `{columns, rows, cells}` for the
  Phase 4 variant matrix UI.
- **Supplier mapping**: three-level VARIANT/TEMPLATE/CATEGORY (service + DB CHECK
  `supplier_products_exactly_one_level_chk`) with **real FKs** to Party (3A) and the 3B product
  tables; supplier must be a same-company Party holding the SUPPLIER role (422
  `NOT_A_SUPPLIER`).
- **20 p3b spec files** (`apps/backend/src/products/p3b-*.spec.ts`): category hierarchy cycle
  guard, company isolation, bilingual fields, dynamic attribute creation, attribute ordering,
  deterministic variant generation, no duplicate combinations, SKU uniqueness, UOM
  conversions, cross-category block, product-weight conversion, supplier role/target
  validation, list projection (no N+1), optimistic locking, permission enforcement,
  audit-rollback atomicity, archive filtering, restart persistence.

### Phase 3B corrections (commits `e24fb73` schema / `2b64b81` backend, migration `20241008000000_p3b_corrections`) — COMPLETED
- **Selected template values**: `ProductTemplateAttributeValue`
  (`UNIQUE(template_attribute_id, attribute_value_id)`, `display_order`, `active`) curates
  each template attribute's value set (`POST/GET /api/products/templates/:id/attributes/:aid/values`,
  replace-set or add-one); preview/matrix/generation build combinations ONLY from the
  selected active values, falling back to the attribute's global values while none are
  selected (`TemplatesService.effectiveUniverse` — transitional rule).
- **DB-safe combination keys**: `ProductVariant.combination_key` = canonical sorted
  `attribute_id=attribute_value_id` pairs joined with `|` (deterministic `buildCombinationKey`
  + backfill); `UNIQUE(template_id, combination_key)` is the ONLY duplicate authority — a
  concurrent generate that races past the pre-check aborts with P2002 → 409
  `VARIANT_COMBINATION_EXISTS`.
- **Explicit weight UOM**: `weight_uom_id` REQUIRED whenever `weight_per_unit` is set
  (422 `WEIGHT_UOM_REQUIRED`); must sit in the company's Weight UOM category, resolved
  canonically by category `code === 'WEIGHT'`; piece→kg→ton conversion path
  (`convertWithProductWeight`: 100 pcs × 18.7 kg = 1870 kg → 1.87 ton).
- **UOM base semantics**: AT MOST one base unit per category (not exactly one); conversion
  blocked (422 `UOM_NO_BASE_UNIT`) until a base exists; base ratio exactly 1
  (422 `UOM_BASE_RATIO_ONE`); `conversion_ratio <= 0` rejected by DB CHECK
  `uoms_conversion_ratio_positive_chk`.
- **Cross-company FK integrity**: shared `assertSameCompany` guard for every product FK
  target (category parent, brand/logo, template FKs, attribute values, variant template/UOMs,
  supplier mappings, UOM conversion endpoints). **File isolation**: file metadata/download/
  attachment lists resolve only through the caller's company's attachments.
- Forward-only migration restored `parties_name_fa_trgm_idx` (dropped by the diff-based 3B
  migration) + `contact_phones` normalized index; historical migrations untouched.
- **14 c3b acceptance scenarios** (`c3b-01` trgm index restored … `c3b-14` file metadata
  company isolation).

### Phase 4 — Sales/Purchase (schema commit `c467f85`, migrations `20241008100000_phase4_sales_purchase` + `20241008110000_restore_raw_indexes`, plus backend/frontend implementation) — COMPLETED
- **6 new backend modules** (`apps/backend/src/`): `crm` (leads, opportunities, lost reasons,
  payment terms), `sales` (documents + lines + variant matrix + flow endpoints), `purchase`
  (documents + lines + flow endpoints), `allocations`, `price-request` (requests, lines,
  offers, worklist, daily-lowest), `document-flow` (relations + related-documents endpoint).
- **CRM funnel**: `Lead` (NEW→CONTACTED→QUALIFIED/LOST), `Opportunity`
  (OPEN→QUALIFIED→QUOTED→WON/LOST; a returning customer gets a NEW opportunity per buying
  intent; customer must hold the CUSTOMER role), configurable `LostReason` (required when
  LOST; 6 Persian defaults seeded) and `PaymentTerm` (4 Persian defaults seeded).
- **Quotation = sales order, ONE document**: `id` + `document_number` allocated once at
  creation from the `SD` sequence and never regenerated; statuses
  DRAFT→QUOTATION→SENT→CUSTOMER_CONFIRMED→SALES_ORDER→PARTIALLY_LOADED→COMPLETED
  (+ CANCELLED/LOST); server-authoritative exact Decimal totals; sales record scope
  OWN/TEAM/ALL keyed on the salesperson; matrix endpoint creates one line per non-empty cell
  with `printableDescription`.
- **Confirmation lock/override**: after CUSTOMER_CONFIRMED the line fields are locked
  (403 `ORDER_LOCKED`); holders of `sales.override_confirmed_order` may still edit but MUST
  pass a reason (422 `OVERRIDE_REASON_REQUIRED`) → `OVERRIDE_CONFIRMED_ORDER` audit row +
  party timeline event, written in the same mutation transaction.
- **Purchase is independent** (no price request or sale required): DRAFT→ORDER_PLACED→
  PARTIALLY_LOADED→COMPLETED (+ CANCELLED); SUPPLIER role + active company-member buyer
  required; `create-purchase`-from-sale / `create-sale`-from-purchase copy lines 1:1 and
  write reciprocal `CREATED_FROM` relations.
- **M:N allocation with concurrency guard**: line-level `SalesPurchaseAllocation`
  (`UNIQUE(sales_line_id, purchase_line_id)`, same variant on both lines); writes run in a
  **SERIALIZABLE transaction + `SELECT … FOR UPDATE` on both lines in consistent id order** —
  concurrent over-allocation: exactly one writer wins (409 `ALLOCATION_EXCEEDS_QUANTITY`).
- **Price-request worklist without duplication**: `GET /api/price-requests/worklist` →
  `{today, previousDays}`; a still-OPEN previous-day request appears under `previousDays` as
  the SAME record (never copied or deleted). Supplier offers: several per line (first offer
  moves OPEN→OFFERED), owner-only edit/delete, blocked after conversion.
- **Daily-lowest via RANK()**: derived with
  `RANK() OVER (PARTITION BY day, product_variant_id, uom_id ORDER BY offered_price)` filtered
  to `rnk = 1` — ties mean ALL co-lowest offers (nothing stored); comparison within one uom
  group (cross-uom normalization deferred to Phase 5); supplier lowest-report per
  (supplier, product, uom) over N days.
- **TodayPriceProvider interface**: `TODAY_PRICE_PROVIDER` token with a `NullTodayPriceProvider`
  default (always null — a pricing outage must never block a request); the concrete
  daily-pricing engine lands in Phase 5.
- **DocumentRelation reciprocal navigation**: polymorphic
  `(from_type, from_id) → (to_type, to_id)` with CREATED_FROM/GENERATED_FROM/RELATED/BASED_ON
  and a unique tuple; `GET /api/documents/:type/:id/relations` returns both directions with
  reciprocal pairs deduped.
- **p4-01…p4-34 acceptance suite** (23 spec files: numbering, role requirements, exact Decimal
  totals, matrix cells, lock/override, version conflicts, allocation race, worklist/lowest
  intelligence, company isolation, audit rollback atomicity, restart persistence, no-N+1
  grid) + seed/permission extensions (`sales.*`, `purchase.*`, `price_request.*`,
  `allocations.manage`, `crm.*`, `paymentterm.manage`).

### Phase 5 — Daily Pricing + Publishing Engine (COMPLETED — commit pending)
- DailyPrice engine: today-only upsert with old/new audit, past days immutable (pricing.edit_history override), bulk percent/fixed updates, grid with yesterday delta, today-price provider bound into price requests
- Publishing: batch → per-channel queue items (7 channels, all mock adapters via IntegrationConfig), BullMQ execution, retry/cancel with attempt history + providerResponse, duplicate publish prevention (unique batch+channel+destination), 5s-poll admin dashboard
- Automation foundation: PRICE_UPDATED / CUSTOMER_INACTIVE_DAYS / QUOTATION_PENDING_DAYS rules with condition evaluator, idempotent runs (auto:/daily: keys), async via queue, manual run
- Public API: /api/public/prices(+history), portal lookup {matched,linked} only
- Supplier intelligence: cheapest-report (win counts + lastWonAt, ties included, no averages)
- Tests: 124 suites — 541/541 integration; fixed cheapestReport SQL alias bug + DailyPriceService optional-hook DI + pricing.module export wiring at smoke

### Phase 6 — Loading + Inventory + Operational Settlement (COMPLETED — commit pending)
- Architecture checkpoint: docs/04-domain-boundaries.md (ratified: DailyPrice never creates stock/cost; Loading is THE physical event; invoice independent; movements auto-generated; no manual stock entry; multi-warehouse open)
- Loading lifecycle: DRAFT→CONFIRMED→(CANCELLED); one-transaction confirm = allocation re-validation (FOR UPDATE) + StockMovement OUT per line (idempotencyKey loading:{id}:line:{n}) + operationalLoadedAmount on Sales/Purchase docs (Decimal) + doc status PARTIALLY_LOADED/COMPLETED + DEBT GATE (balance>0 → ApprovalRequest RELEASE_DRIVER_INFO + driverInfoRestricted) + audit/timeline
- Driver-info visibility: restricted payload for callers without release/decide permission; manager release/reject flow with notifications
- Purchase receive: POST /purchase/:id/receive → IN movements (idempotent no-op re-receive)
- Inventory: computed stock (SUM IN-OUT, negative flagged), movements ledger, warehouses CRUD with at-most-one default, MAIN warehouse seeded
- Approvals: lean ApprovalRequest engine (single approver) — foundation for Workflow Phase 9
- Frontend: /loadings (list/new/detail with confirm + release modal + related docs), /inventory (3 tabs), /approvals, receive button on purchase detail
- Tests: 145 suites — 595/595 integration; live smoke: purchase 40t receive → IN movement (re-receive no-op), loading 40t confirm → OUT movement + operationalLoadedAmount 14.2B + debt gate restricted → manager release → visible; stock 0; DTO fix ArrayMinSize found by smoke

### Phase 6 Integrity Gate (COMPLETED — commits 1f5bc46 schema + gate impl)
- Location-based movements: StockLocation (SUPPLIER/INTERNAL/CUSTOMER/TRANSIT); movements carry source/destination locations; company stock = INTERNAL net only — direct SUPPLIER→CUSTOMER creates NO fake internal stock
- Normalized quantities: movements keep sourceQuantity/sourceUom verbatim; normalizedQuantity in variant.inventoryUomId (authoritative, service-locked after movements) via UOM engine; piece↔weight only via weightPerUnit; impossible → UOM_CONVERSION_IMPOSSIBLE
- Loading: explicit route enum; allocation qty is in LoadingLine.uom — converted to target line UOM before over-allocation math; operational amounts = convertedQty × immutable unit-price snapshot; REVERSAL (compensating movements, operational rollback, approval cancel, audit REVERSAL_REASON_REQUIRED) — originals immutable
- GoodsReceipt/Lines: real partial receipts (30+35+36 vs PO 100 → actual 101, overReceipt flagged per pushing receipt), confirm/reverse/cancel, movements SUPPLIER→INTERNAL; purchase /receive tombstoned (RECEIVE_DEPRECATED)
- ApprovalRequest fully generic (no Loading FK); document flow gains goods_receipt
- inventory.negative_stock_policy setting (ALLOW/WARN/BLOCK); POST /inventory/transfer (INTERNAL→INTERNAL preserves company total)
- 25 new g6 tests (170 suites, 626/626 integration); live smoke A (direct, mixed kg/ton: 40,000kg→40ton, amounts 14.2B/13.6B exact, no internal stock) and B (GRN 101t in, loading 25,000kg→25t out → stock 76, reversal → back to 101, opLoaded rolled back)

### Phase 6 final corrections (COMPLETED — commits 13eb22e schema + final impl)
- PurchaseLineFulfillment ledger (GOODS_RECEIPT | DIRECT_LOADING rows, unique per line+type+source): received / directLoaded / fulfilled coexist — GET /api/purchase/:id/fulfillment reports all three (ordered/received/directLoaded/fulfilled/remaining/overReceived + amount split)
- GRN over-receipt snapshots persisted at confirm (ordered/received/overReceived per line, immutable)
- StockMovement unitCostSnapshot/totalCostSnapshot (immutable valuation foundation for Accounting): GRN cost = PO unitPrice converted per inventory-UOM; loading OUT mirrors linked PO cost; reversals negate totalCost and never touch originals
- operationalLoadedAmount now recomputed from the fulfillment ledger under FOR UPDATE (no last-write-wins)
- Tests: 173 suites — 629/629 integration (g6f-01..03); live smoke: PO 100t = GRN 60t + direct loading 40t → fulfilled 100t COMPLETED, ledger rows verified

### Accounting Architecture Checkpoint (2026-10-12 — docs only, no code)
- docs/05-accounting-architecture.md ratified: accounting docs independent from operational; profit = fulfillment ledger + loading allocations + cost snapshots + price snapshots (never tax invoices); valuation = Specific Identification linked to purchase fulfillment (FIFO/Average documented as future); double-entry design on existing schema (posting rules, immutable posted, reversal); treasury boundary confirmed in code (only Receipt/Payment/Transfer/Check clear/write bank); tax/Moadian M:N boundary; financial records immutability rules. Phase 7 checklist included.

### Phase 7A — Accounting Foundation (COMPLETED)
- FiscalYear + 12 monthly FiscalPeriods (Jalali labels, company-scoped); posting guard assertOpenPeriod: CLOSED year/period rejected (FISCAL_YEAR_CLOSED/PERIOD_CLOSED/PERIOD_NOT_FOUND); no calendar = unguarded (documented); reversals bypass guard by design
- AccountType INCOME → REVENUE (enum migrated with data mapping)
- JournalLineAnalytic dimensions (CUSTOMER/SUPPLIER/EMPLOYEE/PROJECT/COST_CENTER) + partyId analytic on lines — receivable/payable analytical tracking (Ravan group pattern)
- Journal engine: guard integrated; analytics persisted in post(); fiscal-year API (list/create/close/period status, accounting.fiscal.manage permission, audited)
- Migration 20241014000000 with fiscal 1405 seeding per company; INCOME→REVENUE data mapping in-migration
- Tests g7-01..06 (balanced/unbalanced/closed-period/immutable/reversal/analytics) — 174 suites, 635/635 integration

### Phase 7B — Operational Accounting Integration (COMPLETED — commits 1740656 schema + final impl)
- Event engine: AccountingEvent log (idempotent per key, FAILED rows retryable via POST /accounting/events/:id/post) → PostingRule/Lines (configurable, per-company, measure-based: RECEIVABLE/REVENUE/COGS/INVENTORY/PAYABLE) → balanced JournalEntry
- Hooks: loading confirm emits SALES_COMPLETED_LOADING (revenue from price snapshots, COGS from movement cost snapshots) + PURCHASE_FULFILLED (direct trade, fulfillment ledger amounts); loading reverse emits INVENTORY_REVERSAL with swapped sides; GRN confirm emits GOODS_RECEIPT_CONFIRMED; payment/receipt events reserved
- Analytics: CUSTOMER dimension on receivable lines, SUPPLIER on payable lines — ledger + grouped responsibility reporting foundation ready
- Rules never block operations: failures land in event log with error, retry endpoint re-posts
- Fixes found by smoke: reversal swaps sides (not negative amounts), INVENTORY measure included in sale payload, default rules + accounting.posting.manage permission seeded, audience dedupe
- Tests: 174 suites — 635/635 integration (g7-01..06 + all prior); smoke: sale journal 14.2B rev / 13.6B COGS balanced with CUSTOMER analytic, purchase journal balanced with SUPPLIER analytic, reversal mirrored, all 113 events POSTED balanced

### Reporting Architecture Checkpoint (2026-10-12 — docs only)
- docs/06-reporting-architecture.md ratified: reports read ONLY from accounting entries + cost snapshots (never sales/purchase tables); GL with running balances + drill-down; trial balance with explicit balanced assertion; subsidiary ledger on partyId/analytics with financial-responsibility grouped view (no identity merge) and operational-balance reconciliation column; operational profit from SALES/PURCHASE journals only; inventory valuation via specific-identification cost snapshots (customer/supplier locations reported separately); opening balances = balanced OPENING journal entries via import; endpoints listed. Phase 7C checklist embedded.

### Phase 7C — Reporting Engine (COMPLETED — commits 25dacd7 schema + impl)
- ReportsService: General Ledger (opening balance, running balance with normal-side sign, drill-down fields, reversed flag) + Trial Balance (opening/movement/closing placed by normal side, explicit balanced assertion)
- SubsidiaryLedgerService: party balances from accounting lines (CUSTOMER/SUPPLIER role join), per-party ledger drill-down, responsibility-group view (individual + group total), reconciliation delta vs PartyOperationalBalance
- ProfitReportService: per sales doc revenue/COGS/grossProfit/margin from SALES_COMPLETED_LOADING journals (never tax invoices), dimensions date/customer/salesperson/variant/supplier via journal→event→document joins
- ValuationReportService: quantity/value per variant from normalizedQuantity × unitCostSnapshot on INTERNAL locations, warehouse breakdown, per-variant history with running quantity
- OpeningBalanceService: stage (validation, side-mismatch guard) → generate ONE balanced OPENING journal (residual to OPENING_EQUITY) + endpoints (accounting.report / accounting.fiscal.manage)
- placement bug found by tests fixed (both-columns bug on negative signed balances); p5c-05 made hermetic; p5-12 timeout
- Tests: 175 suites — 641/641 integration (g7c-01..06)

### Reporting Integrity Gate (COMPLETED — commits 1f5bc46-era + final impl)
- Reversal semantics: REVERSED originals + POSTED reversals BOTH included in net reports (pairs cancel); display carries reversed flag + reversal link
- TB: from/to/fiscalYear/period windows, opening vs period movement vs closing (no double count), hierarchical roll-up leaf/summary/all, normal-side placement fixed (negative balances no longer in both columns)
- GL: keyset pagination (date, entryNumber, lineId) with cursor-scoped running balance + full-range totals; account subtree; journalCode/partyId/analytic filters
- Valuation: LEGS model (destination +, source −) — INTERNAL transfers net zero at company level; grandTotalValue in SQL (page-stable); asOf
- ProfitReport: events-only (no operational table reads), per (salesDoc, variant, supplier) attribution with immutable dimension snapshots (CUSTOMER/SUPPLIER/SALESPERSON/PRODUCT_VARIANT)
- JournalService: Decimal-only math (no Number/Math.round); OpeningBalance: residual computed BEFORE post (one balanced journal, dead code removed)
- Tests g7i-01..20; p5c-05 hermetic company; p5-12 timeout; treasury gates Decimal-persistence relaxed
- Tests: 176 suites — 648/648 integration; smoke A/B verified live

### Post-Commit Review and Critical Fixes (COMPLETED)
- P0: g7i afterAll cleanup fully company-scoped (analytics via own line ids); DB guard refuses non-localhost DATABASE_URL; second-company survival test proves other-company data untouched
- P1 Decimal: toNumber() eliminated from event engine, reports, opening balance — Decimal end-to-end; precision tests cover save/report/reversal of 123456789012345.6789
- P1 valuation: explicit UNION ALL legs (destination +, source −) per movement; branch-safe JOIN order; warehouse filter per-leg
- P1 report tests: parent=exact Σ children, reversal before/after balance comparison, GL full-walk continuity, loud skips (console.warn) instead of silent
- P2: profit date basis = JournalEntry.entryDate (financial date), documented in code; createdAt is bookkeeping timestamp only
- Tests: 176 suites — 649/649 integration

### DB Safety Gate (COMPLETED — commits 6db34f5, c575b32)
- Dedicated `tcerp_test` database (migrate + seed) is the DEFAULT target of `npm run test:integration`; the development database `tcerp` requires an explicit `TCERP_INTEGRATION_ALLOW_DEV_DB=1` opt-in (db-guard throws otherwise)
- Guard moved to `src/testing/db-guard.ts`; centrally invoked in `integrationPrisma()`; fail-closed on missing DATABASE_URL during integration runs; error messages never contain credentials
- Scoped cleanups: g7c-reports full hermetic-company cleanup; g7a explicit-ID capture; g6-25 self-contained warehouse fixture (was silently relying on dev-DB leftovers)
- Tests: 179 suites — 667/667 integration (then 670 with guard regression tests)

### Cleanup Hardening (COMPLETED — commit cae751d)
- g7a: every created id registered immediately after creation (before failing assertions); g7-03 fiscal-period status restored to its ORIGINAL value on every exit path via try/finally; fiscal-year registration right after create

### Phase 7D — Accounting UI and Fiscal Lifecycle (COMPLETED — commit <sha>)
- Backend: journal-entry drill-down endpoint (`GET /accounting/reports/journal-entries/:id`, accounting.report, company-scoped, reversal linkage); GL controller now exposes the service's full filter surface (journalCode/partyId/analyticType/analyticId/limit/cursor — stale-controller discrepancy fixed); `FiscalYearService.reopenYear` (narrow: year-only reopen, periods stay CLOSED until individually reopened, audited, conflict on OPEN year); pre-existing `fiscal.create` transaction bug fixed (final getById read the base client inside the create transaction — could not see the uncommitted year; masked until now because the dev DB always had pre-existing years)
- Permissions: `accountant` is the only non-admin role with `accounting.report` / `accounting.fiscal.manage` / `accounting.posting.manage`; operational roles (salesperson, buyer, purchase_manager, financial_manager) have none of them — codified by g7d-05
- Frontend (RTL Persian, Next.js app router): `/accounting` hub (permission-aware tiles); General Ledger (keyset pagination, Jalali dates, drill-down modal); Trial Balance (balanced status banner, fiscal-year filter); Subsidiary Ledger (balances → per-party ledger drill-down); Operational Profit (event-based, totals); Inventory Valuation (page-stable grand totals); Opening Balances (stage + generate); Fiscal Years (list, close/reopen year, close/reopen period — all with explicit confirmation dialogs). `faMoneyExact` formats backend decimal STRINGS with Persian digits and thousand separators — monetary values never round-trip through JS floats
- Year-end closing journals / retained-earnings transfer: NOT implemented — the requirements do not define their accounting semantics (documented gap, not invented)
- Tests: 5 new g7d cases (drill-down + reversal linkage, company isolation, close/reopen-year posting lifecycle, audit trail, seeded role permissions); 184 suites — 675/675 integration

### Phase 8 — Tax Invoices & Moadian (COMPLETED — commits Phase 8 series)
- Schema: `SalesTaxInvoice` (+lines, +submissions) با وضعیت‌های DRAFT→READY→SENDING→SUBMITTED→SUCCESS/FAILED، `PurchaseTaxInvoice` ثبت حداقلی، migration `20241021090000_phase8_tax_invoices` (افزایشی، non-destructive)
- Submission lifecycle: claim اتمیک READY/FAILED→SENDING، uid یکتا DB-level، `retry=true` رسمی در ارسال مجدد، payload_snapshot هر تلاش، استعلام PENDING/SUCCESS/FAILED رسمی
- Adapter مودیان: interface + **MockMoadianAdapter** (پیش‌فرض) + **MoadianHttpAdapter** (طبق دستورالعمل فنی tax.gov.ir: normal-enqueue/INQUIRY_BY_UID/GET_TOKEN، امضا RSA2048-SHA256، AES-256-GCM/RSA-OAEP — **تأییدنشده روی سرویس واقعی**؛ نیازمند اعتبارنامه Sharjh که عمداً در مخزن نیست)
- بدون سند حسابداری جدید: صورتحساب مالیاتی لایه گزارش/ارسال است؛ مالیات/درآمد قبلاً با رویدادهای بارگیری ثبت شده (مرز مصوب docs/05 §7)
- Permission جدید `tax.submit`؛ salesperson هیچ دسترسی tax.* ندارد (p8-03)
- UI: `/tax-invoices` (فهرست+فیلتر+ایجاد از سند تکمیل‌شده+ارسال/استعلام/تاریخچه+جزئیات) + nav
- مقدار صورتحساب = بارگیری‌شده (tax_invoiced_quantity ≠ ordered) با Decimal دقیق؛ مبلغ هر تخصیص M:N = جمع کل فاکتور
- شکاف‌های مستند: sstid (نگاه docs/08)، اتصال واقعی نیازمند اعتبارنامه، ارسال زمان‌دار در صف نیست
- Tests: p8-01..09 (صدور/ردی/مجوز/ارسال/استعلام/retry/هم‌زمانی/خرید/وضعیت مودیان سند) — 181 suite، 694/694 integration

## Current module
- **Phase 4 (Sales/Purchase: CRM funnel, sales, purchase, allocations, price requests,
  document flow) is COMPLETE.** Next: **Phase 5 — Daily Pricing + Publishing**.
  Phase 2 remains verified end-to-end on the live local stack (see Verification below).

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
> constraints exist now. Phase 3 **wired its FKs** (supplier mapping carries real FKs to
> Party and the 3B product tables); the remaining bare-UUID columns
> (`sales_document_id`/`purchase_document_id`, `sales_line_id`/`purchase_line_id`,
> loading `product_variant_id`/`uom_id`, `sales_tax_invoice_id`/`purchase_tax_invoice_id`)
> are wired by **Phases 6/7/8** — the columns exist precisely so the corrected relations
> never need renumbering. Phase 4 landed its own tables with **real FKs** (sales/purchase
> documents & lines, allocations, price requests, offers, document relations).

- Phase 3: ~~CRM (Party/Contacts/Addresses/Customer Score) + Product (templates, variants,
  attributes, UOM, brands, categories, supplier mapping)~~ — **DONE** (3A `1f57758` +
  3A corrective pass `f32fe7f` + 3B `2989f4f`; see Completed above)
- Phase 4: ~~Sales (Lead/Opportunity/SalesDocument), Purchase, Price Request, Supplier Offers,
  Document Flow, Sales↔Purchase allocation~~ — **DONE** (3B corrections `e24fb73`/`2b64b81`
  + Phase 4 `c467f85` + implementation; see Completed above)
- Phase 5 — **NEXT**: Daily Pricing + Publishing (channel adapters, per-channel jobs) — `DailyPrice` now
  references **real** `ProductVariant` rows (FKs landed with 3B)
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
9. **Audit atomicity** (3A corrections, applied across 3B): mutations write audit rows in the
   SAME transaction via `AuditService.recordTx(tx)`; an audit failure propagates and rolls
   back the mutation too — audit can never be silently skipped.
10. **Platform-level dedupe via partial unique indexes** (migration `20241007000000_p3a_corrections`):
    `user_permission_overrides_platform_uniq` and `queue_jobs_platform_idempotency_uniq`
    (`WHERE company_id IS NULL`) — PostgreSQL NULL-distinct semantics defeat a plain composite
    unique for platform-wide (null-company) rows, so the DB-level partial uniques close the gap.
11. **Variant generation = skip-with-report** (3B): generate runs in ONE transaction; existing
    identical attribute combinations are skipped and reported (`{created[], skipped[]}`),
    never duplicated or mutated; SKU collisions auto-suffix `-2`, `-3`, then 409
    `VARIANT_SKU_COLLISION`.
12. **Route prefixes** (3B): `/api/categories`, `/api/brands`, `/api/uoms/*` are top-level;
    everything else (attributes, attribute-values, templates with nested attribute/variant/
    matrix routes, supplier-mappings) lives under `/api/products`.
13. **Party grid projection ≤2 queries** (3A corrective pass): the relations a grid row needs
    (primary phone, roles, owner) are fetched in the same `findMany` (no per-row follow-ups,
    no N+1) plus one `count` — exactly 2 queries per page.
14. **Sales quotation = sales order, single number** (Phase 4): quotation and sales order are
    ONE `SalesDocument` — `id` + `document_number` are allocated once at creation from the
    `SD` sequence and NEVER regenerated; the workflow only moves `status`
    (DRAFT→…→COMPLETED). No separate quotation table, no renumbering on confirmation
    (REQUIREMENTS §9 enforced by schema + service).
15. **Daily-lowest is derived via RANK(), not a stored boolean** (Phase 4):
    `RANK() OVER (PARTITION BY day, product_variant_id, uom_id ORDER BY offered_price)`
    filtered to `rnk = 1` — ties mean ALL co-lowest offers and nothing can go stale.
    Cross-uom comparison is deferred to Phase 5 (offers are ranked within one uom group).
16. **Allocation writes are SERIALIZABLE + row-locked** (Phase 4): `SalesPurchaseAllocation`
    create/update run in a SERIALIZABLE transaction taking `SELECT … FOR UPDATE` on BOTH
    lines in consistent id order (deadlock-free); under concurrent over-allocation exactly
    one writer wins.
17. **TodayPriceProvider token with a null impl** (Phase 4): price requests get "today's
    price" through the `TODAY_PRICE_PROVIDER` DI token; Phase 4 ships only
    `NullTodayPriceProvider` (always null) so requests never depend on pricing data — the
    concrete daily-pricing engine binds to the token in Phase 5.

## Known issues
- Ports: DB exposed on host **5433** and MinIO on **9100** (already reflected in
  `docker-compose.yml`, `.env.example`, `apps/backend/.env`) because 5432/9000 are taken by
  the user's local PostgreSQL service and PhpStorm.
- Docker Hub blocks `minio/minio` on this network — `docker-compose.yml` still references the
  official name; if the image is missing, pull via mirror and retag:
  `docker pull docker.arvancloud.ir/minio/minio:latest && docker tag docker.arvancloud.ir/minio/minio:latest minio/minio:latest`.
- Frontend dashboard is a shell; widgets arrive in Phase 10. Auth gate is client-side in the
  shell (fine for now; server middleware can be added later).
- Sales/purchase documents have no `notes` column yet (REQUIREMENTS §9 lists `notes` among
  the quotation header fields) — the DTOs accept `notes` for forward-compatibility but it is
  NOT persisted; add the column with the next schema change (same pattern as the
  `tax_definitions` `used_at` note in `apps/backend/README.md`).

## Next steps
1. Phase 7D is COMPLETE and awaiting review (accounting UI + fiscal lifecycle). Phase 8
   (Treasury/Tax/Moadian per REQUIREMENTS §111) has NOT been started and must wait for
   review approval.
2. Year-end closing journals / retained-earnings transfer remain a DOCUMENTED GAP — the
   requirements do not define their accounting semantics; do not invent them.
