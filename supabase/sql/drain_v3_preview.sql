-- drain v3 PREVIEW — READ-ONLY. One SELECT. For every stamped memberStates
-- entry on a teacher band copy in teacher_actuals, the admin band card it
-- would merge into, the admin entry it would touch, and what v3 would do.
-- "drains_tonight" = the band day is on or before today (Melbourne).
-- (The v2 previews in drain_v2_preview.sql still apply unchanged.)

-- (P6) Teacher attendance stamps → v3 outcome.
WITH copies AS (
  SELECT ta.id AS actuals_id, ta.week_key, ta.school_id, ta.teacher_id, t, wa.missed AS wa_missed,
         (ta.week_key::date + (array_position(ARRAY['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'], t->>'day') - 1))
           <= (now() AT TIME ZONE 'Australia/Melbourne')::date AS drains_tonight,
         (SELECT a FROM jsonb_array_elements(COALESCE(wa.lessons, '[]'::jsonb)) a
          WHERE COALESCE(a->>'isBandSession', 'false') = 'true'
            AND CASE WHEN NULLIF(t->>'originBandLessonId', '') IS NOT NULL
                     THEN a->>'id' = t->>'originBandLessonId'
                     ELSE a->>'bandId' = t->>'bandId' AND a->>'day' = t->>'day'
                          AND (SELECT count(*) FROM jsonb_array_elements(wa.lessons) a2
                               WHERE COALESCE(a2->>'isBandSession', 'false') = 'true'
                                 AND a2->>'bandId' = t->>'bandId' AND a2->>'day' = t->>'day') = 1 END
          LIMIT 1) AS admin_card
  FROM teacher_actuals ta
  CROSS JOIN LATERAL jsonb_array_elements(ta.lessons) t
  LEFT JOIN weekly_adjustments wa ON wa.week_key = ta.week_key AND wa.school_id = ta.school_id
  WHERE COALESCE(t->>'isBandSession', 'false') = 'true' AND COALESCE(t->>'isCatchup', 'false') <> 'true'
), stamps AS (
  SELECT c.*, te,
         (SELECT ae FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.admin_card->'memberStates') = 'array'
                                                   THEN c.admin_card->'memberStates' ELSE '[]'::jsonb END) ae
          WHERE ae->>'enrolmentId' = te->>'enrolmentId' LIMIT 1) AS ae,
         CASE WHEN te->'attended' = 'false'::jsonb THEN 'absent'
              WHEN te->'attended' IS NULL OR te->'attended' = 'null'::jsonb THEN 'clear' END AS stamp_kind,
         CASE WHEN te->>'writtenAt' ~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}' THEN (te->>'writtenAt')::timestamptz END AS w_ts
  FROM copies c
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.t->'memberStates') = 'array' THEN c.t->'memberStates' ELSE '[]'::jsonb END) te
  WHERE NULLIF(te->>'writerTeacherId', '') IS NOT NULL
), judged AS (
  SELECT s.*,
         greatest(CASE WHEN s.ae->>'teacherWrittenAt' ~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}' THEN (s.ae->>'teacherWrittenAt')::timestamptz END,
                  CASE WHEN s.ae->>'adminOverrideAt'  ~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}' THEN (s.ae->>'adminOverrideAt')::timestamptz END) AS last_write,
         EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(s.wa_missed, '[]'::jsonb)) m
                 WHERE m->>'bandLessonId' = s.admin_card->>'id'
                   AND (m->>'enrolmentId' = s.ae->>'enrolmentId'
                        OR (m->>'studentId' = s.ae->>'studentId' AND m->>'instrument' = s.ae->>'instrument'))) AS has_band_miss,
         EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s.admin_card->'removedLessons') = 'array'
                                                         THEN s.admin_card->'removedLessons' ELSE '[]'::jsonb END) cd
                 WHERE COALESCE(cd->>'isBandSession', 'false') <> 'true' AND COALESCE(cd->>'isGroup', 'false') <> 'true'
                   AND CASE WHEN NULLIF(cd->>'enrolmentId', '') IS NOT NULL THEN cd->>'enrolmentId' = s.ae->>'enrolmentId'
                            ELSE cd->>'studentId' = s.ae->>'studentId' AND cd->>'instrument' = s.ae->>'instrument' END) AS has_ledger_card
  FROM stamps s
)
SELECT actuals_id, week_key, school_id, drains_tonight,
       admin_card->>'id'          AS admin_card_id,
       admin_card->>'bandName'    AS band_name,
       te->>'enrolmentId'         AS enrolment_id,
       stamp_kind,
       te->>'writtenAt'           AS written_at,
       ae->>'consumption'         AS consumption,
       ae->>'teacherWrittenAt'    AS admin_teacher_written_at,
       ae->>'adminOverrideAt'     AS admin_override_at,
       ae->>'writerTeacherId'     AS admin_writer,
       ae->'attended'             AS admin_attended,
       has_band_miss,
       CASE
         WHEN admin_card IS NULL                                      THEN 'no admin card: copy not merged'
         WHEN jsonb_typeof(admin_card->'memberStates') <> 'array'
           OR admin_card->'memberStates' IS NULL                      THEN 'legacy band: ignored'
         WHEN ae IS NULL                                              THEN 'SKIP: member not on admin band'
         WHEN w_ts IS NULL                                            THEN 'SKIP: no/invalid writtenAt'
         WHEN stamp_kind IS NULL                                      THEN 'SKIP: attended is not false/null'
         WHEN ae->>'consumption' IS NULL
           OR ae->>'consumption' NOT IN ('regular', 'catchup', 'free') THEN 'SKIP: consumption ' || COALESCE(ae->>'consumption', 'unattributed')
         WHEN last_write IS NOT NULL AND w_ts <= last_write           THEN 'SKIP: not newer than last teacher/admin write'
         WHEN NULLIF(ae->>'writerTeacherId', '') IS NULL
           AND (ae->'attended' = 'false'::jsonb OR has_band_miss)     THEN 'SKIP: admin-recorded absence wins'
         WHEN ae->>'consumption' = 'regular' AND stamp_kind = 'absent' THEN
           CASE WHEN has_band_miss THEN 'UPDATE reason on the teacher miss'
                WHEN has_ledger_card THEN 'MOVE ledger card to missed'
                ELSE 'NO-OP: no ledger card' END
         WHEN ae->>'consumption' = 'regular'                          THEN
           CASE WHEN has_band_miss THEN 'RESTORE miss to ledger' ELSE 'STAMP only (nothing to clear)' END
         WHEN ae->>'consumption' = 'catchup' AND stamp_kind = 'absent' THEN
           'MARK catch-up absent' || CASE WHEN te->'absence'->'suggestOwed' = 'true'::jsonb THEN ' (suggests owed)' ELSE '' END
         WHEN ae->>'consumption' = 'catchup'                          THEN
           CASE WHEN ae ? 'absentCatchupSnapshot' THEN 'SKIP: owed-on snapshot held' ELSE 'CLEAR catch-up absence' END
         WHEN stamp_kind = 'absent'                                   THEN 'MARK free member absent'
         ELSE                                                              'CLEAR free member absence'
       END AS v3_outcome
FROM judged
ORDER BY week_key, school_id, actuals_id, enrolment_id;
