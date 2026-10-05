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

## 3. Product & Pricing

| Module | Responsibility | Key entities |
|---|---|---|
| Product | Odoo-style template + variants, dynamic attributes, hierarchical categories, brands | `ProductTemplate`, `ProductVariant`, `Attribute`, `AttributeValue`, `ProductCategory`, `Brand` |
| UOM | UOM categories and precise conversion (KG ↔ TON) | `Uom`, `UomCategory`, `UomConversion` |
| Supplier Product | Supplier↔product mapping, genuinely three-level (variant/template/category, exactly one FK set — DB CHECK) | `SupplierProduct` |
| Daily Pricing | Per-variant daily price with full history, bulk update engine | `DailyPrice` |
| Publishing | Publish price batches to Website/Telegram/WhatsApp/Eitaa/Bale/Rubika; per-channel job isolation | `PublishBatch`, `PublishBatchItem` |
| Tax Product | Separate catalog used only by tax invoices/Moadian | `TaxProduct` |

## 4. Sales

| Module | Responsibility | Key entities |
|---|---|---|
| Lead / Opportunity | CRM funnel; a returning customer gets a new Opportunity | `Lead`, `Opportunity` |
| Sales Document | Shared Quotation→SalesOrder entity (same number, status progression), line lock after confirm, manager override with audit | `SalesDocument`, `SalesLine` |
| Lost Quotes | Lost reasons (configurable) + aggregate report | `LostReason` config |
| Sales Pricing follow-up | Quotation follow-up automations | via Automation |

## 5. Procurement

| Module | Responsibility | Key entities |
|---|---|---|
| Purchase | Independent purchase documents; linked M:N with sales | `PurchaseDocument`, `PurchaseLine` |
| Price Request | Independent; optional customer; lines with today's known price | `PriceRequest`, `PriceRequestLine` |
| Supplier Offers | Multiple offers per request line; daily-lowest tracking & supplier intelligence | `SupplierOffer` |
| Sales↔Purchase Allocation | M:N, preferably line-level allocation of tonnage | `SalesPurchaseAllocation` |

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
