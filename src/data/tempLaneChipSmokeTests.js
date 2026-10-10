// ============================================================
// tempLaneChipSmokeTests.js — v2.49.11 a one-week temporary teacher is a
// lane of its own on the weekly page: the day-header chip switches the
// cards, and per-day Clear and the day-header email/export act only on the
// chosen chip's cards. Fixtures mirror Moorabbin Tue 13 Oct 2026: Rauzah on
// permanent lane xov9t1ep, Matt on a temporary lane for week 2026-10-12.
// ============================================================

import { lessonBelongsToViewedLane, lessonShownInViewedLane, getDayLaneTeacher, getDayLanes, getManualPlaceLane } from "../utils/teacherCoverageDB";
import { generateExportHtml } from "./exportHelpers";
import { pickDayAttachment } from "../utils/dayEmailAttachment";

const S = "moorabbin";
const W2 = "2026-10-12";
const W3 = "2026-10-19";
const TEACHERS = [{ id: "matt", name: "Matt Moras" }, { id: "rauzah", name: "Rauzah Hamzah" }];
const RAUZAH = { id: "xov9t1ep", schoolId: S, day: "Tuesday", teacherId: "rauzah", status: "active", effectiveTo: null, createdAt: "2026-10-10T15:10" };
const ENDED = { id: "ybayneaf", schoolId: S, day: "Tuesday", teacherId: "matt", status: "active", effectiveTo: "2026-10-05", createdAt: "2026-10-10T15:00" };
const TC = [RAUZAH, ENDED];
const TEMP = [{ id: "tmpmatt1", schoolId: S, day: "Tuesday", weekKey: W2, teacherId: "matt", createdAt: "2026-10-11T09:00" }];

const card = (id, bucket_id, start) => ({ id, schoolId: S, day: "Tuesday", start, bucket_id });
const MATT_CARDS = [card("m1", "tmpmatt1", "08:30"), card("m2", "tmpmatt1", "09:00")];
const RAUZAH_CARDS = [card("r1", "xov9t1ep", "09:30"), card("r2", "xov9t1ep", "10:00"), card("r3", "xov9t1ep", "10:30")];
const ENDED_CARD = card("e1", "ybayneaf", "11:00");       // lane ended before week 2
const ARCHIVED_CARD = card("a1", "glkw2if8", "11:30");    // lane not in the active list
const OTHER_DAY = { id: "w1", schoolId: S, day: "Wednesday", start: "09:00", bucket_id: "wedlane" };
const ALL = [...MATT_CARDS, ...RAUZAH_CARDS, ENDED_CARD, ARCHIVED_CARD, OTHER_DAY];

const viewing = (laneId) => ({ [S]: { Tuesday: laneId } });
const ids = (arr) => arr.map(l => l.id);
// The weekly page's per-day call shape (Clear count/target, Clear menu, email/export).
const belongs = (vl, wk = W2, temps = TEMP) => (l) => lessonBelongsToViewedLane(l, vl, TC, S, wk, temps);
const shown = (vl, wk = W2, temps = TEMP) => ALL.filter(l => l.day === "Tuesday" && lessonShownInViewedLane(l, vl, TC, S, wk, temps));

export function runTempLaneChipTests(assert) {
  // ── Chips: one permanent + one temporary lane ──
  assert("tempLaneChip: week 2 Tuesday has both chips",
    ids(getDayLanes(TC, S, "Tuesday", TEMP, W2)), ["xov9t1ep", "tmpmatt1"]);

  // ── Cards split by chip, both ways ──
  assert("tempLaneChip: Matt's chip shows Matt's cards (+ ended/archived)",
    ids(shown(viewing("tmpmatt1"))), ["m1", "m2", "e1", "a1"]);
  assert("tempLaneChip: Rauzah's chip shows Rauzah's cards (+ ended/archived)",
    ids(shown(viewing("xov9t1ep"))), ["r1", "r2", "r3", "e1", "a1"]);

  // ── Clear: target set and count only the chosen chip's cards ──
  const clearTarget = (vl) => ALL.filter(l => l.day === "Tuesday" && belongs(vl)(l));
  assert("tempLaneChip: Clear with Matt's chip targets only Matt's 2 cards",
    [ids(clearTarget(viewing("tmpmatt1"))), clearTarget(viewing("tmpmatt1")).length], [["m1", "m2"], 2]);
  assert("tempLaneChip: Clear with Rauzah's chip targets only Rauzah's 3 cards",
    [ids(clearTarget(viewing("xov9t1ep"))), clearTarget(viewing("xov9t1ep")).length], [["r1", "r2", "r3"], 3]);
  const kept = ALL.filter(l => l.day !== "Tuesday" || !belongs(viewing("tmpmatt1"))(l));
  assert("tempLaneChip: clearing Matt's Tuesday keeps Rauzah's and the other cards",
    ids(kept), ["r1", "r2", "r3", "e1", "a1", "w1"]);

  // ── Day-header email/export: only the chosen chip's cards ──
  assert("tempLaneChip: email/export with Matt's chip covers Matt's cards only",
    ids(ALL.filter(l => l.day === "Tuesday").filter(belongs(viewing("tmpmatt1")))), ["m1", "m2"]);

  // ── Retired / ended lane cards show under every chip (v2.49.7, unchanged) ──
  assert("tempLaneChip: ended and archived cards show under both chips",
    ["tmpmatt1", "xov9t1ep"].map(v => [ENDED_CARD, ARCHIVED_CARD].every(l => shown(viewing(v)).includes(l))), [true, true]);

  // ── One permanent lane only (week 3: no temporary lane) → every card belongs ──
  assert("tempLaneChip: single permanent lane — every card belongs",
    [...MATT_CARDS, ...RAUZAH_CARDS].map(belongs(viewing("tmpmatt1"), W3)), [true, true, true, true, true]);

  // ── Two permanent lanes: unchanged whether or not temp lanes are passed ──
  const TWO = [RAUZAH, { id: "mattperm", schoolId: S, day: "Tuesday", teacherId: "matt", status: "active", effectiveTo: null, createdAt: "2026-10-11" }];
  const twoCards = [card("p1", "mattperm", "08:30"), card("p2", "xov9t1ep", "09:30")];
  const twoBelongs = (temps) => twoCards.map(l => lessonBelongsToViewedLane(l, viewing("mattperm"), TWO, S, W3, temps));
  assert("tempLaneChip: two permanent lanes — unchanged by the temp-lane argument",
    [twoBelongs(undefined), twoBelongs([])], [[true, false], [true, false]]);

  // ── Master timetable call (no week): temp lanes ignored, unchanged ──
  assert("tempLaneChip: MTT call — temp lanes ignored, single lane passes every card",
    [...MATT_CARDS, ...RAUZAH_CARDS].map(l => [lessonBelongsToViewedLane(l, viewing("tmpmatt1"), TC, S, null, TEMP), lessonBelongsToViewedLane(l, viewing("tmpmatt1"), TC, S, null)]),
    [...MATT_CARDS, ...RAUZAH_CARDS].map(() => [true, true]));

  // ── Remembered lane missing for the viewed week → same fallback everywhere ──
  // Week 2 with a stale remembered id: first lane (Rauzah) for header, chips and cards.
  const stale = viewing("gone1234");
  const headerLane = getDayLaneTeacher(TC, TEACHERS, S, "Tuesday", null, W2, stale, TEMP)?.lane?.id;
  const dayLanes = getDayLanes(TC, S, "Tuesday", TEMP, W2);
  const chipLane = dayLanes.some(c => c.id === stale[S].Tuesday) ? stale[S].Tuesday : dayLanes[0].id; // WeeklyAdjustments chip rule
  assert("tempLaneChip: stale remembered lane — header, chips and cards agree on Rauzah",
    [headerLane, chipLane, ids(shown(stale)).filter(id => id !== "e1" && id !== "a1")], ["xov9t1ep", "xov9t1ep", ["r1", "r2", "r3"]]);
  // Week 3 remembering last week's temp lane: it no longer exists, so Rauzah's lane.
  assert("tempLaneChip: remembered temp lane absent next week — falls back to the first lane",
    [getDayLaneTeacher(TC, TEACHERS, S, "Tuesday", null, W3, viewing("tmpmatt1"), TEMP)?.lane?.id,
      lessonBelongsToViewedLane(RAUZAH_CARDS[0], viewing("tmpmatt1"), TC, S, W3, TEMP)], ["xov9t1ep", true]);
}

// ── Day PDF (the weekly day-header email attachment): temporary-slot lessons
//    belong to the temporary teacher. v2.49.12 — fed the WHOLE day (both
//    teachers) through pickDayAttachment, as composeForDay does; the v2.49.11
//    version fed Matt's lessons alone and so never exercised the real call. ──
export function runTempLaneDayPdfTests(assert) {
  const lesson = (id, start, end, bucket_id) => ({ id, schoolId: S, day: "Tuesday", start, end, bucket_id, studentName: "Student " + id, instrument: "Piano" });
  const wholeDay = [lesson("m1", "08:30", "09:00", "tmpmatt1"), lesson("m2", "09:30", "10:00", "tmpmatt1"),
    lesson("r1", "10:00", "10:30", "xov9t1ep"), lesson("r2", "10:30", "11:00", "xov9t1ep"), lesson("r3", "11:00", "11:30", "xov9t1ep")];
  const schools = [{ id: S, name: "Moorabbin Primary", slots: [] }];
  const teachers = [
    { id: "matt", name: "Matt Moras", teacherBreaks: [{ schoolId: S, day: "Tuesday", start: "09:10" }] },
    { id: "rauzah", name: "Rauzah Hamzah", teacherBreaks: [] },
  ];
  const base = { schoolId: S, day: "Tuesday", title: "T", teacherCoverage: TC, enrolments: [], laneOverrides: [] };
  const attach = pickDayAttachment({ lessons: wholeDay, day: "Tuesday", schoolId: S, weekKey: W2, teacherCoverage: TC, viewedLanes: viewing("tmpmatt1"), temporaryLanes: TEMP });
  const weekly = generateExportHtml(attach.lessons, [], schools, teachers, { ...base, teacherName: attach.teacherName, weekKey: W2, temporaryLanes: TEMP }) || "";
  assert("tempLaneDayPdf: header names the temporary teacher", weekly.includes("Matt · 2 lessons"), true);
  assert("tempLaneDayPdf: the temporary teacher's break is included", weekly.includes(">Break<"), true);
  // No week (master timetable / no temp lanes): unchanged — every lesson resolves to the first permanent lane (Rauzah), no Matt break.
  const noWeek = generateExportHtml(wholeDay, [], schools, teachers, { ...base, weekKey: null }) || "";
  assert("tempLaneDayPdf: no-week call unchanged (first permanent lane's teacher)",
    [noWeek.includes("Rauzah · 5 lessons"), noWeek.includes(">Break<")], [true, false]);
}

// ── v2.49.14 — Waiting List "Place → This week" honours the selected chip,
//    including a one-week teacher. Owner's real ids: Moorabbin week 2026-10-12
//    Tuesday — permanent lane xov9t1ep (teacher 3ogbshd6), temporary lane
//    udrscl4q (teacher 97m7cb1o). The WHOLE Tuesday (both lanes' cards, the
//    temporary lane, the other lanes) goes through getManualPlaceLane, the call
//    handleManualSchedule makes, then the new card is built the way the
//    handler builds it (bucket_id = destLane.lane.id) and appended to the day. ──
export function runWaitingListPlaceTests(assert) {
  const PERM = { id: "xov9t1ep", schoolId: S, day: "Tuesday", teacherId: "3ogbshd6", status: "active", effectiveTo: null, createdAt: "2026-10-10T15:10" };
  const OLD = { id: "ybayneaf", schoolId: S, day: "Tuesday", teacherId: "97m7cb1o", status: "active", effectiveTo: "2026-10-05", createdAt: "2026-10-10T15:00" };
  const ARCH = { id: "glkw2if8", schoolId: S, day: "Tuesday", teacherId: "97m7cb1o", status: "archived", effectiveTo: null, createdAt: "2026-01-01" };
  const tc = [ARCH, OLD, PERM];
  const temps = [{ id: "udrscl4q", schoolId: S, day: "Tuesday", weekKey: W2, teacherId: "97m7cb1o", createdAt: "2026-10-11T09:00" },
    { id: "othwk001", schoolId: S, day: "Tuesday", weekKey: W3, teacherId: "97m7cb1o", createdAt: "2026-10-11T09:05" }];
  const teachers = [{ id: "3ogbshd6", name: "Rauzah Hamzah" }, { id: "97m7cb1o", name: "Matt Moras" }];
  const day = [card("t1", "udrscl4q", "08:30"), card("t2", "udrscl4q", "09:00"),
    card("p1", "xov9t1ep", "09:30"), card("p2", "xov9t1ep", "10:00"), card("p3", "xov9t1ep", "10:30"),
    card("e1", "ybayneaf", "11:00"), card("a1", "glkw2if8", "11:30")];
  const place = (vl, extra = {}) => {
    const dest = getManualPlaceLane({ target: "weekly", teacherCoverage: tc, teachers, schoolId: S, day: "Tuesday",
      laneOverrides: [], weekKey: W2, viewedLanes: vl, temporaryLanes: temps, ...extra });
    if (!dest || !dest.lane || !dest.teacher) return { dest, lessons: day };
    const lesson = { id: "new1", studentId: "stu", schoolId: S, day: "Tuesday", start: "12:00", bucket_id: dest.lane.id };
    return { dest, lessons: [...day, lesson], lesson };
  };

  const tmp = place(viewing("udrscl4q"));
  assert("waitingListPlace: temporary chip selected → new card on udrscl4q (Matt)",
    [tmp.lesson.bucket_id, tmp.dest.teacher.id, tmp.lessons.length], ["udrscl4q", "97m7cb1o", 8]);
  assert("waitingListPlace: new card shows under the temporary chip, not the permanent one",
    [lessonShownInViewedLane(tmp.lesson, viewing("udrscl4q"), tc, S, W2, temps), lessonShownInViewedLane(tmp.lesson, viewing("xov9t1ep"), tc, S, W2, temps)], [true, false]);
  assert("waitingListPlace: existing Tuesday cards untouched", tmp.lessons.slice(0, 7), day);

  const perm = place(viewing("xov9t1ep"));
  assert("waitingListPlace: permanent chip selected → new card on xov9t1ep (Rauzah)",
    [perm.lesson.bucket_id, perm.dest.teacher.id], ["xov9t1ep", "3ogbshd6"]);

  // No chip selected: the same lane as the pre-v2.49.14 call (no temporary lanes).
  const before = getDayLaneTeacher(tc, teachers, S, "Tuesday", [], W2, {});
  const none = place({});
  assert("waitingListPlace: no chip selected → same lane as before the change",
    [none.lesson.bucket_id, before.lane.id], ["xov9t1ep", "xov9t1ep"]);
  // A remembered chip from another week's temporary lane falls back to the first permanent lane.
  assert("waitingListPlace: chip for another week's temp lane → first permanent lane",
    place(viewing("othwk001")).lesson.bucket_id, "xov9t1ep");
  // Chip pointing at the ended lane falls back too (ended before this week).
  assert("waitingListPlace: chip on an ended lane → first permanent lane",
    place(viewing("ybayneaf")).lesson.bucket_id, "xov9t1ep");
  // Lane override for the week still applies to the permanent lane's teacher.
  const ovr = place(viewing("xov9t1ep"), { laneOverrides: [{ weekKey: W2, bucketId: "xov9t1ep", overrideTeacherId: "97m7cb1o" }] });
  assert("waitingListPlace: week override still names the covering teacher",
    [ovr.lesson.bucket_id, ovr.dest.teacher.id], ["xov9t1ep", "97m7cb1o"]);
  // Master target is unchanged: never a temporary lane, even with that chip stored.
  const master = getManualPlaceLane({ target: "master", teacherCoverage: tc, teachers, schoolId: S, day: "Tuesday",
    laneOverrides: [], weekKey: W2, viewedLanes: viewing("udrscl4q"), temporaryLanes: temps });
  assert("waitingListPlace: master target ignores temporary lanes (unchanged)", master.lane.id, "xov9t1ep");
  // Behaviour difference: a day covered ONLY by a one-week teacher used to be
  // refused ("No covering lane"); it now places with that teacher.
  const onlyTemp = getManualPlaceLane({ target: "weekly", teacherCoverage: [ARCH, OLD], teachers, schoolId: S, day: "Tuesday",
    laneOverrides: [], weekKey: W2, viewedLanes: {}, temporaryLanes: temps });
  assert("waitingListPlace: temp-only day → one-week teacher's lane (was: no covering lane)",
    [onlyTemp?.lane?.id, getDayLaneTeacher([ARCH, OLD], teachers, S, "Tuesday", [], W2, {})], ["udrscl4q", null]);
}
