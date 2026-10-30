# 12 — Notification Center & SMS (Phase 9D)

> Status: **LOCALLY VERIFIED** (integration suites green on `tcerp_test`; CI green on push).
> Scope: REQUIREMENTS §27 Notification Engine + SMS — the last sub-phase of Phase 9 (Gate E).
> Foundation (Phase 2/5/mini-gates): Notification + NotificationRule models, IN_APP
> dispatch with conditions/delays/priorities, recipient resolution, rules CRUD — audited
> and preserved.

## 1. What Phase 9D added

### 1.1 The SMS channel on notification rules actually works
`dispatchRulesForEvent` previously ignored the rule's `channels` JSON and always created
IN_APP rows only. Now:
- `IN_APP` → the existing recipient-driven path (delay via `notification.dispatch` job).
- `SMS` → `SmsService.dispatchForRule`: resolves target PARTIES (`payload.partyId` +
  `smsConfig.partyIds`), takes each party's best MOBILE phone, renders the rule's
  `smsConfig` (`templateCode` or literal `text`, both interpolated with the payload +
  `smsConfig.vars`), and enqueues ONE deduped message per mobile. The rule's
  `delayConfig.delayMinutes` rides on the `sms.send` delivery.
- Dedup: `notification-sms:{ruleId}:{partyId}:{eventKey}` (eventKey from the payload,
  falling back to its `date`) — a redelivered/replayed event reconciles to the SAME
  `SmsMessage` row (DB unique), never a second SMS.
- `smsConfig` is persisted through the rules CRUD (create + update, audited).

### 1.2 Durable send log (`SmsMessage`) — the report IS the log
- Migration `20241101100000_phase9d_notification_sms`: `sms_templates`, `sms_messages`
  (status QUEUED/SENT/FAILED, source AUTOMATION/NOTIFICATION_RULE/MANUAL, templateCode,
  partyId, error, providerResponse, queuedJobId, `idempotency_key` UNIQUE,
  requestedById) and `notification_rules.sms_config`.
- `SmsService.enqueueSend`: canonicalizes the mobile (`normalizeIranMobile` — Persian
  digits, +98/0098/98 prefixes), validates the text, persists the QUEUED row
  (**P2002 → the existing row is returned as the authority; no second job**), then
  enqueues ONE `sms.send` delivery (`sms-job:{messageId}`, maxAttempts 3, optional
  delayMs).
- `SmsSendHandler` write-back: with `{smsMessageId}` payloads it delivers through the
  company's active SMS IntegrationConfig + channel adapter and flips the row to
  **SENT** (sentAt) or **FAILED** (error + providerResponse) — queue retries re-drive
  the SAME row. A missing config fails (`NO_ADAPTER_CONFIG`) and lands the row on
  FAILED so it surfaces in the report. The legacy inline payload (pre-9D) still sends
  but logs nothing.

### 1.3 SMS templates + manual send/resend (کنترل دسترسی)
- `sms_templates` CRUD (`notifications.view` read / `notifications.edit` write, audited):
  company-scoped, unique code, `{var}` placeholders, activate/deactivate (render rejects
  inactive templates with 404; literal `text` remains the fallback).
- `POST /notifications/sms/send` (`notifications.edit`): manual send with **opt-in
  dedup** — a client retry passes `idempotencyKey` and reconciles to ONE row; a fresh
  send without one is a NEW message (repeating a legitimate announcement works).
- `POST /notifications/sms/:id/resend` (`notifications.edit`): FAILED rows only — a
  FRESH row (the original log is history, never rewritten) with a deterministic
  `sms-resend:{id}:{n}` key; concurrent resends reconcile to one new message.
- `GET /notifications/sms`: the send report with status/source filters + paging.

### 1.4 Inbox read-state + company-resolved list
- `POST /notifications/:id/read` (ownership enforced by the conditional update — a
  foreign id matches zero rows) and `POST /notifications/read-all`.
- `GET /notifications` now resolves the CALLER's company server-side when no explicit
  `companyId` query is present (x-company-id header / default membership), so the
  frontend inbox shows the working company without needing company state client-side;
  `includePlatform=true` adds platform-wide rows.

### 1.5 Automation SMS → the logged path
The `SEND_SMS` action (single + audience fan-out) now enqueues through `SmsService`
(source `AUTOMATION`, `sourceId` = run id, `partyId` recorded) with the SAME
idempotency keys as before — every automation SMS leaves a durable, reportable row.

## 2. Frontend `/notifications` (new page, nav «اعلان‌ها»)
Three tabs: **اعلان‌ها** (inbox with unread filter, mark-read, mark-all-read), **پیامک‌ها**
(send log with status filter + failure reasons, manual send modal — free text or template
with JSON vars — resend, template cards with activate/deactivate/delete + create),
**قواعد اعلان** (rules list, enable/disable, delete). Dense RTL Persian, paged tables.

## 3. Tests
- `p9d-notifications-sms.spec.ts` (6): dual-channel dispatch (IN_APP + logged SMS with
  rendered template), eventKey dedup (one row across replays), handler SENT/FAILED
  write-back + resend semantics (fresh row, SENT-reject), manual canonicalization +
  opt-in dedup, template lifecycle + inactive rejection, automation logged path.
- `p5c-05` updated to the 9D contract (durable SmsMessage rows + `sms-job:{id}` jobs
  replace raw `sms.send` job assertions); `p5-13` gained the suite timeout.
- Full automation suites 22/22 green.

## 4. Claim separation
Verified against `tcerp_test` with the mock SMS adapter + stubbed BullMQ (durable
QueueJob rows). REAL provider dispatch (Kavenegar/SMS.ir …), provider DLR callbacks and
the deployed scheduler remain runtime-unverified — the adapter surface is the existing
`PublishingAdapter` SMS channel; a real provider is one IntegrationConfig + adapter away.
