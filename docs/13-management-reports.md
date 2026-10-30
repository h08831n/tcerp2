# 13 — Management Reports & Dashboard (Phase 10, Gate F)

> Status: **LOCALLY VERIFIED** (integration 8/8 g10 suites on `tcerp_test`; CI green on push).
> Scope: REQUIREMENTS §31/§33/§10 — the first Phase-10 slice: dashboard KPIs,
> performance reports, operational watchlists and the global-search command palette.
> **Deliberately deferred** (documented at §5): saved views, per-warehouse negative-stock
> drill-down, debt reports (operational vs accounting gap), win/loss offer report.

## 1. Principles (per the handover's reporting rules)

- **Source of truth**: every figure aggregates the OPERATIONAL tables in SQL —
  sales/purchase documents, loadings + allocations, goods receipts, stock movements,
  parties. Tax invoices are NEVER a sales/profit source (REQUIREMENTS §35); the
  7C accounting reports remain the financial layer.
- **Totals over the whole filtered set**, never the rendered page (pending-orders
  computes totalAmount over all matching rows, items are a 50-row preview).
- **Company scoping**: every query filters `company_id` from the server-resolved
  company context; global search is company-scoped (proven by an isolation test).
- **Read-only** — no report endpoint mutates anything.

## 2. Endpoints (`reports.view`; seeded to admin + the four manager roles, NOT to
operational roles)

| Endpoint | Content (SQL source) |
|---|---|
| `GET /reports/dashboard` | Sales: open quotations (QUOTATION/SENT count+total), open orders (SALES_ORDER/PARTIALLY_LOADED), COMPLETED this month. Purchase: open + completed this month. Loadings: today count (`loading_date >= LOCAL midnight`), pending driver-release (CONFIRMED + restricted), reversed this month. Customers: inactive-60d count. Inventory: negative-balance variant count (INTERNAL in/out CASE — the inventory module's exact formula). |
| `GET /reports/sales-performance` | Per salesperson: open quotations/orders (count + totals), completed (count + total) + **delivered qty** mapped through CONFIRMED loading allocations → sales lines → documents. |
| `GET /reports/purchase-performance` | Per supplier: orders count, ordered/open/completed totals + **received qty** from CONFIRMED goods-receipt lines through purchase lines. |
| `GET /reports/inactive-customers` | CUSTOMER parties (non-archived) with NO non-cancelled sale in 60 days (or never) — daysSince, owner, mobile presence; 200-row cap, NULLs (never-purchased) first. |
| `GET /reports/pending-orders?olderThanDays=7` | Sales orders older than the window with age days, per-document totals; `totalAmount` covers the whole filtered set. |
| `GET /reports/negative-stock` | Per-variant INTERNAL balance < 0 (same CASE as computed stock; internal→internal transfers net zero). |
| `GET /reports/search?q=` | سراسری — companies/parties (name, EN name, phone), variants (sku/name), sales + purchase documents (number); LIMIT 5 each; ≥2 chars; LIKE wildcards escaped; fully parameterized. |

### Day-boundary correctness note
The dashboard's «today» uses **LOCAL midnight** (the server's calendar), not the
pricing module's UTC-midnight day-key normalization — in the Iranian afternoon the
UTC boundary would push the local day's loadings into "yesterday" (g10-01 caught
this). The pricing day convention stays for its date-only columns.

## 3. Frontend
- **Dashboard rebuilt** (was a shell): 6 KPI cards (sales/purchase/loadings/inactive/
  negative-stock, each linking to its module), pending-orders + inactive-customers
  tables, quick actions now real links. Graceful degradation: without `reports.view`
  the page renders the welcome + quick actions only (no error toast).
- **Ctrl+K command palette**: debounced global search (250 ms) with grouped results
  (parties / products / sales docs / purchase docs), keyboard-openable (Ctrl/⌘+K),
  Esc-close, results navigate to the entity pages.

## 4. Tests (`g10-management-reports.spec.ts`, 8)
Dashboard DELTA assertions (before/after creating this spec's rows — the shared
company makes absolute counts meaningless), per-salesperson split + delivered qty via
real allocations, per-supplier split + GRN received qty, inactive list on an ISOLATED
company (the shared company's never-purchased customers exceed the report cap — the
invariant needs a deterministic scope), pending-orders window + whole-set totals,
negative stock (IN 100 / OUT 150 → −50), search fragment hits + cross-company
isolation + short-term rejection, and the seed contract (manager roles hold
`reports.view`; salesperson/buyer do not).

## 5. Deferred to the next Phase-10 slice (NOT claimed as done)
- Debt report (operational balance vs accounting balance + gap) — needs the
  claims/settlement aggregation reviewed against the 7C subsidiary ledger.
- Win/loss offer report (price-request offers outcome tracking).
- Per-warehouse negative-stock drill-down and warehouse-turnover report.
- Saved Views + palette keyboard navigation (arrow keys/Enter through results).
- Loadings report variations (weighbridge-delta, incomplete).
