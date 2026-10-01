-- Riptide duplicate clean-up — week 2026-09-07, school pwa2twgi,
-- bandId cdhfs43b, Friday. v1 drain appended the teacher's copy
-- (card id aauisy56mts3c2pv, writerTeacherId q0jjoc9q) beside the admin's
-- card. Legacy band (term 3, no memberStates).
--
-- Effect of the duplicate (admin v2.41.2 investigation):
--   Tally — none, PROVIDED (i-b) returns no rows. The Tally takes the FIRST
--     matching band card per enrolment per week (tallyDerive.js
--     matchByBandSession + .find), so two cards still give one tick. Only a
--     student listed on the copy but not on the admin card would be ticked
--     solely by the copy; (i-b) lists exactly those.
--   Invoices — none. Band cards carry no top-level enrolmentId/studentId,
--     so invoicing never counts them.
--   Only the Claude assistant's weekly "X completed" context line counts the
--     copy (+1 for that week); it is not a Tally or invoice figure.
--
-- Run order: (i), (i-b), then (ii), then (i) again. Each is one statement.

-- (i) READ-ONLY — both Riptide cards. Expect two rows before (ii), one after.
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

-- (i-b) READ-ONLY — students the teacher copy lists (members or
-- removedLessons) that the admin card does not. No rows = removing the copy
-- changes no Tally tick.
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

-- (ii) WRITE — remove ONLY the element with id 'aauisy56mts3c2pv' from that
-- row's lessons; order of every other card kept. Guarded: does nothing
-- unless the copy is present AND another Riptide Friday card (the admin's)
-- is still in the row. Expect "UPDATE 1".
UPDATE weekly_adjustments wa
SET lessons = (SELECT COALESCE(jsonb_agg(l ORDER BY pos), '[]'::jsonb)
               FROM jsonb_array_elements(wa.lessons) WITH ORDINALITY AS j(l, pos)
               WHERE l->>'id' IS DISTINCT FROM 'aauisy56mts3c2pv')
WHERE wa.week_key = '2026-09-07'
  AND wa.school_id = 'pwa2twgi'
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(wa.lessons) l WHERE l->>'id' = 'aauisy56mts3c2pv')
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(wa.lessons) l
              WHERE l->>'bandId' = 'cdhfs43b' AND l->>'day' = 'Friday'
                AND l->>'id' IS DISTINCT FROM 'aauisy56mts3c2pv');
