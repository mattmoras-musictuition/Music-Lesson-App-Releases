-- Fixtures for drain_teacher_actuals v4 (draft). Loaded on top of
-- fixtures.sql + v3_fixtures.sql. Schools prefixed m_ (missed accounting)
-- and d_ (day_edited_at skip).

-- ═════════ m_live: the Thu 8 Oct 2026 Moorabbin fault, field for field ═════════
-- Admin Thursday: Amelia (carries the teacher's own teacherId, archived and
-- hidden in admin), Oliver (no teacherId), Kept (teacher left it attended),
-- Leg (legacy: no enrolmentId, no teacherId), Grp (group), Dup1/Dup2 (one
-- student, two enrolments, same instrument — legitimate), Added (admin
-- added after the import; the copy knows nothing of it), and an admin
-- absence AbsR whose lesson the teacher recorded as attended.
-- The teacher app copied cards keep the admin card's fields with a NEW id;
-- its mark-missed entries carry lessonId = the COPY's id, studentId,
-- instrument, teacherId copied from the card, writerTeacherId — and no
-- enrolmentId or groupId (MyWeek.js confirmMissed).
INSERT INTO weekly_adjustments VALUES (NULL, pw(), 'm_live',
 '[{"id":"x7sfv8ps","day":"Thursday","start":"13:10","teacherId":"3ogbshd6","enrolmentId":"8lo5rf1u","studentId":"sAmelia","studentName":"Amelia Tarlamis","instrument":"Piano","writerTeacherId":null},
   {"id":"xx0g10wm","day":"Thursday","start":"10:00","teacherId":null,"enrolmentId":"fgvmtl6v","studentId":"sOliver","studentName":"Oliver Marchment","instrument":"Guitar","writerTeacherId":null},
   {"id":"Kept","day":"Thursday","start":"09:00","enrolmentId":"eK","studentId":"sK","instrument":"Piano"},
   {"id":"Leg","day":"Thursday","start":"09:30","studentId":"sL","instrument":"Drums"},
   {"id":"Grp","day":"Thursday","start":"11:00","isGroup":true,"groupId":"gG","studentIds":["sg1","sg2"]},
   {"id":"Dup1","day":"Thursday","start":"12:00","enrolmentId":"eD1","studentId":"sD","instrument":"Guitar"},
   {"id":"Dup2","day":"Thursday","start":"12:30","enrolmentId":"eD2","studentId":"sD","instrument":"Guitar"},
   {"id":"Added","day":"Thursday","start":"14:00","enrolmentId":"eNew","studentId":"sNew","instrument":"Violin"},
   {"id":"FriA","day":"Friday","start":"09:00","enrolmentId":"eF","studentId":"sF","instrument":"Piano"}]',
 '[{"id":"AbsR","day":"Thursday","start":"14:30","enrolmentId":"eR","studentId":"sR","instrument":"Flute","reason":"informed_absence"}]',
 '', 'g', '[]');
INSERT INTO teacher_actuals VALUES ('ta_m_live', pw(), 'm_live', '3ogbshd6',
 '[{"id":"cK","day":"Thursday","start":"09:00","enrolmentId":"eK","studentId":"sK","instrument":"Piano","writerTeacherId":"3ogbshd6","frozenTeacherId":"3ogbshd6"},
   {"id":"cLeg","day":"Thursday","start":"09:30","studentId":"sL","instrument":"Drums","writerTeacherId":"3ogbshd6","frozenTeacherId":"3ogbshd6"},
   {"id":"cD1","day":"Thursday","start":"12:00","enrolmentId":"eD1","studentId":"sD","instrument":"Guitar","writerTeacherId":"3ogbshd6","frozenTeacherId":"3ogbshd6"},
   {"id":"cR","day":"Thursday","start":"14:30","enrolmentId":"eR","studentId":"sR","instrument":"Flute","writerTeacherId":"3ogbshd6","frozenTeacherId":"3ogbshd6"}]',
 '[{"id":"mAm","lessonId":"cAm","day":"Thursday","start":"13:10","teacherId":"3ogbshd6","studentId":"sAmelia","studentName":"Amelia Tarlamis","instrument":"Piano","reason":"other","writerTeacherId":"3ogbshd6","frozenTeacherId":"3ogbshd6"},
   {"id":"mOl","lessonId":"cOl","day":"Thursday","start":"10:00","teacherId":null,"studentId":"sOliver","studentName":"Oliver Marchment","instrument":"Guitar","reason":"other","writerTeacherId":"3ogbshd6","frozenTeacherId":"3ogbshd6"},
   {"id":"mG","lessonId":"cG","day":"Thursday","start":"11:00","isGroup":true,"studentId":null,"studentName":"Group","reason":"other","writerTeacherId":"3ogbshd6","frozenTeacherId":"3ogbshd6"}]');

-- m_src: a future teacher app that carries sourceLessonId wins over every
-- other key (the copy's enrolment was re-minted).
INSERT INTO weekly_adjustments VALUES (NULL, pw(), 'm_src',
 '[{"id":"S1","day":"Tuesday","enrolmentId":"eOld","studentId":"sS","instrument":"Cello"}]', '[]', '', 'g', '[]');
INSERT INTO teacher_actuals VALUES ('ta_m_src', pw(), 'm_src', 'tS', '[]',
 '[{"id":"mS","sourceLessonId":"S1","day":"Tuesday","enrolmentId":"eNewer","studentId":"sS","instrument":"Cello","reason":"other","writerTeacherId":"tS","importedAt":"2026-01-01T00:00:00Z"}]');

-- ═════════ d_: day_edited_at skip (v4 only) ═════════
-- d_skip: the admin edited Thursday AFTER the copy → admin day untouched,
-- copy discarded. Friday: copy newer than the admin edit → drains.
INSERT INTO weekly_adjustments VALUES (NULL, pw(), 'd_skip',
 '[{"id":"DA","day":"Thursday","enrolmentId":"eA","studentId":"sA","instrument":"Piano"},
   {"id":"DB","day":"Thursday","enrolmentId":"eB","studentId":"sB","instrument":"Piano"},
   {"id":"DF","day":"Friday","enrolmentId":"eF","studentId":"sF","instrument":"Piano"}]',
 '[]', '', 'g', '[]', '{"Thursday":"2026-10-07T05:00:00Z","Friday":"2026-10-01T00:00:00Z"}');
INSERT INTO teacher_actuals VALUES ('ta_d_skip', pw(), 'd_skip', 'tD',
 '[{"id":"cDA","day":"Thursday","enrolmentId":"eA","studentId":"sA","instrument":"Piano","importedAt":"2026-10-05T00:00:00Z"},
   {"id":"cDF","day":"Friday","enrolmentId":"eF","studentId":"sF","instrument":"Piano","importedAt":"2026-10-06T00:00:00Z"}]',
 '[{"id":"mDB","day":"Thursday","studentId":"sB","instrument":"Piano","reason":"other","importedAt":"2026-10-05T00:00:00Z"}]');

-- d_legacy: same admin stamp, but the copy has no importedAt (today's
-- teacher app) → drains exactly as v3 would.
INSERT INTO weekly_adjustments VALUES (NULL, pw(), 'd_legacy',
 '[{"id":"LA","day":"Thursday","enrolmentId":"eA","studentId":"sA","instrument":"Piano"}]',
 '[]', '', 'g', '[]', '{"Thursday":"2026-10-07T05:00:00Z"}');
INSERT INTO teacher_actuals VALUES ('ta_d_legacy', pw(), 'd_legacy', 'tL',
 '[{"id":"cLA","day":"Thursday","enrolmentId":"eA","studentId":"sA","instrument":"Piano"}]', '[]');

-- m_dup: one student, two enrolments, same instrument. The teacher keeps the
-- 09:45 lesson (copy has its enrolment) and marks the 15:00 one missed (no
-- enrolment on the miss). E3 was added by the admin after the import (same
-- student and instrument, 15:30): the copy does not account for it.
INSERT INTO weekly_adjustments VALUES (NULL, pw(), 'm_dup',
 '[{"id":"E1","day":"Wednesday","start":"09:45","enrolmentId":"eE1","studentId":"sE","instrument":"Piano"},
   {"id":"E2","day":"Wednesday","start":"15:00","enrolmentId":"eE2","studentId":"sE","instrument":"Piano"},
   {"id":"E3","day":"Wednesday","start":"15:30","enrolmentId":"eE3","studentId":"sE","instrument":"Piano"}]',
 '[]', '', 'g', '[]');
INSERT INTO teacher_actuals VALUES ('ta_m_dup', pw(), 'm_dup', 'tE',
 '[{"id":"cE1","day":"Wednesday","start":"09:45","enrolmentId":"eE1","studentId":"sE","instrument":"Piano","writerTeacherId":"tE"}]',
 '[{"id":"mE2","lessonId":"cE2","day":"Wednesday","start":"15:00","studentId":"sE","instrument":"Piano","reason":"other","writerTeacherId":"tE"}]');
