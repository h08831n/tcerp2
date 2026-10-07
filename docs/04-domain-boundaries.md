# TCERP — Domain Boundaries Checkpoint (pre-Phase 6, 2026-10-10)

Ratified rules and how the codebase honours them. This document is the reference
for Phase 6 (Loading + Inventory + Operational Settlement) and every later phase.

## 1. DailyPrice NEVER creates inventory or cost
- `daily_prices` is a display/pricing table only. It has no link to stock, cost,
  accounting or documents. Its only consumers are: price grids, the website
  public API, the `TodayPriceProvider` used as a **default** for new document
  lines, publishing templates and automation triggers.
- Verified: no code path from `pricing/` writes to inventory, accounting or
  documents; `DailyPrice` rows never mutate after their day closes
  (`PRICE_HISTORY_IMMUTABLE`). A changed DailyPrice cannot retroactively affect
  any document — lines carry `priceSource`/`priceDate` snapshots (p5c-01).

## 2. Loading is the operational event that affects physical quantity
- The Loading (header + lines + allocations) is the single physical event:
  a bill of lading actually leaves/enters. Phase 6 generates `StockMovement`
  rows ONLY from confirmed Loadings (out) and confirmed Purchases (in).
- One loading is registered once and shared by the sale and purchase sides via
  `LoadingAllocation` (sales_line_id / purchase_line_id).

## 3. Invoice is tax/accounting only and is independent from loading
- Tax invoices (Phase 8) are accounting/Moadian documents. They neither read
  nor write loading state, operational quantities, or inventory. Operational
  quantities are: `ordered_quantity` (document), `loaded_quantity` (sum of
  confirmed loadings), `tax_invoiced_quantity` (Phase 8) — never forced equal
  (REQUIREMENTS §19/§24).

## 4. Inventory movements are generated automatically from operational documents
- Sources of truth for movements: **PurchaseDocument** (confirmed → IN) and
  **Loading** (confirmed → OUT). Transfers (warehouse→warehouse) are future.
  Every movement carries `source_entity_type`/`source_entity_id` + an
  idempotency key so document re-confirmations can never double-count stock.

## 5. No manual stock entry in the current business model
- There is no manual stock-adjustment endpoint and none will be added; the only
  future adjustment path is an audited operational decision with its own
  document type (explicitly out of scope until requested).

## 6. Future multi-warehouse must remain possible
- `Warehouse` is a first-class entity from Phase 6 with one seeded default per
  company; every `StockMovement` carries `warehouse_id`. `Loading` gains a
  warehouse reference (nullable = default) so multi-warehouse later needs no
  renumbering or data migration — only more warehouses.

## Boundary map

```
DailyPrice ──(default only, snapshot into line)──> SalesLine/PurchaseLine
SalesDocument ──(planned qty)──┐
PurchaseDocument ──(IN)────────┤
                               ├──> StockMovement (auto, idempotent, warehouse-scoped)
Loading (confirm) ──(OUT)──────┘
Loading ──(allocations)──> SalesLine / PurchaseLine  (operational loaded amounts)
OperationalSettlementClaim / Receipt / Payment ──> operational balance (debt gate)
Invoice (Phase 8) ──> tax/accounting ONLY (never loading/stock)
```

## Debt gate (REQUIREMENTS §20)
Confirming a Loading for a customer with outstanding operational balance > 0
hides driver/carrier info from customer-facing surfaces and creates an
`ApprovalRequest` for the manager; approval releases the data. Implemented in
Phase 6 with a lean, reusable ApprovalRequest entity.
