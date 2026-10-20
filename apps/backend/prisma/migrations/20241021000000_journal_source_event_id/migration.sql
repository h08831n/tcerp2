-- Durable idempotency key for event-driven postings: links a journal entry to
-- the single accounting event that created it. Postgres UNIQUE allows any
-- number of NULLs, so manual/opening/reversal journals are unaffected — only
-- the same accounting event can never produce two linked journals.
ALTER TABLE "journal_entries" ADD COLUMN "source_event_id" UUID;
CREATE UNIQUE INDEX "journal_entries_source_event_id_key" ON "journal_entries"("source_event_id");
