# 11 — Automation Engine (Phase 5 foundation + Phase 9C hardening)

> Status: **LOCALLY VERIFIED** (integration suites green on `tcerp_test`; CI green on push).
> Scope: REQUIREMENTS §27 Automation Engine + §52 rules. The Phase 5 lean subset
> (event hook, daily scans, idempotent runs, audiences) was audited in 9C and extended
> with bounded durable retry, execution delays, dry-run validation and the REAL
> CREATE_ACTIVITY action.

## 1. Foundation already in place (Phase 5 + p5c — audited, unchanged)

| Requirement (§27) | Implementation |
|---|---|
| محرک رویداد | `PRICE_UPDATED` hook from the pricing engine (post-commit, async), `CUSTOMER_INACTIVE_DAYS` / `QUOTATION_PENDING_DAYS` daily scans (06:00 self-rescheduling queue job + manual endpoint), `MANUAL` trigger |
| شرط‌های all و any تو در تو | `notification-conditions.ts` — recursive `all`/`any` groups, `{field, equals|in|gt|lt}`, dot paths |
| تعریف مخاطبان | `SmsAudienceConfig` (`ALL_CUSTOMERS` / `INACTIVE_DAYS` / `PRODUCT_BUYERS`) resolved per run, capped (`SMS_AUDIENCE_CAP = 200`) |
| اقدام | `PUBLISH_PRICE` (auto publish batch), `SEND_SMS` (single + audience fan-out), `CREATE_NOTIFICATION`, `CREATE_ACTIVITY` |
| صف اجرای ناهمگام | `automation.run` / `automation.daily_scan` queue jobs on the durable Postgres `QueueJob` table |
| Idempotency | run `idempotencyKey` UNIQUE (`auto:{rule}:{variant}:{date}`, `daily:{rule}:{date}:{record}`, `manual:…`) — duplicates become SKIPPED rows, never double actions |
| تاریخچه Run | `AutomationRun` rows record `ruleVersion`, payload, conditions result, error |
| غیرفعال‌سازی قانون | `enabled` flag + versioned updates (every run pins the rule version it executed) |
| جلوگیری از حلقه بی‌نهایت | actions NEVER write `DailyPrice` (the only re-triggering event) — publishing/SMS/notifications/activities only; the daily-scan chain is idempotent per date |

## 2. Phase 9C additions

### 2.1 Bounded durable retry
- `automation_runs.attempts` (migration `20241031100000`) counts EVERY execution
  attempt on the run row itself — observable, crash-safe budget.
- On failure: if `attempts < maxAttempts` the run resets to PENDING and a follow-up
  `automation.run` job re-executes it after `retryDelayMinutes`
  (job key `automation-retry:{runId}:{attempt}` — one delivery per attempt).
- Policy lives on the rule: `actionConfig.retry = { maxAttempts, delayMinutes }`
  (defaults 3 attempts / 5 minutes; clamped 1..10 attempts, 1..1440 minutes).
- `automation.run` jobs are enqueued with `maxAttempts: 1` — queue redelivery is a
  no-op (the PENDING check) and retries are owned by the DURABLE run row, so the
  budget survives process restarts and is visible in run history.
- Exhausted budget → terminal `FAILED` (error retained on the row).

### 2.2 Execution delay
- `triggerConfig.delayMinutes` (clamped 0..10080): a matched event creates the run
  row immediately (idempotency unchanged) and enqueues ONE `automation.run` delivery
  with `delayMs` — the run stays PENDING until the queue fires it.
- Honored on all three paths: PRICE_UPDATED events, MANUAL runs, and daily scans
  (per-record and audience runs alike). Scans without delay keep the inline path.

### 2.3 Dry run (read-only validation)
- `POST /automation/rules/:id/dry-run` (`automation.view`): builds the SAME event a
  real run would see, evaluates conditions and computes `wouldDo` per action —
  **no run rows, no batches, no queue jobs, no notifications, no activities**.
- `PUBLISH_PRICE` → the batch that would be created; `SEND_SMS` → audience resolved
  with would-queue/skipped-no-mobile counts + ≤20-member preview (presence flags,
  no mobile numbers); `CREATE_NOTIFICATION` → resolved recipient count + interpolated
  title/body; `CREATE_ACTIVITY` → the activity that would be created.
- Response also carries the effective execution `policy`.

### 2.4 CREATE_ACTIVITY → the real Activity engine
- The action now creates a REAL activity through the Phase 9A engine's SYSTEM
  creation (`createSystemActivity`) — idempotent via `activity:{run.idempotencyKey}`,
  so a retried run never duplicates the follow-up.
- Related entity is derived from the event (`partyId` → party, `documentId` →
  sales_document); events with neither (e.g. price events) are rejected with
  `AUTOMATION_ACTIVITY_NO_RELATED_ENTITY` — use `CREATE_NOTIFICATION` there.
  `actionConfig` = `{ title, description?, typeCode?, days? (dueDate), assignedToOwner? }`.

### 2.5 Fixes
- **P1 (PII in logs)**: a leftover `console.log('DEBUG-SCAN members:…')` in the SMS
  audience action dumped party IDs + mobile numbers to stdout — removed.
- `manualRun` now re-reads the run row after execution — the caller sees the FINAL
  status, not the pre-execution snapshot.

## 3. Tests

- `p9c-automation.spec.ts` (6): retry budget + terminal FAILED + retry jobs,
  successful retry recovery on the same row, delay parks PENDING with a SCHEDULED
  job, dry-run strictly side-effect-free (set-comparison before/after), real
  activity creation + idempotency, immediate path regression.
- `p5-11/12/13`, `p5c-05` green; `p5-13` updated to the new CREATE_ACTIVITY
  contract (real activity with run-level idempotency instead of the tagged
  notification).

## 4. Claim separation

Everything above is verified against `tcerp_test` with the stubbed BullMQ driver
(durable QueueJob rows). Real SMS dispatch, real Telegram publishing and the
scheduler behavior in a deployed multi-instance environment remain runtime-unverified.
