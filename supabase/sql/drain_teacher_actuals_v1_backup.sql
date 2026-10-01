-- drain_teacher_actuals — v1 BACKUP (live definition as of 1 Oct 2026,
-- supplied verbatim by the owner). Applying this file is the ROLLBACK for
-- drain_teacher_actuals_v2.sql. The function text below is unchanged.

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
                              )), '[]'::jsonb) || d.past_lessons,
          missed  = COALESCE((SELECT jsonb_agg(msd) FROM jsonb_array_elements(adjustments.missed) msd
                              WHERE NOT (
                                EXISTS (
                                  SELECT 1 FROM jsonb_array_elements(d.past_missed) past
                                  WHERE past->>'day' = msd->>'day'
                                    AND COALESCE(msd->>'isBandSession', 'false') <> 'true'
                                    AND (
                                      past->>'teacherId' = msd->>'teacherId'
                                      OR (msd->>'teacherId' IS NULL AND msd->>'enrolmentId' IS NOT NULL AND past->>'enrolmentId' = msd->>'enrolmentId')
                                      OR (msd->>'teacherId' IS NULL AND msd->>'groupId'    IS NOT NULL AND past->>'groupId'    = msd->>'groupId')
                                    )
                                )
                                AND (adjustments.week_key::date + (array_position(dow, msd->>'day') - 1)) <= cutoff
                              )), '[]'::jsonb) || d.past_missed
      WHERE adjustments.week_key = d.row_week_key AND adjustments.school_id = d.row_school_id;
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
