-- Assertions for drain v4 against teacher app v1.20.0 shapes
-- (v4_teacher_fixtures.sql). Uses the helpers from checks.sql.
-- Output: one row per check, "PASS"/"FAIL".

SELECT CASE WHEN pass THEN 'PASS' ELSE 'FAIL' END AS result, name, got
FROM (VALUES
  -- admin edit later than the copy's newest importedAt → day skipped
  ('t_admin_wins: admin Thursday untouched (W1 keeps the admin''s 10:30), no miss appended',
     ids(wa_lessons('t_admin_wins')) = 'W1,W2' AND el(wa_lessons('t_admin_wins'),'W1')->>'start' = '10:30'
     AND ids(wa_missed('t_admin_wins')) = '',
     ids(wa_lessons('t_admin_wins')) || ' | ' || ids(wa_missed('t_admin_wins'))),
  ('t_admin_wins: skipped day still leaves teacher_actuals (no re-fire)',
     ta('ta_t_admin_wins') = '<deleted>',                                                    ta('ta_t_admin_wins')),
  -- teacher edit later → copy replaces the admin day
  ('t_teacher_wins: copy replaces W1, miss removes W2 and is appended',
     ids(wa_lessons('t_teacher_wins')) ~ '^tw[0-9]+$'
     AND (wa_lessons('t_teacher_wins')->0->>'sourceLessonId') = 'W1'
     AND (wa_lessons('t_teacher_wins')->0->>'start') = '10:00'
     AND ids(wa_missed('t_teacher_wins')) = 'mTW'
     AND (wa_missed('t_teacher_wins')->0->>'sourceLessonId') = 'W2',
     ids(wa_lessons('t_teacher_wins')) || ' | ' || ids(wa_missed('t_teacher_wins'))),
  -- sourceLessonId picks the right one of two same-instrument cards
  ('t_two_same: the miss removes L2 (moved, so start no longer matches); admin-added L1 kept',
     ids(wa_lessons('t_two_same')) = 'L1' AND ids(wa_missed('t_two_same')) = 'mL2',
     ids(wa_lessons('t_two_same')) || ' | ' || ids(wa_missed('t_two_same'))),
  ('t_two_same_old (v1.19.1, as today): the miss names no card — L2 survives beside it',
     ids(wa_lessons('t_two_same_old')) = 'L1,L2' AND ids(wa_missed('t_two_same_old')) = 'mL2o',
     ids(wa_lessons('t_two_same_old')) || ' | ' || ids(wa_missed('t_two_same_old'))),
  -- mixed: some entries lack importedAt
  ('t_mixed_skip: Thursday skipped as a whole (unstamped and unparseable entries too); legacy Friday drains',
     ids(wa_lessons('t_mixed_skip')) = 'X1,X2,t_mixed_skip_fri' AND ids(wa_missed('t_mixed_skip')) = '',
     ids(wa_lessons('t_mixed_skip')) || ' | ' || ids(wa_missed('t_mixed_skip'))),
  ('t_mixed_skip: teacher row drained',
     ta('ta_t_mixed_skip') = '<deleted>',                                                    ta('ta_t_mixed_skip')),
  ('t_mixed_drain: newest stamp beats the admin → whole Thursday drains, unstamped entries included',
     ids(wa_lessons('t_mixed_drain')) ~ '^md[0-9]+,md[0-9]+,t_mixed_drain_old,t_mixed_drain_bad,t_mixed_drain_fri$',
     ids(wa_lessons('t_mixed_drain'))),
  -- old and new teacher apps in one drain
  ('t_side: v1.19.1 copy drains as today (O1, O2 replaced; miss appended)',
     ids(wa_lessons('t_side')) ~ '^N1,N2,so[0-9]+$' AND ids(wa_missed('t_side')) = 'mO2',
     ids(wa_lessons('t_side')) || ' | ' || ids(wa_missed('t_side'))),
  ('t_side: v1.20.0 copy skipped — admin''s N1 14:05 kept, no N2 miss',
     el(wa_lessons('t_side'),'N1')->>'start' = '14:05' AND NOT (ids(wa_missed('t_side')) ~ 'mN2'),
     (el(wa_lessons('t_side'),'N1')->>'start') || ' | ' || ids(wa_missed('t_side'))),
  ('t_side: both teacher rows drained',
     ta('ta_t_side_old') = '<deleted>' AND ta('ta_t_side_new') = '<deleted>',               ta('ta_t_side_old') || ' / ' || ta('ta_t_side_new'))
) AS t(name, pass, got);
