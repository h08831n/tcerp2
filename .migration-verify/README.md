# .migration-verify — kept evidence artifacts

Historical, intentionally retained (thirteenth review #7):

- seed-legacy.sql - representative pre-migration moadian_diagnostic_runs rows
  (all six statuses) used to replay and verify the data-preserving migration
  20241022120000_phase8_attempt_model against tcerp_test.
- verify.sql, verify-output.txt - the 14-field preservation verification
  (every legacy row's identity/result/timestamps must match its migrated
  attempt row 1:1; the recorded output shows 6=6 rows, all checks true).

Everything else (per-review test patch fragments) has been removed: those
tests are integrated in the maintained spec files under apps/backend/src.

To re-run the verification: replay migrations on a fresh tcerp_test with the
attempt migration staged out, run seed-legacy.sql, stage it back in, run
prisma migrate deploy, then execute verify.sql.
