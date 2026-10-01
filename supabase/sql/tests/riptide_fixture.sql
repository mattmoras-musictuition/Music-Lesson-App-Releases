-- Mock of the live Riptide row (shape only; ids from the dispatch, other
-- values invented). Used to exercise riptide_cleanup.sql locally.
INSERT INTO weekly_adjustments VALUES ('daf539a2-ec67-45e5-8533-a3a5beb5b9e5', '2026-09-07', 'pwa2twgi',
 '[{"id":"before1","day":"Monday","teacherId":"tX"},
   {"id":"adminRip","isBandSession":true,"bandId":"cdhfs43b","bandName":"Riptide","day":"Friday","start":"13:00","end":"13:30",
    "members":[{"studentId":"s1","instrument":"Guitar"},{"studentId":"s2","instrument":"Drums"}],
    "removedLessons":[{"day":"Friday","studentId":"s1","instrument":"Guitar"},{"day":"Friday","studentId":"s2","instrument":"Drums"}]},
   {"id":"middle1","day":"Friday","teacherId":"tY"},
   {"id":"aauisy56mts3c2pv","isBandSession":true,"bandId":"cdhfs43b","bandName":"Riptide","day":"Friday","start":"13:00","end":"13:30",
    "writerTeacherId":"q0jjoc9q","teacherId":"q0jjoc9q",
    "members":[{"studentId":"s1","instrument":"Guitar"},{"studentId":"s2","instrument":"Drums"}],
    "removedLessons":[{"day":"Friday","studentId":"s1","instrument":"Guitar"},{"day":"Friday","studentId":"s2","instrument":"Drums"}]},
   {"id":"after1","day":"Friday","teacherId":"tZ"}]',
 '[]', '', '', '[]');
