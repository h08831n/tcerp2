# 10 — Workflow Engine & Approval Engine (Phase 9B, Gate E)

> Status: **LOCALLY VERIFIED** (integration 827/827 + unit 455-pass on `tcerp_test`; CI green on push).
> Scope: REQUIREMENTS §27 (Workflow / Approval subset of Phase 9) — the state machine,
> approval-gated transitions, SLA timers/escalation, and the generalized approval engine.
> Phase 9C (Automation extensions) and 9D (Notification Center + SMS) remain planned.

## 1. What exists (and where)

| Component | File |
|---|---|
| Workflow service (engine) | `apps/backend/src/workflow/workflow.service.ts` |
| Structured condition evaluator (pure) | `apps/backend/src/workflow/workflow-conditions.ts` |
| Workflow controller (definitions + instances) | `apps/backend/src/workflow/workflow.controller.ts` |
| Approval engine (generalized) | `apps/backend/src/approvals/approvals.service.ts` |
| Decision bridge (approvals → workflow) | `apps/backend/src/approvals/approval-decision.bus.ts` |
| Durable timers + action registry | `apps/backend/src/workflow-timer/workflow-timer.service.ts` (pre-existing) |
| Frontend `/workflow` | `apps/frontend/src/app/(app)/workflow/page.tsx` |
| Frontend `/approvals` | `apps/frontend/src/app/(app)/approvals/page.tsx` |
| Tests | `p9b-workflow-engine.spec.ts` (14), `p9b-approval-engine.spec.ts` (6), `workflow-conditions.spec.ts` (7) |

Schema (migration `20241030100000_phase9b_workflow_engine`, forward-only, `tcerp_test`/CI only):
`workflow_transitions`, `workflow_execution_logs`, `approval_events` (new tables);
`is_active` on definitions; `is_initial`/`is_final`/`sla_hours` on states;
`version`/`context`/`created_by` on instances; `due_at`/`escalation_level`/`source`/
`workflow_instance_id` on `approval_requests`; a **partial unique index**
`approval_requests_one_pending_per_entity` — at most ONE PENDING request per
(company, entity, type), enforced by the database even under concurrent creation.
Migration `20241030102000_phase9b_allocation_fk_alignment` backfills the two
allocation→invoice FK constraints the schema always declared (Phase 8 tables were created
without them); the p8 spec cleanups were reordered accordingly.

## 2. Workflow state machine

**Definitions** (`workflow.admin`): company-scoped, `code` unique per company. Created with
nested states + transitions in ONE transaction. Structural invariants (service AND DB):
exactly one initial state, ≥1 final state, transition endpoints must be defined states,
no self-loops, valid condition trees, unique codes. The structure is immutable after
creation — `PATCH` changes only `name`/`entityType`/`isActive`. Entities that can drive an
instance: `loading`, `goods_receipt`, `sales_document`, `purchase_document` (registry in
`WORKFLOW_ENTITY_MODELS`, validated against the company).

**Instances** (`workflow.start` to operate, `workflow.view` to read):
- Start is idempotent by DB unique `(definitionId, entityType, entityId)` — a concurrent
  double-start reconciles through P2002 → `409 WORKFLOW_INSTANCE_EXISTS`. A `STARTED` log
  row and an audited `WORKFLOW_INSTANCE_STARTED` entry commit atomically.
- An initial-state `slaHours` schedules a durable REMINDER timer (row inside the
  transaction, BullMQ `workflow.timer` job after commit).

**Transitions** (from the current state only — otherwise `404 WORKFLOW_TRANSITION_NOT_AVAILABLE`):
1. Per-transition `requiredPermission` is checked server-side against the caller's
   effective permission set (`403 WORKFLOW_TRANSITION_PERMISSION_REQUIRED`).
2. Structured condition evaluated against the instance `context` — nested `all`/`any`
   trees, ops `eq ne gt gte lt lte in notIn contains`, dot paths, numeric-only ordering
   (a missing/non-numeric operand NEVER satisfies an ordering).
3. **Approval gate** (`requiresApproval`): the instance PARKS — a PENDING
   `ApprovalRequest` (`source=WORKFLOW`, `entityType=workflow_instance`) is created
   atomically with an `APPROVAL_REQUESTED` log; with `slaHours` an ESCALATION timer is
   scheduled. A second attempt while parked → `409 WORKFLOW_APPROVAL_PENDING`.
4. **Plain transition**: the state flip is an optimistic-concurrency
   `updateMany WHERE id = … AND version = … AND status='ACTIVE'` — of two simultaneous
   transitions exactly one wins, the loser gets `409 WORKFLOW_CONCURRENT_MODIFICATION`.
   Final states complete the instance in the same atomic flip. Every flip writes a
   `TRANSITION` execution-log row + audit entry in the same transaction; a failing audit
   rolls the whole flip back (p9b-13).
5. Post-transition `notify` actions run AFTER commit (best effort, never un-apply).

**Execution history**: `workflow_execution_logs` is append-only —
`STARTED | TRANSITION | APPROVAL_REQUESTED | APPROVAL_DECIDED | TIMER_FIRED | CANCELLED | FAILED`.

**Cancel** (`workflow.start` route; starter or `workflow.admin`): flips to CANCELLED and
cancels SCHEDULED timers + PENDING workflow approvals + their `CANCELLED` events — all in
one transaction, with best-effort BullMQ job cleanup after.

## 3. Decision → resume bridge

`ApprovalDecisionBus` is a one-way in-process bridge: `ApprovalsModule` emits AFTER the
deciding transaction commits; `WorkflowModule` subscribes at init. Contract:

- **APPROVED** → the parked transition applies (system actor, logged); the instance
  completes if the target state is final. The resume re-reads the live row and skips
  cleanly if the instance moved on (logged `APPROVAL_DECIDED` with the reason).
- **REJECTED** → the instance stays ACTIVE at the same state; the transition may be
  re-requested (fresh approval — the partial unique allows it since the old one is no
  longer PENDING).
- **Idempotent**: a decision that already applied is a no-op (TRANSITION log check +
  version guard).
- **Failure recovery**: a failed resume writes a `FAILED` log and enqueues a durable
  `workflow.resume` queue job (maxAttempts 3); the queue handler re-runs the same
  idempotent path. A resume failure NEVER un-decides the approval.

## 4. Escalation (SLA)

Timer action `approval_escalate` (registered by the engine into the pre-existing
`WorkflowActionRegistry`): fires only while the approval is still PENDING —
bumps `escalation_level` (guarded on status), writes an `ESCALATED` approval event +
`TIMER_FIRED` log, and notifies the configured roles (default `admin`) in-app.
`state_sla` reminds on state budgets. Timer processing goes through the real
`processDue` path (durable rows + `workflow.timer` queue), proven by w9b-12.

## 5. Generalized approval engine

- **Create** (`POST /approvals`, `approvals.request` or `approvals.decide`): any
  registered entity (`loading`, `goods_receipt` — `workflow_instance` is engine-internal
  and rejected from the public API), optional reason + dueAt, role notifications
  (default `sales_manager`). Duplicate prevention = the partial unique index
  (sequential AND concurrent duplicates → `409 APPROVAL_PENDING_EXISTS`).
- **Decide** (`approvals.decide`): the flip is an atomic conditional `updateMany` on
  `status=PENDING` — two concurrent deciders reconcile (one wins, one `409`). The Phase 6
  loading debt-gate effect (APPROVED `RELEASE_DRIVER_INFO` clears
  `driver_info_restricted` + party timeline event) is preserved and regression-tested.
- **Cancel**: requester or decide-holder; PENDING only; audited + evented.
- **List/detail scope** (mirrors the activities engine): `approvals.decide` or
  `approvals.view_all` → company-wide; `approvals.request` → OWN (requestedBy or
  approverId), stranger rows 404.
- **History**: every lifecycle mutation writes an `approval_events` row
  (`REQUESTED | DECIDED | CANCELLED | ESCALATED`) atomically in the same transaction.

## 6. Permissions seeded

`workflow.view` / `workflow.start` / `workflow.admin` (module `workflow`);
`approvals.request` / `approvals.view_all` (module `approvals`).
Role wiring: admin = all; sales_manager = view/start + request/view_all (+ existing
decide); salesperson, purchase_manager, accountant = `approvals.request`.

## 7. Frontend

- `/workflow`: definitions table + structured create dialog (states/transitions with
  condition JSON), instances table with paging, instance detail modal (available
  transitions with execute, cancel, linked approvals with escalation level, execution
  log timeline), start-instance dialog (definition/entity/UUID/context JSON).
- `/approvals`: status filter, decision modal with note, cancel, history modal
  (event timeline), create-request modal, WORKFLOW-source badge, due date +
  escalation display, workflow_instance links to `/workflow`.

## 8. Claim separation

- **Verified by local tests** (`tcerp_test`): all engine behaviors above (invariants,
  idempotency, concurrency, permission checks, atomicity/rollback, isolation,
  escalation via `processDue`, resume idempotency, partial-unique duplicate rejection).
- **NOT yet verified**: multi-user UI behavior against a live backend, BullMQ driver in
  a deployed environment (tests use the DB-polling driver), and any real company data.
  No production database was touched; migrations are applied to `tcerp_test`/CI only.
