# TCERP — Reporting Architecture Checkpoint (pre-Phase 7C, 2026-10-12)

Ratified reporting architecture. **Source-of-truth rule**: every financial
report reads from accounting entries (`journal_entries` + `journal_lines` +
`journal_line_analytics`) and inventory cost snapshots (`stock_movements`) —
NEVER directly from sales/purchase/loading tables. Operational tables remain
the operational truth; accounting is the financial truth; the event engine
(7B) is the one-way bridge.

## 0. Shared reporting foundation (built first in 7C)

- **Report query service layer** (`src/accounting/reports/`): one service per
  report, each returning `{rows, totals, meta}` with company scoping, date
  ranges in Jalali-aware day keys, and pagination where the rows can be long.
- **Account resolution**: reports accept account code prefixes (e.g. `1*` for
  assets) and resolve through `ChartOfAccount` hierarchy — parent codes roll
  up children.
- **Analytic filters**: every report can filter/group by
  `journal_line_analytics` dimensions (CUSTOMER, SUPPLIER, EMPLOYEE, PROJECT,
  COST_CENTER) and `partyId`.
- **Reversal handling**: REVERSED entries are excluded from net figures by
  default (both the original and its mirror cancel arithmetically, so showing
  both is equivalent — but reports list them with an explicit `reversed` flag
  and exclude the pair from balances to keep the ledger auditable).
- **Closed-period awareness**: reports never mutate; they read across periods
  and show a period column.

## 1. General Ledger (دفتر کل)

- Input: account (or account subtree), date range, optional journalCode,
  partyId/analytic filters.
- Rows: one per `JournalLine` with entry number, date, description, debit,
  credit — ordered by (entryDate, entryNumber, line order).
- Running balance per account: opening balance (sum before `from` date,
  respecting account normal side: ASSET/EXPENSE → debit-positive;
  LIABILITY/EQUITY/REVENUE → credit-positive) + Σdebit − Σcredit per row.
- Ending balance row; grand totals across the selected subtree.
- Drill-down: row → source journal entry (and its `documentType`/`documentId`
  link to the operational origin, e.g. `SALES_COMPLETED_LOADING` → sales doc).

## 2. Trial Balance (تراز آزمایشی)

- Input: date (`as-of`), optional period/fiscal-year, level of account tree
  (leaf / summary).
- Rows: per account — opening debit/credit, period debit, period credit,
  ending debit/credit (normal-side signed, negatives rendered on the
  opposite column as customary).
- Invariant check rendered in the response: `Σ debit == Σ credit` at every
  level (guaranteed by posting rules; the report asserts it and surfaces
  `balanced: true` explicitly so any future manual-data corruption is
  immediately visible).
- Multi-level: leaf accounts + roll-up by parent path (hierarchical CoA).

## 3. Customer/Supplier subsidiary ledger (دفتر معین)

- Built on `JournalLine.partyId` + `journal_line_analytics` (CUSTOMER /
  SUPPLIER dimensions) — the analytical layer from 7A.
- Rows: per party — opening balance, per-document movement lines (invoice
  amount, receipt/payment amount), closing balance, last activity date.
- Sign convention: customers (RECEIVABLE side) debit-positive; suppliers
  (PAYABLE side) credit-positive.
- **Financial responsibility grouping** (REQUIREMENTS §38/§100): the report
  accepts a `responsiblePartyId` and adds a grouped view — the responsible
  party's own balance + Σ member balances (from `FinancialResponsibility`) —
  WITHOUT merging identities: individual rows remain, plus a group total row.
  This is the "Mr Ravan total debt" view.
- Cross-check panel: accounting balance per party vs the operational
  `PartyOperationalBalance` (claims/fulfillment cache) — surfaced as a
  reconciliation delta column, not silently merged.

## 4. Operational profit reports (سود عملیاتی)

- Per docs/05 §2 — computed from:
  - revenue leg: `SALES_COMPLETED_LOADING` journals (REVENUE measure lines),
  - cost leg: the same journals' COGS lines (= Σ movement cost snapshots),
  - optionally split by customer / product variant (variant mapping from the
    event payload stored on `AccountingEvent.payload`).
- Rows per sales document / per customer / per period:
  revenue, COGS, gross profit, margin %.
- Variance panel: price-snapshot revenue vs daily-price revenue at shipping
  date (informational — shows discounts given against list price).
- Explicitly EXCLUDED: tax invoice amounts (Phase 8 posts its own journals;
  they land in different accounts and never feed this report).

## 5. Inventory valuation reports (ارزش‌گذاری موجودی)

- Source: `stock_movements.normalizedQuantity` × `unitCostSnapshot` per
  variant, aggregated per INTERNAL location; company view = Σ internal.
- Rows per variant: quantity on hand (normalized, inventoryUom), unit cost
  (latest IN snapshot — specific identification), inventory value, and
  breakdown by warehouse/location.
- History view: per variant, IN/OUT movements with running quantity and value
  (each OUT valued at ITS OWN cost snapshot — specific identification, never
  re-valued retroactively).
- In-transit/customers: quantities at SUPPLIER/CUSTOMER locations are listed
  separately (consignment-style) and are NOT part of company inventory value.

## 6. Opening balances (افتتاحیه)

- One operational model: `OpeningBalanceEntry` (Phase 7C adds it) — company,
  fiscal year, account code, debit/credit (or party + amount for AR/AP
  analytic rows), variant+qty+unitCost for inventory rows, plus a generated
  balancing `OPENING` journal entry per company (Dr/Cr the OPENING_EQUITY
  account) so the trial balance stays balanced from day one.
- Import path: reuse the CSV/XLSX import engine (Phase 11) with a mapping
  preset; validation = Σ debit == Σ credit across the import batch.
- Seeded for dev: current bank balances, claims, inventory snapshots become
  opening entries via an explicit "generate opening entry" action
  (accounting.fiscal.manage permission), audited.

## Report inventory (Phase 7C endpoints, all GET, permission `accounting.report`)

| Report | Endpoint |
|---|---|
| General Ledger | `GET /api/accounting/reports/general-ledger` |
| Trial Balance | `GET /api/accounting/reports/trial-balance` |
| Customer/Supplier ledger | `GET /api/accounting/reports/subsidiary-ledger` (+ `?responsiblePartyId=` grouped view) |
| Operational profit | `GET /api/accounting/reports/operational-profit` (per document / customer / period) |
| Inventory valuation | `GET /api/accounting/reports/inventory-valuation` (+ per-variant history) |

## Performance

- Ledger queries aggregate in SQL (GROUP BY account/party) — never row-by-row.
- Indexes already present: `journal_lines(account_id)`, `(journal_entry_id)`,
  `journal_entries(company_id, entry_date)`, `stock_movements` composite;
  reporting adds none unless EXPLAIN shows a gap (documented then).
- Large ranges: cursor pagination on ledger drill-down; totals always
  computed in SQL, not in JS.

## Out of scope for 7C (later)

Balance sheet / P&L statement layout, tax reports, Moadian summaries,
consolidated multi-company reporting, budget-vs-actual.
