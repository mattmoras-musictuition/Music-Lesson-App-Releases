-- Drain v3 assertions (run after checks.sql, whose helpers they reuse).
-- Output: one row per check, "PASS"/"FAIL".

CREATE OR REPLACE FUNCTION a1(s text) RETURNS jsonb LANGUAGE sql AS
$$ SELECT el(wa_lessons(s), 'A1') $$;
CREATE OR REPLACE FUNCTION ent_of(s text, enr text) RETURNS jsonb LANGUAGE sql AS
$$ SELECT ms(wa_lessons(s), 'A1', enr) $$;
CREATE OR REPLACE FUNCTION fixture_ent(s text, enr text) RETURNS jsonb LANGUAGE sql AS
$$ SELECT m FROM fixture_snapshot f, jsonb_array_elements(el(f.lessons, 'A1')->'memberStates') m
   WHERE f.school_id = s AND m->>'enrolmentId' = enr LIMIT 1 $$;

SELECT CASE WHEN pass THEN 'PASS' ELSE 'FAIL' END AS result, name, got
FROM (VALUES
  -- rule 2: regular absent
  ('v3 rule 2: regular absent → ledger card becomes a cluster-5 miss',
     wa_missed('s_reg_abs') = jsonb_build_array(
       (card('C1','e1') - 'teacherId') || jsonb_build_object('reason','informed_absence','reasonDetail','Camp','notes','note',
         'makeupEligible',true,'madeUp',false,'cardNote','','bandLessonId','A1','ledgerTeacherId','tq','ledgerCard',card('C1','e1'))),
     wa_missed('s_reg_abs')::text),
  ('v3 rule 2: miss has no teacherId / writerTeacherId / isBandSession',
     NOT (el(wa_missed('s_reg_abs'),'C1') ?| ARRAY['teacherId','writerTeacherId','isBandSession']), el(wa_missed('s_reg_abs'),'C1')::text),
  ('v3 rule 2: ledger emptied; band times unchanged',
     a1('s_reg_abs')->'removedLessons' = '[]' AND a1('s_reg_abs')->>'start' = '13:00', (a1('s_reg_abs') - 'memberStates')::text),
  ('v3 rule 2+7: regular entry stamped, attended stays null',
     ent_of('s_reg_abs','e1') = ent('e1','regular', jsonb_build_object('writerTeacherId','tw','teacherWrittenAt',ts(1))),
     ent_of('s_reg_abs','e1')::text),
  ('v3 rule 2: fallback ledger card (no enrolmentId) → miss takes the entry''s enrolmentId',
     el(wa_missed('s_reg_abs_fb'),'C1')->>'enrolmentId' = 'e1' AND el(wa_missed('s_reg_abs_fb'),'C1')->>'reason' = 'uninformed_absence'
     AND el(wa_missed('s_reg_abs_fb'),'C1')->'makeupEligible' = 'false' AND NOT (el(wa_missed('s_reg_abs_fb'),'C1') ? 'ledgerTeacherId')
     AND a1('s_reg_abs_fb')->'removedLessons' = '[]',
     wa_missed('s_reg_abs_fb')::text),
  ('v3 rule 2: existing teacher miss → reason fields updated only, no duplicate',
     wa_missed('s_reg_update') = jsonb_build_array(tmiss('informed_absence') || jsonb_build_object('reason','teacher_absent','makeupEligible',false))
     AND ent_of('s_reg_update','e1')->>'teacherWrittenAt' = ts(2),
     wa_missed('s_reg_update')::text),
  ('v3 rule 2: no ledger card → nothing written, entry unstamped',
     wa_missed('s_reg_noledger') = '[]' AND ent_of('s_reg_noledger','e1') = ent('e1','regular'),
     ent_of('s_reg_noledger','e1')::text),
  -- rule 3: regular clear
  ('v3 rule 3: teacher clear → miss back to ledger via ledgerCard',
     wa_missed('s_reg_clear') = '[]' AND a1('s_reg_clear')->'removedLessons' = jsonb_build_array(card('C1','e1'))
     AND ent_of('s_reg_clear','e1')->>'teacherWrittenAt' = ts(2) AND ent_of('s_reg_clear','e1')->>'writerTeacherId' = 'tw',
     wa_missed('s_reg_clear')::text || ' | ' || (a1('s_reg_clear')->'removedLessons')::text),
  -- rule 1 skips
  ('v3 rule 1: admin-recorded regular absence wins over a newer teacher clear',
     wa_missed('s_admin_reg') = jsonb_build_array(tmiss('uninformed_absence')) AND ent_of('s_admin_reg','e1') = fixture_ent('s_admin_reg','e1'),
     wa_missed('s_admin_reg')::text),
  ('v3 rule 1: admin-recorded catch-up absence wins over a newer teacher clear',
     ent_of('s_admin_cu','e1') = fixture_ent('s_admin_cu','e1'), ent_of('s_admin_cu','e1')::text),
  ('v3 rule 1: writtenAt equal to teacherWrittenAt → skip',
     ent_of('s_skip_teacher_ts','e1') = fixture_ent('s_skip_teacher_ts','e1'), ent_of('s_skip_teacher_ts','e1')::text),
  ('v3 rule 1: writtenAt older than teacherWrittenAt → skip',
     ent_of('s_skip_teacher_ts','e2') = fixture_ent('s_skip_teacher_ts','e2'), ent_of('s_skip_teacher_ts','e2')::text),
  ('v3 rule 1: stale stamp re-sent after admin undo → skip (card stays in ledger)',
     wa_missed('s_stale_after_undo') = '[]' AND a1('s_stale_after_undo')->'removedLessons' = jsonb_build_array(card('C1','e1'))
     AND ent_of('s_stale_after_undo','e1') = fixture_ent('s_stale_after_undo','e1'),
     wa_missed('s_stale_after_undo')::text),
  ('v3 rule 1: newer teacher mark after admin undo → applied',
     ids(wa_missed('s_newer_after_undo')) = 'C1' AND ent_of('s_newer_after_undo','e1')->>'teacherWrittenAt' = ts(6)
     AND ent_of('s_newer_after_undo','e1')->>'adminOverrideAt' = ts(5),
     ids(wa_missed('s_newer_after_undo'))),
  ('v3 rule 1: unattributed / not_in_session / forward / billed ignored',
     a1('s_unattr')->'memberStates' = (SELECT el(lessons,'A1')->'memberStates' FROM fixture_snapshot WHERE school_id = 's_unattr'),
     (a1('s_unattr')->'memberStates')::text),
  ('v3 rule 1: missing / bad writtenAt, attended true, unknown enrolment → ignored',
     a1('s_bad_stamps')->'memberStates' = (SELECT el(lessons,'A1')->'memberStates' FROM fixture_snapshot WHERE school_id = 's_bad_stamps'),
     (a1('s_bad_stamps')->'memberStates')::text),
  -- rule 4/5: catch-up
  ('v3 rule 4: catch-up absent → attended false, suggestOwed kept, makeupEligible false, row fields kept',
     ent_of('s_cu_abs','e1') = ent('e1','catchup', jsonb_build_object('catchupId','CU1','consumedWeekKey','2026-08-24','fee',30,
        'attended',false,'absence',absn('informed_absence',false,true),'writerTeacherId','tw','teacherWrittenAt',ts(1))),
     ent_of('s_cu_abs','e1')::text),
  ('v3 rule 5: teacher catch-up clear → attended null, absence gone, catchupId kept',
     ent_of('s_cu_clear','e2') = ent('e2','catchup', jsonb_build_object('catchupId','CU2','writerTeacherId','tw','teacherWrittenAt',ts(2))),
     ent_of('s_cu_clear','e2')::text),
  ('v3 rule 5: owed-on absence (snapshot) never cleared by the drain',
     ent_of('s_cu_snapshot','e3') = fixture_ent('s_cu_snapshot','e3'), ent_of('s_cu_snapshot','e3')::text),
  ('v3: catchups table untouched',
     (SELECT string_agg(row_to_json(c)::text, ',' ORDER BY id) FROM catchups c) = (SELECT snap FROM catchups_snapshot),
     (SELECT count(*)::text FROM catchups)),
  -- rule 6: free
  ('v3 rule 6: free absent → attended false, stamped',
     ent_of('s_free','e1') = ent('e1','free', jsonb_build_object('attended',false,'writerTeacherId','tw','teacherWrittenAt',ts(2))),
     ent_of('s_free','e1')::text),
  ('v3 rule 6: free clear → attended null',
     ent_of('s_free','e2') = ent('e2','free', jsonb_build_object('writerTeacherId','tw','teacherWrittenAt',ts(2))),
     ent_of('s_free','e2')::text),
  -- drain bookkeeping
  ('v3: band copies never appended (one band card per stamp school)',
     (SELECT bool_and(jsonb_array_length(lessons) = 1) FROM weekly_adjustments WHERE school_id LIKE 's\_%'),
     (SELECT string_agg(school_id || ':' || ids(lessons), ' ') FROM weekly_adjustments WHERE school_id LIKE 's\_%' AND jsonb_array_length(lessons) <> 1)),
  ('v3: stamp rows cleared from teacher_actuals',
     NOT EXISTS (SELECT 1 FROM teacher_actuals WHERE school_id LIKE 's\_%'),
     (SELECT string_agg(id, ',') FROM teacher_actuals WHERE school_id LIKE 's\_%'))
) AS c(name, pass, got)
ORDER BY name;
