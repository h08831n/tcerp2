-- Phase 9C: durable automation retry — each execution attempt of a run is
-- counted on the run row itself so a failed action can be retried with a
-- bounded attempt budget (default 3) and an inter-attempt delay, observable
-- in the run history (attempts + error survive on the row).
ALTER TABLE "automation_runs" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
