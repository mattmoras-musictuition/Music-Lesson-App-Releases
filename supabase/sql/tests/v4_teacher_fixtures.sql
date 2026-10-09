-- Fixtures for drain v4 with what TEACHER APP v1.20.0 actually writes.
-- Loaded on top of fixtures.sql + v3_fixtures.sql + v4_fixtures.sql.
-- Schools prefixed t_.
--
-- Generated, not hand-written: the teacher_actuals rows come from running
-- the teacher app's own helpers (planDayImport, cardIdentity,
-- restampChangedDays — the updateActuals re-stamp — and stampFrozenEntries,
-- the upsert's frozen stamp) through Import → move → mark missed, with the
-- confirmMissed object literal mirrored from MyWeek.js. Rows marked
-- "v1.19.1" mirror teacher app 8302c13 (no sourceLessonId, no importedAt,
-- a miss without enrolmentId/groupId). Two entries in t_mixed_* are written
-- by hand (an unstamped v1.19.1 add, and an unparseable importedAt).
-- weekKey inside entries is a placeholder; the drain never reads it.
--
-- Timeline (UTC): Import 21:00 · teacher edit "before" 22:00 ·
-- admin day edit 23:00 · teacher edit "after" 01:00 next day.
--
--   t_admin_wins    imported, W2 marked missed at 22:00; admin moved W1 at
--                   23:00 → admin wins: Thursday skipped.
--   t_teacher_wins  same, but W2 marked missed at 01:00 → the whole day
--                   re-stamped 01:00, newer than the admin → copy drains.
--   t_two_same      one student, two Guitar enrolments on Wednesday. L2
--                   imported, moved 15:00→15:30, marked missed; L1 added by
--                   the admin after the Import. The miss's sourceLessonId
--                   removes L2, never L1.
--   t_two_same_old  the same day from v1.19.1 (no admin stamp): today's
--                   behaviour — the miss names no card, L2 survives.
--   t_mixed_skip    Thursday: two stamped entries (Import 21:00), one
--                   unstamped v1.19.1 add, one unparseable importedAt;
--                   admin 23:00 → the whole day skipped. Friday: no stamps
--                   at all → legacy, drains as v3 despite the admin stamp.
--   t_mixed_drain   same, but the stamped entries were re-stamped 01:00 →
--                   the whole day drains, unstamped entries included.
--   t_side          a v1.19.1 teacher and a v1.20.0 teacher, same school,
--                   same Thursday, admin edited after both: the old copy
--                   drains as today, the new copy is skipped.

INSERT INTO weekly_adjustments VALUES (NULL, pw(), 't_admin_wins',
 '[{"id":"W1","day":"Thursday","start":"10:30","end":"11:00","schoolId":"SCH","teacherName":"Nat","teacherId":"tN","enrolmentId":"eW1","studentId":"sW1","studentName":"Wendy One","instrument":"Piano"},
   {"id":"W2","day":"Thursday","start":"11:00","end":"11:30","schoolId":"SCH","teacherName":"Nat","teacherId":"tN","enrolmentId":"eW2","studentId":"sW2","studentName":"Will Two","instrument":"Piano"}]',
 '[]', '', 'g', '[]', '{"Thursday":"2026-10-12T23:00:00.000Z"}');
INSERT INTO teacher_actuals VALUES ('ta_t_admin_wins', pw(), 't_admin_wins', 'tN',
 '[{"id":"aw1","day":"Thursday","start":"10:00","end":"10:30","schoolId":"SCH","teacherName":"Nat","teacherId":"tN","enrolmentId":"eW1","studentId":"sW1","studentName":"Wendy One","instrument":"Piano","writerTeacherId":"tN","sourceLessonId":"W1","importedAt":"2026-10-12T22:00:00.000Z","frozenTeacherId":"tN"}]',
 '[{"id":"mAW","lessonId":"aw2","studentId":"sW2","studentName":"Will Two","studentNames":null,"className":null,"instrument":"Piano","teacherId":"tN","teacherName":"Nat","schoolId":"SCH","day":"Thursday","start":"11:00","weekKey":"<pw>","weekLabel":"Week 1","reason":"sick","reasonDetail":"","notes":"","makeupEligible":false,"isGroup":false,"recordedAt":"2026-10-12T22:00:00.000Z","writerTeacherId":"tN","sourceLessonId":"W2","enrolmentId":"eW2","importedAt":"2026-10-12T22:00:00.000Z","frozenTeacherId":"tN"}]');
INSERT INTO weekly_adjustments VALUES (NULL, pw(), 't_teacher_wins',
 '[{"id":"W1","day":"Thursday","start":"10:30","end":"11:00","schoolId":"SCH","teacherName":"Nat","teacherId":"tN","enrolmentId":"eW1","studentId":"sW1","studentName":"Wendy One","instrument":"Piano"},
   {"id":"W2","day":"Thursday","start":"11:00","end":"11:30","schoolId":"SCH","teacherName":"Nat","teacherId":"tN","enrolmentId":"eW2","studentId":"sW2","studentName":"Will Two","instrument":"Piano"}]',
 '[]', '', 'g', '[]', '{"Thursday":"2026-10-12T23:00:00.000Z"}');
INSERT INTO teacher_actuals VALUES ('ta_t_teacher_wins', pw(), 't_teacher_wins', 'tN',
 '[{"id":"tw3","day":"Thursday","start":"10:00","end":"10:30","schoolId":"SCH","teacherName":"Nat","teacherId":"tN","enrolmentId":"eW1","studentId":"sW1","studentName":"Wendy One","instrument":"Piano","writerTeacherId":"tN","sourceLessonId":"W1","importedAt":"2026-10-13T01:00:00.000Z","frozenTeacherId":"tN"}]',
 '[{"id":"mTW","lessonId":"tw4","studentId":"sW2","studentName":"Will Two","studentNames":null,"className":null,"instrument":"Piano","teacherId":"tN","teacherName":"Nat","schoolId":"SCH","day":"Thursday","start":"11:00","weekKey":"<pw>","weekLabel":"Week 1","reason":"sick","reasonDetail":"","notes":"","makeupEligible":false,"isGroup":false,"recordedAt":"2026-10-13T01:00:00.000Z","writerTeacherId":"tN","sourceLessonId":"W2","enrolmentId":"eW2","importedAt":"2026-10-13T01:00:00.000Z","frozenTeacherId":"tN"}]');
INSERT INTO weekly_adjustments VALUES (NULL, pw(), 't_two_same',
 '[{"id":"L1","day":"Wednesday","start":"09:00","end":"09:30","schoolId":"SCH","teacherName":"Nat","teacherId":null,"enrolmentId":"eD1","studentId":"sD","studentName":"Dee","instrument":"Guitar"},
   {"id":"L2","day":"Wednesday","start":"15:00","end":"15:30","schoolId":"SCH","teacherName":"Nat","teacherId":null,"enrolmentId":"eD2","studentId":"sD","studentName":"Dee","instrument":"Guitar"}]',
 '[]', '', 'g', '[]', '{"Wednesday":"2026-10-12T23:00:00.000Z"}');
INSERT INTO teacher_actuals VALUES ('ta_t_two_same', pw(), 't_two_same', 'tN',
 '[]',
 '[{"id":"mL2","lessonId":"ts5","studentId":"sD","studentName":"Dee","studentNames":null,"className":null,"instrument":"Guitar","teacherId":null,"teacherName":"Nat","schoolId":"SCH","day":"Wednesday","start":"15:30","weekKey":"<pw>","weekLabel":"Week 1","reason":"sick","reasonDetail":"","notes":"","makeupEligible":false,"isGroup":false,"recordedAt":"2026-10-13T01:00:00.000Z","writerTeacherId":"tN","sourceLessonId":"L2","enrolmentId":"eD2","importedAt":"2026-10-13T01:00:00.000Z","frozenTeacherId":"tN"}]');
INSERT INTO weekly_adjustments VALUES (NULL, pw(), 't_two_same_old',
 '[{"id":"L1","day":"Wednesday","start":"09:00","end":"09:30","schoolId":"SCH","teacherName":"Nat","teacherId":null,"enrolmentId":"eD1","studentId":"sD","studentName":"Dee","instrument":"Guitar"},
   {"id":"L2","day":"Wednesday","start":"15:00","end":"15:30","schoolId":"SCH","teacherName":"Nat","teacherId":null,"enrolmentId":"eD2","studentId":"sD","studentName":"Dee","instrument":"Guitar"}]',
 '[]', '', 'g', '[]', '{}');
INSERT INTO teacher_actuals VALUES ('ta_t_two_same_old', pw(), 't_two_same_old', 'tO',
 '[]',
 '[{"id":"mL2o","lessonId":"to6","studentId":"sD","studentName":"Dee","studentNames":null,"className":null,"instrument":"Guitar","teacherId":null,"teacherName":"Nat","schoolId":"SCH","day":"Wednesday","start":"15:30","weekKey":"<pw>","weekLabel":"Week 1","reason":"sick","reasonDetail":"","notes":"","makeupEligible":false,"isGroup":false,"recordedAt":"2026-10-13T01:00:00.000Z","writerTeacherId":"tO","frozenTeacherId":"tO"}]');
INSERT INTO weekly_adjustments VALUES (NULL, pw(), 't_mixed_skip',
 '[{"id":"X1","day":"Thursday","start":"09:00","end":"09:30","schoolId":"SCH","teacherName":"Nat","teacherId":"tN","enrolmentId":"eX1","studentId":"sX1","studentName":"Xan","instrument":"Drums"},
   {"id":"X2","day":"Thursday","start":"09:30","end":"10:00","schoolId":"SCH","teacherName":"Nat","teacherId":"tN","enrolmentId":"eX2","studentId":"sX2","studentName":"Xia","instrument":"Drums"},
   {"id":"XF","day":"Friday","start":"09:00","end":"09:30","schoolId":"SCH","teacherName":"Nat","teacherId":"tN","enrolmentId":"eXF","studentId":"sXF","studentName":"Xavi","instrument":"Drums"}]',
 '[]', '', 'g', '[]', '{"Thursday":"2026-10-12T23:00:00.000Z","Friday":"2026-10-12T23:00:00.000Z"}');
INSERT INTO teacher_actuals VALUES ('ta_t_mixed_skip', pw(), 't_mixed_skip', 'tN',
 '[{"id":"ms7","day":"Thursday","start":"09:00","end":"09:30","schoolId":"SCH","teacherName":"Nat","teacherId":"tN","enrolmentId":"eX1","studentId":"sX1","studentName":"Xan","instrument":"Drums","writerTeacherId":"tN","sourceLessonId":"X1","importedAt":"2026-10-12T21:00:00.000Z","frozenTeacherId":"tN"},
   {"id":"ms8","day":"Thursday","start":"09:30","end":"10:00","schoolId":"SCH","teacherName":"Nat","teacherId":"tN","enrolmentId":"eX2","studentId":"sX2","studentName":"Xia","instrument":"Drums","writerTeacherId":"tN","sourceLessonId":"X2","importedAt":"2026-10-12T21:00:00.000Z","frozenTeacherId":"tN"},
   {"id":"t_mixed_skip_old","day":"Thursday","start":"11:00","end":"11:30","enrolmentId":"eX3","studentId":"sX3","studentName":"Xu","instrument":"Drums","teacherId":"tN","writerTeacherId":"tN","frozenTeacherId":"tN"},
   {"id":"t_mixed_skip_bad","day":"Thursday","start":"12:00","end":"12:30","enrolmentId":"eX4","studentId":"sX4","instrument":"Drums","teacherId":"tN","writerTeacherId":"tN","frozenTeacherId":"tN","importedAt":"not-a-date"},
   {"id":"t_mixed_skip_fri","day":"Friday","start":"09:00","end":"09:30","schoolId":"SCH","teacherName":"Nat","teacherId":"tN","enrolmentId":"eXF","studentId":"sXF","studentName":"Xavi","instrument":"Drums","writerTeacherId":"tN","frozenTeacherId":"tN"}]',
 '[]');
INSERT INTO weekly_adjustments VALUES (NULL, pw(), 't_mixed_drain',
 '[{"id":"X1","day":"Thursday","start":"09:00","end":"09:30","schoolId":"SCH","teacherName":"Nat","teacherId":"tN","enrolmentId":"eX1","studentId":"sX1","studentName":"Xan","instrument":"Drums"},
   {"id":"X2","day":"Thursday","start":"09:30","end":"10:00","schoolId":"SCH","teacherName":"Nat","teacherId":"tN","enrolmentId":"eX2","studentId":"sX2","studentName":"Xia","instrument":"Drums"},
   {"id":"XF","day":"Friday","start":"09:00","end":"09:30","schoolId":"SCH","teacherName":"Nat","teacherId":"tN","enrolmentId":"eXF","studentId":"sXF","studentName":"Xavi","instrument":"Drums"}]',
 '[]', '', 'g', '[]', '{"Thursday":"2026-10-12T23:00:00.000Z","Friday":"2026-10-12T23:00:00.000Z"}');
INSERT INTO teacher_actuals VALUES ('ta_t_mixed_drain', pw(), 't_mixed_drain', 'tN',
 '[{"id":"md9","day":"Thursday","start":"09:00","end":"09:30","schoolId":"SCH","teacherName":"Nat","teacherId":"tN","enrolmentId":"eX1","studentId":"sX1","studentName":"Xan","instrument":"Drums","writerTeacherId":"tN","sourceLessonId":"X1","importedAt":"2026-10-13T01:00:00.000Z","frozenTeacherId":"tN"},
   {"id":"md10","day":"Thursday","start":"10:00","end":"10:30","schoolId":"SCH","teacherName":"Nat","teacherId":"tN","enrolmentId":"eX2","studentId":"sX2","studentName":"Xia","instrument":"Drums","writerTeacherId":"tN","sourceLessonId":"X2","importedAt":"2026-10-13T01:00:00.000Z","frozenTeacherId":"tN"},
   {"id":"t_mixed_drain_old","day":"Thursday","start":"11:00","end":"11:30","enrolmentId":"eX3","studentId":"sX3","studentName":"Xu","instrument":"Drums","teacherId":"tN","writerTeacherId":"tN","frozenTeacherId":"tN"},
   {"id":"t_mixed_drain_bad","day":"Thursday","start":"12:00","end":"12:30","enrolmentId":"eX4","studentId":"sX4","instrument":"Drums","teacherId":"tN","writerTeacherId":"tN","frozenTeacherId":"tN","importedAt":"not-a-date"},
   {"id":"t_mixed_drain_fri","day":"Friday","start":"09:00","end":"09:30","schoolId":"SCH","teacherName":"Nat","teacherId":"tN","enrolmentId":"eXF","studentId":"sXF","studentName":"Xavi","instrument":"Drums","writerTeacherId":"tN","frozenTeacherId":"tN"}]',
 '[]');
INSERT INTO weekly_adjustments VALUES (NULL, pw(), 't_side',
 '[{"id":"O1","day":"Thursday","start":"13:00","end":"13:30","schoolId":"SCH","teacherName":"Nat","teacherId":"tO","enrolmentId":"eO1","studentId":"sO1","studentName":"Ola","instrument":"Violin"},
   {"id":"O2","day":"Thursday","start":"13:30","end":"14:00","schoolId":"SCH","teacherName":"Nat","teacherId":"tO","enrolmentId":"eO2","studentId":"sO2","studentName":"Oz","instrument":"Violin"},
   {"id":"N1","day":"Thursday","start":"14:05","end":"14:35","schoolId":"SCH","teacherName":"Nat","teacherId":"tN","enrolmentId":"eN1","studentId":"sN1","studentName":"Nia","instrument":"Cello"},
   {"id":"N2","day":"Thursday","start":"14:30","end":"15:00","schoolId":"SCH","teacherName":"Nat","teacherId":"tN","enrolmentId":"eN2","studentId":"sN2","studentName":"Ned","instrument":"Cello"}]',
 '[]', '', 'g', '[]', '{"Thursday":"2026-10-12T23:00:00.000Z"}');
INSERT INTO teacher_actuals VALUES ('ta_t_side_old', pw(), 't_side', 'tO',
 '[{"id":"so11","day":"Thursday","start":"13:00","end":"13:30","schoolId":"SCH","teacherName":"Nat","teacherId":"tO","enrolmentId":"eO1","studentId":"sO1","studentName":"Ola","instrument":"Violin","writerTeacherId":"tO","frozenTeacherId":"tO"}]',
 '[{"id":"mO2","lessonId":"so12","studentId":"sO2","studentName":"Oz","studentNames":null,"className":null,"instrument":"Violin","teacherId":"tO","teacherName":"Nat","schoolId":"SCH","day":"Thursday","start":"13:30","weekKey":"<pw>","weekLabel":"Week 1","reason":"sick","reasonDetail":"","notes":"","makeupEligible":false,"isGroup":false,"recordedAt":"2026-10-12T22:00:00.000Z","writerTeacherId":"tO","frozenTeacherId":"tO"}]');
INSERT INTO teacher_actuals VALUES ('ta_t_side_new', pw(), 't_side', 'tN',
 '[{"id":"sn13","day":"Thursday","start":"14:00","end":"14:30","schoolId":"SCH","teacherName":"Nat","teacherId":"tN","enrolmentId":"eN1","studentId":"sN1","studentName":"Nia","instrument":"Cello","writerTeacherId":"tN","sourceLessonId":"N1","importedAt":"2026-10-12T22:00:00.000Z","frozenTeacherId":"tN"}]',
 '[{"id":"mN2","lessonId":"sn14","studentId":"sN2","studentName":"Ned","studentNames":null,"className":null,"instrument":"Cello","teacherId":"tN","teacherName":"Nat","schoolId":"SCH","day":"Thursday","start":"14:30","weekKey":"<pw>","weekLabel":"Week 1","reason":"sick","reasonDetail":"","notes":"","makeupEligible":false,"isGroup":false,"recordedAt":"2026-10-12T22:00:00.000Z","writerTeacherId":"tN","sourceLessonId":"N2","enrolmentId":"eN2","importedAt":"2026-10-12T22:00:00.000Z","frozenTeacherId":"tN"}]');
