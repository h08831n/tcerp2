# 14 — Import/Export Engine (Phase 11, Gate G — slice 1)

> Status: **LOCALLY VERIFIED** (CSV unit 5/5 + g11 integration 8/8 on `tcerp_test`; CI green on push).
> Scope: handover §31 — the durable import engine + parties CSV export + DAILY_PRICE
> import (slice 2) + a 1500-row load smoke. **Deferred**: XLSX reader (needs a library
> decision), product/document entities, backup/restore drill (held for the FINAL review
> stage per the owner's explicit instruction), full load test, monitoring wiring.

## 1. Engine shape (handover §31 requirements → implementation)

| Requirement | Implementation |
|---|---|
| دانلود نمونه فایل | `GET /imports/sample?entityType=PARTY` — canonical headers + example rows, UTF-8 BOM |
| Mapping ستون‌ها | `columnMapping {field: csvHeader}` (client auto-maps by header; nameFa mandatory; unknown field / missing header rejected) |
| اعتبارسنجی پیش از Import | EVERY row validated at create time (name required, party type enum, phone canonicalized via `normalizeIranMobile`, nationalId/economicCode digit shapes) — bad rows are FAILED **before any business write** |
| نمایش خطاهای هر ردیف | `GET /imports/:id/rows` — the durable `ImportJobRow` list IS the report (per-row status + error code) |
| جلوگیری از ایجاد تکراری | natural-key dedupe by **normalized phone** (the CRM's duplicate authority) — checked inside the row transaction, so even a same-file collision becomes DUPLICATE (g11-02) |
| سیاست UPDATE_MATCHED | `updateMatched` option: matched-by-phone parties get updated (name/type/nationalId/economicCode); without it the row is DUPLICATE (g11-05) |
| اجرای دسته‌ای (۱۰۰۰ رکورد) | `batchSize` (1..5000, default 500) read chunks |
| سیاست Commit صریح | `commitMode`: **PER_ROW** (default — one short tx per row; a bad row never hurts neighbours) or **BATCH** (chunk all-or-nothing, documented tradeoff — g11-06 proves rollback) — the file NEVER lives inside one giant transaction |
| Resume در صورت شکست | counters persist on the job after EVERY batch; `run()` processes only PENDING rows — a crashed run resumes exactly where it stopped (g11-04 simulates the torn state) |
| Idempotency | re-running a COMPLETED/PARTIALLY_FAILED job is legal and processes nothing new (g11-03); CANCELLED/FAILED jobs refuse to run |
| گزارش موفق/ناموفق/تکراری | `okCount / updatedCount / duplicateCount / failedCount` on the job row, incremented per batch |
| Audit | IMPORT_CREATED at create, IMPORT_COMPLETED (counts) at run end, per-batch business writes visible via the rows table |

## 2. Endpoints

- `POST /imports` (`imports.run`) — create + validate (CSV in the JSON body, ≤20k rows)
- `GET /imports` (`imports.view`), `GET /imports/:id`, `GET /imports/:id/rows?problems`
- `POST /imports/:id/run`, `POST /imports/:id/cancel` (`imports.run`)
- `GET /imports/sample?entityType=PARTY` (`imports.view`)
- `GET /exports/parties.csv` (`imports.export`) — company-wide CSV dump, UTF-8 BOM

## 3. Permissions (seeded)
`imports.view` (admin, sales_manager, purchase_manager, accountant), `imports.run`
(admin, sales_manager, purchase_manager), `imports.export` (admin, sales_manager,
purchase_manager). The export is a **deliberate OWN-scope bypass** (company-wide data
dump) — hence its own manager-only permission rather than `parties.view` (g11-08 pins
that salesperson holds none of them).

## 4. Frontend `/imports` (nav «ورود اطلاعات»)
Upload (client-side file read) → auto-mapping by header → validation summary → run
with live counters → per-row drill-down modal (payload + status + error). Sample-CSV
download, job list with paging, cancel.

## 5. Tests
- `csv.spec.ts` (unit, 5): RFC-4180 parsing (quoted commas/doubled quotes/embedded
  CRLF preserved verbatim), minimal-quoting serialization round-trip, BOM headers.
- `g11-import-engine.spec.ts` (integration, 8): pre-run validation, PER_ROW
  neighbour-sparing, idempotent re-run, crash-resume, updateMatched on/off, BATCH
  rollback, company-scoped export isolation, sample + seed contract.

## 6. Claim separation
Verified against `tcerp_test` with direct service calls (controller decorators are the
same guard pattern as every module). XLSX, additional entities, background-queue
execution for huge files, backup/restore and load tests are NOT done yet.


## 7. Slice 2 — DAILY_PRICE import + load smoke

- `entityType=DAILY_PRICE` (migration `20241101130000` adds the enum value): columns
  `variantSku` (required), `date` (YYYY-MM-DD **calendar-validated** — shape regex alone
  accepted 2026-13-99, caught by g11-09), `price` (>0), `uomSymbol` (optional → the
  variant's default uom).
- Pre-run validation bulk-prefetches the company's variant SKUs + uom symbols, so
  unknown references fail BEFORE any write (`VARIANT_NOT_FOUND` / `UOM_NOT_FOUND`);
  run re-resolves fresh and a vanished reference is a row failure.
- Upsert on the daily price's NATURAL unique `(company, variant, date, uom)` —
  `updateMatched` re-imports corrected prices on the same key (g11-09 covers create,
  duplicate, and update on one lifecycle). Created rows carry `source=IMPORTED`.
- **Load smoke (g11-10)**: 1500-row party import (PER_ROW, batchSize 500) completes
  100% OK in ~26s (~58 rows/s) on the dev Docker Postgres — a scale-sanity bound, not
  a benchmark; real sizing happens on production hardware.
