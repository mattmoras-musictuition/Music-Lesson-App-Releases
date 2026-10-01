-- Fixtures for drain_teacher_actuals v1 vs v2. One school_id per case so the
-- checks are isolated. Schools prefixed nb_ hold NO teacher band copies, no
-- band-stamped misses and no new-band ledgers: v1 and v2 must leave them
-- byte-identical. Schools prefixed b_ exercise B1–B3.
--
-- pw() = last week's Monday (all days past); fw() = Monday in two weeks (all
-- days future). See schema.sql.

-- ═════════════════════════ NON-BAND ═════════════════════════

-- nb_main: v1 removal by teacherId, enrolment-only and group-only admin
-- cards; an admin band card the guard must keep; catch-up exclusions.
INSERT INTO weekly_adjustments VALUES (NULL, pw(), 'nb_main',
 '[{"id":"L1","day":"Monday","teacherId":"t1","enrolmentId":"e1","studentId":"s1","instrument":"Piano","start":"09:00"},
   {"id":"L2","day":"Monday","enrolmentId":"e2","studentId":"s2","instrument":"Guitar"},
   {"id":"L3","day":"Monday","groupId":"g3","isGroup":true},
   {"id":"L4","day":"Tuesday","teacherId":"t1","enrolmentId":"e4"},
   {"id":"L5","day":"Monday","teacherId":"t2","enrolmentId":"e5"},
   {"id":"AB","day":"Monday","teacherId":"t1","isBandSession":true,"bandId":"BZ"}]',
 '[{"id":"M1","day":"Monday","teacherId":"t1","enrolmentId":"e6"},
   {"id":"M2","day":"Tuesday","teacherId":"t2","enrolmentId":"e8"}]',
 'keep', 'g', '[]');
INSERT INTO teacher_actuals VALUES ('ta_nb1', pw(), 'nb_main', 't1',
 '[{"id":"X1","day":"Monday","teacherId":"t1","enrolmentId":"e1","start":"09:10"},
   {"id":"X2","day":"Monday","teacherId":"t1","enrolmentId":"e2"},
   {"id":"X3","day":"Monday","teacherId":"t1","groupId":"g3"},
   {"id":"XC","day":"Monday","teacherId":"t1","isCatchup":true},
   {"id":"XU","day":"Funday","teacherId":"t1"}]',
 '[{"id":"Y1","day":"Monday","teacherId":"t1","enrolmentId":"e7"},
   {"id":"YC","day":"Monday","teacherId":"t1","isCatchup":true}]');
-- future week for the same teacher: everything stays in teacher_actuals
INSERT INTO teacher_actuals VALUES ('ta_nb1f', fw(), 'nb_main', 't1',
 '[{"id":"F1","day":"Monday","teacherId":"t1"},{"id":"FC","day":"Tuesday","teacherId":"t1","isCatchup":true}]',
 '[{"id":"FM","day":"Wednesday","teacherId":"t1"}]');

-- nb_new: no weekly_adjustments row yet → insert-if-missing path.
INSERT INTO teacher_actuals VALUES ('ta_nb2', pw(), 'nb_new', 't3',
 '[{"id":"N1","day":"Wednesday","teacherId":"t3"}]', '[]');

-- nb_mix: week_key two days ago, so Monday is past and Sunday is future
-- within one row (the future split).
INSERT INTO teacher_actuals VALUES ('ta_nb3',
 ((now() AT TIME ZONE 'Australia/Melbourne')::date - 2)::text, 'nb_mix', 't4',
 '[{"id":"P1","day":"Monday","teacherId":"t4"},{"id":"P7","day":"Sunday","teacherId":"t4"}]',
 '[{"id":"PM7","day":"Sunday","teacherId":"t4"}]');

-- ═════════════════════════ BAND ═════════════════════════

-- b_origin: origin-id match; times/slot from T; A.id, bandId, bucket and
-- members kept; the teacher's regular Friday card replaces admin's (v1).
INSERT INTO weekly_adjustments VALUES (NULL, pw(), 'b_origin',
 '[{"id":"A1","isBandSession":true,"bandId":"BX","bandName":"Riptide","day":"Friday","start":"13:00","end":"13:30","slotId":"s1","bucket_id":"bk1",
    "members":[{"studentId":"sm1","instrument":"Guitar"}],"removedLessons":[],"memberStates":[]},
   {"id":"R1","day":"Friday","teacherId":"t1","enrolmentId":"eR"}]', '[]', '', '', '[]');
INSERT INTO teacher_actuals VALUES ('ta_b_origin', pw(), 'b_origin', 't1',
 '[{"id":"T1","isBandSession":true,"bandId":"BX-reminted","originBandLessonId":"A1","bandName":"Riptide","day":"Friday","start":"14:00","end":"14:30","slotId":"s2",
    "teacherId":"t1","writerTeacherId":"t1","members":[],"removedLessons":[],"memberStates":[]},
   {"id":"TR","day":"Friday","teacherId":"t1","enrolmentId":"eR"}]', '[]');

-- b_two: two sessions of one band on one day, resolved by origin id.
INSERT INTO weekly_adjustments VALUES (NULL, pw(), 'b_two',
 '[{"id":"A1","isBandSession":true,"bandId":"BX","day":"Friday","start":"13:00","end":"13:30","slotId":"s1","memberStates":[]},
   {"id":"A2","isBandSession":true,"bandId":"BX","day":"Friday","start":"15:00","end":"15:30","slotId":"s2a","memberStates":[]}]', '[]', '', '', '[]');
INSERT INTO teacher_actuals VALUES ('ta_b_two', pw(), 'b_two', 't1',
 '[{"id":"T2","isBandSession":true,"bandId":"BX","originBandLessonId":"A2","day":"Friday","start":"15:15","end":"15:45","teacherId":"t1","memberStates":[]}]', '[]');

-- b_fb_unique: no origin id; exactly one A with bandId+day → merge.
INSERT INTO weekly_adjustments VALUES (NULL, pw(), 'b_fb_unique',
 '[{"id":"A1","isBandSession":true,"bandId":"BX","day":"Friday","start":"13:00","end":"13:30","removedLessons":[{"day":"Friday","studentId":"sm1","instrument":"Guitar"}]}]', '[]', '', '', '[]');
INSERT INTO teacher_actuals VALUES ('ta_b_fb_unique', pw(), 'b_fb_unique', 't1',
 '[{"id":"T3","isBandSession":true,"bandId":"BX","day":"Friday","start":"13:05","end":"13:35","teacherId":"t1"}]', '[]');

-- b_fb_ambig_legacy: no origin id; two candidate A → no match; legacy T appended.
INSERT INTO weekly_adjustments VALUES (NULL, pw(), 'b_fb_ambig_legacy',
 '[{"id":"A1","isBandSession":true,"bandId":"BX","day":"Friday","start":"13:00"},
   {"id":"A2","isBandSession":true,"bandId":"BX","day":"Friday","start":"15:00"}]', '[]', '', '', '[]');
INSERT INTO teacher_actuals VALUES ('ta_b_fb_ambig_legacy', pw(), 'b_fb_ambig_legacy', 't1',
 '[{"id":"T4","isBandSession":true,"bandId":"BX","day":"Friday","start":"13:00","teacherId":"t1"}]', '[]');

-- b_fb_ambig_new: same, but T is a new band (memberStates array) → dropped.
INSERT INTO weekly_adjustments VALUES (NULL, pw(), 'b_fb_ambig_new',
 '[{"id":"A1","isBandSession":true,"bandId":"BX","day":"Friday","start":"13:00","memberStates":[]},
   {"id":"A2","isBandSession":true,"bandId":"BX","day":"Friday","start":"15:00","memberStates":[]}]', '[]', '', '', '[]');
INSERT INTO teacher_actuals VALUES ('ta_b_fb_ambig_new', pw(), 'b_fb_ambig_new', 't1',
 '[{"id":"T5","isBandSession":true,"bandId":"BX","day":"Friday","start":"13:00","teacherId":"t1","memberStates":[]}]', '[]');

-- b_crossday: T (origin A1) says Thursday; A keeps Friday, times still update.
INSERT INTO weekly_adjustments VALUES (NULL, pw(), 'b_crossday',
 '[{"id":"A1","isBandSession":true,"bandId":"BX","day":"Friday","start":"13:00","end":"13:30","memberStates":[]}]', '[]', '', '', '[]');
INSERT INTO teacher_actuals VALUES ('ta_b_crossday', pw(), 'b_crossday', 't1',
 '[{"id":"T6","isBandSession":true,"bandId":"BX","originBandLessonId":"A1","day":"Thursday","start":"10:00","end":"10:30","teacherId":"t1","memberStates":[]}]', '[]');

-- b_orphan_new: admin band gone (re-import); new-band copy is dropped.
INSERT INTO weekly_adjustments VALUES (NULL, pw(), 'b_orphan_new', '[]', '[]', '', '', '[]');
INSERT INTO teacher_actuals VALUES ('ta_b_orphan_new', pw(), 'b_orphan_new', 't1',
 '[{"id":"T7","isBandSession":true,"bandId":"BX","originBandLessonId":"GONE","day":"Friday","teacherId":"t1","memberStates":[]}]', '[]');

-- b_orphan_legacy: legacy copies with and without origin id, no admin band → appended.
INSERT INTO weekly_adjustments VALUES (NULL, pw(), 'b_orphan_legacy', '[]', '[]', '', '', '[]');
INSERT INTO teacher_actuals VALUES ('ta_b_orphan_legacy', pw(), 'b_orphan_legacy', 't1',
 '[{"id":"T8","isBandSession":true,"bandId":"BX","originBandLessonId":"GONE","day":"Friday","teacherId":"t1"},
   {"id":"T9","isBandSession":true,"bandId":"BY","day":"Friday","teacherId":"t1"}]', '[]');

-- b_b2a: NEW band ledger (removedLessons). E1 matches by enrolmentId, E2 by
-- the studentId+instrument fallback (R lacks enrolmentId), E3 is another
-- day, E4 another student. M1/M2 the same for misses. RX is still removed
-- by the v1 teacherId test.
INSERT INTO weekly_adjustments VALUES (NULL, pw(), 'b_b2a',
 '[{"id":"A1","isBandSession":true,"bandId":"BX","day":"Friday","memberStates":[],
    "removedLessons":[{"day":"Friday","enrolmentId":"eA","studentId":"sA","instrument":"Guitar"},
                      {"day":"Friday","studentId":"sB","instrument":"Drums"}]},
   {"id":"RX","day":"Friday","teacherId":"t1","enrolmentId":"eQ"}]', '[]', '', '', '[]');
INSERT INTO teacher_actuals VALUES ('ta_b_b2a', pw(), 'b_b2a', 't1',
 '[{"id":"E1","day":"Friday","teacherId":"t1","enrolmentId":"eA","studentId":"sA","instrument":"Guitar"},
   {"id":"E2","day":"Friday","teacherId":"t1","enrolmentId":"eB2","studentId":"sB","instrument":"Drums"},
   {"id":"E3","day":"Thursday","teacherId":"t1","enrolmentId":"eA","studentId":"sA","instrument":"Guitar"},
   {"id":"E4","day":"Friday","teacherId":"t1","enrolmentId":"eO","studentId":"sO","instrument":"Bass"}]',
 '[{"id":"M1","day":"Friday","teacherId":"t1","enrolmentId":"eA","studentId":"sA","instrument":"Guitar"},
   {"id":"M2","day":"Friday","teacherId":"t1","enrolmentId":"eO2","studentId":"sO2","instrument":"Cello"}]');

-- b_b2a_legacy: same ledger on a LEGACY band → no skip (B2a needs memberStates).
INSERT INTO weekly_adjustments VALUES (NULL, pw(), 'b_b2a_legacy',
 '[{"id":"A1","isBandSession":true,"bandId":"BX","day":"Friday",
    "removedLessons":[{"day":"Friday","enrolmentId":"eA","studentId":"sA","instrument":"Guitar"}]}]', '[]', '', '', '[]');
INSERT INTO teacher_actuals VALUES ('ta_b_b2a_legacy', pw(), 'b_b2a_legacy', 't1',
 '[{"id":"E1","day":"Friday","teacherId":"t1","enrolmentId":"eA","studentId":"sA","instrument":"Guitar"}]', '[]');

-- b_b2b: admin band-stamped miss; E1 (no enrolmentId) matches by
-- studentId+instrument → skipped; E2 other instrument → appended.
INSERT INTO weekly_adjustments VALUES (NULL, pw(), 'b_b2b',
 '[{"id":"A1","isBandSession":true,"bandId":"BX","day":"Friday","memberStates":[],"removedLessons":[]}]',
 '[{"id":"BM","day":"Friday","bandLessonId":"A1","enrolmentId":"eC","studentId":"sC","instrument":"Piano"}]', '', '', '[]');
INSERT INTO teacher_actuals VALUES ('ta_b_b2b', pw(), 'b_b2b', 't1',
 '[{"id":"E1","day":"Friday","teacherId":"t1","studentId":"sC","instrument":"Piano"},
   {"id":"E2","day":"Friday","teacherId":"t1","studentId":"sC","instrument":"Violin"}]', '[]');

-- b_b3: teacher miss stamped with bandLessonId → ignored entirely; admin's
-- own band absence and admin's Friday miss for t1 both stand.
INSERT INTO weekly_adjustments VALUES (NULL, pw(), 'b_b3',
 '[{"id":"A1","isBandSession":true,"bandId":"BX","day":"Friday","memberStates":[],"removedLessons":[]}]',
 '[{"id":"BM2","day":"Friday","bandLessonId":"A1","enrolmentId":"eD","studentId":"sD","instrument":"Sax"},
   {"id":"AM","day":"Friday","teacherId":"t1","enrolmentId":"eZ"}]', '', '', '[]');
INSERT INTO teacher_actuals VALUES ('ta_b_b3', pw(), 'b_b3', 't1', '[]',
 '[{"id":"TB3","day":"Friday","teacherId":"t1","bandLessonId":"A1","enrolmentId":"eD","studentId":"sD","instrument":"Sax"}]');

-- b_ms_inert: T's entry has no writerTeacherId → A's memberStates unchanged.
INSERT INTO weekly_adjustments VALUES (NULL, pw(), 'b_ms_inert',
 '[{"id":"A1","isBandSession":true,"bandId":"BX","day":"Friday","removedLessons":[],
    "memberStates":[{"enrolmentId":"e1","studentId":"s1","instrument":"Guitar","consumption":"regular","catchupId":null,"consumedWeekKey":null,"fee":null,"attended":null,"writerTeacherId":null}]}]',
 '[]', '', '', '[]');
INSERT INTO teacher_actuals VALUES ('ta_b_ms_inert', pw(), 'b_ms_inert', 't1',
 '[{"id":"T10","isBandSession":true,"bandId":"BX","originBandLessonId":"A1","day":"Friday","teacherId":"t1",
    "memberStates":[{"enrolmentId":"e1","consumption":"free","attended":true,"writerTeacherId":null,"fee":50}]}]', '[]');

-- b_ms_stamped: stamped T entries. e1 takes attended/absence/writer; e2's
-- old absence is cleared (T has none); e4 has no T entry; T's e3 is not added.
INSERT INTO weekly_adjustments VALUES (NULL, pw(), 'b_ms_stamped',
 '[{"id":"A1","isBandSession":true,"bandId":"BX","day":"Friday","removedLessons":[],
    "memberStates":[
      {"enrolmentId":"e1","consumption":"regular","catchupId":"CU1","consumedWeekKey":"2099-01-05","fee":40,"attended":null,"writerTeacherId":null,"absentCatchupSnapshot":{"x":1}},
      {"enrolmentId":"e2","consumption":"catchup","catchupId":"CU2","fee":null,"attended":false,"absence":{"reason":"Old"},"writerTeacherId":null},
      {"enrolmentId":"e4","consumption":"free","attended":null,"writerTeacherId":null}]}]',
 '[]', '', '', '[]');
INSERT INTO teacher_actuals VALUES ('ta_b_ms_stamped', pw(), 'b_ms_stamped', 't1',
 '[{"id":"T11","isBandSession":true,"bandId":"BX","originBandLessonId":"A1","day":"Friday","teacherId":"t1",
    "memberStates":[
      {"enrolmentId":"e1","consumption":"free","catchupId":"ZZ","fee":99,"attended":false,"absence":{"reason":"Sick"},"writerTeacherId":"tw"},
      {"enrolmentId":"e2","consumption":"free","attended":true,"writerTeacherId":"tw"},
      {"enrolmentId":"e3","consumption":"regular","attended":true,"writerTeacherId":"tw"}]}]', '[]');

-- b_future: a future-week band copy stays in teacher_actuals untouched.
INSERT INTO weekly_adjustments VALUES (NULL, fw(), 'b_future',
 '[{"id":"A1","isBandSession":true,"bandId":"BX","day":"Friday","start":"13:00","memberStates":[]}]', '[]', '', '', '[]');
INSERT INTO teacher_actuals VALUES ('ta_b_future', fw(), 'b_future', 't1',
 '[{"id":"T12","isBandSession":true,"bandId":"BX","originBandLessonId":"A1","day":"Friday","start":"14:00","teacherId":"t1","memberStates":[]}]', '[]');
