-- Assertions for drain v4 (draft). Uses the helpers from checks.sql.
-- Output: one row per check, "PASS"/"FAIL".

SELECT CASE WHEN pass THEN 'PASS' ELSE 'FAIL' END AS result, name, got
FROM (VALUES
  -- m_live: the Thu 8 Oct fault
  ('m_live: missed lessons leave no admin card (Amelia, Oliver, group)',
     NOT (ids(wa_lessons('m_live')) ~ '(^|,)(x7sfv8ps|xx0g10wm|Grp)(,|$)'),            ids(wa_lessons('m_live'))),
  ('m_live: kept and legacy cards replaced, not doubled',
     NOT (ids(wa_lessons('m_live')) ~ '(^|,)(Kept|Leg|Dup1)(,|$)'),                    ids(wa_lessons('m_live'))),
  ('m_live: second enrolment and admin-added card untouched',
     ids(wa_lessons('m_live')) = 'Dup2,Added,FriA,cK,cLeg,cD1,cR',                      ids(wa_lessons('m_live'))),
  ('m_live: admin absence replaced by the teacher''s attended lesson',
     ids(wa_missed('m_live')) = 'mAm,mOl,mG',                                            ids(wa_missed('m_live'))),
  ('m_live: teacher row drained',
     ta('ta_m_live') = '<deleted>',                                                      ta('ta_m_live')),
  -- m_src: future sourceLessonId beats a mismatched enrolment
  ('m_src: sourceLessonId removes its card',
     ids(wa_lessons('m_src')) = '' AND ids(wa_missed('m_src')) = 'mS',                  ids(wa_lessons('m_src')) || ' | ' || ids(wa_missed('m_src'))),
  -- m_dup: student+instrument fallback narrowed by start time
  ('m_dup: missed second enrolment removed by start; admin-added third kept',
     ids(wa_lessons('m_dup')) = 'E3,cE1' AND ids(wa_missed('m_dup')) = 'mE2',           ids(wa_lessons('m_dup')) || ' | ' || ids(wa_missed('m_dup'))),
  -- d_skip / d_legacy: day_edited_at
  ('d_skip: admin-edited Thursday untouched, newer Friday copy drained',
     ids(wa_lessons('d_skip')) = 'DA,DB,cDF' AND ids(wa_missed('d_skip')) = '',         ids(wa_lessons('d_skip')) || ' | ' || ids(wa_missed('d_skip'))),
  ('d_skip: skipped day discarded from teacher_actuals (no re-fire)',
     ta('ta_d_skip') = '<deleted>',                                                      ta('ta_d_skip')),
  ('d_legacy: copy without importedAt drains as v3',
     ids(wa_lessons('d_legacy')) = 'cLA',                                                ids(wa_lessons('d_legacy')))
) AS t(name, pass, got);
