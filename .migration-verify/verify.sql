-- VERIFICATION (fourth review #2): every migrated attempt must carry the
-- exact identity, result, and timestamps of its legacy run row
WITH expected(uid, status, ref, err, errd, conf, taxres, sent, inq, created, updated) AS (
  VALUES
    ('legacy-uid-PREPARED',  'PREPARED',  NULL,      NULL,      NULL,               NULL,      NULL,           NULL::timestamptz,         NULL::timestamptz,         '2026-10-17T08:00:00Z'::timestamptz, '2026-10-17T08:00:05Z'::timestamptz),
    ('legacy-uid-SUBMITTED', 'SUBMITTED', 'ref-sub', NULL,      NULL,               NULL,      NULL,           '2026-10-18T09:00:00Z'::timestamptz, '2026-10-18T09:00:10Z'::timestamptz, '2026-10-18T08:30:00Z'::timestamptz, '2026-10-18T09:00:10Z'::timestamptz),
    ('legacy-uid-PENDING',   'PENDING',   'ref-pend',NULL,      NULL,               NULL,      NULL,           '2026-10-19T09:00:00Z'::timestamptz, '2026-10-19T09:00:20Z'::timestamptz, '2026-10-19T08:30:00Z'::timestamptz, '2026-10-19T09:00:20Z'::timestamptz),
    ('legacy-uid-SUCCESS',   'SUCCESS',   'ref-ok',  NULL,      NULL,               'conf-ok', 'tax-result-ok','2026-10-20T09:00:00Z'::timestamptz, '2026-10-20T09:00:30Z'::timestamptz, '2026-10-20T08:30:00Z'::timestamptz, '2026-10-20T09:00:30Z'::timestamptz),
    ('legacy-uid-REJECTED',  'REJECTED',  'ref-rej', 'CONTENT', 'bad tax id',       NULL,      NULL,           '2026-10-21T09:00:00Z'::timestamptz, '2026-10-21T09:00:40Z'::timestamptz, '2026-10-21T08:30:00Z'::timestamptz, '2026-10-21T09:00:40Z'::timestamptz),
    ('legacy-uid-UNKNOWN',   'UNKNOWN',   'ref-unk', 'TIMEOUT', 'transport timeout',NULL,      NULL,           '2026-10-22T10:00:00Z'::timestamptz, '2026-10-22T10:00:50Z'::timestamptz, '2026-10-22T09:30:00Z'::timestamptz, '2026-10-22T10:00:50Z'::timestamptz)
)
SELECT
  e.uid,
  a.status::text                    = e.status                    AS status_ok,
  a.reference_number  IS NOT DISTINCT FROM e.ref                  AS ref_ok,
  a.error_code        IS NOT DISTINCT FROM e.err                  AS err_ok,
  a.error_detail      IS NOT DISTINCT FROM e.errd                 AS errd_ok,
  a.confirmation_reference_id IS NOT DISTINCT FROM e.conf         AS conf_ok,
  a.tax_result        IS NOT DISTINCT FROM e.taxres               AS taxres_ok,
  a.sent_at           IS NOT DISTINCT FROM e.sent                 AS sent_ok,
  a.inquired_at       IS NOT DISTINCT FROM e.inq                  AS inq_ok,
  a.created_at                      = e.created                   AS created_ok,
  a.updated_at                      = e.updated                   AS updated_ok,
  a.attempt                         = 1                           AS attempt_no_ok,
  a.retry                           = false                       AS retry_ok,
  a.payload_snapshot                = '{}'::jsonb                 AS snapshot_placeholder_ok
FROM expected e
JOIN moadian_diagnostic_attempts a USING (uid)
ORDER BY e.uid;

-- counts must match 1:1
SELECT (SELECT count(*) FROM moadian_diagnostic_runs)    AS legacy_runs,
       (SELECT count(*) FROM moadian_diagnostic_attempts) AS migrated_attempts;

-- obsolete columns must be gone
SELECT column_name FROM information_schema.columns
WHERE table_name = 'moadian_diagnostic_runs'
  AND column_name IN ('uid','reference_number','error_code','error_detail',
                      'confirmation_reference_id','tax_result','sent_at','inquired_at');
