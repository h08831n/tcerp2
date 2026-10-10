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
1. Phase 5 — Daily Pricing + Publishing: per-variant daily price with full history
   (`DailyPrice` already references the real `ProductVariant` rows landed in 3B), bulk
   update engine, publish batches to Website/Telegram/WhatsApp/Eitaa/Bale/Rubika with
   per-channel job isolation; bind a concrete `TodayPriceProvider` to the
   `TODAY_PRICE_PROVIDER` token; add cross-uom daily-lowest comparison.
