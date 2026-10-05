# TCERP — Initial ERD (target model)

Conventions (apply to every table, including Phase-2 modules):

- **PK**: UUID v4 (`gen_random_uuid()`), column `id`.
- **Naming**: snake_case tables & columns via `@@map` / `@map`.
- **Timestamps**: every important entity has `created_at`, `updated_at`, `created_by` and where needed `updated_by`, `archived_at`, `archived_by`.
- **Money**: `NUMERIC(20,4)` — never float. **Quantities**: `NUMERIC(18,4)`. Percent: `NUMERIC(9,4)`.
- **Dates**: stored as `timestamptz` (instant) or `date` (business day); UI renders Jalali by default.
- **Soft delete**: `deleted_at`/`archived_at` for business data; accounting documents use status lifecycle (`DRAFT/POSTED/REVERSED/CANCELLED`), never hard delete.
- **Multi-company readiness**: domain tables carry `company_id` (nullable FK) from introduction; Phase-1 foundation tables omit it (single-company).
- **Optimistic locking**: `version INT` on concurrently-edited documents.

## Diagrams by bounded context

### Identity, Audit & Foundation

```mermaid
erDiagram
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
    FILE_BLOB ||--o{ FILE_ATTACHMENT : "attached as"
    USER ||--o{ FILE_BLOB : uploads
    USER ||--o{ NOTIFICATION : receives
    NOTIFICATION_RULE ||--o{ NOTIFICATION : fires
    USER ||--o{ PORTAL_ACCOUNT : "links to party via"
    PARTY ||--o{ PORTAL_ACCOUNT : "portal identity"
```

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
    USER ||--o{ PARTY : "owner_user_id"
    USER ||--o{ ACTIVITY : "assigned_to / created_by"
    ACTIVITY }o--|| ACTIVITY_TYPE : "dynamic types"
```

`PARTY.role` is a multi-valued relation (a company can be CUSTOMER and SUPPLIER simultaneously).
Unique: normalized mobile (exact-duplicate block), `national_id`, `economic_code`.

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
    SUPPLIER ||--o{ SUPPLIER_PRODUCT : "maps (template|variant|group level)"
    PRODUCT_VARIANT ||--o{ SUPPLIER_PRODUCT : supplied as
    PRODUCT_VARIANT ||--o{ DAILY_PRICE : "1:N price history"
    USER ||--o{ DAILY_PRICE : "set by"
    DAILY_PRICE ||--o{ PUBLISH_BATCH_ITEM : published in
    PUBLISH_BATCH ||--o{ PUBLISH_BATCH_ITEM : "channel jobs"
    TAX_PRODUCT ||--o{ SALES_TAX_INVOICE_LINE : "tax catalog only"
```

`DAILY_PRICE`: unique `(product_variant_id, date, source)`; full history retained.

### Sales / Procurement / Loading

```mermaid
erDiagram
    PARTY ||--o{ SALES_DOCUMENT : "customer"
    USER ||--o{ SALES_DOCUMENT : "salesperson"
    PAYMENT_TERM }o--|| SALES_DOCUMENT : "optional term"
    SALES_DOCUMENT ||--o{ SALES_LINE : "1:N lines"
    PRODUCT_VARIANT ||--o{ SALES_LINE : sold as
    UOM ||--o{ SALES_LINE : uom
    SALES_DOCUMENT ||--o{ LOST_QUOTE : "lost reason (configurable)"
    PARTY ||--o{ PURCHASE_DOCUMENT : "supplier"
    PURCHASE_DOCUMENT ||--o{ PURCHASE_LINE : "1:N lines"
    PRODUCT_VARIANT ||--o{ PURCHASE_LINE : bought as
    SALES_LINE ||--o{ SALES_PURCHASE_ALLOCATION : "M:N alloc"
    PURCHASE_LINE ||--o{ SALES_PURCHASE_ALLOCATION : "M:N alloc"
    PARTY ||--o{ PRICE_REQUEST : "optional customer"
    USER ||--o{ PRICE_REQUEST : "requester"
    PRICE_REQUEST ||--o{ PRICE_REQUEST_LINE : "1:N"
    PRODUCT_VARIANT ||--o{ PRICE_REQUEST_LINE : requested
    PRICE_REQUEST_LINE ||--o{ SUPPLIER_OFFER : "N offers"
    PARTY ||--o{ SUPPLIER_OFFER : "supplier"
    SALES_DOCUMENT ||--o{ LOADING_ALLOCATION : "loaded for"
    PURCHASE_DOCUMENT ||--o{ LOADING_ALLOCATION : "sourced from"
    LOADING ||--o{ LOADING_ALLOCATION : "1:N allocs"
    PARTY ||--o{ LOADING : "driver / carrier (roles)"
    PRODUCT_VARIANT ||--o{ LOADING : loaded
```

`SALES_DOCUMENT.status` (workflow): `DRAFT → QUOTATION → QUOTATION_SENT → CUSTOMER_CONFIRMED →
SALES_ORDER → PARTIALLY_LOADED → COMPLETED → CLOSED` (+ `REOPENED`, `LOST`).
Three distinct quantities: `ordered_quantity`, `loaded_quantity` (sum of actual loadings),
`tax_invoiced_quantity` — never forced equal.

### Inventory

```mermaid
erDiagram
    WAREHOUSE ||--o{ LOCATION : "1:N"
    LOCATION ||--o{ STOCK_MOVEMENT : "from/to location"
    PRODUCT_VARIANT ||--o{ STOCK_MOVEMENT : moves
    UOM ||--o{ STOCK_MOVEMENT : uom
    PURCHASE_DOCUMENT ||--o{ STOCK_MOVEMENT : "generates (in)"
    LOADING ||--o{ STOCK_MOVEMENT : "generates (out)"
    STOCK_MOVEMENT }o--|| SALES_DOCUMENT : "optionally for"
```

### Tax & Moadian

```mermaid
erDiagram
    PARTY ||--o{ SALES_TAX_INVOICE : "buyer"
    SALES_TAX_INVOICE ||--o{ SALES_TAX_INVOICE_LINE : "1:N"
    TAX_PRODUCT ||--o{ SALES_TAX_INVOICE_LINE : "tax product (separate catalog)"
    SALES_DOCUMENT ||--o{ TAX_INVOICE_ORDER_ALLOCATION : "M:N"
    SALES_TAX_INVOICE ||--o{ TAX_INVOICE_ORDER_ALLOCATION : "M:N"
    PARTY ||--o{ PURCHASE_TAX_INVOICE : "seller"
    PURCHASE_TAX_INVOICE ||--o{ PURCHASE_TAX_INVOICE_LINE : "1:N"
    PURCHASE_DOCUMENT ||--o{ TAX_INVOICE_ORDER_ALLOCATION : "M:N"
    PURCHASE_TAX_INVOICE ||--o{ TAX_INVOICE_ORDER_ALLOCATION : "M:N"
    SALES_TAX_INVOICE ||--o{ MOADIAN_SUBMISSION : submitted as
    SALES_TAX_INVOICE ||--o{ SALES_TAX_INVOICE : "corrective/cancellation/return (original_ref)"
    MOADIAN_SUBMISSION ||--o{ MOADIAN_SUBMISSION_ATTEMPT : "1:N attempts (never deleted)"
    MOADIAN_INCOMING_INVOICE }o--o| PURCHASE_TAX_INVOICE : "matched"
    TAX_RATE ||--o{ SALES_TAX_INVOICE_LINE : "rate snapshot (immutable per doc)"
```

`TAX_RATE` is append-only: changing VAT creates a new rate row; documents keep a snapshot.
`MOADIAN_SUBMISSION.status`: `NOT_SENT/QUEUED/SENDING/SUBMITTED/WAITING_RESULT/SUCCESS/FAILED/NEEDS_REVIEW`.

### Accounting

```mermaid
erDiagram
    ACCOUNT ||--o{ ACCOUNT : "hierarchical parent"
    FISCAL_YEAR ||--o{ FISCAL_PERIOD : "1:N periods"
    JOURNAL ||--o{ JOURNAL_ENTRY : "1:N"
    JOURNAL_ENTRY ||--o{ JOURNAL_LINE : "1:N (debit==credit enforced)"
    ACCOUNT ||--o{ JOURNAL_LINE : posted to
    PARTY ||--o{ JOURNAL_LINE : "detail (subsidiary ledger)"
    BANK_ACCOUNT ||--o{ BANK_TRANSACTION : "ordered by (date, sequence_no) + running balance"
    PARTY ||--o{ OPERATIONAL_PAYMENT_CLAIM : claimed by
    SALES_DOCUMENT ||--o{ OPERATIONAL_PAYMENT_CLAIM : "declared on"
    OPERATIONAL_PAYMENT_CLAIM ||--o| RECEIPT : "MATCHED → receipt"
    BANK_ACCOUNT ||--o{ RECEIPT : "credits bank"
    BANK_ACCOUNT ||--o{ PAYMENT : "debits bank"
    CHECK ||--o{ BANK_TRANSACTION : "on CLEARED/PAID only"
    PARTY ||--o{ CHECK : "issuer/holder"
    BANK_TRANSACTION ||--o{ RECONCILIATION_ITEM : reconciled in
    RECONCILIATION ||--o{ RECONCILIATION_ITEM : has
    PARTY ||--o{ FINANCIAL_RESPONSIBILITY : "group (A,B → Ravan)"
    DESCRIPTION_TEMPLATE ||--o{ JOURNAL_LINE : "template engine"
```

Invariants: `SUM(JournalLine.debit) == SUM(JournalLine.credit)` (DB constraint/service check);
posted entries immutable (reverse instead); invoices never touch bank directly;
check registration does not change bank balance.

### Workflow / Automation / Platform engines

```mermaid
erDiagram
    WORKFLOW_DEFINITION ||--o{ WORKFLOW_STATE : "1:N"
    WORKFLOW_DEFINITION ||--o{ WORKFLOW_TRANSITION : "1:N"
    WORKFLOW_STATE ||--o{ WORKFLOW_TRANSITION : "from/to"
    WORKFLOW_DEFINITION ||--o{ WORKFLOW_INSTANCE : "runs on entity"
    WORKFLOW_INSTANCE ||--o{ WORKFLOW_TRANSITION_LOG : "history"
    APPROVAL_REQUEST ||--o{ APPROVAL_STEP : "single/role/sequential"
    USER ||--o{ APPROVAL_STEP : "decided by"
    AUTOMATION_RULE ||--o{ AUTOMATION_RULE_VERSION : "versioned"
    AUTOMATION_RULE_VERSION ||--o{ AUTOMATION_RUN : "1:N runs (idempotent keys)"
    AUTOMATION_RUN ||--o{ AUTOMATION_ACTION_RESULT : "1:N actions"
    AUTOMATION_RULE ||--o{ AUTOMATION_SCHEDULED_ACTION : "delayed, cancellable"
    SMS_TEMPLATE ||--o{ SMS_LOG : sent as
    INTEGRATION_CONFIG ||--o{ QUEUE_JOB : "adapter jobs"
    QUEUE_JOB ||--o{ QUEUE_JOB_ATTEMPT : "attempt history / DLQ"
```

`AUTOMATION_RUN` carries `idempotency_key UNIQUE` — duplicate event delivery never double-fires
SMS/Activity/Approval. `AUTOMATION_SCHEDULED_ACTION` is cancelled when the guard condition
no longer holds (e.g. quotation confirmed before 3-day follow-up).

## Cardinality summary (required list)

| Relation | Cardinality |
|---|---|
| Party → Address / Contact / PartyRole | 1:N |
| ProductTemplate → ProductVariant | 1:N |
| SalesDocument → SalesLine / PurchaseDocument → PurchaseLine | 1:N |
| Sales ↔ Purchase | **M:N** (`SalesPurchaseAllocation`, line-level) |
| SalesOrder ↔ SalesTaxInvoice | **M:N** (`TaxInvoiceOrderAllocation`, with `allocated_amount`, optional `allocated_quantity`) |
| PurchaseOrder ↔ PurchaseTaxInvoice | **M:N** (same) |
| PriceRequestLine → SupplierOffer | 1:N |
| Loading → Purchase/Sales lines | M:N via `LoadingAllocation` (auto-match in 1:1) |
| MoadianSubmission → Attempts | 1:N (append-only) |
| Party ↔ Role | M:N (`PartyRole`, multiple roles per party) |
| User ↔ Role ↔ Permission | M:N + per-user overrides |

## Key indexes & unique constraints

| Table | Constraint / Index | Why |
|---|---|---|
| `users` | UNIQUE `username`, `email` | login |
| `parties` | UNIQUE `normalized_mobile` (partial, where deleted_at is null); index `national_id`, `economic_code`; trigram/GIN index on name for similarity search | duplicate detection |
| `sales_documents` | UNIQUE `document_number` (per sequence/company); index `(status, date)`, `customer_id`, `salesperson_id` | lists & reports |
| `purchase_documents` | UNIQUE `document_number`; index `(supplier_id, date)` | same |
| `daily_prices` | UNIQUE `(product_variant_id, date)`; index `(product_variant_id, date DESC)` | "today's price" lookup |
| `supplier_offers` | index `(price_request_line_id)`, `(supplier_id, date)` | supplier intelligence |
| `tax_invoice_order_allocations` | UNIQUE `(invoice_id, order_type, order_id)` | no double-allocation |
| `journal_entries` | UNIQUE `entry_number`; index `(journal_id, date)`, `(status)` | ledger |
| `bank_transactions` | UNIQUE `(bank_account_id, date, sequence_no)` | running balance integrity |
| `checks` | index `(status, due_date)` | due-date notifications |
| `queue_jobs` | UNIQUE `idempotency_key` (nullable); index `(status, priority, scheduled_at)` | worker claim |
| `audit_logs` | index `(entity_type, entity_id)`, `actor_id`, `created_at` | timeline & review |
| `file_blobs` | UNIQUE `sha256` | content dedupe |
| `refresh_tokens` | UNIQUE `token_hash`; index `user_id` | auth |
| `moadian_submission_attempts` | UNIQUE `(submission_id, attempt_no)` | append-only history |
| `portal_accounts` | UNIQUE `verified_mobile` (canonical); FK `party_id` | portal linking |
| all `_allocations` | FK indexes on both sides; `CHECK (quantity > 0)` | integrity |
| documents (money) | `CHECK (amount >= 0)` where applicable; journal `CHECK (debit = 0 OR credit = 0)` | accounting integrity |
