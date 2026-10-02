-- Assertions run after SELECT drain_teacher_actuals(NULL, true).
-- Output: one row per check, "PASS"/"FAIL". run.sh fails on any v2 FAIL.

CREATE OR REPLACE FUNCTION wa_lessons(s text, wk text DEFAULT pw()) RETURNS jsonb LANGUAGE sql AS
$$ SELECT lessons FROM weekly_adjustments WHERE school_id = s AND week_key = wk $$;
CREATE OR REPLACE FUNCTION wa_missed(s text, wk text DEFAULT pw()) RETURNS jsonb LANGUAGE sql AS
$$ SELECT missed FROM weekly_adjustments WHERE school_id = s AND week_key = wk $$;
-- ids in array order, e.g. 'A1,TR'
CREATE OR REPLACE FUNCTION ids(arr jsonb) RETURNS text LANGUAGE sql AS
$$ SELECT COALESCE(string_agg(x->>'id', ',' ORDER BY o), '') FROM jsonb_array_elements(arr) WITH ORDINALITY j(x, o) $$;
CREATE OR REPLACE FUNCTION el(arr jsonb, i text) RETURNS jsonb LANGUAGE sql AS
$$ SELECT x FROM jsonb_array_elements(arr) x WHERE x->>'id' = i LIMIT 1 $$;
CREATE OR REPLACE FUNCTION ms(arr jsonb, i text, enr text) RETURNS jsonb LANGUAGE sql AS
$$ SELECT m FROM jsonb_array_elements(el(arr, i)->'memberStates') m WHERE m->>'enrolmentId' = enr LIMIT 1 $$;
CREATE OR REPLACE FUNCTION ta(i text) RETURNS text LANGUAGE sql AS
$$ SELECT COALESCE((SELECT ids(lessons) || ' | ' || ids(missed) FROM teacher_actuals WHERE id = i), '<deleted>') $$;

SELECT CASE WHEN pass THEN 'PASS' ELSE 'FAIL' END AS result, name, got
FROM (VALUES
  -- origin-id match
  ('origin: one band card, A.id kept, no double',     ids(wa_lessons('b_origin')) = 'A1,TR',                         ids(wa_lessons('b_origin'))),
  ('origin: start/end/slotId from T',                  el(wa_lessons('b_origin'),'A1')->>'start' = '14:00'
                                                       AND el(wa_lessons('b_origin'),'A1')->>'end' = '14:30'
                                                       AND el(wa_lessons('b_origin'),'A1')->>'slotId' = 's2',        (el(wa_lessons('b_origin'),'A1') - 'members')::text),
  ('origin: bandId/bucket/members/day are A''s',       el(wa_lessons('b_origin'),'A1')->>'bandId' = 'BX'
                                                       AND el(wa_lessons('b_origin'),'A1')->>'bucket_id' = 'bk1'
                                                       AND el(wa_lessons('b_origin'),'A1')->'members' = '[{"studentId":"sm1","instrument":"Guitar"}]'
                                                       AND el(wa_lessons('b_origin'),'A1')->>'day' = 'Friday'
                                                       AND NOT (el(wa_lessons('b_origin'),'A1') ? 'originBandLessonId'),
                                                                                                                       el(wa_lessons('b_origin'),'A1')::text),
  -- two sessions, one day
  ('two sessions: both kept, only A2 updated',         ids(wa_lessons('b_two')) = 'A1,A2'
                                                       AND el(wa_lessons('b_two'),'A1')->>'start' = '13:00'
                                                       AND el(wa_lessons('b_two'),'A2')->>'start' = '15:15'
                                                       AND el(wa_lessons('b_two'),'A2')->>'end' = '15:45',          wa_lessons('b_two')::text),
  ('two sessions: A2 slotId kept (T has none)',        el(wa_lessons('b_two'),'A2')->>'slotId' = 's2a',               el(wa_lessons('b_two'),'A2')::text),
  -- fallback
  ('fallback unique: merged, no double',               ids(wa_lessons('b_fb_unique')) = 'A1'
                                                       AND el(wa_lessons('b_fb_unique'),'A1')->>'start' = '13:05'
                                                       AND jsonb_array_length(el(wa_lessons('b_fb_unique'),'A1')->'removedLessons') = 1,
                                                                                                                       wa_lessons('b_fb_unique')::text),
  ('fallback ambiguous, legacy T: appended',           ids(wa_lessons('b_fb_ambig_legacy')) = 'A1,A2,T4',             ids(wa_lessons('b_fb_ambig_legacy'))),
  ('fallback ambiguous, new T: dropped',               ids(wa_lessons('b_fb_ambig_new')) = 'A1,A2',                   ids(wa_lessons('b_fb_ambig_new'))),
  -- cross-day
  ('cross-day: A keeps Friday, times from T',          ids(wa_lessons('b_crossday')) = 'A1'
                                                       AND el(wa_lessons('b_crossday'),'A1')->>'day' = 'Friday'
                                                       AND el(wa_lessons('b_crossday'),'A1')->>'start' = '10:00',  wa_lessons('b_crossday')::text),
  -- orphans
  ('orphan new-band copy dropped',                     ids(wa_lessons('b_orphan_new')) = '',                          ids(wa_lessons('b_orphan_new'))),
  ('orphan legacy copies appended',                    ids(wa_lessons('b_orphan_legacy')) = 'T8,T9',                  ids(wa_lessons('b_orphan_legacy'))),
  -- B2(a)
  ('B2a: E1 (enrolmentId) + E2 (fallback) skipped; RX still removed',
                                                       ids(wa_lessons('b_b2a')) = 'A1,E3,E4',                         ids(wa_lessons('b_b2a'))),
  ('B2a: missed M1 skipped, M2 appended',              ids(wa_missed('b_b2a')) = 'M2',                                ids(wa_missed('b_b2a'))),
  ('B2a: legacy band ledger does not skip',            ids(wa_lessons('b_b2a_legacy')) = 'A1,E1',                     ids(wa_lessons('b_b2a_legacy'))),
  -- B2(b)
  ('B2b: E1 skipped by studentId+instrument, E2 kept', ids(wa_lessons('b_b2b')) = 'A1,E2',                            ids(wa_lessons('b_b2b'))),
  ('B2b: admin band miss untouched',                   ids(wa_missed('b_b2b')) = 'BM',                                ids(wa_missed('b_b2b'))),
  -- B3
  ('B3: band-stamped teacher miss ignored; admin misses stand',
                                                       ids(wa_missed('b_b3')) = 'BM2,AM',                             ids(wa_missed('b_b3'))),
  ('B3: drained entry cleared from teacher_actuals',   ta('ta_b_b3') = '<deleted>',                                   ta('ta_b_b3')),
  -- memberStates
  ('memberStates inert: A unchanged',                  el(wa_lessons('b_ms_inert'),'A1')->'memberStates'
                                                       = '[{"enrolmentId":"e1","studentId":"s1","instrument":"Guitar","consumption":"regular","catchupId":null,"consumedWeekKey":null,"fee":null,"attended":null,"writerTeacherId":null}]',
                                                                                                                       (el(wa_lessons('b_ms_inert'),'A1')->'memberStates')::text),
  ('v2-only memberStates stamped: e1 attended/absence/writer from T',
                                                       ms(wa_lessons('b_ms_stamped'),'A1','e1')
                                                       = '{"enrolmentId":"e1","consumption":"regular","catchupId":"CU1","consumedWeekKey":"2099-01-05","fee":40,"attended":false,"absence":{"reason":"Sick"},"writerTeacherId":"tw","absentCatchupSnapshot":{"x":1}}',
                                                                                                                       ms(wa_lessons('b_ms_stamped'),'A1','e1')::text),
  ('v2-only memberStates stamped: e2 absence cleared, A''s consumption kept',
                                                       ms(wa_lessons('b_ms_stamped'),'A1','e2')
                                                       = '{"enrolmentId":"e2","consumption":"catchup","catchupId":"CU2","fee":null,"attended":true,"writerTeacherId":"tw"}',
                                                                                                                       ms(wa_lessons('b_ms_stamped'),'A1','e2')::text),
  ('v2-only memberStates stamped: e4 unchanged, T''s e3 not added, order kept',
                                                       ms(wa_lessons('b_ms_stamped'),'A1','e4') = '{"enrolmentId":"e4","consumption":"free","attended":null,"writerTeacherId":null}'
                                                       AND (SELECT string_agg(m->>'enrolmentId', ',' ORDER BY o) FROM jsonb_array_elements(el(wa_lessons('b_ms_stamped'),'A1')->'memberStates') WITH ORDINALITY j(m,o)) = 'e1,e2,e4',
                                                                                                                       (el(wa_lessons('b_ms_stamped'),'A1')->'memberStates')::text),
  -- catch-ups, future split, non-band core
  ('catch-ups: past XC/YC not appended',               ids(wa_lessons('nb_main')) = 'L4,L5,AB,X1,X2,X3' AND ids(wa_missed('nb_main')) = 'M2,Y1',
                                                                                                                       ids(wa_lessons('nb_main')) || ' | ' || ids(wa_missed('nb_main'))),
  ('catch-ups: past row cleared (XC, YC, unknown-day XU gone)', ta('ta_nb1') = '<deleted>',                           ta('ta_nb1')),
  ('future: future-week row kept incl. future catch-up', ta('ta_nb1f') = 'F1,FC | FM',                                ta('ta_nb1f')),
  ('future: mixed row keeps only Sunday',              ta('ta_nb3') = 'P7 | PM7',                                     ta('ta_nb3')),
  ('future: future band copy stays in teacher_actuals', ta('ta_b_future') = 'T12 | '
                                                       AND el(wa_lessons('b_future', fw()),'A1')->>'start' = '13:00', ta('ta_b_future')),
  ('insert-if-missing: nb_new row created',            ids(wa_lessons('nb_new')) = 'N1',                              ids(wa_lessons('nb_new')))
) AS c(name, pass, got)
ORDER BY name;
