# TCERP — Domain Map

Steel & iron B2B trading ERP/CRM. Domain-Driven module boundaries; each module owns its
schema tables, backend services, API, permissions, audit events and frontend. Modules are
independent but connected through explicit, auditable relations (Document Flow).
**Multi-company from day one** (Correction Gate #1): every module row below is scoped per
`Company` via `company_id` (mandatory for domain tables, nullable=platform for queue/audit).

## 1. Platform Core (Foundation)

| Module | Responsibility | Key entities |
|---|---|---|
| Companies | Multi-company from day one (Correction Gate #1): membership, default company, company-scoped uniques everywhere; roles/permissions stay system-level, company role bindings via membership | `Company`, `UserCompany`, `User.default_company_id` |
| Identity & Access | Users, dynamic roles, backend-enforced permissions, record scopes, teams, delegation | `User`, `Role`, `Permission`, `UserRole`, `RolePermission`, `UserPermissionOverride`, `Team` |
| Audit | Immutable trail of every important change (who/when/old/new/action/reason); `company_id` nullable = platform event | `AuditLog` |
| Settings | Central typed settings per company, section JSON export/import with preview, audited | `Setting` (UNIQUE `company_id, key`) |
| Sequences | Document numbering v2 (SD-1405-00125 style), company-scoped, reset cycles (NEVER/FISCAL_YEAR/JALALI_YEAR/MONTHLY), concurrency-safe allocation, never renumbers history | `Sequence` |
| Files | Central content-addressed file store (sha256 dedupe) + attachments to any entity | `FileBlob`, `FileAttachment` |
| Queue | Async job platform; BullMQ/Redis = runtime execution/scheduling/retry, PostgreSQL `QueueJob` + `JobExecution` = durable history, status, audit, idempotency; `QUEUE_DRIVER=auto` falls back to DB polling without Redis | `QueueJob`, `JobExecution` |
| Workflow timers | Runtime timers owned by the Workflow engine, executed via the queue | `WorkflowTimer` (ESCALATION/REMINDER/TIMEOUT) |
| Integrations | Adapter registry (SMS, Telegram, WhatsApp, Eitaa, Bale, Rubika, Website, Moadian, Email) | `IntegrationConfig` |
| Notifications | In-app notification center + completed rule engine (nested conditions, recipients, channels, delay, priority) | `Notification`, `NotificationRule` |

## 2. CRM

| Module | Responsibility | Key entities |
|---|---|---|
| Party | Single central entity for Customer/Supplier/Driver/Carrier/Partner; multiple roles per party | `Party`, `PartyRole`, `Contact`, `Address` |
| Duplicate Detection | Exact mobile block, name-similarity warning, other-salesperson warning | (services on Party) |
| Customer Scoring | Auto 5-level score (Bronze→VIP) from profit/tonnage/frequency/payments | computed on `Party` |
| Favorite Products | Derived from purchase history → Smart SMS / marketing | derived |
| Financial Responsibility | Grouping parties under a financially responsible party without merging identities | `FinancialResponsibility` |
| Activities | Generic activity engine (call, meeting, follow-up…), dynamic types | `Activity` |

Party/CRM tables landed in **Phase 3A** (commit `1f57758`); the corrective pass (`f32fe7f`)
added pg_trgm-accelerated search + a ≤2-query grid projection for lists, company-member
owners, company-scoped team record scopes and **transactional audit atomicity**
(`AuditService.recordTx(tx)` — audit rows are written inside the mutation transaction;
failure propagates and rolls back both). The **CRM funnel is implemented in Phase 4**:
`Lead` / `Opportunity` / `LostReason` / `PaymentTerm` are live (see §4); `Activity` stays
Phase 9.

## 3. Product & Pricing

**Implemented in Phase 3B** (commit `2989f4f`, migration `20241007100000_phase3b_product_catalog`)
plus the **3B correction pass** (commits `e24fb73`/`2b64b81`, migration `20241008000000_p3b_corrections`:
selected template values, DB-unique variant combination keys, explicit weight UOM, at-most-one
UOM base semantics, cross-company FK integrity, file isolation):
categories/brands/UOM engine/attributes/templates/variants/variant matrix/supplier mappings
are live in `apps/backend/src/products/*`. Daily Pricing, Publishing and Tax Product remain
future phases.

| Module | Responsibility | Key entities |
|---|---|---|
| Product | Odoo-style template + variants with **deterministic variant generation** (cartesian preview, one-transaction generate with skip-with-report `{created[], skipped[]}`), dynamic attributes, hierarchical cycle-guarded categories, brands; matrix API for the Phase 4 variant UI | `ProductTemplate`, `ProductVariant`, `Attribute`, `AttributeValue`, `ProductCategory`, `Brand` |
| UOM | UOM categories with exactly one base unit; precise conversion via Decimal(20,6) `conversion_ratio` vs the base (KG ↔ TON); cross-category conversion blocked (422); product-weight conversion path for `weight_per_unit`-carrying variants | `Uom`, `UomCategory` (no separate conversion table — ratios live on `uoms`) |
| Supplier Product | Supplier↔product mapping, genuinely three-level (variant/template/category, exactly one FK set — DB CHECK `supplier_products_exactly_one_level_chk`); **real FKs** to Party (3A) and the 3B product tables; supplier must hold the SUPPLIER role (422 `NOT_A_SUPPLIER`) | `SupplierProduct` |
| Daily Pricing | **Phase 5 (future)**: per-variant daily price with full history, bulk update engine — the engine references the **real** `ProductVariant` rows landed in 3B | `DailyPrice` (not in schema yet) |
| Publishing | **Phase 5 (future)**: publish price batches to Website/Telegram/WhatsApp/Eitaa/Bale/Rubika; per-channel job isolation | `PublishBatch`, `PublishBatchItem` (not in schema yet) |
| Tax Product | **Phase 8 (future)**: separate catalog used only by tax invoices/Moadian | `TaxProduct` (not in schema yet) |

## 4. Sales — implemented in Phase 4 (`apps/backend/src/crm`, `apps/backend/src/sales`)

| Module | Responsibility | Key entities |
|---|---|---|
| Lead / Opportunity | CRM funnel — **implemented**: Lead `NEW→CONTACTED→QUALIFIED/LOST`; Opportunity `OPEN→QUALIFIED→QUOTED→WON/LOST`; a returning customer gets a NEW Opportunity per buying intent (the Party master never changes); customer must hold the CUSTOMER role (422 `NOT_A_CUSTOMER`); LostReason required when LOST | `Lead`, `Opportunity`, `LostReason` |
| Sales Document | Shared Quotation→SalesOrder entity — **implemented**: ONE `SalesDocument` with ONE id + ONE document_number allocated once at creation from the `SD` sequence and never regenerated (REQUIREMENTS §9); statuses `DRAFT→QUOTATION→SENT→CUSTOMER_CONFIRMED→SALES_ORDER→PARTIALLY_LOADED→COMPLETED` (+`CANCELLED`/`LOST`); line fields locked after confirmation — override only with `sales.override_confirmed_order` + a mandatory reason (422 `OVERRIDE_REASON_REQUIRED`, audited `OVERRIDE_CONFIRMED_ORDER` + timeline event in the same tx, else 403 `ORDER_LOCKED`); server-authoritative exact Decimal totals; variant-matrix line entry (one line per non-empty cell, `printableDescription` default); OWN/TEAM/ALL record scope keyed on the salesperson | `SalesDocument`, `SalesLine` |
| Lost Quotes | Configurable per-company lost reasons (reportable, 6 Persian defaults seeded); reason required when marking a document/opportunity LOST | `LostReason` |
| Payment Terms | Configurable per-company terms attached to sales/purchase documents (4 Persian defaults seeded) | `PaymentTerm` |
| Sales Pricing follow-up | Quotation follow-up automations — Phase 9 | via Automation |

## 5. Procurement — implemented in Phase 4 (`apps/backend/src/{purchase,price-request,allocations,document-flow}`)

| Module | Responsibility | Key entities |
|---|---|---|
| Purchase | Independent purchase documents (no price request or sale required): `DRAFT→ORDER_PLACED→PARTIALLY_LOADED→COMPLETED` (+`CANCELLED`); supplier must hold the SUPPLIER role (422 `NOT_A_SUPPLIER`), buyer must be an active company member; `create-purchase`-from-sale / `create-sale`-from-purchase copy lines and write reciprocal `CREATED_FROM` relations | `PurchaseDocument`, `PurchaseLine` |
| Price Request | Independent (customer optional, must hold CUSTOMER role when given): `OPEN→OFFERED→CONVERTED/CLOSED`; company-scoped `PRQ` numbering; lines carry variant/quantity/uom; worklist `{today, previousDays}` shows still-OPEN previous-day requests as the SAME records (never copied or deleted); "today's price" comes through the `TodayPriceProvider` interface (`NullTodayPriceProvider` until Phase 5) | `PriceRequest`, `PriceRequestLine` |
| Supplier Offers | Several offers per request line (first offer moves OPEN→OFFERED); owner-only edit/delete, blocked after conversion; supplier must hold the SUPPLIER role; **daily-lowest derived via `RANK()`** per (day, variant, uom) — ties mean ALL co-lowest offers (no stored boolean); supplier lowest-report per (supplier, product, uom) | `SupplierOffer` |
| Sales↔Purchase Allocation | Line-level M:N (`UNIQUE(sales_line_id, purchase_line_id)`, same variant on both sides); over-allocation guarded by a SERIALIZABLE transaction + `SELECT … FOR UPDATE` on both lines in consistent id order — under concurrency exactly one writer wins (409 `ALLOCATION_EXCEEDS_QUANTITY`) | `SalesPurchaseAllocation` |
| Document Flow | Navigation infrastructure over the documents: polymorphic relations `CREATED_FROM / GENERATED_FROM / RELATED / BASED_ON` between `sales_document` / `purchase_document` / `price_request` / `lead` / `opportunity` (unique tuple, no hard FKs); related-documents endpoint returns both directions with reciprocal pairs deduped | `DocumentRelation` |

## 6. Logistics & Inventory

| Module | Responsibility | Key entities |
|---|---|---|
| Loading | Single load record registered once, shown on both sale & purchase sides: header + per-product lines + allocations to sales/purchase lines; actual vs ordered vs invoiced quantities; weighbridge images, driver/carrier parties | `Loading`, `LoadingLine`, `LoadingAllocation` |
| Debt-aware release | Customer debt → driver info hidden until manager approval (Approval engine) | via Approval/Workflow |
| Inventory | Auto stock movements from Purchase/Loading/Transfer/Sales; supplier→customer now, warehouse-ready | `Warehouse`, `Location`, `StockMovement` |

## 7. Tax & Compliance

| Module | Responsibility | Key entities |
|---|---|---|
| Tax Invoices | Separate Sales/Purchase tax invoice entities; explicit M:N allocation tables (no polymorphic allocation); no quantity equality enforcement; total reconciliation warnings; hidden from salespersons | `SalesTaxInvoice(+Line)`, `PurchaseTaxInvoice(+Line)`, `SalesTaxInvoiceOrderAllocation`, `PurchaseTaxInvoiceOrderAllocation` |
| Tax Definitions | Company-scoped, immutable after first use (rate change = new row); invoice lines carry `tax_definition_id` + `tax_rate_snapshot` | `TaxDefinition` |
| Moadian | Full module: connection settings (encrypted secrets), prevalidation, submission queue, per-attempt history, status inquiry scheduler, corrective/cancellation/return invoices, purchase inbox + match, buyer response | `MoadianSubmission`, `MoadianSubmissionAttempt`, `MoadianIncomingInvoice`, … |

## 8. Accounting & Finance

| Module | Responsibility | Key entities |
|---|---|---|
| General Ledger | Real double-entry: per-company CoA, journals (entries+lines), draft/posted/reversed; posted entries never edited — reversed instead; `SUM(debit)==SUM(credit)` enforced in the POST transaction; `debit>=0, credit>=0, never both positive` (DB CHECK) | `ChartOfAccount`, `JournalEntry`, `JournalLine` |
| Descriptions | Journal-line description template engine with placeholders | `DescriptionTemplate` |
| Bank | `BankStatementLine` = NON-source ordered ledger per account: daily `sequence_no`, deterministic ordering (no gapless requirement), `running_balance`, source links, reconciliation flags. Treasury sources: Receipt, Payment, BankTransfer, check clearing/payment, Bank Adjustment (later, permission-sensitive) | `BankAccount`, `BankStatementLine` |
| Transfers | Dr Destination X + Dr Bank Fee Expense F / Cr Source X+F; statement lines: source WITHDRAWAL X+F, destination DEPOSIT X | `BankTransfer` |
| Receipts/Payments | Bank only changes via receipt/payment/cleared check/paid check/bank transfer; invoices NEVER touch bank directly | `Receipt`, `Payment` |
| Settlement Claims | Salesperson-declared receipts (customer) / payments (supplier); party always set; UNMATCHED/MATCHED/REJECTED; no bank effect until matched; REJECT restores operational balance (+ audit + timeline + notification) | `OperationalSettlementClaim`, `PartyOperationalBalance` |
| Checks | Incoming/outgoing lifecycle; bank entry ONLY on incoming CLEARED / outgoing PAID; due notifications | `Check` |
| Reconciliation | Bank & payment reconciliation against statement lines | `Reconciliation`, `ReconciliationItem` |
| Opening Balances | Migration import from legacy software | import engine target |

## 9. Workflow & Automation Platform

| Module | Responsibility | Key entities |
|---|---|---|
| Workflow Engine | Generic configurable state machine: states, transitions, conditions, field locking, role rules, timers, reopen/rollback, transition actions | `WorkflowDefinition`, `WorkflowState`, `WorkflowInstance`, `WorkflowTimer` (runtime, executed via queue) |
| Approval Engine | Platform-level approvals: single/role-based/sequential approvers | `ApprovalRequest`, `ApprovalStep` |
| Automation Engine | Trigger→Filter→Conditions→Delay→Actions→Error handling; idempotent runs, versioned rules, test mode, retries, logs | `AutomationRule(+Version)`, `AutomationRun`, `AutomationAction` |
| SMS | Template engine with placeholders, send log, manual resend, provider fallback | `SmsTemplate`, `SmsLog` |
| Smart SMS | Rule-based v1 (e.g. bought rebar in 90d AND price dropped today) | rules |

## 10. Analytics & Productivity

Reporting engine (every list → report: nested filters, group-by, aggregations, saved/shared views),
Global search (Ctrl+K) + Command Palette, Dashboards (role-specific, customizable),
Calendar (activity/check/payment layers), Timeline per entity, Import/Export engine
(wizard, saved mappings, chunked async processing, resume checkpoints, failed-rows export).

## 11. API & Portal

REST API platform (auth, permissions, rate limit, audit, versioning; active company resolved
from the `X-Company-Id` header and validated against `UserCompany` membership),
Customer Portal API (OTP-verified mobile → `PortalAccount` link per company; ambiguous mobile
exposes nothing automatically; driver info gated by approval workflow).

## Module interaction spine

```
Party ──< Opportunity ──< SalesDocument ──< Loading >── PurchaseDocument >── Supplier
             │                │   │                │
             │                │   ├── M:N ──< PurchaseDocument        (SalesPurchaseAllocation)
             │                │   ├── M:N ──< SalesTaxInvoice           (SalesTaxInvoiceOrderAllocation)
             │                │   └──< OperationalSettlementClaim ──> Receipt/Payment (accounting match)
             │                └───> StockMovement (auto, via Loading)
             └──< Activity / Timeline / FileAttachment / ApprovalRequest / AutomationRun
```

Every company-scoped table above carries `company_id`; the active company comes from the
authenticated user's `UserCompany` membership (default = `users.default_company_id`,
overridable via `X-Company-Id`). Roles/Permissions remain system-level.

## Excluded (do NOT build until explicitly requested)

Sales Contract module, Customer Credit Limit, Stock Reservation, Serial/Lot/Batch,
Production/MRP, Fleet Management, Transportation Cost, Customer Delivery Confirmation,
Odoo-style generic pricing rules. Feature flags: `FleetManagement=OFF`,
`AdvancedWarehouse=OFF`, `CreditLimit=OFF`.
