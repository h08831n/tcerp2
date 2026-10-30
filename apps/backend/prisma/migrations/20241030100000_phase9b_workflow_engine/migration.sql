-- Phase 9B (Gate E): Workflow state machine + generalized approval engine.
-- Forward-only, applied to tcerp_test/CI only.

-- WorkflowDefinition: deactivate without touching running instances
ALTER TABLE "workflow_definitions" ADD COLUMN "is_active" BOOLEAN NOT NULL DEFAULT true;

-- WorkflowState: explicit initial/final flags + time-in-state SLA budget
ALTER TABLE "workflow_states" ADD COLUMN "is_initial" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "is_final" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "sla_hours" INTEGER;

-- WorkflowInstance: optimistic concurrency, condition-evaluation context, starter
ALTER TABLE "workflow_instances" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "context" JSONB,
  ADD COLUMN "created_by" UUID;

-- WorkflowTransition: the machine's edges — condition, permission,
-- approval gate and post-transition actions.
CREATE TABLE "workflow_transitions" (
    "id" UUID NOT NULL,
    "definition_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "from_state_id" UUID NOT NULL,
    "to_state_id" UUID NOT NULL,
    "required_permission" TEXT,
    "condition_json" JSONB,
    "requires_approval" BOOLEAN NOT NULL DEFAULT false,
    "approval_type" TEXT,
    "sla_hours" INTEGER,
    "actions_json" JSONB,
    CONSTRAINT "workflow_transitions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "workflow_transitions_definition_id_code_key" ON "workflow_transitions"("definition_id", "code");
CREATE INDEX "workflow_transitions_from_state_id_idx" ON "workflow_transitions"("from_state_id");
ALTER TABLE "workflow_transitions" ADD CONSTRAINT "workflow_transitions_definition_id_fkey" FOREIGN KEY ("definition_id") REFERENCES "workflow_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workflow_transitions" ADD CONSTRAINT "workflow_transitions_from_state_id_fkey" FOREIGN KEY ("from_state_id") REFERENCES "workflow_states"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "workflow_transitions" ADD CONSTRAINT "workflow_transitions_to_state_id_fkey" FOREIGN KEY ("to_state_id") REFERENCES "workflow_states"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- WorkflowExecutionLog: append-only run history (transitions, approvals, timers)
CREATE TABLE "workflow_execution_logs" (
    "id" UUID NOT NULL,
    "instance_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "transition_id" UUID,
    "from_state_id" UUID,
    "to_state_id" UUID,
    "actor_user_id" UUID,
    "note" TEXT,
    "data" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "workflow_execution_logs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "workflow_execution_logs_instance_id_created_at_idx" ON "workflow_execution_logs"("instance_id", "created_at");
ALTER TABLE "workflow_execution_logs" ADD CONSTRAINT "workflow_execution_logs_instance_id_fkey" FOREIGN KEY ("instance_id") REFERENCES "workflow_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workflow_execution_logs" ADD CONSTRAINT "workflow_execution_logs_transition_id_fkey" FOREIGN KEY ("transition_id") REFERENCES "workflow_transitions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ApprovalRequest: due date + escalation counter, provenance
-- (MANUAL vs WORKFLOW) and the driving workflow instance.
ALTER TABLE "approval_requests" ADD COLUMN "due_at" TIMESTAMPTZ(6),
  ADD COLUMN "escalation_level" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN "workflow_instance_id" UUID;
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_workflow_instance_id_fkey" FOREIGN KEY ("workflow_instance_id") REFERENCES "workflow_instances"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ApprovalEvent: append-only decision history, recorded atomically with
-- every lifecycle mutation of a request.
CREATE TABLE "approval_events" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "actor_user_id" UUID,
    "note" TEXT,
    "data" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "approval_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "approval_events_request_id_created_at_idx" ON "approval_events"("request_id", "created_at");
ALTER TABLE "approval_events" ADD CONSTRAINT "approval_events_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "approval_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- At most ONE pending request per (company, entity, type): the partial unique
-- makes duplicate-request prevention a database guarantee, not a check-then-
-- insert race. Decided/cancelled rows don't participate, so a fresh request
-- after a REJECTED decision stays legal.
CREATE UNIQUE INDEX "approval_requests_one_pending_per_entity"
  ON "approval_requests" ("company_id", "entity_type", "entity_id", "approval_type")
  WHERE "status" = 'PENDING';
