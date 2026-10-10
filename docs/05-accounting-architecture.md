# TCERP — Accounting Architecture Checkpoint (pre-Phase 7, 2026-10-12)

Ratified architecture for Phase 7 (Accounting Core), grounded in the code that
already exists. **No code was changed in this checkpoint.**

## Operational flow under review (implemented state)

```
Purchase ──┬─ GoodsReceipt (INTERNAL)   ──┐
           └─ Direct Loading ────────────┤
Sales ──── Loading ──────────────────────┤
                                          ├──> StockMovement (normalized, locations)
Loading allocations ─> PurchaseLineFulfillment ledger (received | directLoaded | fulfilled)
StockMovement ─> unitCostSnapshot / totalCostSnapshot (immutable)
OperationalSettlementClaim ─> PartyOperationalBalance (debt gate)
```

## 1. Accounting documents are independent from operational documents

- Tax Invoice (Phase 8) is created ONLY by accountant-role users
  (`taxinvoice.*` permissions; salesperson role gets none — REQUIREMENTS §23).
- Tax invoices never write to operational documents: no `operationalLoadedAmount`,
  no fulfillment ledger, no stock movement, no cost snapshot is touched by them.
- Verified today: no `SalesTaxInvoice`/`PurchaseTaxInvoice` tables or services
  exist yet (only `TaxDefinition` rate catalog); nothing can violate this
  boundary before Phase 8 builds it with these rules.

## 2. Profit calculation source (operational only)

Gross operational profit per completed trade is computed from:

- **Fulfillment ledger** (`PurchaseLineFulfillment`): actual received / direct
  loaded quantities per purchase line — the authoritative "what actually moved".
- **Sales loading allocations** (`LoadingAllocation` → confirmed `Loading`):
  actual quantities shipped to the customer.
- **Cost snapshots** (`StockMovement.unitCostSnapshot/totalCostSnapshot`):
  the immutable per-unit cost at the moment of each physical movement
  (specific cost, see §3).
- **Price snapshots** (`SalesLine.unitPrice` / `PurchaseLine.unitPrice` —
  immutable document-time snapshots with `priceSource/priceDate`, p5c-01).

Formula (Phase 7 report): `profit = Σ(sales loaded qty × sale line unitPrice)
− Σ(cost snapshots attributable to those movements) − (direct costs when
implemented)`. **Tax invoices are NOT inputs to this calculation** — they exist
only for the tax authority (REQUIREMENTS §22).

## 3. Inventory valuation method: SPECIFIC COST (selected)

- **Selected: Specific Identification, linked to purchase fulfillment.** Each
  `StockMovement` (IN and OUT) already carries its own `unitCostSnapshot` taken
  from the exact purchase line that fulfilled it (GRN → PO line unitPrice
  converted per inventory-UOM; direct loading → the allocated PO line's cost).
  This matches the steel-trading reality: every lot is physically distinct and
  its purchase price is known — no averaging assumption is ever needed.
- **Future candidates (documented, NOT built):** FIFO (consume oldest IN lots
  per variant/location) and Weighted Average (periodic recost). The movement
  rows + cost snapshots are sufficient to backfill either later; nothing in
  Phase 7 hard-codes against them.
- Cost history is **immutable**: movement rows are never updated (insert-only,
  ON CONFLICT DO NOTHING); reversals create compensating rows with negated
  `totalCostSnapshot` and the original's `unitCostSnapshot` (g6f-03).

## 4. Double-entry design (already scaffolded — Phase 7 implements services)

Already in schema + DB (Correction Gate migration):

- `ChartOfAccount` — hierarchical per company, `UNIQUE(company_id, code)`;
  seeded codes: `BANK`, `RECEIVABLE`, `PAYABLE`, `BANK_FEE_EXPENSE`,
  `SALES_REVENUE`, `PURCHASE_EXPENSE`, `VAT_PAYABLE`, `CHECKS_IN_TRANSIT`.
- `JournalEntry` — `status: DRAFT | POSTED | REVERSED | CANCELLED`,
  `UNIQUE(company_id, entry_number)` (Sequence engine, `JE-1405-…`),
  `reversedByEntryId` linkage, optimistic `version`.
- `JournalLine` — DB CHECK: `debit >= 0 AND credit >= 0 AND NOT (both > 0)`
  (one-sided lines only); party reference for subsidiary ledgers.
- **Posting rules** (`JournalService.post`, already implemented): lines XOR
  debit/credit; `SUM(debit) == SUM(credit)` enforced inside the POST
  transaction (`JOURNAL_UNBALANCED`); DRAFT → POSTED atomic; posted entries are
  NEVER edited or deleted — correction = `reverse()` which creates a mirrored
  REVERSED entry and links `reversedByEntryId`; bank documents post inside the
  same transaction that writes their statement lines.
- Phase 7 adds: receivable/payable subsidiary posting from operational
  settlements (claims MATCHED), inventory value postings sourced from cost
  snapshots, fiscal-year open/close guards.

## 5. Treasury integration boundary (confirmed in code)

- Invoice creation (operational OR tax) **never** touches bank balances or
  statement lines. Verified: the only `BankStatementLine` writers are
  `receipt-payment.service.ts`, `bank-transfer.service.ts`,
  `checks.service.ts` — all treasury documents.
- Treasury effects come exclusively from: **Receipt** (Dr BANK / Cr
  RECEIVABLE + DEPOSIT line), **Payment** (Dr PAYABLE / Cr BANK + WITHDRAWAL),
  **BankTransfer** (Dr destination X, Dr BANK_FEE_EXPENSE F, Cr source X+F; two
  statement lines), **Check clearing** (incoming CLEARED / outgoing PAID only).
- `BankStatementLine` remains the non-source ordering ledger with deterministic
  `(date, sequence_no)` + running balance (UNIQUE company+account+date+seq).
- Settlement claims (UNMATCHED) move the *operational* balance only; the bank
  effect happens when the accountant MATCHES a claim to a Receipt/Payment.

## 6. Tax/Moadian integration boundary (confirmed by design)

- Operational Sales/Purchase documents are the trading truth; Tax Invoices are
  parallel accounting artifacts referencing them M:N via explicit allocation
  tables (`SalesTaxInvoiceOrderAllocation` / `PurchaseTaxInvoiceOrderAllocation`
  — already in schema since the Correction Gate).
- Multiple tax invoices per operational document stay supported (M:N with
  allocated_amount/quantity; totals reconciliation is WARNING-level,
  REQUIREMENTS §24/§25).
- Moadian submission history is append-only per attempt; tax-product catalog is
  separate from operational products.

## 7. Audit / security of financial records

- Every financial mutation is audited **atomically** with the business write
  (`AuditService.recordTx` — audit failure rolls the mutation back; corr-05/g6
  patterns).
- Posted journal entries immutable; corrections only via REVERSED mirror
  entries; movement cost history append-only; fulfillment ledger rows carry
  `reversedAt` instead of deletion.
- Permission boundaries: accountant/financial-manager roles own tax invoices,
  reconciliation and posting; salespersons hold no financial read permissions
  (enforced server-side since Phase 2).

## Phase 7 implementation checklist (next step, pending approval)

1. Accounting services on existing models: fiscal years/periods, journal CRUD +
   posting rules (JournalService exists — extend with fiscal-period guards),
   trial balance, general/subsidiary ledger reports.
2. Claims MATCHED → Receivable/Payable subsidiary postings.
3. Inventory valuation report from cost snapshots (specific cost).
4. Operational profit report per §2 formula.
5. Opening balances import path.
6. Tests: unbalanced entry rejected, double-posting rejected, posted
   immutability, reversal mirror, fiscal-year close guard, profit formula on
   mixed kg/ton smoke.
