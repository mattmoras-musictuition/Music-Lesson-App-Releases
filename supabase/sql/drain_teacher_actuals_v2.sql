-- drain_teacher_actuals — v2 (band merge). Admin v2.41.2 dispatch, Part B.
--
-- Same signature, hour guard, cutoff, catch-up exclusions, past/future split,
-- insert-if-missing and teacher_actuals update/delete as v1 (B4). The
-- admin-card REMOVAL test is v1's text unchanged, including the
-- isBandSession guard, so admin band cards are never removed by it.
--
-- What changes is only what gets APPENDED, plus one in-place band update:
--
-- B1  A past teacher band copy T (isBandSession = true) that resolves to an
--     admin band card A in the same weekly_adjustments row is NOT appended.
--     Resolve: A.isBandSession AND A.id = T.originBandLessonId. Only when T
--     has no originBandLessonId: A.bandId = T.bandId AND A.day = T.day, and
--     exactly one such A. On a match A is updated in place (A.id kept):
--       - start, end, slotId from T where T has them (non-null);
--       - day stays A.day (teacher-side cross-day moves are blocked; if T.day
--         differs, A.day wins; if equal it is the same value anyway);
--       - every other A field unchanged (members, removedLessons, ...);
--       - memberStates: A's entries only. An A entry takes attended, absence
--         and writerTeacherId from the first T entry with the same
--         enrolmentId AND a non-null writerTeacherId; otherwise it is kept.
--         consumption, consumedWeekKey, fee, catchupId and
--         absentCatchupSnapshot are always A's. (Inert today: nothing stamps
--         entry-level writerTeacherId yet.)
--     No match: T with a memberStates array (a NEW band the admin removed,
--     e.g. by re-import) is dropped; a LEGACY T is appended as in v1.
--
-- B2  A past non-band teacher lesson or miss E is not appended when the row
--     (as it stood before this drain touched it) has
--       (a) a band with a memberStates array whose removedLessons holds R
--           with R.day = E.day and the same enrolment, or
--       (b) a missed entry with bandLessonId set, same day, same enrolment.
--     Same enrolment = enrolmentId equal; if either side lacks enrolmentId
--     (absent, null or ""), studentId AND instrument equal.
--     E still takes part in the v1 removal test; only its append is skipped.
--
-- B3  Past teacher misses carrying bandLessonId are left out entirely: not
--     used for removal, not appended. Admin's own band absences stand.
--     Temporary, until teacher attendance ships. They are still cleared from
--     teacher_actuals like every other drained entry.
--
-- Rollback: apply drain_teacher_actuals_v1_backup.sql.

CREATE OR REPLACE FUNCTION public.drain_teacher_actuals(p_school_id_filter text DEFAULT NULL::text, p_skip_hour_guard boolean DEFAULT false)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  melb_now       timestamptz := now() AT TIME ZONE 'Australia/Melbourne';
  cutoff         date;
  dow            CONSTANT text[] := ARRAY['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
  admin_user_id  CONSTANT uuid   := 'daf539a2-ec67-45e5-8533-a3a5beb5b9e5';
  d              record;
  -- v2 working state, per teacher_actuals row
  adj_lessons    jsonb;   -- target row's lessons BEFORE this drain's update
  b2_ledger      jsonb;   -- B2 (a)+(b) entries, each carrying day + enrolment keys
  removal_missed jsonb;   -- past_missed minus B3 entries (used for removal)
  append_lessons jsonb;   -- what v1 appended as d.past_lessons, after B1/B2
  append_missed  jsonb;   -- what v1 appended as d.past_missed, after B2/B3
  merges         jsonb;   -- [{aId, t}] band copies resolved to an admin card
  e              jsonb;
  mg             jsonb;
  a_id           text;
  n_match        integer;
BEGIN
  IF NOT p_skip_hour_guard AND EXTRACT(HOUR FROM melb_now) <> 18 THEN
    RETURN;
  END IF;
  cutoff := melb_now::date;

  FOR d IN
    SELECT
      actuals.id         AS row_id,
      actuals.week_key   AS row_week_key,
      actuals.school_id  AS row_school_id,
      actuals.teacher_id AS row_teacher_id,
      COALESCE((SELECT jsonb_agg(lsn) FROM jsonb_array_elements(actuals.lessons) lsn
                WHERE (actuals.week_key::date + (array_position(dow, lsn->>'day') - 1)) <= cutoff
                  AND COALESCE(lsn->>'isCatchup', 'false') <> 'true'), '[]'::jsonb) AS past_lessons,
      COALESCE((SELECT jsonb_agg(lsn) FROM jsonb_array_elements(actuals.lessons) lsn
                WHERE (actuals.week_key::date + (array_position(dow, lsn->>'day') - 1)) >  cutoff), '[]'::jsonb) AS future_lessons,
      COALESCE((SELECT jsonb_agg(msd) FROM jsonb_array_elements(actuals.missed) msd
                WHERE (actuals.week_key::date + (array_position(dow, msd->>'day') - 1)) <= cutoff
                  AND COALESCE(msd->>'isCatchup', 'false') <> 'true'), '[]'::jsonb) AS past_missed,
      COALESCE((SELECT jsonb_agg(msd) FROM jsonb_array_elements(actuals.missed) msd
                WHERE (actuals.week_key::date + (array_position(dow, msd->>'day') - 1)) >  cutoff), '[]'::jsonb) AS future_missed
    FROM teacher_actuals actuals
    WHERE p_school_id_filter IS NULL OR actuals.school_id = p_school_id_filter
  LOOP
    IF jsonb_array_length(d.past_lessons) > 0 OR jsonb_array_length(d.past_missed) > 0 THEN
      INSERT INTO weekly_adjustments (user_id, week_key, school_id, lessons, missed, notes, generated_at, breaks)
      VALUES (admin_user_id, d.row_week_key, d.row_school_id, '[]'::jsonb, '[]'::jsonb, '', '', '[]'::jsonb)
      ON CONFLICT (week_key, school_id) DO NOTHING;

      -- ── Snapshot the target row before it is touched (B1 resolve, B2) ──
      SELECT COALESCE(adjustments.lessons, '[]'::jsonb),
             -- B2 ledger: (a) removedLessons of NEW bands, (b) band-stamped misses
             COALESCE((SELECT jsonb_agg(r)
                       FROM jsonb_array_elements(COALESCE(adjustments.lessons, '[]'::jsonb)) b,
                            jsonb_array_elements(CASE WHEN jsonb_typeof(b->'removedLessons') = 'array'
                                                      THEN b->'removedLessons' ELSE '[]'::jsonb END) r
                       WHERE COALESCE(b->>'isBandSession', 'false') = 'true'
                         AND jsonb_typeof(b->'memberStates') = 'array'), '[]'::jsonb)
             ||
             COALESCE((SELECT jsonb_agg(m)
                       FROM jsonb_array_elements(COALESCE(adjustments.missed, '[]'::jsonb)) m
                       WHERE NULLIF(m->>'bandLessonId', '') IS NOT NULL), '[]'::jsonb)
        INTO adj_lessons, b2_ledger
      FROM weekly_adjustments adjustments
      WHERE adjustments.week_key = d.row_week_key AND adjustments.school_id = d.row_school_id;

      -- ── Lessons: B1 resolve band copies, B2 skip regulars (order kept) ──
      append_lessons := '[]'::jsonb;
      merges         := '[]'::jsonb;
      FOR e IN SELECT x FROM jsonb_array_elements(d.past_lessons) WITH ORDINALITY AS j(x, ord) ORDER BY ord LOOP
        IF COALESCE(e->>'isBandSession', 'false') = 'true' THEN
          a_id := NULL;
          IF NULLIF(e->>'originBandLessonId', '') IS NOT NULL THEN
            SELECT a->>'id' INTO a_id
            FROM jsonb_array_elements(adj_lessons) a
            WHERE COALESCE(a->>'isBandSession', 'false') = 'true'
              AND a->>'id' = e->>'originBandLessonId'
            LIMIT 1;
          ELSE
            -- Fallback for copies imported before teacher app v1.18.0.
            SELECT count(*), min(a->>'id') INTO n_match, a_id
            FROM jsonb_array_elements(adj_lessons) a
            WHERE COALESCE(a->>'isBandSession', 'false') = 'true'
              AND a->>'bandId' = e->>'bandId'
              AND a->>'day'    = e->>'day';
            IF n_match <> 1 THEN a_id := NULL; END IF;
          END IF;

          IF a_id IS NOT NULL THEN
            merges := merges || jsonb_build_array(jsonb_build_object('aId', a_id, 't', e));
          ELSIF jsonb_typeof(e->'memberStates') = 'array' THEN
            NULL;  -- orphan NEW band copy: admin removed the band, drop it
          ELSE
            append_lessons := append_lessons || jsonb_build_array(e);  -- legacy orphan: as v1
          END IF;
        ELSIF NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(b2_ledger) r
          WHERE r->>'day' = e->>'day'
            AND CASE WHEN NULLIF(r->>'enrolmentId', '') IS NOT NULL AND NULLIF(e->>'enrolmentId', '') IS NOT NULL
                     THEN r->>'enrolmentId' = e->>'enrolmentId'
                     ELSE r->>'studentId' = e->>'studentId' AND r->>'instrument' = e->>'instrument' END
        ) THEN
          append_lessons := append_lessons || jsonb_build_array(e);
        END IF;
      END LOOP;

      -- ── Missed: B3 out entirely; B2 skip on non-band (order kept) ──
      removal_missed := '[]'::jsonb;
      append_missed  := '[]'::jsonb;
      FOR e IN SELECT x FROM jsonb_array_elements(d.past_missed) WITH ORDINALITY AS j(x, ord) ORDER BY ord LOOP
        CONTINUE WHEN NULLIF(e->>'bandLessonId', '') IS NOT NULL;  -- B3
        removal_missed := removal_missed || jsonb_build_array(e);
        IF COALESCE(e->>'isBandSession', 'false') = 'true' OR NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(b2_ledger) r
          WHERE r->>'day' = e->>'day'
            AND CASE WHEN NULLIF(r->>'enrolmentId', '') IS NOT NULL AND NULLIF(e->>'enrolmentId', '') IS NOT NULL
                     THEN r->>'enrolmentId' = e->>'enrolmentId'
                     ELSE r->>'studentId' = e->>'studentId' AND r->>'instrument' = e->>'instrument' END
        ) THEN
          append_missed := append_missed || jsonb_build_array(e);
        END IF;
      END LOOP;

      -- ── v1 update. Removal text unchanged; only the appended arrays and
      --    the missed removal input (B3) differ. ──
      UPDATE weekly_adjustments adjustments
      SET lessons = COALESCE((SELECT jsonb_agg(lsn) FROM jsonb_array_elements(adjustments.lessons) lsn
                              WHERE NOT (
                                EXISTS (
                                  SELECT 1 FROM jsonb_array_elements(d.past_lessons) past
                                  WHERE past->>'day' = lsn->>'day'
                                    AND COALESCE(lsn->>'isBandSession', 'false') <> 'true'
                                    AND (
                                      past->>'teacherId' = lsn->>'teacherId'
                                      OR (lsn->>'teacherId' IS NULL AND lsn->>'enrolmentId' IS NOT NULL AND past->>'enrolmentId' = lsn->>'enrolmentId')
                                      OR (lsn->>'teacherId' IS NULL AND lsn->>'groupId'    IS NOT NULL AND past->>'groupId'    = lsn->>'groupId')
                                    )
                                )
                                AND (adjustments.week_key::date + (array_position(dow, lsn->>'day') - 1)) <= cutoff
                              )), '[]'::jsonb) || append_lessons,
          missed  = COALESCE((SELECT jsonb_agg(msd) FROM jsonb_array_elements(adjustments.missed) msd
                              WHERE NOT (
                                EXISTS (
                                  SELECT 1 FROM jsonb_array_elements(removal_missed) past
                                  WHERE past->>'day' = msd->>'day'
                                    AND COALESCE(msd->>'isBandSession', 'false') <> 'true'
                                    AND (
                                      past->>'teacherId' = msd->>'teacherId'
                                      OR (msd->>'teacherId' IS NULL AND msd->>'enrolmentId' IS NOT NULL AND past->>'enrolmentId' = msd->>'enrolmentId')
                                      OR (msd->>'teacherId' IS NULL AND msd->>'groupId'    IS NOT NULL AND past->>'groupId'    = msd->>'groupId')
                                    )
                                )
                                AND (adjustments.week_key::date + (array_position(dow, msd->>'day') - 1)) <= cutoff
                              )), '[]'::jsonb) || append_missed
      WHERE adjustments.week_key = d.row_week_key AND adjustments.school_id = d.row_school_id;

      -- ── B1 in-place merge of each resolved copy into its admin card ──
      FOR mg IN SELECT x FROM jsonb_array_elements(merges) WITH ORDINALITY AS j(x, ord) ORDER BY ord LOOP
        UPDATE weekly_adjustments adjustments
        SET lessons = (
          SELECT jsonb_agg(
                   CASE WHEN COALESCE(a->>'isBandSession', 'false') = 'true' AND a->>'id' = mg->>'aId' THEN
                     -- start / end / slotId from T where present; day and the rest stay A's
                     (a || jsonb_strip_nulls(jsonb_build_object(
                            'start',  mg->'t'->'start',
                            'end',    mg->'t'->'end',
                            'slotId', mg->'t'->'slotId')))
                     ||
                     CASE WHEN jsonb_typeof(a->'memberStates') = 'array' THEN
                       jsonb_build_object('memberStates', (
                         SELECT COALESCE(jsonb_agg(
                                  CASE WHEN tm.te IS NULL THEN ae
                                       ELSE (ae - 'attended' - 'absence' - 'writerTeacherId')
                                            || jsonb_build_object('attended',        COALESCE(tm.te->'attended', 'null'::jsonb),
                                                                  'writerTeacherId', tm.te->'writerTeacherId')
                                            || CASE WHEN tm.te ? 'absence'
                                                    THEN jsonb_build_object('absence', tm.te->'absence')
                                                    ELSE '{}'::jsonb END
                                  END ORDER BY aord), '[]'::jsonb)
                         FROM jsonb_array_elements(a->'memberStates') WITH ORDINALITY AS aj(ae, aord)
                         LEFT JOIN LATERAL (
                           SELECT tx AS te
                           FROM jsonb_array_elements(CASE WHEN jsonb_typeof(mg->'t'->'memberStates') = 'array'
                                                          THEN mg->'t'->'memberStates' ELSE '[]'::jsonb END)
                                WITH ORDINALITY AS tj(tx, tord)
                           WHERE tx->>'enrolmentId' = ae->>'enrolmentId'
                             AND NULLIF(tx->>'writerTeacherId', '') IS NOT NULL
                           ORDER BY tord
                           LIMIT 1
                         ) tm ON true
                       ))
                     ELSE '{}'::jsonb END
                   ELSE a END
                 ORDER BY ord)
          FROM jsonb_array_elements(adjustments.lessons) WITH ORDINALITY AS lj(a, ord)
        )
        WHERE adjustments.week_key = d.row_week_key AND adjustments.school_id = d.row_school_id;
      END LOOP;
    END IF;

    UPDATE teacher_actuals
    SET lessons = d.future_lessons, missed = d.future_missed
    WHERE id = d.row_id;
  END LOOP;

  DELETE FROM teacher_actuals
  WHERE (p_school_id_filter IS NULL OR school_id = p_school_id_filter)
    AND jsonb_array_length(lessons) = 0
    AND jsonb_array_length(missed) = 0;
END;
$function$
;
