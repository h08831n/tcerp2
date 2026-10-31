# 13 — Management Reports & Dashboard (Phase 10, Gate F)

> Status: **LOCALLY VERIFIED** (integration 8/8 g10 suites on `tcerp_test`; CI green on push).
> Scope: REQUIREMENTS §31/§33/§10 — the first Phase-10 slice: dashboard KPIs,
> performance reports, operational watchlists and the global-search command palette.
> **Slice 2 delivered** (بخش §6): debt report, win/loss offers (explicit outcome),
> per-warehouse negative stock, warehouse turnover, saved views, palette keyboard nav.
> Still deferred: loadings report variations (weighbridge-delta, incomplete).

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


## 6. Gate F slice 2 (second delivery)

### 6.1 گزارش بدهی — `GET /reports/debt?role=CUSTOMER|SUPPLIER` (`accounting.report`)
EXPOSES ACCOUNTING BALANCES — gated by the 7C ledger's permission, NOT reports.view.
Per party: **accounting balance** (debit − credit signed per role, POSTED/REVERSED
journals — the 7C subsidiary formula), the **cached operational balance**
(PartyOperationalBalance), their **reconciliation delta**, the party's **UNMATCHED
settlement claims** (declared-but-unreconciled, direction-matched) and **unsettled
checks** (REGISTERED/PENDING/DEPOSITED/BOUNCED with count/total/nearest due).
KEY JOIN DECISION: the party list is a **LEFT join** over journal lines (the 7C
subsidiary ledger INNER-joins) — a party holding an operational balance but no
journal history is exactly a reconciliation gap and must appear with accounting = 0
(g10-09 pins this). Only parties with at least one signal (balance ≠ 0, claim, or
check) are listed; groupTotal covers the whole filtered set.

### 6.2 برد/باخت پیشنهادها
`SupplierOffer.outcome` (WON/LOST + decidedAt/By, migration
`20241101110000_phase10_offer_outcome`) — the handover forbids inferring outcomes, so
the report aggregates EXPLICIT decisions only; suppliers without any decided offer are
absent from the report. Decision surface: `POST /price-requests/offers/:offerId/outcome`
(`price_request.manage_offers`, audited with the old value, re-decidable as a
correction). Report `GET /reports/offers-outcome` (reports.view): per-supplier
won/lost/winRate/avgOfferedPrice + the 50 most recent decided offers.

### 6.3 انبار به تفکیک انبار
- `GET /reports/negative-stock/by-warehouse` (reports.view): per-warehouse negative
  balances — movements attribute to the warehouse of the INTERNAL side (destination
  for IN, source for OUT); internal→internal transfers net within the warehouse.
- `GET /reports/warehouse-turnover?from&to` (reports.view): period IN/OUT per
  (warehouse, variant) + full-history ending balance; boundaries are local-calendar
  (from = local midnight, to = local end-of-day).

### 6.4 Frontend
- New **`/reports` page** (nav «گزارش‌ها» now live): debt tab (role toggle, search,
  saved views), offers tab (per-supplier summary cards + recent decisions with
  inline WON/LOST), stock tab (per-warehouse negative + turnover with date window).
- **Saved Views**: per-tab named filter sets in localStorage (≤10 per scope,
  best-effort — storage failure never blocks the page).
- **Palette keyboard navigation**: flat navigable result list (arrow keys move,
  Enter opens, hover syncs the selection, role=listbox).

### 6.5 Tests (g10-09..12)
Debt JOIN semantics on an isolated company (no journals → accounting 0, operational
5m, delta −5m, one UNMATCHED claim with its document CHECK constraint, one PENDING
check), offers outcome aggregation (winner 100% / loser 0% / undecided absent),
per-warehouse attribution on an independent variant (−25 on MAIN), turnover
relationships (in/out ≥ the spec's movements, ending = in − out) + invalid-period
rejection.
