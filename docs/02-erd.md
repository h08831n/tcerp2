# TCERP — ERD (after the Architecture Correction Gate, 2026-10-06)

Conventions (apply to every table, including Phase-2 modules):

- **PK**: UUID v4 (`gen_random_uuid()`), column `id`.
- **Naming**: snake_case tables & columns via `@@map` / `@map`.
- **Timestamps**: every important entity has `created_at`, `updated_at`, `created_by` and where needed `updated_by`, `archived_at`, `archived_by`.
- **Money**: `NUMERIC(20,4)` — never float. **Quantities**: `NUMERIC(18,4)`. Percent: `NUMERIC(9,4)`.
- **Dates**: stored as `timestamptz` (instant) or `date` (business day); UI renders Jalali by default.
- **Soft delete**: `deleted_at`/`archived_at` for business data; accounting documents use status lifecycle (`DRAFT/POSTED/REVERSED/CANCELLED`), never hard delete.
- **Multi-company from day one** (Correction Gate #1): `companies` + `user_companies` exist now;
  `users.default_company_id` resolves the active company. Company scope is **mandatory** on
  `teams`, `settings`, `sequences`, `integration_configs`, `notification_rules`; **nullable**
  (null = platform-level) on `queue_jobs` and `audit_logs`. Roles/Permissions stay system-level;
  company-specific role bindings are supported through `user_companies` (see §Identity).
  All "natural" unique constraints are company-scoped (see the constraint table below).
- **Optimistic locking**: `version INT` on concurrently-edited documents (e.g. `journal_entries`,
  `party_operational_balances`).
- **Phase-N FKs**: columns whose target tables land with their own phase (Party → Phase 3,
  Product → Phase 3, Sales/Purchase documents & lines → Phase 4, Tax invoices → Phase 8) exist
  now as bare UUIDs so corrected relations never need renumbering. They are marked
  **"FK in Phase N"** below; the FK constraints are added by those phases' migrations.
  Ground truth for field names: `apps/backend/prisma/schema.prisma`
  (migrations `20241006000000_correction_gate` + `20241006120000_party_operational_balance`).

## Diagrams by bounded context

### Identity, Companies, Audit & Foundation

```mermaid
erDiagram
    COMPANY ||--o{ USER_COMPANY : "membership"
    USER ||--o{ USER_COMPANY : "member of (is_default flag)"
    USER }o--o| COMPANY : "default_company_id"
    COMPANY ||--o{ TEAM : "company-scoped"
    COMPANY ||--o{ SETTING : "UNIQUE(company_id, key)"
    COMPANY ||--o{ SEQUENCE : "UNIQUE(company_id, document_type)"
    COMPANY ||--o{ INTEGRATION_CONFIG : "UNIQUE(company_id, code)"
    COMPANY ||--o{ NOTIFICATION_RULE : "UNIQUE(company_id, code)"
    COMPANY ||--o{ QUEUE_JOB : "nullable (null = platform)"
    COMPANY ||--o{ AUDIT_LOG : "nullable (null = platform)"
    USER ||--o{ USER_ROLE : has
    ROLE ||--o{ USER_ROLE : grants
    ROLE ||--o{ ROLE_PERMISSION : has
    PERMISSION ||--o{ ROLE_PERMISSION : in
    USER ||--o{ USER_PERMISSION_OVERRIDE : "grant/revoke"
    PERMISSION ||--o{ USER_PERMISSION_OVERRIDE : overridden
    USER ||--o{ REFRESH_TOKEN : "sessions (rotated, hashed)"
    TEAM ||--o{ TEAM_MEMBER : has
    USER ||--o{ TEAM_MEMBER : "member of"
    TEAM }o--|| USER : "managed by"
    USER ||--o{ AUDIT_LOG : "acts in"
    USER ||--o{ QUEUE_JOB : "creates"
    QUEUE_JOB ||--o{ JOB_EXECUTION : "append-only attempt history"
    FILE_BLOB ||--o{ FILE_ATTACHMENT : "attached as"
    USER ||--o{ FILE_BLOB : uploads
    USER ||--o{ NOTIFICATION : receives
    NOTIFICATION_RULE ||--o{ NOTIFICATION : fires
    USER ||--o{ PORTAL_ACCOUNT : "links to party via"
    PARTY ||--o{ PORTAL_ACCOUNT : "portal identity (FK in Phase 3)"
```

- `USER_COMPANY` PK is `(user_id, company_id)` with `is_default BOOLEAN`; index `company_id`.
  Roles/Permissions are **system-level**; company-specific role bindings resolve through
  `user_companies` (future role-scope columns) — permission checks scope via membership.
- `QUEUE_JOB.company_id` / `AUDIT_LOG.company_id` are **nullable**: null = platform-level.
- `JOB_EXECUTION` (append-only, `UNIQUE(job_id, attempt_no)`) is the durable per-attempt
  business history; BullMQ/Redis owns only runtime execution (see Architecture doc).

### CRM

```mermaid
erDiagram
    PARTY ||--o{ PARTY_ROLE : "CUSTOMER | SUPPLIER | DRIVER | CARRIER | PARTNER"
    PARTY ||--o{ CONTACT : "1:N contacts"
    PARTY ||--o{ ADDRESS : "1:N (MAIN/BILLING/SHIPPING/UNLOADING/...)"
    PARTY ||--o{ LEAD : "1:N leads"
    LEAD ||--o{ OPPORTUNITY : "1:N"
    PARTY ||--o{ OPPORTUNITY : "customer of"
    PARTY ||--o{ ACTIVITY : "about"
    PARTY ||--o{ FINANCIAL_RESPONSIBILITY : "member of group"
    PARTY ||--o{ FINANCIAL_RESPONSIBILITY : "responsible party"
    PARTY ||--o{ PARTY_OPERATIONAL_BALANCE : "one cached balance per (company, party)"
    USER ||--o{ PARTY : "owner_user_id"
    USER ||--o{ ACTIVITY : "assigned_to / created_by"
    ACTIVITY }o--|| ACTIVITY_TYPE : "dynamic types"
```

`PARTY.role` is a multi-valued relation (a company can be CUSTOMER and SUPPLIER simultaneously).
Unique: normalized mobile (exact-duplicate block), `national_id`, `economic_code`.
Party tables land in **Phase 3**; `PARTY_OPERATIONAL_BALANCE` already exists
(`UNIQUE(company_id, party_id)`, `balance NUMERIC(20,4)`, optimistic `version`).

### Product & Pricing

```mermaid
erDiagram
    PRODUCT_CATEGORY ||--o{ PRODUCT_CATEGORY : "hierarchical parent"
    BRAND ||--o{ PRODUCT_TEMPLATE : has
    PRODUCT_TEMPLATE ||--o{ PRODUCT_VARIANT : "1:N variants"
    PRODUCT_TEMPLATE }o--|| PRODUCT_CATEGORY : belongs
    PRODUCT_TEMPLATE ||--o{ TEMPLATE_ATTRIBUTE : "attribute lines"
    ATTRIBUTE ||--o{ ATTRIBUTE_VALUE : "1:N values"
    TEMPLATE_ATTRIBUTE }o--|| ATTRIBUTE : uses
    PRODUCT_VARIANT }o--o{ ATTRIBUTE_VALUE : "variant values"
    UOM_CATEGORY ||--o{ UOM : has
    UOM ||--o{ UOM_CONVERSION : "ratio to base"
    PRODUCT_VARIANT }o--|| UOM : "base uom"
    PARTY ||--o{ SUPPLIER_PRODUCT : "supplier_party_id (FK in Phase 3)"
    SUPPLIER_PRODUCT }o--o| PRODUCT_VARIANT : "mapping_level=VARIANT"
    SUPPLIER_PRODUCT }o--o| PRODUCT_TEMPLATE : "mapping_level=TEMPLATE"
    SUPPLIER_PRODUCT }o--o| PRODUCT_CATEGORY : "mapping_level=CATEGORY"
    PRODUCT_VARIANT ||--o{ DAILY_PRICE : "1:N price history"
    USER ||--o{ DAILY_PRICE : "set by"
    DAILY_PRICE ||--o{ PUBLISH_BATCH_ITEM : published in
    PUBLISH_BATCH ||--o{ PUBLISH_BATCH_ITEM : "channel jobs"
    TAX_DEFINITION ||--o{ SALES_TAX_INVOICE_LINE : "tax_definition_id + tax_rate_snapshot (FK in Phase 8)"
```

`DAILY_PRICE`: unique `(product_variant_id, date, source)`; full history retained.

**SupplierProduct is genuinely three-level** (Correction Gate #6): exactly one of
`product_variant_id` / `product_template_id` / `category_id` is set, enforced by DB CHECK
`supplier_products_exactly_one_level_chk` (mapping_level must match the one non-null FK).
Indexes: `(company_id, supplier_party_id)`.

### Sales / Procurement / Loading

```mermaid
erDiagram
    PARTY ||--o{ SALES_DOCUMENT : "customer (FK in Phase 3)"
    USER ||--o{ SALES_DOCUMENT : "salesperson"
    PAYMENT_TERM }o--|| SALES_DOCUMENT : "optional term"
    SALES_DOCUMENT ||--o{ SALES_LINE : "1:N lines"
    PRODUCT_VARIANT ||--o{ SALES_LINE : "sold as (FK in Phase 3)"
    UOM ||--o{ SALES_LINE : uom
    SALES_DOCUMENT ||--o{ LOST_QUOTE : "lost reason (configurable)"
    PARTY ||--o{ PURCHASE_DOCUMENT : "supplier (FK in Phase 3)"
    PURCHASE_DOCUMENT ||--o{ PURCHASE_LINE : "1:N lines"
    PRODUCT_VARIANT ||--o{ PURCHASE_LINE : "bought as (FK in Phase 3)"
    SALES_LINE ||--o{ SALES_PURCHASE_ALLOCATION : "M:N alloc"
    PURCHASE_LINE ||--o{ SALES_PURCHASE_ALLOCATION : "M:N alloc"
    PARTY ||--o{ PRICE_REQUEST : "optional customer"
    USER ||--o{ PRICE_REQUEST : "requester"
    PRICE_REQUEST ||--o{ PRICE_REQUEST_LINE : "1:N"
    PRODUCT_VARIANT ||--o{ PRICE_REQUEST_LINE : requested
    PRICE_REQUEST_LINE ||--o{ SUPPLIER_OFFER : "N offers"
    PARTY ||--o{ SUPPLIER_OFFER : "supplier"
    LOADING ||--o{ LOADING_LINE : "1:N lines"
    PRODUCT_VARIANT ||--o{ LOADING_LINE : "loaded (FK in Phase 3)"
    UOM }o--o| LOADING_LINE : "uom_id (FK in Phase 3)"
    LOADING_LINE ||--o{ LOADING_ALLOCATION : "1:N allocs"
    SALES_LINE |o--o{ LOADING_ALLOCATION : "sales_line_id (FK in Phase 4)"
    PURCHASE_LINE |o--o{ LOADING_ALLOCATION : "purchase_line_id (FK in Phase 4)"
    PARTY ||--o{ LOADING : "driver_party_id / carrier_party_id (FK in Phase 3)"
```

`SALES_DOCUMENT.status` (workflow): `DRAFT → QUOTATION → QUOTATION_SENT → CUSTOMER_CONFIRMED →
SALES_ORDER → PARTIALLY_LOADED → COMPLETED → CLOSED` (+ `REOPENED`, `LOST`).
Three distinct quantities: `ordered_quantity`, `loaded_quantity` (sum of actual loadings),
`tax_invoiced_quantity` — never forced equal.

**Loading = header + lines + allocations** (Correction Gate #5):
- `LOADING` header: `company_id`, `loading_date`, `driver_party_id`, `carrier_party_id`
  (driver/carrier are Party roles; both FKs in Phase 3). Index `(company_id, loading_date)`.
- `LOADING_LINE`: `loading_id`, `product_variant_id` (FK in Phase 3), `actual_quantity`,
  `uom_id` (FK in Phase 3), `notes`. Index `loading_id`.
- `LOADING_ALLOCATION`: `loading_line_id`, `sales_line_id` **or** `purchase_line_id`
  (FKs in Phase 4), `allocated_quantity`. CHECK `loading_allocations_target_chk`:
  `(sales_line_id IS NOT NULL OR purchase_line_id IS NOT NULL) AND allocated_quantity > 0`.
- A loading is registered **once** and is shown on both the sale and the purchase side.

### Inventory

```mermaid
erDiagram
    WAREHOUSE ||--o{ LOCATION : "1:N"
    LOCATION ||--o{ STOCK_MOVEMENT : "from/to location"
    PRODUCT_VARIANT ||--o{ STOCK_MOVEMENT : moves
    UOM ||--o{ STOCK_MOVEMENT : uom
    PURCHASE_DOCUMENT ||--o{ STOCK_MOVEMENT : "generates (in)"
    LOADING ||--o{ STOCK_MOVEMENT : "generates (out, via loading lines)"
    STOCK_MOVEMENT }o--|| SALES_DOCUMENT : "optionally for"
```

### Tax & Moadian

```mermaid
erDiagram
    PARTY ||--o{ SALES_TAX_INVOICE : "buyer"
    SALES_TAX_INVOICE ||--o{ SALES_TAX_INVOICE_LINE : "1:N"
    TAX_PRODUCT ||--o{ SALES_TAX_INVOICE_LINE : "tax product (separate catalog)"
    TAX_DEFINITION ||--o{ SALES_TAX_INVOICE_LINE : "tax_definition_id + tax_rate_snapshot"
    SALES_TAX_INVOICE ||--o{ SALES_TAX_INVOICE_ORDER_ALLOCATION : "1:N"
    SALES_DOCUMENT ||--o{ SALES_TAX_INVOICE_ORDER_ALLOCATION : "document_id (FK in Phase 4)"
    PARTY ||--o{ PURCHASE_TAX_INVOICE : "seller"
    PURCHASE_TAX_INVOICE ||--o{ PURCHASE_TAX_INVOICE_LINE : "1:N"
    PURCHASE_TAX_INVOICE ||--o{ PURCHASE_TAX_INVOICE_ORDER_ALLOCATION : "1:N"
    PURCHASE_DOCUMENT ||--o{ PURCHASE_TAX_INVOICE_ORDER_ALLOCATION : "document_id (FK in Phase 4)"
    SALES_TAX_INVOICE ||--o{ MOADIAN_SUBMISSION : submitted as
    SALES_TAX_INVOICE ||--o{ SALES_TAX_INVOICE : "corrective/cancellation/return (original_ref)"
    MOADIAN_SUBMISSION ||--o{ MOADIAN_SUBMISSION_ATTEMPT : "1:N attempts (never deleted)"
    MOADIAN_INCOMING_INVOICE }o--o| PURCHASE_TAX_INVOICE : "matched"
```

**No generic polymorphic allocation** (Correction Gate #4): two explicit tables —
`SALES_TAX_INVOICE_ORDER_ALLOCATION` (`sales_tax_invoice_id` FK in Phase 8, `sales_document_id`
FK in Phase 4, `allocated_amount`, optional `allocated_quantity`;
`UNIQUE(sales_tax_invoice_id, sales_document_id)`, index `sales_document_id`) and
`PURCHASE_TAX_INVOICE_ORDER_ALLOCATION` (same pattern with `purchase_tax_invoice_id` /
`purchase_document_id`).

`TAX_DEFINITION` (Correction Gate #11): company-scoped (`UNIQUE(company_id, code)`,
e.g. `VAT_9`), append-only after first use — a rate change inserts a **new** row. Invoice
lines carry `tax_definition_id` + `tax_rate_snapshot` (Phase 8 columns on invoice lines);
documents never change retroactively.
`MOADIAN_SUBMISSION.status`: `NOT_SENT/QUEUED/SENDING/SUBMITTED/WAITING_RESULT/SUCCESS/FAILED/NEEDS_REVIEW`.

### Accounting & Finance

```mermaid
erDiagram
    COMPANY ||--o{ CHART_OF_ACCOUNT : "UNIQUE(company_id, code)"
    CHART_OF_ACCOUNT ||--o{ CHART_OF_ACCOUNT : "hierarchical parent"
    COMPANY ||--o{ JOURNAL_ENTRY : "UNIQUE(company_id, entry_number)"
    JOURNAL_ENTRY ||--o{ JOURNAL_LINE : "1:N"
    CHART_OF_ACCOUNT ||--o{ JOURNAL_LINE : posted to
    PARTY }o--o| JOURNAL_LINE : "subsidiary detail (party_id, FK in Phase 3)"
    JOURNAL_ENTRY ||--o{ BANK_STATEMENT_LINE : "journal_entry_id (projection)"
    JOURNAL_ENTRY }o--o| JOURNAL_ENTRY : "reversed_by_entry_id"
    COMPANY ||--o{ BANK_ACCOUNT : "company-scoped"
    BANK_ACCOUNT ||--o{ BANK_STATEMENT_LINE : "ordered ledger"
    PARTY }o--o| RECEIPT : "party_id (FK in Phase 3)"
    PARTY }o--o| PAYMENT : "party_id (FK in Phase 3)"
    PARTY }o--o| CHECK : "party_id (FK in Phase 3)"
    PARTY ||--o{ OPERATIONAL_SETTLEMENT_CLAIM : "party_id (FK in Phase 3)"
    SALES_DOCUMENT |o--o{ OPERATIONAL_SETTLEMENT_CLAIM : "CUSTOMER_RECEIPT (FK in Phase 4)"
    PURCHASE_DOCUMENT |o--o{ OPERATIONAL_SETTLEMENT_CLAIM : "SUPPLIER_PAYMENT (FK in Phase 4)"
    OPERATIONAL_SETTLEMENT_CLAIM |o--o| RECEIPT : "MATCHED → matched_receipt_id"
    OPERATIONAL_SETTLEMENT_CLAIM |o--o| PAYMENT : "MATCHED → matched_payment_id"
    BANK_ACCOUNT ||--o{ RECEIPT : "credits bank"
    BANK_ACCOUNT ||--o{ PAYMENT : "debits bank"
    BANK_ACCOUNT ||--o{ BANK_TRANSFER : "source / destination"
    BANK_ACCOUNT |o--o{ CHECK : "bank_account_id (required before CLEARED/PAID)"
    PARTY ||--o{ FINANCIAL_RESPONSIBILITY : "group (A,B → Ravan)"
    DESCRIPTION_TEMPLATE ||--o{ JOURNAL_LINE : "template engine"
    RECONCILIATION ||--o{ RECONCILIATION_ITEM : "planned (Phase 7)"
    BANK_STATEMENT_LINE ||--o{ RECONCILIATION_ITEM : "reconciled via is_reconciled"
```

Invariants (Correction Gates #2, #12):

- **No standalone `BankTransaction` source of truth.** Treasury sources are `RECEIPT`,
  `PAYMENT`, `BANK_TRANSFER`, incoming-check **clearing**, outgoing-check **payment** and
  (later, permission-sensitive) `BANK_ADJUSTMENT`. `BANK_STATEMENT_LINE` is a **non-source**
  ledger used for deterministic daily ordering, `sequence_no`, `running_balance`,
  `reference_number`, reconciliation and source links
  (`source_entity_type` + `source_entity_id` + `journal_entry_id` + `is_reconciled`).
  Direction is `DEPOSIT | WITHDRAWAL`; `CHECK bank_statement_amount_positive_chk (amount > 0)`.
  Gapless numbering is **not** required; deterministic ordering is.
- **JournalEntry** statuses `DRAFT → POSTED` (or `REVERSED`/`CANCELLED`); posted entries are
  **never edited or deleted** — corrections are made by a reversal entry (`reversed_by_entry_id`).
- **JournalLine** CHECK `journal_lines_debit_credit_chk`: `debit >= 0 AND credit >= 0 AND NOT
  (debit > 0 AND credit > 0)`. `SUM(debit) == SUM(credit)` is enforced inside the POST
  transaction (JournalService), not by a stored CHECK.
- **BankTransfer X with fee F**: Dr Destination Bank X, Dr Bank Fee Expense F, Cr Source Bank
  X+F. Statement lines: source `WITHDRAWAL X+F`, destination `DEPOSIT X`. CHECK
  `bank_transfers_amount_chk`: `amount > 0 AND fee >= 0 AND source_bank_account_id <>
  destination_bank_account_id`.
- **Check** direction-specific lifecycle: incoming `REGISTERED → PENDING → DEPOSITED →
  CLEARED | BOUNCED | CANCELLED`; outgoing `REGISTERED → PENDING → PAID | BOUNCED |
  CANCELLED`. Bank effect happens **only** on incoming `CLEARED` / outgoing `PAID`
  (`bank_account_id` must be set before those transitions); registration never moves bank balance.
- **Invoices NEVER touch bank directly.**
- **OperationalSettlementClaim** (Correction Gate #3, replaces the sale-only
  `OperationalPaymentClaim`): `direction = CUSTOMER_RECEIPT` requires `sales_document_id`,
  `SUPPLIER_PAYMENT` requires `purchase_document_id` (CHECK `claims_direction_document_chk`);
  `party_id` always set (FK in Phase 3); statuses `UNMATCHED / MATCHED / REJECTED`. A claim has
  **no bank effect until matched** (matching creates the `RECEIPT`/`PAYMENT` via
  `matched_receipt_id` / `matched_payment_id`). `REJECTED` **restores** the operational balance
  (`PARTY_OPERATIONAL_BALANCE`, optimistic `version`) and emits audit + timeline + notification.
  CHECK `claims_amount_positive_chk (amount > 0)`; indexes `(company_id, status)`,
  `(party_id, status)`.

### Workflow / Automation / Platform engines

```mermaid
erDiagram
    WORKFLOW_DEFINITION ||--o{ WORKFLOW_STATE : "1:N"
    WORKFLOW_DEFINITION ||--o{ WORKFLOW_INSTANCE : "runs on entity"
    WORKFLOW_STATE ||--o{ WORKFLOW_INSTANCE : "current_state_id"
    WORKFLOW_INSTANCE ||--o{ WORKFLOW_TIMER : "schedules"
    WORKFLOW_STATE ||--o{ WORKFLOW_TIMER : "state_id"
    APPROVAL_REQUEST ||--o{ APPROVAL_STEP : "single/role/sequential"
    USER ||--o{ APPROVAL_STEP : "decided by"
    AUTOMATION_RULE ||--o{ AUTOMATION_RULE_VERSION : "versioned"
    AUTOMATION_RULE_VERSION ||--o{ AUTOMATION_RUN : "1:N runs (idempotent keys)"
    AUTOMATION_RUN ||--o{ AUTOMATION_ACTION_RESULT : "1:N actions"
    AUTOMATION_RULE ||--o{ AUTOMATION_SCHEDULED_ACTION : "delayed, cancellable"
    SMS_TEMPLATE ||--o{ SMS_LOG : sent as
    INTEGRATION_CONFIG ||--o{ QUEUE_JOB : "adapter jobs"
    QUEUE_JOB ||--o{ JOB_EXECUTION : "append-only attempt history"
```

`WORKFLOW_TIMER` (Correction Gate #7) is a **runtime** entity owned by the Workflow engine and
executed via the queue: `workflow_instance_id`, `state_id`, `timer_type`
(`ESCALATION | REMINDER | TIMEOUT`), `due_at`, `status`
(`SCHEDULED | EXECUTED | CANCELLED | FAILED`), `action_config` (JSON), `executed_at`.
Index `(status, due_at)` for the dispatcher poll. (WorkflowDefinition/State/Instance are the
minimal foundation tables; transitions and transition logs arrive with the full Phase 9 engine.)

`AUTOMATION_RUN` carries `idempotency_key UNIQUE` — duplicate event delivery never double-fires
SMS/Activity/Approval. `AUTOMATION_SCHEDULED_ACTION` is cancelled when the guard condition
no longer holds (e.g. quotation confirmed before 3-day follow-up).

## Cardinality summary (required list)

| Relation | Cardinality |
|---|---|
| Company → UserCompany → User | **M:N** with `is_default`; `users.default_company_id` = default |
| Company → Team / Setting / Sequence / IntegrationConfig / NotificationRule / TaxDefinition / BankAccount / ChartOfAccount / JournalEntry / Receipt / Payment / BankTransfer / Check / Claim / Loading / WorkflowDefinition / PortalAccount | 1:N (mandatory company scope) |
| Company → QueueJob / AuditLog | 1:N, `company_id` nullable (null = platform) |
| Party → Address / Contact / PartyRole | 1:N |
| ProductTemplate → ProductVariant | 1:N |
| SalesDocument → SalesLine / PurchaseDocument → PurchaseLine | 1:N |
| Sales ↔ Purchase | **M:N** (`SalesPurchaseAllocation`, line-level, Phase 4) |
| SalesOrder ↔ SalesTaxInvoice | **M:N** (`SalesTaxInvoiceOrderAllocation`, `UNIQUE` pair, amounts + optional quantity) |
| PurchaseOrder ↔ PurchaseTaxInvoice | **M:N** (`PurchaseTaxInvoiceOrderAllocation`, same pattern) |
| PriceRequestLine → SupplierOffer | 1:N |
| Loading → LoadingLine → LoadingAllocation → Sales/Purchase lines | 1:N → **M:N** (auto-match in 1:1); registered once, shown on both sides |
| Supplier ↔ Product | three-level mapping (VARIANT/TEMPLATE/CATEGORY, exactly one FK set) |
| MoadianSubmission → Attempts | 1:N (append-only) |
| Party ↔ Role | M:N (`PartyRole`, multiple roles per party) |
| User ↔ Role ↔ Permission | M:N + per-user overrides (system-level) |
| Party ↔ PartyOperationalBalance | 1:1 per (company, party), cached + optimistic `version` |
| OperationalSettlementClaim → Receipt/Payment | 0..1 on match (`matched_receipt_id` / `matched_payment_id`) |
| QueueJob → JobExecution | 1:N append-only attempt history |
| WorkflowInstance → WorkflowTimer | 1:N runtime timers |
| BankAccount → BankStatementLine | 1:N ordered ledger (non-source) |

## Key indexes & unique constraints

| Table | Constraint / Index | Why |
|---|---|---|
| `companies` | PK `id`; `user_companies` PK `(user_id, company_id)` + index `company_id`; `users.default_company_id` FK | multi-company from day one |
| `users` | UNIQUE `username`, `email`; FK `default_company_id` → `companies` | login + active company |
| `parties` | UNIQUE `normalized_mobile` (partial, where deleted_at is null); index `national_id`, `economic_code`; trigram/GIN index on name for similarity search | duplicate detection (Phase 3) |
| `sales_documents` | UNIQUE `(company_id, document_number)`; index `(status, date)`, `customer_id`, `salesperson_id` | company-scoped numbering, lists & reports |
| `purchase_documents` | UNIQUE `(company_id, document_number)`; index `(supplier_id, date)` | same |
| `daily_prices` | UNIQUE `(product_variant_id, date)`; index `(product_variant_id, date DESC)` | "today's price" lookup |
| `supplier_offers` | index `(price_request_line_id)`, `(supplier_id, date)` | supplier intelligence |
| `supplier_products` | index `(company_id, supplier_party_id)`; CHECK `supplier_products_exactly_one_level_chk` (exactly one of `product_variant_id`/`product_template_id`/`category_id`, matching `mapping_level`) | genuine three-level mapping |
| `settings` | UNIQUE `(company_id, key)` | per-company typed settings |
| `sequences` | UNIQUE `(company_id, document_type)`; fields `prefix`, `padding`, `reset_cycle` (`NEVER\|FISCAL_YEAR\|JALALI_YEAR\|MONTHLY`), `current_number`, `last_reset_marker`; `SELECT … FOR UPDATE` allocation | concurrency-safe v2 engine; history never renumbered |
| `integration_configs` | UNIQUE `(company_id, code)`; index `type` | adapter registry |
| `notification_rules` | UNIQUE `(company_id, code)`; index `(event, enabled)` | completed rule engine (conditions/recipient/channels/delay/priority JSON) |
| `sales_tax_invoice_order_allocations` | UNIQUE `(sales_tax_invoice_id, sales_document_id)`; index `sales_document_id` | no double-allocation (explicit table) |
| `purchase_tax_invoice_order_allocations` | UNIQUE `(purchase_tax_invoice_id, purchase_document_id)`; index `purchase_document_id` | same, purchase side |
| `loading_lines` / `loading_allocations` | index `loading_id` / `loading_line_id`; CHECK `loading_allocations_target_chk` | header+lines loading model |
| `operational_settlement_claims` | CHECK `claims_direction_document_chk`, `claims_amount_positive_chk`; index `(company_id, status)`, `(party_id, status)` | direction-aware claims |
| `party_operational_balances` | UNIQUE `(company_id, party_id)`; optimistic `version` | cached operational balance |
| `chart_of_accounts` | UNIQUE `(company_id, code)`; self-FK `parent_id` | per-company CoA |
| `journal_entries` | UNIQUE `(company_id, entry_number)`; index `(company_id, entry_date)` | ledger |
| `journal_lines` | index `journal_entry_id`, `account_id`; CHECK `journal_lines_debit_credit_chk` (`debit >= 0 AND credit >= 0 AND NOT (debit > 0 AND credit > 0)`); `SUM(debit)==SUM(credit)` in POST transaction | accounting integrity |
| `bank_statement_lines` | UNIQUE `(company_id, bank_account_id, entry_date, sequence_no)` (`bank_statement_lines_company_id_bank_account_id_entry_date__key`); index `(bank_account_id, entry_date)`; CHECK `bank_statement_amount_positive_chk` | deterministic daily ordering + running balance (non-source) |
| `receipts` / `payments` / `bank_transfers` | UNIQUE `(company_id, receipt_number)` / `(company_id, payment_number)` / `(company_id, transfer_number)`; CHECK `bank_transfers_amount_chk` | treasury sources |
| `checks` | index `(company_id, status, due_date)` | due-date notifications; bank effect only on CLEARED/PAID |
| `tax_definitions` | UNIQUE `(company_id, code)` | immutable-after-first-use rates |
| `workflow_timers` | index `(status, due_at)` | timer dispatcher |
| `queue_jobs` | UNIQUE `idempotency_key` (nullable); index `(status, priority, scheduled_at)`, `(job_type, status)`; nullable `company_id` | worker claim; BullMQ = runtime, DB = history |
| `job_executions` | UNIQUE `(job_id, attempt_no)` | append-only attempt history |
| `audit_logs` | index `(entity_type, entity_id)`, `actor_id`, `company_id`, `created_at`; nullable `company_id` | timeline & review |
| `file_blobs` | UNIQUE `sha256` | content dedupe |
| `refresh_tokens` | UNIQUE `token_hash`; index `user_id`, `expires_at` | auth |
| `moadian_submission_attempts` | UNIQUE `(submission_id, attempt_no)` | append-only history |
| `portal_accounts` | UNIQUE `(company_id, verified_mobile)`; index `party_id` | verified mobile used only for initial linking; ambiguous mobile exposes nothing automatically |
| documents (money) | `CHECK (amount >= 0)` where applicable | accounting integrity |
