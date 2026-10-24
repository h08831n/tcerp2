-- representative pre-migration diagnostic history (OLD run model shape):
-- one row per status, distinct run_day per (company, day) constraint
INSERT INTO companies (id, name_fa, status, created_at, updated_at)
VALUES ('11111111-1111-4111-8111-111111111111', 'migration-verify', 'ACTIVE', now(), now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO moadian_diagnostic_runs
  (id, company_id, run_day, uid, fiscal_id, status, reference_number,
   error_code, error_detail, confirmation_reference_id, tax_result,
   sent_at, inquired_at, created_at, updated_at)
VALUES
  ('a0000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', '2026-10-17',
   'legacy-uid-PREPARED', 'F-LEGACY', 'PREPARED', NULL, NULL, NULL, NULL, NULL,
   NULL, NULL, '2026-10-17T08:00:00Z', '2026-10-17T08:00:05Z'),
  ('a0000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', '2026-10-18',
   'legacy-uid-SUBMITTED', 'F-LEGACY', 'SUBMITTED', 'ref-sub', NULL, NULL, NULL, NULL,
   '2026-10-18T09:00:00Z', '2026-10-18T09:00:10Z', '2026-10-18T08:30:00Z', '2026-10-18T09:00:10Z'),
  ('a0000000-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111', '2026-10-19',
   'legacy-uid-PENDING', 'F-LEGACY', 'PENDING', 'ref-pend', NULL, NULL, NULL, NULL,
   '2026-10-19T09:00:00Z', '2026-10-19T09:00:20Z', '2026-10-19T08:30:00Z', '2026-10-19T09:00:20Z'),
  ('a0000000-0000-4000-8000-000000000004', '11111111-1111-4111-8111-111111111111', '2026-10-20',
   'legacy-uid-SUCCESS', 'F-LEGACY', 'SUCCESS', 'ref-ok', NULL, NULL, 'conf-ok', 'tax-result-ok',
   '2026-10-20T09:00:00Z', '2026-10-20T09:00:30Z', '2026-10-20T08:30:00Z', '2026-10-20T09:00:30Z'),
  ('a0000000-0000-4000-8000-000000000005', '11111111-1111-4111-8111-111111111111', '2026-10-21',
   'legacy-uid-REJECTED', 'F-LEGACY', 'REJECTED', 'ref-rej', 'CONTENT', 'bad tax id', NULL, NULL,
   '2026-10-21T09:00:00Z', '2026-10-21T09:00:40Z', '2026-10-21T08:30:00Z', '2026-10-21T09:00:40Z'),
  ('a0000000-0000-4000-8000-000000000006', '11111111-1111-4111-8111-111111111111', '2026-10-22',
   'legacy-uid-UNKNOWN', 'F-LEGACY', 'UNKNOWN', 'ref-unk', 'TIMEOUT', 'transport timeout', NULL, NULL,
   '2026-10-22T10:00:00Z', '2026-10-22T10:00:50Z', '2026-10-22T09:30:00Z', '2026-10-22T10:00:50Z');
