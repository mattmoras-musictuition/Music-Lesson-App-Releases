-- drain v2 PREVIEW — READ-ONLY. Every statement is a SELECT; run each on
-- its own. Shows what drain_teacher_actuals v2 would do with what is in
-- teacher_actuals right now. "drains_tonight" = the entry's date is on or
-- before today (Melbourne), i.e. the 18:00 run would take it.

-- (P1) Band copies in teacher_actuals: which admin band card each resolves
-- to, and what v2 does with it (B1).
SELECT ta.id                       AS actuals_id,
       ta.week_key, ta.school_id, ta.teacher_id,
       t->>'id'                    AS copy_id,
       t->>'bandName'              AS band_name,
       t->>'bandId'                AS band_id,
       t->>'day'                   AS day,
       t->>'originBandLessonId'    AS origin_band_lesson_id,
       (jsonb_typeof(t->'memberStates') = 'array') AS is_new_band,
       (ta.week_key::date + (array_position(ARRAY['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'], t->>'day') - 1))
         <= (now() AT TIME ZONE 'Australia/Melbourne')::date AS drains_tonight,
       r.method, r.candidates, r.admin_card_id,
       CASE WHEN r.admin_card_id IS NOT NULL               THEN 'MERGE into admin card (times/slot from copy)'
            WHEN jsonb_typeof(t->'memberStates') = 'array' THEN 'DROP (new band, no admin card)'
            ELSE                                                'APPEND (legacy, as v1)' END AS v2_outcome
FROM teacher_actuals ta
CROSS JOIN LATERAL jsonb_array_elements(ta.lessons) t
LEFT JOIN weekly_adjustments wa ON wa.week_key = ta.week_key AND wa.school_id = ta.school_id
CROSS JOIN LATERAL (
  SELECT CASE WHEN NULLIF(t->>'originBandLessonId', '') IS NOT NULL THEN 'origin id' ELSE 'bandId+day fallback' END AS method,
         count(*) AS candidates,
         CASE WHEN NULLIF(t->>'originBandLessonId', '') IS NOT NULL THEN min(a->>'id')
              WHEN count(*) = 1 THEN min(a->>'id') END AS admin_card_id
  FROM jsonb_array_elements(COALESCE(wa.lessons, '[]'::jsonb)) a
  WHERE COALESCE(a->>'isBandSession', 'false') = 'true'
    AND CASE WHEN NULLIF(t->>'originBandLessonId', '') IS NOT NULL
             THEN a->>'id' = t->>'originBandLessonId'
             ELSE a->>'bandId' = t->>'bandId' AND a->>'day' = t->>'day' END
) r
WHERE COALESCE(t->>'isBandSession', 'false') = 'true'
  AND COALESCE(t->>'isCatchup', 'false') <> 'true'
ORDER BY ta.week_key, ta.school_id, t->>'day';

-- (P2) Regular lessons / misses v2 would NOT append (B2): the target week
-- already has the student's lesson in a new band's removedLessons (a) or a
-- band-stamped miss (b) for that day.
WITH ledger AS (
  SELECT wa.week_key, wa.school_id, 'a: band removedLessons' AS via, b->>'id' AS band_card_id, r AS e
  FROM weekly_adjustments wa,
       jsonb_array_elements(wa.lessons) b,
       jsonb_array_elements(CASE WHEN jsonb_typeof(b->'removedLessons') = 'array' THEN b->'removedLessons' ELSE '[]'::jsonb END) r
  WHERE COALESCE(b->>'isBandSession', 'false') = 'true' AND jsonb_typeof(b->'memberStates') = 'array'
  UNION ALL
  SELECT wa.week_key, wa.school_id, 'b: band-stamped miss', m->>'bandLessonId', m
  FROM weekly_adjustments wa, jsonb_array_elements(wa.missed) m
  WHERE NULLIF(m->>'bandLessonId', '') IS NOT NULL
), teacher_entries AS (
  SELECT ta.id AS actuals_id, ta.week_key, ta.school_id, ta.teacher_id, 'lesson' AS kind, x AS e
  FROM teacher_actuals ta, jsonb_array_elements(ta.lessons) x
  WHERE COALESCE(x->>'isBandSession', 'false') <> 'true' AND COALESCE(x->>'isCatchup', 'false') <> 'true'
  UNION ALL
  SELECT ta.id, ta.week_key, ta.school_id, ta.teacher_id, 'missed', x
  FROM teacher_actuals ta, jsonb_array_elements(ta.missed) x
  WHERE COALESCE(x->>'isBandSession', 'false') <> 'true' AND COALESCE(x->>'isCatchup', 'false') <> 'true'
    AND NULLIF(x->>'bandLessonId', '') IS NULL
)
SELECT te.actuals_id, te.week_key, te.school_id, te.teacher_id, te.kind,
       te.e->>'id' AS entry_id, te.e->>'day' AS day,
       te.e->>'enrolmentId' AS enrolment_id, te.e->>'studentId' AS student_id, te.e->>'instrument' AS instrument,
       l.via, l.band_card_id
FROM teacher_entries te
JOIN ledger l ON l.week_key = te.week_key AND l.school_id = te.school_id
 AND l.e->>'day' = te.e->>'day'
 AND CASE WHEN NULLIF(l.e->>'enrolmentId', '') IS NOT NULL AND NULLIF(te.e->>'enrolmentId', '') IS NOT NULL
          THEN l.e->>'enrolmentId' = te.e->>'enrolmentId'
          ELSE l.e->>'studentId' = te.e->>'studentId' AND l.e->>'instrument' = te.e->>'instrument' END
ORDER BY te.week_key, te.school_id, te.kind, te.e->>'day';

-- (P3) Teacher misses v2 ignores entirely (B3: carry bandLessonId).
SELECT ta.id AS actuals_id, ta.week_key, ta.school_id, ta.teacher_id,
       x->>'id' AS entry_id, x->>'day' AS day, x->>'bandLessonId' AS band_lesson_id,
       x->>'enrolmentId' AS enrolment_id, x->>'studentId' AS student_id, x->>'instrument' AS instrument
FROM teacher_actuals ta, jsonb_array_elements(ta.missed) x
WHERE NULLIF(x->>'bandLessonId', '') IS NOT NULL
ORDER BY ta.week_key, ta.school_id;

-- (P4) Riptide — both cards (same as riptide_cleanup.sql (i)).
SELECT l->>'id'               AS card_id,
       pos                    AS position_in_lessons,
       l->>'writerTeacherId'  AS writer_teacher_id,
       l->>'teacherId'        AS teacher_id,
       l->>'bandName'         AS band_name,
       l->>'start'            AS start_time,
       l->>'end'              AS end_time,
       jsonb_array_length(COALESCE(l->'members', '[]'::jsonb))        AS n_members,
       jsonb_array_length(COALESCE(l->'removedLessons', '[]'::jsonb)) AS n_removed_lessons,
       l->'members'           AS members,
       l->'removedLessons'    AS removed_lessons
FROM weekly_adjustments wa,
     jsonb_array_elements(wa.lessons) WITH ORDINALITY AS j(l, pos)
WHERE wa.week_key = '2026-09-07'
  AND wa.school_id = 'pwa2twgi'
  AND l->>'bandId' = 'cdhfs43b'
  AND l->>'day' = 'Friday'
ORDER BY pos;

-- (P5) Riptide — students the teacher copy lists that the admin card does
-- not (same as riptide_cleanup.sql (i-b)). No rows = no Tally effect.
WITH cards AS (
  SELECT l, (l->>'id' = 'aauisy56mts3c2pv') AS is_copy
  FROM weekly_adjustments wa, jsonb_array_elements(wa.lessons) l
  WHERE wa.week_key = '2026-09-07' AND wa.school_id = 'pwa2twgi'
    AND l->>'bandId' = 'cdhfs43b' AND l->>'day' = 'Friday'
), people AS (
  SELECT c.is_copy, x.src, x.p->>'studentId' AS student_id, x.p->>'instrument' AS instrument, x.p->>'enrolmentId' AS enrolment_id
  FROM cards c,
       LATERAL (SELECT 'members' AS src, m AS p FROM jsonb_array_elements(COALESCE(c.l->'members', '[]'::jsonb)) m
                UNION ALL
                SELECT 'removedLessons', r FROM jsonb_array_elements(COALESCE(c.l->'removedLessons', '[]'::jsonb)) r) x
)
SELECT cp.src, cp.student_id, cp.instrument, cp.enrolment_id
FROM people cp
WHERE cp.is_copy
  AND NOT EXISTS (SELECT 1 FROM people ad
                  WHERE NOT ad.is_copy AND ad.src = cp.src
                    AND ad.student_id = cp.student_id
                    AND ad.instrument IS NOT DISTINCT FROM cp.instrument);
