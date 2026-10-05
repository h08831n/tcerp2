# TCERP — Domain Map

Steel & iron B2B trading ERP/CRM. Domain-Driven module boundaries; each module owns its
schema tables, backend services, API, permissions, audit events and frontend. Modules are
independent but connected through explicit, auditable relations (Document Flow).

## 1. Platform Core (Foundation)

| Module | Responsibility | Key entities |
|---|---|---|
| Identity & Access | Users, dynamic roles, backend-enforced permissions, record scopes, teams, delegation | `User`, `Role`, `Permission`, `UserRole`, `RolePermission`, `UserPermissionOverride`, `Team` |
| Audit | Immutable trail of every important change (who/when/old/new/action/reason) | `AuditLog` |
| Settings | Central typed settings, section JSON export/import with preview, audited | `Setting` |
| Sequences | Document numbering (SD-1405-00125 style), never renumbers history | `Sequence` |
| Files | Central content-addressed file store (sha256 dedupe) + attachments to any entity | `FileBlob`, `FileAttachment` |
| Queue | Central async job platform, retries, dead-letter, error center | `QueueJob` |
| Integrations | Adapter registry (SMS, Telegram, WhatsApp, Eitaa, Bale, Rubika, Website, Moadian, Email) | `IntegrationConfig` |
| Notifications | In-app notification center + configurable notification rules | `Notification`, `NotificationRule` |

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
| Supplier Product | Supplier↔product mapping at template/variant/group level | `SupplierProduct` |
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
| Loading | Single load record linked to purchase & sales lines; actual vs ordered vs invoiced quantities; weighbridge images, driver/carrier parties | `Loading`, `LoadingAllocation` |
| Debt-aware release | Customer debt → driver info hidden until manager approval (Approval engine) | via Approval/Workflow |
| Inventory | Auto stock movements from Purchase/Loading/Transfer/Sales; supplier→customer now, warehouse-ready | `Warehouse`, `Location`, `StockMovement` |

## 7. Tax & Compliance

| Module | Responsibility | Key entities |
|---|---|---|
| Tax Invoices | Separate Sales/Purchase tax invoice entities; M:N with orders; no quantity equality enforcement; total reconciliation warnings; hidden from salespersons | `SalesTaxInvoice(+Line)`, `PurchaseTaxInvoice(+Line)`, `TaxInvoiceOrderAllocation` |
| Moadian | Full module: connection settings (encrypted secrets), prevalidation, submission queue, per-attempt history, status inquiry scheduler, corrective/cancellation/return invoices, purchase inbox + match, buyer response | `MoadianSubmission`, `MoadianSubmissionAttempt`, `MoadianIncomingInvoice`, … |

## 8. Accounting & Finance

| Module | Responsibility | Key entities |
|---|---|---|
| General Ledger | Real double-entry: CoA, fiscal years/periods, journals, entries+lines, draft/posted/reversed | `ChartOfAccount`, `FiscalYear`, `Journal`, `JournalEntry`, `JournalLine` |
| Descriptions | Journal-line description template engine with placeholders | `DescriptionTemplate` |
| Bank | Bank ledger with daily sequence + running balance (no manual time-of-day) | `BankAccount`, `BankTransaction` |
| Receipts/Payments | Bank only changes via receipt/payment/cleared check/paid check | `Receipt`, `Payment` |
| Payment Claims | Salesperson-declared payments, operational balance effect, MATCHED/REJECTED lifecycle | `OperationalPaymentClaim` |
| Checks | Incoming/outgoing lifecycle; bank entry only on clear/pay; due notifications | `Check` |
| Reconciliation | Bank & payment reconciliation | `Reconciliation`, `ReconciliationItem` |
| Opening Balances | Migration import from legacy software | import engine target |

## 9. Workflow & Automation Platform

| Module | Responsibility | Key entities |
|---|---|---|
| Workflow Engine | Generic configurable state machine: states, transitions, conditions, field locking, role rules, timers, reopen/rollback, transition actions | `WorkflowDefinition`, `WorkflowState`, `WorkflowTransition`, `WorkflowInstance` |
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

REST API platform (auth, permissions, rate limit, audit, versioning),
Customer Portal API (OTP-verified mobile → `PortalAccount` link; driver info gated by approval workflow).

## Module interaction spine

```
Party ──< Opportunity ──< SalesDocument ──< Loading >── PurchaseDocument >── Supplier
             │                │   │                │
             │                │   ├── M:N ──< PurchaseDocument        (SalesPurchaseAllocation)
             │                │   ├── M:N ──< SalesTaxInvoice           (TaxInvoiceOrderAllocation)
             │                │   └──< OperationalPaymentClaim ──> Receipt (accounting match)
             │                └───> StockMovement (auto, via Loading)
             └──< Activity / Timeline / FileAttachment / ApprovalRequest / AutomationRun
```

## Excluded (do NOT build until explicitly requested)

Sales Contract module, Customer Credit Limit, Stock Reservation, Serial/Lot/Batch,
Production/MRP, Fleet Management, Transportation Cost, Customer Delivery Confirmation,
Odoo-style generic pricing rules. Feature flags: `FleetManagement=OFF`,
`AdvancedWarehouse=OFF`, `CreditLimit=OFF`.
