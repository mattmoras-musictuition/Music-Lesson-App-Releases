-- Drain v3 fixtures: teacher attendance stamps. One school per case (s_*).
-- Every school has an admin NEW band card A1 (bandId BX, Friday) and a
-- teacher band copy (origin A1) in last week's teacher_actuals. Stamps carry
-- writerTeacherId 'tw' and an ISO writtenAt; T1 < T2 < ... < T9.
--
-- A stub catchups table holds the catch-up members' rows: the drain must
-- never read or write it.

CREATE TABLE catchups (id text PRIMARY KEY, enrolment_id text, resolves_enrolment_id text, week_key text, band_lesson_id text, day text, time text);
INSERT INTO catchups VALUES
  ('CU1', 'e1', 'e1', pw(), 'A1', 'Friday', '13:00'),
  ('CU2', 'e2', 'e2', pw(), 'A1', 'Friday', '13:00'),
  ('CU3', 'e3', 'e3', pw(), 'A1', 'Friday', '13:00');

-- Entry builders (fixture-only helpers)
CREATE FUNCTION ent(enr text, cons text, extra jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('enrolmentId', enr, 'studentId', 's' || substr(enr, 2), 'instrument', 'Guitar',
           'consumption', cons, 'catchupId', NULL, 'consumedWeekKey', NULL, 'fee', NULL,
           'attended', NULL, 'writerTeacherId', NULL) || extra $$;
CREATE FUNCTION card(id text, enr text, extra jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', id, 'day', 'Friday', 'start', '09:00', 'end', '09:30', 'slotId', 'sl9',
           'teacherId', 'tq', 'enrolmentId', enr, 'studentId', 's' || substr(enr, 2), 'instrument', 'Guitar',
           'schoolId', 'x') || extra $$;
CREATE FUNCTION band_a1(ms jsonb, ledger jsonb DEFAULT '[]') RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_array(jsonb_build_object('id', 'A1', 'isBandSession', true, 'bandId', 'BX', 'bandName', 'Riptide',
           'day', 'Friday', 'start', '13:00', 'end', '13:30', 'members', '[]'::jsonb,
           'removedLessons', ledger, 'memberStates', ms)) $$;
CREATE FUNCTION copy_a1(ms jsonb) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_array(jsonb_build_object('id', 'TC', 'isBandSession', true, 'bandId', 'BX', 'originBandLessonId', 'A1',
           'day', 'Friday', 'start', '13:00', 'end', '13:30', 'teacherId', 'tw', 'memberStates', ms)) $$;
CREATE FUNCTION stamp(enr text, att jsonb, at text, absence jsonb DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$
  SELECT ent(enr, 'free') - 'consumption'
         || jsonb_build_object('consumption', 'teacher-sent', 'attended', att, 'absence', COALESCE(absence, 'null'::jsonb),
                               'writerTeacherId', 'tw', 'writtenAt', at) $$;
CREATE FUNCTION ts(n int) RETURNS text LANGUAGE sql AS $$ SELECT '2026-09-2' || n || 'T01:00:00.000Z' $$;
-- absence payloads
CREATE FUNCTION absn(reason text, eligible boolean, suggest boolean DEFAULT false) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('reason', reason, 'reasonDetail', 'Camp', 'notes', 'note', 'makeupEligible', eligible, 'suggestOwed', suggest) $$;
-- a teacher-owned regular band miss made from card C1 (what rule 2 writes)
CREATE FUNCTION tmiss(reason text) RETURNS jsonb LANGUAGE sql AS $$
  SELECT (card('C1', 'e1') - 'teacherId') || jsonb_build_object('reason', reason, 'reasonDetail', 'Camp', 'notes', 'note',
           'makeupEligible', true, 'madeUp', false, 'cardNote', '', 'bandLessonId', 'A1', 'ledgerTeacherId', 'tq', 'ledgerCard', card('C1', 'e1')) $$;

-- s_reg_abs: regular absent → ledger card moves to missed in cluster-5 shape.
INSERT INTO weekly_adjustments VALUES (NULL, pw(), 's_reg_abs', band_a1(jsonb_build_array(ent('e1', 'regular')), jsonb_build_array(card('C1', 'e1'))), '[]', '', '', '[]');
INSERT INTO teacher_actuals VALUES ('ta_s_reg_abs', pw(), 's_reg_abs', 'tw', copy_a1(jsonb_build_array(stamp('e1', 'false', ts(1), absn('informed_absence', true)))), '[]');

-- s_reg_abs_fb: ledger card without enrolmentId (studentId+instrument match); miss takes the entry's enrolmentId.
INSERT INTO weekly_adjustments VALUES (NULL, pw(), 's_reg_abs_fb', band_a1(jsonb_build_array(ent('e1', 'regular')), jsonb_build_array(card('C1', 'e1') - 'enrolmentId' - 'teacherId')), '[]', '', '', '[]');
INSERT INTO teacher_actuals VALUES ('ta_s_reg_abs_fb', pw(), 's_reg_abs_fb', 'tw', copy_a1(jsonb_build_array(stamp('e1', 'false', ts(1), absn('uninformed_absence', false)))), '[]');

-- s_reg_update: teacher-owned miss exists; newer absent stamp updates reason fields only.
INSERT INTO weekly_adjustments VALUES (NULL, pw(), 's_reg_update',
  band_a1(jsonb_build_array(ent('e1', 'regular', jsonb_build_object('writerTeacherId', 'tw', 'teacherWrittenAt', ts(1))))),
  jsonb_build_array(tmiss('informed_absence')), '', '', '[]');
INSERT INTO teacher_actuals VALUES ('ta_s_reg_update', pw(), 's_reg_update', 'tw', copy_a1(jsonb_build_array(stamp('e1', 'false', ts(2), absn('teacher_absent', false)))), '[]');

-- s_reg_clear: teacher-owned miss; newer clear stamp moves it back to the ledger.
INSERT INTO weekly_adjustments VALUES (NULL, pw(), 's_reg_clear',
  band_a1(jsonb_build_array(ent('e1', 'regular', jsonb_build_object('writerTeacherId', 'tw', 'teacherWrittenAt', ts(1))))),
  jsonb_build_array(tmiss('informed_absence')), '', '', '[]');
INSERT INTO teacher_actuals VALUES ('ta_s_reg_clear', pw(), 's_reg_clear', 'tw', copy_a1(jsonb_build_array(stamp('e1', 'null', ts(2)))), '[]');

-- s_reg_noledger: regular member with no ledger card → not applied, entry unstamped.
INSERT INTO weekly_adjustments VALUES (NULL, pw(), 's_reg_noledger', band_a1(jsonb_build_array(ent('e1', 'regular'))), '[]', '', '', '[]');
INSERT INTO teacher_actuals VALUES ('ta_s_reg_noledger', pw(), 's_reg_noledger', 'tw', copy_a1(jsonb_build_array(stamp('e1', 'false', ts(1), absn('informed_absence', true)))), '[]');

-- s_admin_reg: ADMIN-recorded regular absence (miss, entry has no writer) wins over a newer teacher clear.
INSERT INTO weekly_adjustments VALUES (NULL, pw(), 's_admin_reg',
  band_a1(jsonb_build_array(ent('e1', 'regular', jsonb_build_object('adminOverrideAt', ts(1))))),
  jsonb_build_array(tmiss('uninformed_absence')), '', '', '[]');
INSERT INTO teacher_actuals VALUES ('ta_s_admin_reg', pw(), 's_admin_reg', 'tw', copy_a1(jsonb_build_array(stamp('e1', 'null', ts(9)))), '[]');

-- s_admin_cu: ADMIN-recorded catch-up absence (attended false, no writer) wins over a newer teacher clear.
INSERT INTO weekly_adjustments VALUES (NULL, pw(), 's_admin_cu',
  band_a1(jsonb_build_array(ent('e1', 'catchup', jsonb_build_object('catchupId', 'CU1', 'attended', false,
          'absence', absn('informed_absence', false) - 'suggestOwed')))), '[]', '', '', '[]');
INSERT INTO teacher_actuals VALUES ('ta_s_admin_cu', pw(), 's_admin_cu', 'tw', copy_a1(jsonb_build_array(stamp('e1', 'null', ts(9)))), '[]');

-- s_skip_teacher_ts: stamp writtenAt equal to / older than teacherWrittenAt → skip.
INSERT INTO weekly_adjustments VALUES (NULL, pw(), 's_skip_teacher_ts',
  band_a1(jsonb_build_array(ent('e1', 'free', jsonb_build_object('writerTeacherId', 'tw', 'teacherWrittenAt', ts(5))),
                            ent('e2', 'free', jsonb_build_object('writerTeacherId', 'tw', 'teacherWrittenAt', ts(5))))), '[]', '', '', '[]');
INSERT INTO teacher_actuals VALUES ('ta_s_skip_teacher_ts', pw(), 's_skip_teacher_ts', 'tw',
  copy_a1(jsonb_build_array(stamp('e1', 'false', ts(5)), stamp('e2', 'false', ts(4)))), '[]');

-- s_stale_after_undo: admin undid the teacher's regular absence at T5 (miss back in
-- ledger, writer cleared); the teacher row is re-sent with the old T3 stamp → skip.
INSERT INTO weekly_adjustments VALUES (NULL, pw(), 's_stale_after_undo',
  band_a1(jsonb_build_array(ent('e1', 'regular', jsonb_build_object('teacherWrittenAt', ts(3), 'adminOverrideAt', ts(5)))),
          jsonb_build_array(card('C1', 'e1'))), '[]', '', '', '[]');
INSERT INTO teacher_actuals VALUES ('ta_s_stale_after_undo', pw(), 's_stale_after_undo', 'tw',
  copy_a1(jsonb_build_array(stamp('e1', 'false', ts(3), absn('informed_absence', true)))), '[]');

-- s_newer_after_undo: same, but a NEW teacher mark at T6 → applied.
INSERT INTO weekly_adjustments VALUES (NULL, pw(), 's_newer_after_undo',
  band_a1(jsonb_build_array(ent('e1', 'regular', jsonb_build_object('teacherWrittenAt', ts(3), 'adminOverrideAt', ts(5)))),
          jsonb_build_array(card('C1', 'e1'))), '[]', '', '', '[]');
INSERT INTO teacher_actuals VALUES ('ta_s_newer_after_undo', pw(), 's_newer_after_undo', 'tw',
  copy_a1(jsonb_build_array(stamp('e1', 'false', ts(6), absn('informed_absence', true)))), '[]');

-- s_unattr: unattributed (null), not_in_session, forward and billed members → ignored.
INSERT INTO weekly_adjustments VALUES (NULL, pw(), 's_unattr',
  band_a1(jsonb_build_array(ent('e1', NULL), ent('e2', 'not_in_session'), ent('e3', 'forward'), ent('e4', 'billed'))), '[]', '', '', '[]');
INSERT INTO teacher_actuals VALUES ('ta_s_unattr', pw(), 's_unattr', 'tw',
  copy_a1(jsonb_build_array(stamp('e1', 'false', ts(1)), stamp('e2', 'false', ts(1)), stamp('e3', 'false', ts(1)), stamp('e4', 'false', ts(1)))), '[]');

-- s_cu_abs: catch-up absent with suggestOwed; makeupEligible forced false; row untouched.
INSERT INTO weekly_adjustments VALUES (NULL, pw(), 's_cu_abs',
  band_a1(jsonb_build_array(ent('e1', 'catchup', jsonb_build_object('catchupId', 'CU1', 'consumedWeekKey', '2026-08-24', 'fee', 30)))), '[]', '', '', '[]');
INSERT INTO teacher_actuals VALUES ('ta_s_cu_abs', pw(), 's_cu_abs', 'tw',
  copy_a1(jsonb_build_array(stamp('e1', 'false', ts(1), absn('informed_absence', true, true)))), '[]');

-- s_cu_clear: teacher-owned catch-up absence cleared by a newer stamp.
INSERT INTO weekly_adjustments VALUES (NULL, pw(), 's_cu_clear',
  band_a1(jsonb_build_array(ent('e2', 'catchup', jsonb_build_object('catchupId', 'CU2', 'attended', false,
          'absence', absn('informed_absence', false, true), 'writerTeacherId', 'tw', 'teacherWrittenAt', ts(1))))), '[]', '', '', '[]');
INSERT INTO teacher_actuals VALUES ('ta_s_cu_clear', pw(), 's_cu_clear', 'tw', copy_a1(jsonb_build_array(stamp('e2', 'null', ts(2)))), '[]');

-- s_cu_snapshot: an owed-on absence (snapshot held) is never cleared by the drain.
INSERT INTO weekly_adjustments VALUES (NULL, pw(), 's_cu_snapshot',
  band_a1(jsonb_build_array(ent('e3', 'catchup', jsonb_build_object('catchupId', NULL, 'attended', false, 'writerTeacherId', 'tw',
          'absence', absn('informed_absence', true), 'absentCatchupSnapshot', jsonb_build_object('id', 'CU3'))))), '[]', '', '', '[]');
INSERT INTO teacher_actuals VALUES ('ta_s_cu_snapshot', pw(), 's_cu_snapshot', 'tw', copy_a1(jsonb_build_array(stamp('e3', 'null', ts(9)))), '[]');

-- s_free: free absent, and a teacher-owned free absence cleared.
INSERT INTO weekly_adjustments VALUES (NULL, pw(), 's_free',
  band_a1(jsonb_build_array(ent('e1', 'free'),
                            ent('e2', 'free', jsonb_build_object('attended', false, 'writerTeacherId', 'tw', 'teacherWrittenAt', ts(1))))), '[]', '', '', '[]');
INSERT INTO teacher_actuals VALUES ('ta_s_free', pw(), 's_free', 'tw',
  copy_a1(jsonb_build_array(stamp('e1', 'false', ts(2)), stamp('e2', 'null', ts(2)))), '[]');

-- s_bad_stamps: missing writtenAt, unparseable writtenAt, attended true, stamp
-- for an enrolment the admin band does not have → all ignored, drain completes.
INSERT INTO weekly_adjustments VALUES (NULL, pw(), 's_bad_stamps',
  band_a1(jsonb_build_array(ent('e1', 'free'), ent('e2', 'free'), ent('e3', 'free'))), '[]', '', '', '[]');
INSERT INTO teacher_actuals VALUES ('ta_s_bad_stamps', pw(), 's_bad_stamps', 'tw',
  copy_a1(jsonb_build_array(stamp('e1', 'false', ts(1)) - 'writtenAt', stamp('e2', 'false', 'yesterday-ish'),
                            stamp('e3', 'true', ts(1)), stamp('e9', 'false', ts(1)))), '[]');
