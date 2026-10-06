# TCERP Backend

NestJS 10 + Prisma 5 + PostgreSQL backend for the TCERP steel-trading ERP
(modular monolith, port **3001**, global prefix **/api**).

Foundation: auth (JWT access + rotating refresh in HttpOnly cookies, failed-login
lockout), users/roles/permissions (effective = roles − REVOKE + GRANT
overrides), audit trail, S3/MinIO files with content-addressed dedupe, health
check. Multi-company (Architecture Correction Gate): companies, company context
per request, company-scoped settings/teams/sequences/integrations/notification
rules, sequences v2 (Jalali reset cycles), hybrid BullMQ queue, treasury
(bank accounts / transfers / receipts / payments / checks / statement ledger),
operational settlement claims, tax definitions + invoice↔order allocations,
supplier product mappings, loadings, workflow timers, notification rules.
Phase 3: parties/CRM core + product catalog. Phase 4: CRM funnel
(leads/opportunities/lost reasons/payment terms), sales documents
(quotation = sales order — ONE id, ONE number), purchase documents,
M:N line allocations, price requests + supplier offers (daily-lowest
intelligence), document-flow relations.

## Setup

```bash
npm install
cp .env.example .env               # adjust DATABASE_URL / JWT secrets / SEED_*
npx prisma generate
npx prisma migrate deploy          # needs a running Postgres
npm run db:seed                    # permissions, roles, admin, COA, sequences
npm run start:dev
```

### Credentials (no defaults)

- `SEED_ADMIN_USERNAME` (default `admin`) and `SEED_ADMIN_PASSWORD` configure
  the seeded admin. There is **no default password**. In development, if
  `SEED_ADMIN_PASSWORD` is unset the seed generates a random one and prints it
  **once**. In production an unset password aborts the seed.
- **Startup guard**: with `NODE_ENV=production` the backend refuses to boot
  when `SEED_ADMIN_PASSWORD` (or legacy `ADMIN_PASSWORD`) equals a well-known
  default (`Admin@12345`, `admin`, `password`, `123456`).
- `mustChangePassword=true` is set on the seeded admin; re-seeding never
  resets an existing admin's password.

### Queue driver (`QUEUE_DRIVER`)

`auto` (default) uses BullMQ/Redis for runtime execution and falls back to
DB polling (one-time warning) when Redis is unreachable; `bullmq` is
Redis-only; `db` is polling-only. PostgreSQL (`queue_jobs` + `job_executions`)
always stays the durable source of truth for history, status, retries and
idempotency; BullMQ jobs use `jobId = queue_jobs.id` and a custom backoff
(60s ×4^n capped at 6h, same curve as the DB fallback).

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run build` | Compile (nest build) |
| `npm run start:dev` | Dev server with watch |
| `npm test` | Jest unit tests (no DB/Redis required — Prisma/BullMQ mocked) |
| `TEST_INTEGRATION=1 npm test` | Also run integration tests against the live DB |
| `npm run prisma:generate` | Generate the Prisma client |
| `npm run prisma:migrate` | `prisma migrate deploy` |
| `npm run db:seed` | Idempotent seed (ts-node prisma/seed.ts) |

## Layout

```
prisma/            schema.prisma, migrations/, seed.ts
src/
  common/          errors, exception filter, guards, decorators, DTOs, utils (jalali, phone)
  config/          zod-validated env (CONFIG token, global) + production password guard
  prisma/          PrismaService (global)
  permissions/     effective-permission resolution (global)
  audit/           audit trail (company-scoped) + GET /api/audit
  companies/       Company CRUD + CompanyContextService (x-company-id resolution)  [global]
  queue/           hybrid queue: QueueService, BullMQ producer/worker, DB-polling fallback  [global]
  auth/            login/refresh/logout/me (me returns companies[]), lockout
  users/ roles/ teams/ settings/ sequences/ files/ health/
  accounting/      JournalService (balanced posting, reversal)
  treasury/        bank accounts, transfers, receipts, payments, checks, statement ledger
  claims/          operational settlement claims + party operational balance
  tax/             tax definitions (immutable after first use) + M:N allocations
  supplierproduct/ supplier ↔ product 3-level mapping (exactly-one CHECK)
  products/         Phase 3B catalog: categories, brands, UOM engine +
                    conversions, dynamic attributes, templates/variants,
                    supplier mappings
  loading/         loading header + lines + allocations
  workflow-timer/  durable timers executed by the queue (action registry)
  notifications/   notification rules (condition engine) + dispatch service
  integrations/    integration adapter configs (SMS/…)
  crm/             Phase 4 CRM funnel: leads, opportunities, lost reasons, payment terms
  sales/           Phase 4 sales documents (quotation=order), lines + matrix,
                   confirmation lock/override, OWN/TEAM/ALL scope
  purchase/        Phase 4 purchase documents (independent) + create-purchase-from-sale
  allocations/     Phase 4 sales ↔ purchase line-level M:N allocations (row-locked)
  price-request/   Phase 4 price requests, supplier offers, worklist,
                   daily-lowest intelligence, create sale/purchase from request
  document-flow/   Phase 4 DocumentRelation service + related-documents endpoint
```

Company context: scoped controllers resolve the active company via
`CompanyContextService.requireCompanyId(user, headers)` — the `x-company-id`
header when the user is a member (else 403), else the default membership.
`GET /api/auth/me` returns `companies[]` (`id`, `nameFa`, `isDefault`).

Conventions: typed `AppError` subclasses → `{ statusCode, code, message, details, path, timestamp }`
error envelope; `@RequirePermissions(...)` enforced server-side by
`PermissionsGuard`; every write audited via `AuditService.record` (with
company scope); optimistic locking (`version`) where history matters; sequence
counters and posted journal entries are never rewritten.

## API endpoints

All routes require a valid access token (Bearer header or `access_token`
cookie) except `POST /api/auth/*` and `GET /api/health`. Company-scoped
routes accept `x-company-id`.

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/api/auth/me` (now incl. `companies[]`, `defaultCompanyId`) | authenticated |
| GET | `/api/companies` | `companies.view` |
| POST | `/api/companies` (grants creator membership + default) | `companies.create` |
| GET/PATCH/DELETE | `/api/companies/:id` | `companies.view` / `edit` / `delete` |
| GET | `/api/settings` (`?category=`) — company scoped | `settings.view` |
| PUT | `/api/settings` `{key, value, category?}` (upsert, audited old/new) | `settings.edit` |
| GET | `/api/sequences` — company scoped | `sequences.view` |
| POST | `/api/sequences` (create config) | `sequences.edit` |
| POST | `/api/sequences/allocate` `{documentType}` | `sequences.edit` |
| PUT | `/api/sequences/:id` (prospective config only; counters never rewritten) | `sequences.edit` |
| GET | `/api/queue/jobs` (`?status=&jobType=`; incl. `executionsCount`) | `queue.view` |
| POST | `/api/queue/jobs` (companyId from context; null = platform job) | `queue.enqueue` |
| POST | `/api/queue/jobs/:id/retry` / `:id/cancel` | `queue.retry` |
| GET | `/api/treasury/bank-accounts` | `treasury.view` |
| POST | `/api/treasury/bank-accounts` | `treasury.create` |
| GET/PATCH/DELETE | `/api/treasury/bank-accounts/:id` | `treasury.view` / `edit` / `delete` |
| GET | `/api/treasury/bank-accounts/:id/statement?from&to` (ordered, running balance) | `treasury.view` |
| POST | `/api/treasury/transfers` `{sourceBankAccountId, destinationBankAccountId, amount, fee?}` | `treasury.create` |
| POST | `/api/treasury/receipts` `{bankAccountId, partyId?, amount, date?}` | `treasury.create` |
| POST | `/api/treasury/payments` | `treasury.create` |
| GET | `/api/treasury/checks?status&direction` | `treasury.view` |
| POST | `/api/treasury/checks/incoming` / `outgoing` (no bank effect) | `treasury.create` |
| POST | `/api/treasury/checks/:id/pending` / `:id/deposit` / `:id/bounce` / `:id/cancel` | `treasury.edit` |
| POST | `/api/treasury/checks/:id/clear` `{bankAccountId}` (incoming; bank effect) | `treasury.edit` |
| POST | `/api/treasury/checks/:id/pay` `{bankAccountId}` (outgoing; bank effect) | `treasury.edit` |
| GET | `/api/claims?status&partyId` | `claims.view` |
| POST | `/api/claims` `{direction, partyId, salesDocumentId?, purchaseDocumentId?, amount}` | `claims.create` |
| POST | `/api/claims/:id/reject` `{reason}` (restores balance, audits, notifies) | `claims.edit` |
| POST | `/api/claims/:id/match` `{receiptId?|paymentId?}` | `claims.edit` |
| GET/POST/PATCH | `/api/tax/definitions`, `PATCH /api/tax/definitions/:id` | `tax.view` / `create` / `edit` |
| POST | `/api/tax/definitions/:id/mark-used` (one-way) | `tax.edit` |
| GET/POST | `/api/tax/allocations/sales`, `/api/tax/allocations/purchase` | `tax.view` / `edit` |
| GET/POST/PATCH | `/api/supplier-products` | `supplierproduct.view` / `create` / `edit` |
| GET/POST | `/api/loadings`, `GET /api/loadings/:id` (lines + allocations) | `loading.view` / `create` |
| GET/POST | `/api/workflow-timers`, `POST /api/workflow-timers/:id/cancel` | `workflowtimer.view` / `edit` |
| GET/POST/PATCH/DELETE | `/api/notifications/rules` | `notifications.view` / `edit` |
| GET/POST/PATCH/DELETE | `/api/integrations` | `integrations.view` / `create` / `edit` / `delete` |

### Parties / CRM core (Phase 3A)

All party routes are record-scope filtered (backend-enforced): users with
`parties.scope.all` see every party in the company (`sales_manager` via
`parties.scope.team` sees their teams'), everyone else only parties they own
(`ownerUserId`). Out-of-scope reads/writes → 403. Party PATCH/owner/archive
are optimistic-locked on `version` (`VERSION_CONFLICT` on mismatch).

| Method | Path | Permission |
| --- | --- | --- |
| POST | `/api/parties/check-duplicate` `{mobile?, nameFa?, excludePartyId?}` → `{exact?, similar[]}` (pg_trgm ≥ 0.85, warning only) | `parties.view` |
| POST | `/api/parties` `{type, nameFa, …, phones?, roles?, ownerUserId?}` → 201 `{party, warnings?}` (duplicate normalized MOBILE → 409 `DUPLICATE_PHONE`) | `parties.create` |
| GET | `/api/parties` `?page&pageSize&search&type&role&ownerUserId&archived&scoreLevel&sortBy&sortDir` | `parties.view` |
| GET | `/api/parties/:id` (roles, phones, contacts+phones, addresses, owner, score) | `parties.view` |
| PATCH | `/api/parties/:id` (version-checked; `ownerUserId` change needs `parties.owner.change` + `OWNER_CHANGED` audit/timeline) | `parties.edit` |
| DELETE | `/api/parties/:id` (soft archive) / POST `/api/parties/:id/restore` | `parties.archive` |
| POST/DELETE | `/api/parties/:id/roles` `{role}` · `/api/parties/:id/roles/:role` | `parties.role.manage` |
| POST/DELETE | `/api/parties/:id/phones` `{kind, value, isPrimary?}` · `/api/parties/:id/phones/:phoneId` | `parties.phone.manage` |
| POST/PATCH/DELETE | `/api/parties/:id/contacts` (+`phones[]`) · `/:id/contacts/:contactId` | `parties.contact.manage` |
| POST/PATCH/DELETE | `/api/parties/:id/addresses` · `/:id/addresses/:addressId` | `parties.address.manage` |
| POST | `/api/parties/:id/owner` `{userId}` | `parties.owner.change` |
| GET | `/api/parties/:id/timeline` `?limit&includeHidden` (hidden rows only for scope-ALL / `audit.view` holders) | `timeline.view` |
| POST/DELETE/GET | `/api/parties/:id/financial-responsibility` `{responsiblePartyId}` (member uniqueness; GET returns group + consolidated balance from `party_operational_balances`) | `financialresponsibility.manage` |
| POST | `/api/parties/:id/score/recompute` (rules from Setting `crm.score_rules`; writes `CustomerScoreHistory` + caches `Party.score/scoreLevel`) | `parties.score.compute` |
| GET | `/api/parties/:id/score` → `{score, level, metrics, history[]}` | `parties.view` |

### Product catalog (Phase 3B)

Route prefixes: categories and brands are top-level (`/api/categories`,
`/api/brands`); UOMs are `/api/uoms/*`; everything else lives under the
`/api/products` prefix (`attributes`, `attribute-values`, `templates`,
`uom/convert`, `supplier-mappings`). All rows are company-scoped and audited
in the mutation transaction (`AuditService.recordTx`). List endpoints are
paginated with `?page&pageSize&search&active` (`active` ∈
`true`/`false`/`any`, default `true` — archived rows are hidden).

| Method + path | Notes | Permission |
|---|---|---|
| POST/GET/GET :id/PATCH/DELETE | `/api/categories` — hierarchical (arbitrary depth `parentId`), unique `code` per company, bilingual `nameFa`/`nameEn`; PATCH moving a category under itself/descendant → 422 `CATEGORY_CYCLE`; DELETE hard-blocks with children/templates (archive via PATCH `active:false`) | `products.create` / `products.view` / `products.edit` / `products.archive` |
| POST/GET/GET :id/PATCH | `/api/brands` — unique `code`, `logoAttachmentId` optional FK (validated same-company via the files module) | `products.create` / `products.view` / `products.edit` |
| POST/GET/PATCH | `/api/uoms/categories` — UOM dimension categories | `products.uom.manage` / `products.view` |
| POST/GET/PATCH | `/api/uoms` — units per category; `symbol` unique per company; AT MOST ONE `isBaseUnit` per category (service ConflictError `UOM_BASE_UNIT_EXISTS` + DB partial unique `uoms_base_unit_uniq`; a category may transiently have NO base, which blocks conversion with `UOM_NO_BASE_UNIT` until one exists); base units must keep `conversionRatio = 1` (422 `UOM_BASE_RATIO_ONE`); any ratio ≤ 0 is rejected by the DB CHECK `uoms_conversion_ratio_positive_chk` (mapped to 422 `UOM_RATIO_POSITIVE`) | `products.uom.manage` / `products.view` |
| POST | `/api/products/uom/convert` `{value, fromUomId, toUomId}` → `{value, fromSymbol, toSymbol, categoryId}` — Decimal arithmetic; cross-category → 422 `UOM_CATEGORY_MISMATCH` (product-weight path: `UomConversionService.convertWithProductWeight` for `weightPerUnit`-carrying variants, used by later phases) | `products.view` |
| POST/GET/PATCH | `/api/products/attributes` + `/api/products/attribute-values` — fully dynamic attributes (code unique per company / per attribute, optional Decimal `numericValue`); values belong to their attribute | `products.attributes.manage` / `products.view` |
| POST/GET/PATCH/DELETE | `/api/products/templates` — Odoo-style template; FKs (category/brand/UOMs/tax definition) validated same-company, category must be active; GET list is a lightweight projection + grouped `variantsCount` (≤ 3 queries/page, trgm-accelerated `search` over `name_fa`/`name_en`/`internal_code`); GET `:id` full detail (ordered attributes+values, variants+values, UOM summaries); PATCH is optimistic (`version` mismatch → 409 `VERSION_CONFLICT`); DELETE = soft archive (`active:false`) | `products.create` / `products.view` / `products.edit` / `products.archive` |
| POST/PATCH/DELETE | `/api/products/templates/:id/attributes(/:attributeId)` — `{attributeId, displayOrder?, createsVariants?, isRequired?}`; unique per template; `createsVariants` attributes define the variant space | `products.variants.manage` |
| POST/PATCH/DELETE | `/api/products/templates/:id/attributes/:attributeId/values(/:valueId)` — selected values per template attribute (3B correction pass): POST `{valueIds}` replaces the set / `{valueId}` adds one; PATCH `displayOrder`/`active`; DELETE removes one; value's `attribute_id` must match the template attribute (422 `ATTRIBUTE_VALUE_MISMATCH`) | `products.variants.manage` |
| POST | `/api/products/templates/:id/variants/preview` — restricted to the template's `createsVariants` attributes; full cartesian product with `skuSuggestion` (`internalCode-valueCode…`) and `existsAlready` markers (deterministic) | `products.variants.manage` |
| POST | `/api/products/templates/:id/variants/generate` — user-selected subset only; ONE transaction; existing identical combinations are SKIPPED with a report (`{created[], skipped[]}` — skip-with-report, never duplicated); SKU collisions auto-suffix `-2`, `-3` then 409 `VARIANT_SKU_COLLISION`; SKU unique per company; existing variants are never mutated/deleted | `products.variants.manage` |
| GET | `/api/products/templates/:id/matrix` — `{columns, rows, cells}` for the Phase 4 variant matrix (columns = first createsVariants attribute, rows = the rest, cells = existing variants with their combination map) | `products.view` |
| POST/GET/PATCH | `/api/products/supplier-mappings` — three-level mapping (VARIANT/TEMPLATE/CATEGORY, exactly one target — service + DB CHECK `supplier_products_exactly_one_level_chk`); supplier must be a same-company Party holding the SUPPLIER role (else 422 `NOT_A_SUPPLIER`); FK targets must belong to the same company | `products.supplier_mapping.manage` / `products.view` |

**Product files**: attach through the central files module
(`POST /api/files/attachments` etc.) with `entityType` `product_template` /
`product_variant` and `category` one of
`catalog` / `technical_specification` / `certificate` / `image` / `other`.
No new tables — attachments are already company-isolated by the files module.

Pre-existing groups (users, roles + `GET /api/permissions` catalog, teams,
files, audit — now with optional `?companyId=`) are unchanged; see git history
for their full tables.

### Sales · Purchase · Price requests · Document flow (Phase 4)

All rows are company-scoped and audited atomically (`AuditService.recordTx`
inside the mutation transaction). Document totals are **server-authoritative**
(exact `Prisma.Decimal` math, `common/utils/money`). Quotation and sales order
share ONE `SalesDocument` — the id and `documentNumber` (e.g. `SD-1405-00001`)
are allocated once at creation and never regenerated. After
`CUSTOMER_CONFIRMED` the line fields (variant/quantity/uom/price/discount) are
locked; users holding `sales.override_confirmed_order` may still edit them but
MUST pass a `reason` (422 `OVERRIDE_REASON_REQUIRED` otherwise), which lands in
an `OVERRIDE_CONFIRMED_ORDER` audit row (old/new values + reason, same tx) plus
a party timeline event. Without the permission: 403 `ORDER_LOCKED`.

Sales record scope (OWN/TEAM/ALL) mirrors the party precedent, keyed on the
document's salesperson: `sales.scope.all` (or `sales.view_all`) → ALL,
`sales.scope.team` → TEAM, neither → OWN. Out-of-scope reads/writes → 403;
cross-company rows are 404. The list endpoint is a lightweight projection
served with exactly 3 queries per page (findMany + count + one grouped
line count — no N+1).

| Method | Path | Notes | Permission |
| --- | --- | --- | --- |
| POST/GET/PATCH | `/api/leads` (+ GET/DELETE `:id`) — status chain NEW→CONTACTED→QUALIFIED/LOST enforced | party FK same-company; assigned salesperson must be an active company member | `crm.view` / `crm.manage` |
| POST/GET/PATCH | `/api/opportunities` (+ GET `:id`) — OPEN→QUALIFIED→QUOTED→WON/LOST | customer MUST hold the CUSTOMER role (422 `NOT_A_CUSTOMER`); `lostReasonId` REQUIRED when LOST (422 `LOST_REASON_REQUIRED`) | `crm.view` / `crm.manage` |
| POST/GET/PATCH | `/api/lost-reasons` (+ GET `:id`) — configurable, reportable | unique `code` per company; 6 Persian defaults seeded | `crm.view` / `crm.manage` |
| POST/GET/PATCH | `/api/payment-terms` (+ GET `:id`) | unique `code` per company; 4 Persian defaults seeded (`CASH`, `PRE_LOADING`, `7DAYS`, `30DAYS`) | `crm.view` read / `paymentterm.manage` write |
| POST | `/api/sales` `{customerPartyId, lines?[], status? DRAFT\|QUOTATION, …}` → full detail; default expiration from Setting `sales.quotation_expiration_days` (14) | `priceRequestId` reference only — never required (§16) | `sales.create` |
| GET | `/api/sales` `?page&pageSize&search&status&customerPartyId&salespersonUserId&expired&dateFrom&dateTo` | `expired=true` = expirationDate < now AND status ∈ (QUOTATION, SENT) | `sales.view` |
| GET | `/api/sales/export` | same projection | `sales.export` |
| GET | `/api/sales/:id` | lines with variant (sku/nameFa/template), uom symbol, printable description, tax snapshot | `sales.view` |
| PATCH | `/api/sales/:id` (optimistic; 409 `VERSION_CONFLICT`) | header fields (expiration/paymentTerm/notes/shippingAddress) stay editable on confirmed orders | `sales.edit` |
| POST | `/api/sales/:id/send` · `/:id/confirm` · `/:id/activate` · `/:id/lost` · `/:id/cancel` | send DRAFT/QUOTATION→SENT; confirm →CUSTOMER_CONFIRMED; activate →SALES_ORDER (same id+number); lost requires the reason per Setting `sales.lost_reason_required` (default true) | `sales.edit` / `sales.confirm` / `sales.edit` / `sales.cancel` |
| POST | `/api/sales/:id/lines` · PATCH/DELETE `:id/lines/:lineId` | server-side totals; locked fields need override (above) | `sales.edit` |
| POST | `/api/sales/:id/lines/matrix` `{cells:[{productVariantId, quantity, …}]}` | ONE line per NON-EMPTY cell (quantity absent/≤0 skipped); `printableDescription` defaults to «template nameFa + attribute values ' / '» | `sales.edit` |
| POST | `/api/sales/:id/create-purchase` `{supplierPartyId, …}` | copies lines 1:1 (unitPrice 0 for the buyer), status ORDER_PLACED, CREATED_FROM relations both ways | `purchase.create` |
| POST/GET/GET :id/PATCH/POST lines/PATCH/DELETE | `/api/purchase` — mirror of sales (no matrix); transitions `/:id/place`, `/:id/complete`, `/:id/cancel` | supplier must hold SUPPLIER role (422 `NOT_A_SUPPLIER`); buyer must be an active company member (`BUYER_NOT_COMPANY_MEMBER`); company-wide visibility (no record scope) | `purchase.view` / `create` / `edit` / `cancel` |
| POST | `/api/purchase/:id/create-sale` `{customerPartyId, …}` | copies lines into a QUOTATION (unitPrice 0), CREATED_FROM relations both ways | `sales.create` |
| POST/GET/PATCH/DELETE | `/api/allocations` `{salesLineId, purchaseLineId, allocatedQuantity}` | same company + same variant on BOTH lines (422 `ALLOCATION_VARIANT_MISMATCH`); over-allocation → 409 `ALLOCATION_EXCEEDS_QUANTITY`; SERIALIZABLE tx + `FOR UPDATE` on both lines (consistent id order) → concurrent over-allocation: exactly one wins | `allocations.manage` |
| POST | `/api/price-requests` `{customerPartyId?, lines[]}` → `PRQ-1405-00001` | customer optional (must hold CUSTOMER role when given) | `price_request.create` |
| GET | `/api/price-requests` `?status&customerPartyId&requesterUserId&search` | paginated | `price_request.view` |
| GET | `/api/price-requests/worklist?date=` → `{today, previousDays}` | previous-day OPEN requests appear as the SAME records under `previousDays` (never copied/deleted); date-only params are local-midnight windows | `price_request.view` |
| POST/PATCH/DELETE | `/api/price-requests/:id/lines(+:id/lines/:lineId)` | request lines; editable while OPEN/OFFERED | `price_request.create` |
| POST | `/api/price-requests/:id/convert` · `/:id/close` | OPEN|OFFERED → CONVERTED / CLOSED (the create-sale/purchase flows CONVERT automatically) | `price_request.create` |
| POST | `/api/price-requests/:id/create-sale` `{customerPartyId?, lineSelections?}` | QUOTATION with `priceRequestId` + GENERATED_FROM relations both ways → CONVERTED | `sales.create` |
| POST | `/api/price-requests/:id/create-purchase` `{supplierPartyId, lineSelections? {offerId}}` | ORDER_PLACED copy; a selected offer's price becomes the unit price | `purchase.create` |
| POST/GET/PATCH/DELETE | `/api/price-requests/lines/:lineId/offers` | several offers per line; first offer moves the request OPEN→OFFERED; supplier must hold SUPPLIER role (422 `NOT_A_SUPPLIER`); update/delete own offer only (403 `NOT_OFFER_OWNER`), blocked after conversion (409 `PRICE_REQUEST_CONVERTED`) | `price_request.manage_offers` / `price_request.view` read |
| GET | `/api/price-requests/daily-lowest?date&variantId` | MIN(offeredPrice) per (day, variant, uom) — ALL co-lowest offers on ties; comparison within the same uom group (cross-uom normalization lands with Phase 5) | `price_request.view` |
| GET | `/api/price-requests/suppliers/lowest-report?days=60` | per (supplier, product, uom) count of daily-lowest wins — "supplier X was daily lowest K times in N days" | `price_request.view` |
| GET | `/api/documents/:type/:id/relations` | grouped counts + labelled items, both directions, reciprocal pairs deduped; types: `sales_document`, `purchase_document`, `price_request`, `lead`, `opportunity` | authenticated (company-scoped) |

Phase 4 party timeline events (written in the same tx): `QUOTATION_CREATED`,
`QUOTATION_SENT`, `SALE_CONFIRMED`, `SALE_LOST`, `ORDER_OVERRIDDEN`,
`PURCHASE_CREATED`, `PRICE_REQUEST_CREATED`.

**Schema mismatch (reported, not worked around silently)**: REQUIREMENTS §9
lists `notes` among the quotation header fields, but the frozen Phase 4 schema
has no `sales_documents.notes` / `purchase_documents.notes` column. The DTOs
accept `notes` for forward-compatibility but it is not persisted; adding the
column is recommended for the next schema change.

### Parties — corrective pass notes (corr-01…corr-06)

- **Search (`?search=`)** ORs every identifier: `nameFa` (ilike over the
  `parties_name_fa_trgm_idx` GIN trigram index), `nameEn`, `internalCode`,
  `economicCode`, `registrationNumber` (all ilike contains — code-ish fields),
  `nationalId` / `nationalCode` (exact equals — unique identity numbers), and
  phones: a search input that normalizes as an Iranian mobile is matched
  exactly against `party_phones.normalized_value` AND
  `contact_phones.normalized_value` (via the party's contacts); any other
  digit-ish input (≥ 4 digits) is matched as a substring of the normalized
  values.
- **List projection** returns exactly the grid fields: `id, type, nameFa,
  nameEn, internalCode, primaryPhone {kind, normalizedValue} | null, roles[]
  (codes), owner {id, name} | null (firstName+lastName, else username), score,
  scoreLevel, archived (bool), version, createdAt, updatedAt` — relations are
  resolved in the SAME `findMany` (≤ 2 queries per page, no N+1).
- **Owner assignment** (create / PATCH `ownerUserId` / POST `:id/owner`)
  requires the target user to be an ACTIVE member of the party's company
  (`user_companies` ⋈ `users.status='ACTIVE'`); otherwise 422
  `OWNER_NOT_COMPANY_MEMBER`.
- **TEAM scope is company-scoped**: `teamUserIds(userId, companyId)` only lets
  teams of THAT company contribute members (membership or team-manager).
- **Audit atomicity**: business mutation + TimelineEvent + AuditLog run in ONE
  transaction. `AuditService.recordTx(tx, entry)` writes with the caller's
  transaction client and propagates failures so the mutation rolls back when
  the audit write fails (the legacy `record()` keeps its swallow-and-log
  behavior for non-transactional callers).
- **Queue idempotency** is DB-enforced with no race-prone pre-check:
  `enqueue` inserts first; on P2002 company jobs re-fetch by
  `(companyId, idempotencyKey)` and platform jobs by the partial unique index
  `queue_jobs_platform_idempotency_uniq` (idempotency_key WHERE company_id IS
  NULL), so platform-level dedupe no longer has a concurrency gap. The same
  migration's `user_permission_overrides_platform_uniq` enforces a single
  platform-wide (user, permission) override.

### Product catalog — 3B correction pass notes (c3b-01…c3b-14)

- **Selected values per template attribute** (`ProductTemplateAttributeValue`,
  migration `20241008000000_p3b_corrections`): each template attribute can
  curate its own value set —
  `POST /api/products/templates/:templateId/attributes/:attributeId/values`
  takes either `{valueIds: [...]}` (REPLACE the whole set; `[]` clears it,
  array order becomes display order) or `{valueId}` (add one, idempotent);
  `PATCH .../values/:valueId` toggles `displayOrder`/`active`; `DELETE
  .../values/:valueId` removes one. A candidate value must belong to the
  template attribute's attribute (`attribute_id` equality) or it is rejected
  with 422 `ATTRIBUTE_VALUE_MISMATCH`; foreign-company values are invisible
  (404). All mutations are audited inside the transaction.
- **Transitional value-universe rule**: preview / generate / matrix build
  combinations ONLY from the template attribute's SELECTED active values.
  While a template attribute has NO selected values yet, it falls back to the
  attribute's GLOBAL active values (`TemplatesService.effectiveUniverse` —
  documented in code and here). Once the first value is selected, the global
  fallback disappears for that attribute.
- **Combination key**: `buildCombinationKey(pairs)` (pure, in
  `templates.service.ts`) canonically serializes a combination as
  `attributeId=attributeValueId` segments sorted by attributeId then
  attributeValueId, joined with `|` — identical to the DB backfill format.
  Every generated variant persists it in `product_variants.combination_key`
  and the DB unique `(template_id, combination_key)` is the ONLY duplicate
  authority: a concurrent generate that races past the in-transaction
  pre-check aborts with P2002, mapped to 409
  `VARIANT_COMBINATION_EXISTS` (or `VARIANT_SKU_COLLISION` when only the SKU
  collided). Sequential duplicates keep the skip-with-report behavior
  (`skipped[].reason = 'VARIANT_COMBINATION_EXISTS'`).
- **Explicit weight UOM**: whenever a variant carries `weightPerUnit`
  (create/generate/PATCH — the PATCH checks the MERGED state),
  `weightUomId` is REQUIRED (422 `WEIGHT_UOM_REQUIRED`), must belong to the
  caller's company AND sit in the company's `WEIGHT` UOM category, resolved
  canonically by category `code === 'WEIGHT'` (422 `WEIGHT_CATEGORY_REQUIRED`
  / `UOM_NOT_IN_COMPANY`). `UomConversionService.convertWithProductWeight`
  computes `quantity × weightPerUnit` (in the weight UOM) then the standard
  Weight-category conversion to the target — e.g. 100 pieces × 18.7 kg/piece
  = 1870 kg → 1.87 ton. Without a complete `weightPerUnit`+`weightUomId`
  pair the strict same-category rule stays in force.
- **UOM base semantics**: a category has AT MOST ONE base unit — never
  "exactly one". Conversion inside a category with no ACTIVE base is blocked
  (422 `UOM_NO_BASE_UNIT`) until a base exists; base creation/promotion
  enforces ratio exactly 1 (422 `UOM_BASE_RATIO_ONE`); promoting a second
  base is a 409 `UOM_BASE_UNIT_EXISTS` (DB partial unique backstop); ratio
  ≤ 0 is rejected by the DB CHECK and mapped to 422 `UOM_RATIO_POSITIVE`.
  Demoting the base is allowed (the category then transiently has none).
- **Cross-company FK integrity**: one shared guard
  (`assertSameCompany(companyId, entity)` in
  `src/common/utils/entity-company.ts`) is used consistently for
  Category.parent, Brand (+ logo attachment company), Template
  category/brand/salesUom/purchaseUom/taxDefinition, TemplateAttribute
  attribute (+ its selected values, via the attribute), Variant
  template/defaultUom/weightUom, SupplierMapping supplierParty/targets, and
  the UOM conversion endpoints. A missing or foreign target is 422 — rows of
  other companies are never addressable.
- **File access isolation**: `GET /api/files/:id` (metadata), blob download
  and `GET /api/files/attachments` only resolve through attachments of the
  caller's company; when the attachment's `entityType` is a company-scoped
  entity (party / product_template / product_variant / product_category /
  brand / supplier_product / uom / uom_category / attribute /
  tax_definition) the target must EXIST in the attachment's company —
  missing target 404, foreign target 403. The blob itself is globally
  deduped by sha256, but is unreachable without a company-valid attachment,
  so metadata/filenames never cross companies.

## Seeded data (idempotent, `npm run db:seed`)

- Company `00000000-0000-4000-8000-000000000001` (`SEED_COMPANY_NAME`,
  default «شرکت پیش‌فرض»).
- Reference UOM categories with base units (3B correction pass, upserted on
  `(companyId, code)` / `(companyId, symbol)` — re-seeding never duplicates
  or mutates them): `WEIGHT` (وزن) — `kg` base (ratio 1), `g`, `ton`;
  `LENGTH` (طول) — `m` base, `cm`; `UNIT` (شمارش) — `pcs` base, `dozen`. The
  `WEIGHT` category code is the canonical contract for the variant
  `weightUomId` validation.
- 99-permission catalog: `users.*`, `roles.*`, `teams.*`, `settings.*`,
  `sequences.*`, `audit.view`, `files.*`, `queue.*`, `companies.*`,
  `claims.*`, `treasury.*`, `tax.*`, `supplierproduct.*`, `loading.*`,
  `workflowtimer.*`, `notifications.*`, `integrations.*`, `parties.*`
  (incl. `parties.scope.all` / `parties.scope.team` record scopes),
  `financialresponsibility.manage`, `timeline.view`,
  `products.*` (view / create / edit / archive / attributes.manage /
  variants.manage / uom.manage / supplier_mapping.manage; `salesperson` and
  `buyer` get `products.view`), plus Phase 4: `sales.*` (view / create / edit /
  confirm / cancel / override_confirmed_order / view_all / export +
  `sales.scope.team` / `sales.scope.all`), `purchase.*` (view / create / edit /
  cancel), `price_request.*` (view / create / manage_offers),
  `allocations.manage`, `crm.view` / `crm.manage`, `paymentterm.manage`.
- System roles: `admin` (all), `salesperson` (OWN sales scope),
  `sales_manager` (`sales.scope.team`), `buyer`, `purchase_manager`,
  `accountant`, `financial_manager`, `pricing_user`.
- Chart of accounts: `BANK`, `RECEIVABLE`, `CHECKS_IN_TRANSIT`, `PAYABLE`,
  `VAT_PAYABLE`, `SALES_REVENUE`, `BANK_FEE_EXPENSE`, `PURCHASE_EXPENSE`.
- Sequences per company (JALALI_YEAR reset, padding 5): `SALES_DOCUMENT(SD)`,
  `PURCHASE(PO)`, `PRICE_REQUEST(PRQ)`, `SALES_TAX_INVOICE(STI)`,
  `PURCHASE_TAX_INVOICE(PTI)`, `RECEIPT(REC)`, `PAYMENT(PAY)`,
  `JOURNAL_ENTRY(JE)`, `CHECK(CHK)`, `BANK_TRANSFER(BT)` → e.g. `SD-1405-00001`.
- Lost reasons (Phase 4, per company): `PRICE_HIGH` قیمت بالا, `COMPETITOR`
  خرید از رقیب, `NO_NEED` عدم نیاز, `DELAY` تاخیر, `PAYMENT_TERMS` عدم توافق
  شرایط پرداخت, `OTHER` سایر.
- Payment terms (Phase 4, per company): `CASH` نقدی, `PRE_LOADING` تسویه قبل
  از بارگیری, `7DAYS` تسویه ۷ روزه, `30DAYS` تسویه ۳۰ روزه.
- One inactive sample `IntegrationConfig` (SMS).

## Tests

`npm test` — 484 tests across 103 suites (the live-DB integration tests
auto-skip without `TEST_INTEGRATION=1`; with it, all 484 run against Postgres
and clean up after themselves). Coverage includes the 15
architecture-gate scenarios (greppable as `01 company-scoped-sequence-uniqueness` …
`15 outgoing-check-paid-bank-effect`), the Phase 3A party/CRM acceptance
tests (`p3a-01` duplicate normalized phone … `p3a-12` score rules from
settings), the Phase 3B product-catalog acceptance tests (`p3b-01` category
hierarchy … `p3b-20` restart persistence), the Phase 3B correction-pass
tests (`c3b-01` trgm index restored … `c3b-14` file metadata company
isolation) plus the Phase 4 acceptance tests (`p4-01` quotation→order same
id/number … `p4-34` grid without N+1 — numbering, role requirements, exact
Decimal totals, matrix cells, confirmation lock/override/audit atomicity,
version conflicts, M:N allocations incl. the concurrent over-allocation race,
price-request worklist/lowest-supplier intelligence, company isolation,
restart persistence) and Jalali conversion, phone
normalization, login lockout, permissions, sequence v2 format/reset/allocate,
queue backoff/priority/idempotency. Integration tests clean up after
themselves; unit tests need neither Postgres nor Redis.

Known schema-vs-code note: the frozen schema has no `usedAt` column on
`tax_definitions`; first-use immutability is tracked in a company-scoped
Setting (`tax.definition.used`). Adding the real column is recommended for the
next schema change.
