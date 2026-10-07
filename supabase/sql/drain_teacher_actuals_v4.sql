-- drain_teacher_actuals — v4 DRAFT (admin day edits beat an older teacher copy).
-- Admin v2.49.3 dispatch. NOT APPLIED. Do not apply until a teacher release
-- stamps importedAt (spec below) — until then every card is legacy and v4
-- behaves exactly like v3, so applying early is harmless but pointless.
-- Needs weekly_adjustments.day_edited_at (supabase/sql/add_day_edited_at.sql).
--
-- Rollback: apply drain_teacher_actuals_v3.sql.
--
-- ── What v4 changes (everything else is v3, unchanged) ──────────────────
-- Per teacher_actuals row, per past day D (same past/future split as v3):
--   copy freshness  = newest importedAt among that row's lessons AND missed
--                     entries for D (band copies included); unparseable
--                     values are ignored.
--   admin edit time = weekly_adjustments.day_edited_at ->> D for the row's
--                     (week_key, school_id), read before this drain writes.
--   If BOTH exist and admin edit time > copy freshness, D is SKIPPED for
--   this teacher:
--     • none of the copy's D entries (lessons, band copies, missed) feed the
--       v1 remove-and-append — the admin's day stays exactly as it is;
--     • the legacy orphan band append (copies with no memberStates) is not
--       done for D either (it is an append);
--     • the B1 band merge still runs for D's band copies, byte-for-byte as
--       v3 (attendance stamps keep their own writtenAt rules);
--     • D's entries are still removed from teacher_actuals at the end (the
--       row keeps only future days, as v3), so a skipped day never re-fires.
--   If no D entry carries a parseable importedAt (older teacher app), D is
--   legacy and drains exactly as v3. Same if the admin never stamped D.
--
-- ── Teacher app spec (for the later teacher dispatch) ───────────────────
-- Stamp importedAt (ISO 8601 with offset, e.g. new Date().toISOString())
-- on every lessons[] and missed[] entry the teacher app writes:
--   • at Import day: every copied card, missed entry and catch-up import;
--   • on any teacher change to a day (move, add, delete, mark missed,
--     band attendance, catch-up place/cancel): re-stamp importedAt on EVERY
--     lessons/missed entry of each day touched (both days for a move).
--     Re-stamping the whole day, not just the edited card, is what lets a
--     teacher deletion or move-out beat an earlier admin edit — a deleted
--     card carries no stamp of its own.
--   • band attendance: re-stamp the band copy's importedAt as well as
--     memberStates[].writtenAt (v3 rules for writtenAt are unchanged).
-- Never copy importedAt from the admin's weekly_adjustments cards (the
-- admin does not set it; Import must set a fresh value).
--
-- ── v3 header (unchanged behaviour) ─────────────────────────────────────
-- drain_teacher_actuals — v3 (teacher-recorded band attendance).
-- Admin v2.42.0 dispatch. Extends v2; everything v2 does is unchanged
-- except the memberStates part of the B1 in-place merge, which v3 replaces.
--
-- Data contract (shared with teacher app v1.19.0). The teacher writes ONLY
-- onto the memberStates entry (matched by enrolmentId) of its band copy:
--   absent: attended:false, absence:{reason, reasonDetail, notes,
--           makeupEligible, suggestOwed}, writerTeacherId, writtenAt (ISO)
--   clear:  attended:null, absence:null, writerTeacherId, writtenAt
-- Admin bookkeeping on the ADMIN entry: teacherWrittenAt (writtenAt of the
-- last stamp applied) and adminOverrideAt (set by any admin absence action,
-- which also clears writerTeacherId so the absence is admin-owned).
--
-- For each A entry with a stamped T entry (same enrolmentId, non-null
-- writerTeacherId — v2's selection), on a merged band copy:
--  1. SKIP when: writtenAt missing/invalid; T.attended is neither false nor
--     null; consumption is not regular/catchup/free (null = unattributed,
--     not_in_session, forward, billed); writtenAt <= greatest(
--     teacherWrittenAt, adminOverrideAt); or the admin owns an absence —
--     A.attended = false with no A.writerTeacherId, or a band miss for this
--     enrolment + band with no A.writerTeacherId.
--  2. regular, absent: the member's ledger card(s) move from A.removedLessons
--     into missed[] in the cluster-5 shape (enrolmentId, bandLessonId,
--     ledgerTeacherId, ledgerCard, the card's own day/time/slot; no
--     teacherId, writerTeacherId or isBandSession on the miss; reason fields
--     as the admin reason prompt writes them). If the miss already exists,
--     only its reason fields are updated. No ledger card → not applied.
--     A.attended stays null (the miss IS the record; tallyDerive drops a
--     regular tick on attended === false).
--  3. regular, clear: band misses for the member go back to the ledger
--     (ledgerCard, as cluster-5 Undo does).
--  4. catchup, absent: attended:false + absence incl. suggestOwed;
--     makeupEligible forced false (forfeit until the admin confirms).
--  5. catchup, clear: attended null, absence removed. Not applied if the
--     entry holds absentCatchupSnapshot (an admin owed-on absence).
--  6. free: attended:false, or cleared.
--  7. Applied → A.writerTeacherId and A.teacherWrittenAt from the stamp.
-- The catchups table is never read or written. Re-drains are idempotent
-- (the writtenAt rule). B3 is unchanged.
--
-- Rollback: apply drain_teacher_actuals_v2.sql.

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
  -- v3 working state, per merge
  cur_lessons    jsonb;
  cur_missed     jsonb;
  band_a         jsonb;   -- the admin band card being merged into
  a_pos          bigint;
  t              jsonb;
  ms_out         jsonb;
  ae             jsonb;
  te             jsonb;
  mine           jsonb;   -- this member's band misses (bandMissesFor)
  cards          jsonb;   -- this member's ledger cards (ledgerCardsFor)
  abs_in         jsonb;
  stamp_kind     text;
  cons           text;
  w_ts           timestamptz;
  ts_teacher     timestamptz;
  ts_admin       timestamptz;
  applied        boolean;
  -- v4 working state, per teacher_actuals row
  adm_stamps     jsonb;   -- target row's day_edited_at BEFORE this drain's update
  day_fresh      jsonb;   -- { day: newest importedAt (ISO) } over the copy's past entries
  skip_days      text[];  -- past days where the admin edited after the copy
  use_lessons    jsonb;   -- past_lessons minus skipped days (removal + append input)
  merge_lessons  jsonb;   -- use_lessons plus skipped days' band copies (B1 input)
  use_missed     jsonb;   -- past_missed minus skipped days
  cp             jsonb;   -- (not x: v3 uses x as a column alias)
  dname          text;
  ts_copy        timestamptz;
  ts_adm         timestamptz;
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

      -- ── v4: which past days did the admin edit after this copy? ──
      SELECT CASE WHEN jsonb_typeof(adjustments.day_edited_at) = 'object' THEN adjustments.day_edited_at ELSE '{}'::jsonb END
        INTO adm_stamps
      FROM weekly_adjustments adjustments
      WHERE adjustments.week_key = d.row_week_key AND adjustments.school_id = d.row_school_id;
      adm_stamps := COALESCE(adm_stamps, '{}'::jsonb);
      day_fresh := '{}'::jsonb;
      FOR cp IN SELECT y FROM jsonb_array_elements(d.past_lessons || d.past_missed) AS j(y) LOOP
        CONTINUE WHEN jsonb_typeof(cp) <> 'object' OR NULLIF(cp->>'day', '') IS NULL;
        -- an unparseable value never aborts the drain
        BEGIN ts_copy := (cp->>'importedAt')::timestamptz; EXCEPTION WHEN others THEN ts_copy := NULL; END;
        CONTINUE WHEN ts_copy IS NULL;
        IF day_fresh->>(cp->>'day') IS NULL OR ts_copy > (day_fresh->>(cp->>'day'))::timestamptz THEN
          day_fresh := day_fresh || jsonb_build_object(cp->>'day', ts_copy);
        END IF;
      END LOOP;
      skip_days := ARRAY[]::text[];
      FOR dname IN SELECT jsonb_object_keys(day_fresh) LOOP
        BEGIN ts_adm := (adm_stamps->>dname)::timestamptz; EXCEPTION WHEN others THEN ts_adm := NULL; END;
        IF ts_adm IS NOT NULL AND ts_adm > (day_fresh->>dname)::timestamptz THEN
          skip_days := skip_days || dname;
        END IF;
      END LOOP;
      use_lessons := COALESCE((SELECT jsonb_agg(y ORDER BY ord) FROM jsonb_array_elements(d.past_lessons) WITH ORDINALITY AS j(y, ord)
                               WHERE NOT (COALESCE(y->>'day', '') = ANY (skip_days))), '[]'::jsonb);
      merge_lessons := COALESCE((SELECT jsonb_agg(y ORDER BY ord) FROM jsonb_array_elements(d.past_lessons) WITH ORDINALITY AS j(y, ord)
                                 WHERE NOT (COALESCE(y->>'day', '') = ANY (skip_days))
                                    OR COALESCE(y->>'isBandSession', 'false') = 'true'), '[]'::jsonb);
      use_missed := COALESCE((SELECT jsonb_agg(y ORDER BY ord) FROM jsonb_array_elements(d.past_missed) WITH ORDINALITY AS j(y, ord)
                              WHERE NOT (COALESCE(y->>'day', '') = ANY (skip_days))), '[]'::jsonb);

      -- ── Lessons: B1 resolve band copies, B2 skip regulars (order kept) ──
      append_lessons := '[]'::jsonb;
      merges         := '[]'::jsonb;
      -- v4: merge_lessons (skipped days keep only their band copies, for B1)
      FOR e IN SELECT x FROM jsonb_array_elements(merge_lessons) WITH ORDINALITY AS j(x, ord) ORDER BY ord LOOP
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
          ELSIF NOT (COALESCE(e->>'day', '') = ANY (skip_days)) THEN
            append_lessons := append_lessons || jsonb_build_array(e);  -- legacy orphan: as v1 (v4: not on a skipped day)
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
      FOR e IN SELECT x FROM jsonb_array_elements(use_missed) WITH ORDINALITY AS j(x, ord) ORDER BY ord LOOP  -- v4: use_missed
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
                                  SELECT 1 FROM jsonb_array_elements(use_lessons) past  -- v4: use_lessons
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

      -- ── B1 in-place merge of each resolved copy into its admin card.
      --    v2: start / end / slotId from T. v3: teacher attendance stamps
      --    (rules 1–7 in the header) instead of v2's memberStates copy. ──
      FOR mg IN SELECT x FROM jsonb_array_elements(merges) WITH ORDINALITY AS j(x, ord) ORDER BY ord LOOP
        SELECT COALESCE(adjustments.lessons, '[]'::jsonb), COALESCE(adjustments.missed, '[]'::jsonb)
          INTO cur_lessons, cur_missed
        FROM weekly_adjustments adjustments
        WHERE adjustments.week_key = d.row_week_key AND adjustments.school_id = d.row_school_id;

        band_a := NULL; a_pos := NULL;
        SELECT x, ord INTO band_a, a_pos
        FROM jsonb_array_elements(cur_lessons) WITH ORDINALITY AS j(x, ord)
        WHERE COALESCE(x->>'isBandSession', 'false') = 'true' AND x->>'id' = mg->>'aId'
        ORDER BY ord LIMIT 1;
        CONTINUE WHEN band_a IS NULL;

        t := mg->'t';
        -- v2: start / end / slotId from T where present; day and the rest stay A's
        band_a := band_a || jsonb_strip_nulls(jsonb_build_object(
                    'start',  t->'start',
                    'end',    t->'end',
                    'slotId', t->'slotId'));

        IF jsonb_typeof(band_a->'memberStates') = 'array' THEN
          ms_out := '[]'::jsonb;
          FOR ae IN SELECT x FROM jsonb_array_elements(band_a->'memberStates') WITH ORDINALITY AS j(x, ord) ORDER BY ord LOOP
            -- v2's stamp selection: first T entry, same enrolmentId, non-null writerTeacherId
            te := (SELECT tx
                   FROM jsonb_array_elements(CASE WHEN jsonb_typeof(t->'memberStates') = 'array'
                                                  THEN t->'memberStates' ELSE '[]'::jsonb END)
                        WITH ORDINALITY AS tj(tx, tord)
                   WHERE tx->>'enrolmentId' = ae->>'enrolmentId'
                     AND NULLIF(tx->>'writerTeacherId', '') IS NOT NULL
                   ORDER BY tord LIMIT 1);

            IF te IS NOT NULL AND jsonb_typeof(ae) = 'object' THEN
              cons := ae->>'consumption';
              stamp_kind := CASE WHEN te->'attended' = 'false'::jsonb THEN 'absent'
                                 WHEN te->'attended' IS NULL OR te->'attended' = 'null'::jsonb THEN 'clear'
                                 ELSE NULL END;
              -- timestamps: an unparseable value never aborts the drain
              BEGIN w_ts := (te->>'writtenAt')::timestamptz; EXCEPTION WHEN others THEN w_ts := NULL; END;
              BEGIN ts_teacher := (ae->>'teacherWrittenAt')::timestamptz; EXCEPTION WHEN others THEN ts_teacher := NULL; END;
              BEGIN ts_admin := (ae->>'adminOverrideAt')::timestamptz; EXCEPTION WHEN others THEN ts_admin := NULL; END;
              -- this member's band misses (bandAbsence.js bandMissesFor)
              mine := COALESCE((SELECT jsonb_agg(m) FROM jsonb_array_elements(cur_missed) m
                                WHERE m->>'bandLessonId' = band_a->>'id'
                                  AND (m->>'enrolmentId' = ae->>'enrolmentId'
                                       OR (m->>'studentId' = ae->>'studentId' AND m->>'instrument' = ae->>'instrument'))),
                               '[]'::jsonb);
              abs_in := CASE WHEN jsonb_typeof(te->'absence') = 'object' THEN te->'absence' ELSE '{}'::jsonb END;
              applied := false;

              IF w_ts IS NULL OR stamp_kind IS NULL
                 OR cons IS NULL OR cons NOT IN ('regular', 'catchup', 'free')
                 OR (greatest(ts_teacher, ts_admin) IS NOT NULL AND w_ts <= greatest(ts_teacher, ts_admin))
                 OR (NULLIF(ae->>'writerTeacherId', '') IS NULL
                     AND (ae->'attended' = 'false'::jsonb OR jsonb_array_length(mine) > 0)) THEN
                NULL;  -- rule 1: skip

              ELSIF cons = 'regular' AND stamp_kind = 'absent' THEN
                IF jsonb_array_length(mine) > 0 THEN
                  -- already recorded: reason fields only
                  cur_missed := (SELECT jsonb_agg(
                                   CASE WHEN m->>'bandLessonId' = band_a->>'id'
                                         AND (m->>'enrolmentId' = ae->>'enrolmentId'
                                              OR (m->>'studentId' = ae->>'studentId' AND m->>'instrument' = ae->>'instrument'))
                                        THEN m || jsonb_build_object(
                                               'reason',         COALESCE(NULLIF(abs_in->>'reason', ''), 'other'),
                                               'reasonDetail',   COALESCE(abs_in->>'reasonDetail', ''),
                                               'notes',          COALESCE(abs_in->>'notes', ''),
                                               'makeupEligible', abs_in->'makeupEligible' = 'true'::jsonb)
                                        ELSE m END
                                   ORDER BY ord)
                                 FROM jsonb_array_elements(cur_missed) WITH ORDINALITY AS mj(m, ord));
                  applied := true;
                ELSE
                  -- this member's ledger cards (bandAbsence.js ledgerCardsFor)
                  cards := COALESCE((SELECT jsonb_agg(c ORDER BY ord)
                                     FROM jsonb_array_elements(CASE WHEN jsonb_typeof(band_a->'removedLessons') = 'array'
                                                                    THEN band_a->'removedLessons' ELSE '[]'::jsonb END)
                                          WITH ORDINALITY AS cj(c, ord)
                                     WHERE COALESCE(c->>'isBandSession', 'false') <> 'true'
                                       AND COALESCE(c->>'isGroup', 'false') <> 'true'
                                       AND CASE WHEN NULLIF(c->>'enrolmentId', '') IS NOT NULL
                                                THEN c->>'enrolmentId' = ae->>'enrolmentId'
                                                ELSE c->>'studentId' = ae->>'studentId' AND c->>'instrument' = ae->>'instrument' END),
                                    '[]'::jsonb);
                  IF jsonb_array_length(cards) > 0 THEN
                    band_a := jsonb_set(band_a, '{removedLessons}', COALESCE((
                           SELECT jsonb_agg(c ORDER BY ord)
                           FROM jsonb_array_elements(band_a->'removedLessons') WITH ORDINALITY AS cj(c, ord)
                           WHERE NOT (c IN (SELECT jsonb_array_elements(cards)))), '[]'::jsonb));
                    -- the cluster-5 miss shape (planMarkAbsent regular)
                    cur_missed := cur_missed || (
                      SELECT jsonb_agg(
                               ((c - 'teacherId' - 'writerTeacherId')
                                || jsonb_build_object(
                                     'enrolmentId',    COALESCE(NULLIF(c->>'enrolmentId', ''), ae->>'enrolmentId'),
                                     'reason',         COALESCE(NULLIF(abs_in->>'reason', ''), 'other'),
                                     'reasonDetail',   COALESCE(abs_in->>'reasonDetail', ''),
                                     'notes',          COALESCE(abs_in->>'notes', ''),
                                     'makeupEligible', abs_in->'makeupEligible' = 'true'::jsonb,
                                     'madeUp',         false,
                                     'cardNote',       '',
                                     'bandLessonId',   band_a->>'id')
                                || CASE WHEN NULLIF(c->>'teacherId', '') IS NOT NULL
                                        THEN jsonb_build_object('ledgerTeacherId', c->>'teacherId') ELSE '{}'::jsonb END
                                || jsonb_build_object('ledgerCard', c))
                               ORDER BY ord)
                      FROM jsonb_array_elements(cards) WITH ORDINALITY AS cj(c, ord));
                    applied := true;
                  END IF;  -- no ledger card: nothing to move, not applied
                END IF;

              ELSIF cons = 'regular' AND stamp_kind = 'clear' THEN
                IF jsonb_array_length(mine) > 0 THEN
                  -- cluster-5 Undo: misses out, cards back (bandAbsence.js cardFromBandMiss)
                  cur_missed := COALESCE((SELECT jsonb_agg(m ORDER BY ord)
                                          FROM jsonb_array_elements(cur_missed) WITH ORDINALITY AS mj(m, ord)
                                          WHERE NOT (m IN (SELECT jsonb_array_elements(mine)))), '[]'::jsonb);
                  band_a := jsonb_set(band_a, '{removedLessons}',
                         COALESCE(CASE WHEN jsonb_typeof(band_a->'removedLessons') = 'array' THEN band_a->'removedLessons' END, '[]'::jsonb)
                         || (SELECT jsonb_agg(
                                      CASE WHEN jsonb_typeof(m->'ledgerCard') = 'object' THEN m->'ledgerCard'
                                           ELSE (m - 'reason' - 'reasonDetail' - 'notes' - 'makeupEligible' - 'madeUp'
                                                   - 'cardNote' - 'bandLessonId' - 'ledgerTeacherId' - 'ledgerCard')
                                                || CASE WHEN NULLIF(m->>'ledgerTeacherId', '') IS NOT NULL
                                                        THEN jsonb_build_object('teacherId', m->>'ledgerTeacherId') ELSE '{}'::jsonb END
                                      END ORDER BY ord)
                             FROM jsonb_array_elements(mine) WITH ORDINALITY AS mj(m, ord)));
                END IF;
                applied := true;

              ELSIF cons = 'catchup' AND stamp_kind = 'absent' THEN
                ae := ae || jsonb_build_object(
                        'attended', false,
                        'absence', jsonb_build_object(
                           'reason',         COALESCE(NULLIF(abs_in->>'reason', ''), 'other'),
                           'reasonDetail',   COALESCE(abs_in->>'reasonDetail', ''),
                           'notes',          COALESCE(abs_in->>'notes', ''),
                           'makeupEligible', false,
                           'suggestOwed',    abs_in->'suggestOwed' = 'true'::jsonb));
                applied := true;

              ELSIF cons = 'catchup' AND stamp_kind = 'clear' THEN
                IF NOT (ae ? 'absentCatchupSnapshot') THEN
                  ae := (ae - 'absence') || jsonb_build_object('attended', NULL);
                  applied := true;
                END IF;

              ELSIF cons = 'free' AND stamp_kind = 'absent' THEN
                ae := ae || jsonb_build_object('attended', false);
                applied := true;

              ELSIF cons = 'free' AND stamp_kind = 'clear' THEN
                ae := (ae - 'absence') || jsonb_build_object('attended', NULL);
                applied := true;
              END IF;

              IF applied THEN  -- rule 7
                ae := ae || jsonb_build_object('writerTeacherId', te->'writerTeacherId',
                                               'teacherWrittenAt', te->'writtenAt');
              END IF;
            END IF;
            ms_out := ms_out || jsonb_build_array(ae);
          END LOOP;
          band_a := jsonb_set(band_a, '{memberStates}', ms_out);
        END IF;

        cur_lessons := (SELECT jsonb_agg(CASE WHEN ord = a_pos THEN band_a ELSE x END ORDER BY ord)
                        FROM jsonb_array_elements(cur_lessons) WITH ORDINALITY AS j(x, ord));
        UPDATE weekly_adjustments adjustments
        SET lessons = cur_lessons, missed = cur_missed
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
