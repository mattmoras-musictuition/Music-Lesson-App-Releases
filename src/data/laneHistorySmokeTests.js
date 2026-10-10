// ============================================================
// laneHistorySmokeTests.js — v2.49.8 a lesson resolves to its own lane's
// teacher whatever the lane's status or end date. Fixtures mirror Moorabbin
// after the Tue/Fri swap and the owner's 10 Oct SQL: Tuesday glkw2if8 (Matt,
// original, archived; holds week 1's 7 lessons) and ybayneaf (Matt, archived,
// empty); xov9t1ep Rauzah active. Friday ep9xlw5o Rauzah active, ended
// 2026-10-05; npm9gxwu Matt active.
// ============================================================

import {
  getCardTeacherId, setLaneHistory, recordLaneHistory, getLaneHistory,
  findLaneById, getDayLanes, findLaneId, laneAppliesForWeek,
} from "../utils/teacherCoverageDB";
import { getLiveTeacherId } from "../utils/helpers";
import { generateWeeklyTimetable } from "./weeklyTimetableGenerator";

const S = "moorabbin";
const W1 = "2026-10-05";   // past
const W2 = "2026-10-12";
const FUTURE = "2099-01-05"; // always a future week

const ACTIVE = [
  { id: "xov9t1ep", schoolId: S, day: "Tuesday", teacherId: "rauzah", status: "active", effectiveTo: null, createdAt: "2026-10-10T15:10" },
  { id: "ep9xlw5o", schoolId: S, day: "Friday",  teacherId: "rauzah", status: "active", effectiveTo: W1,   createdAt: "2026-01-01" },
  { id: "npm9gxwu", schoolId: S, day: "Friday",  teacherId: "matt",   status: "active", effectiveTo: null, createdAt: "2026-10-10T15:20" },
];
const ARCHIVED = [
  { id: "glkw2if8", schoolId: S, day: "Tuesday", teacherId: "matt", status: "archived", effectiveTo: null, createdAt: "2026-01-01" },
  { id: "ybayneaf", schoolId: S, day: "Tuesday", teacherId: "matt", status: "archived", effectiveTo: "2026-10-12", createdAt: "2026-10-10T15:00" },
];

export function runLaneHistoryTests(assert) {
  // The index is module state the live app also fills: save and restore it.
  const saved = getLaneHistory();
  try {
    setLaneHistory(ARCHIVED);
    const tc = ACTIVE;
    const tue = (extra = {}) => ({ id: "t1", day: "Tuesday", schoolId: S, start: "09:00", bucket_id: "glkw2if8", ...extra });
    const friOld = { id: "f1", day: "Friday", schoolId: S, bucket_id: "ep9xlw5o" };
    const friNew = { id: "f2", day: "Friday", schoolId: S, bucket_id: "npm9gxwu" };

    // Past week + archived lane + no stamp → the lane's teacher (was Rauzah via fallback).
    assert("laneHistory: past week archived lane, no stamp → lane teacher", getCardTeacherId(tue(), tc, [], W1, []), "matt");
    assert("laneHistory: archived lane, no week (MTT) → lane teacher", getCardTeacherId(tue(), tc), "matt");

    // Stamp wins in a past week.
    assert("laneHistory: frozen stamp wins over own lane", getCardTeacherId(tue({ frozenTeacherId: "rauzah" }), tc, [], W1, []), "rauzah");

    // Override on own lane wins (past week, and a live week).
    const lo = [{ weekKey: W1, bucketId: "glkw2if8", overrideTeacherId: "cover" }, { weekKey: W2, bucketId: "npm9gxwu", overrideTeacherId: "cover2" }];
    assert("laneHistory: past-week override on own lane wins", getCardTeacherId(tue({ frozenTeacherId: "matt" }), tc, lo, W1, []), "cover");
    assert("laneHistory: live-week override on own lane wins", getCardTeacherId(friNew, tc, lo, W2, []), "cover2");

    // Ended lane in a future week (and the MTT) → own teacher (approved reversal).
    assert("laneHistory: ended lane, future week → own teacher", getCardTeacherId(friOld, tc, [], FUTURE, []), "rauzah");
    assert("laneHistory: ended lane, MTT → own teacher", getCardTeacherId(friOld, tc), "rauzah");

    // Active applicable lanes: unchanged in every week.
    assert("laneHistory: active lane W2 unchanged", getCardTeacherId(friNew, tc, [], W2, []), "matt");
    assert("laneHistory: active lane future unchanged", getCardTeacherId(friNew, tc, [], FUTURE, []), "matt");
    assert("laneHistory: active lane MTT unchanged", getCardTeacherId({ ...tue(), bucket_id: "xov9t1ep" }, tc), "rauzah");

    // bucket_id with no row anywhere → day-lane fallback.
    assert("laneHistory: unknown bucket_id → day-lane fallback", getCardTeacherId(tue({ bucket_id: "gone1234" }), tc, [], W2, []), "rauzah");
    // Legacy card without bucket_id → unchanged fallback (first applicable lane).
    assert("laneHistory: legacy card Tuesday → day-lane fallback", getCardTeacherId({ id: "l1", day: "Tuesday", schoolId: S }, tc, [], W2, []), "rauzah");
    assert("laneHistory: legacy card Friday W1 → first applicable lane", getCardTeacherId({ id: "l2", day: "Friday", schoolId: S }, tc, [], W1, []), "rauzah");
    assert("laneHistory: legacy card Friday W2 → first applicable lane", getCardTeacherId({ id: "l3", day: "Friday", schoolId: S }, tc, [], W2, []), "matt");

    // History never leaks into the active-only consumers.
    assert("laneHistory: getDayLanes Tuesday W1 stays active-only", getDayLanes(tc, S, "Tuesday", [], W1).map(l => l.id), ["xov9t1ep"]);
    assert("laneHistory: findLaneId ignores archived lanes", findLaneId(tc, S, "Tuesday", "matt"), null);
    assert("laneHistory: findLaneById reads the history", findLaneById(tc, "glkw2if8")?.teacherId, "matt");

    // Generator stampFrozen on an archived-lane lesson stamps the lane's teacher.
    const school = { id: S, name: "Moorabbin", slots: [{ id: "p1", name: "P1", start: "09:00", end: "09:30" }] };
    const master = { id: "M1", studentId: "seb", studentName: "Seb", schoolId: S, day: "Tuesday", start: "09:00", end: "09:30", slotId: "p1", bucket_id: "glkw2if8", instrument: "Guitar" };
    const wd = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].map((day, i) => ({ day, date: `2026-10-0${5 + i}` }));
    const gen = generateWeeklyTimetable([master], school, [{ id: "seb", name: "Seb", schoolId: S, className: "3A" }],
      [{ id: "matt", name: "Matt" }, { id: "rauzah", name: "Rauzah" }], [], [], wd, [], [], tc, []);
    assert("laneHistory: generator stamps archived lane's teacher", gen.lessons.map(l => l.frozenTeacherId), ["matt"]);

    // Confirm day collects teachers exactly as confirmDay does (getLiveTeacherId
    // with the week's overrides/key/temp lanes) → Matt for week 1 Tuesday.
    const week1Tue = [tue({ id: "a" }), tue({ id: "b", start: "09:30" }), tue({ id: "c", start: "10:00" })];
    const collected = [...new Set(week1Tue.map(l => getLiveTeacherId(l, [], [], tc, [], W1, [])).filter(Boolean))];
    assert("laneHistory: Confirm day collects the lane's teacher", collected, ["matt"]);

    // Archived-lane load failure → empty index → v2.49.7 fallback, no throw.
    setLaneHistory([]);
    assert("laneHistory: empty index → v2.49.7 day-lane fallback", getCardTeacherId(tue(), tc, [], W1, []), "rauzah");
    // An in-session archive is recorded and resolves straight away.
    recordLaneHistory(ARCHIVED[0]);
    assert("laneHistory: in-session archive resolves without restart", getCardTeacherId(tue(), tc, [], W1, []), "matt");
    setLaneHistory(null);
    assert("laneHistory: null history is safe", getLaneHistory(), []);
  } finally {
    setLaneHistory(saved);
  }
}

// ── v2.49.14 — adding a group to the master skips ended lanes. findLaneId's
//    default (every active lane) is what the weekly generator relies on; the
//    group handler passes the forward rule laneAppliesForWeek(lane, null). ──
export function runGroupLaneTests(assert) {
  const forward = (l) => laneAppliesForWeek(l, null);
  // Matt Friday: an end-dated lane created BEFORE the live one (array order = load order).
  const ended = { id: "fmatold1", schoolId: S, day: "Friday", teacherId: "matt", status: "active", effectiveTo: W2, createdAt: "2026-01-01" };
  const live = { id: "fmatnew1", schoolId: S, day: "Friday", teacherId: "matt", status: "active", effectiveTo: null, createdAt: "2026-10-11" };
  const archived = { id: "fmatarc1", schoolId: S, day: "Friday", teacherId: "matt", status: "archived", effectiveTo: null, createdAt: "2025-01-01" };
  const tc = [archived, ended, live, ...ACTIVE.filter(l => l.teacherId !== "matt")];
  assert("groupLane: default returns today's answer (first active lane = ended one)", findLaneId(tc, S, "Friday", "matt"), "fmatold1");
  assert("groupLane: forward mode returns the live lane", findLaneId(tc, S, "Friday", "matt", forward), "fmatnew1");
  // Only an ended lane: default still finds it; forward treats the day as uncovered.
  const onlyEnded = [archived, ended];
  assert("groupLane: default keeps an ended-only day covered", findLaneId(onlyEnded, S, "Friday", "matt"), "fmatold1");
  assert("groupLane: forward mode — ended-only day has no covering lane", findLaneId(onlyEnded, S, "Friday", "matt", forward), null);
  // Archived lanes never match in either mode; other teachers never match.
  assert("groupLane: archived-only day uncovered in both modes",
    [findLaneId([archived], S, "Friday", "matt"), findLaneId([archived], S, "Friday", "matt", forward)], [null, null]);
  assert("groupLane: other teacher's live lane not returned", findLaneId(tc, S, "Friday", "rauzah", forward), null);
  // A live lane with no end date is found the same way by both modes.
  assert("groupLane: live lane same in both modes",
    [findLaneId(ACTIVE, S, "Tuesday", "rauzah"), findLaneId(ACTIVE, S, "Tuesday", "rauzah", forward)], ["xov9t1ep", "xov9t1ep"]);

  // Weekly generator (default findLaneId): a lesson on an ended lane in its
  // FINAL week is still rescheduled onto that lane's teacher, not dropped.
  const school = { id: S, name: "Moorabbin", days: ["Friday"], slots: [
    { id: "p1", name: "P1", start: "09:00", end: "09:30", type: "class" },
    { id: "p2", name: "P2", start: "09:30", end: "10:00", type: "class" }] };
  const master = { id: "G1", studentId: "seb", studentName: "Seb", schoolId: S, day: "Friday", start: "09:00", end: "09:30", slotId: "p1", bucket_id: "fmatold1", instrument: "Guitar" };
  const wd = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].map((day, i) => ({ day, date: `2026-10-1${2 + i}` }));
  const move = [{ action: "move", lessonMatch: (l) => l.id === "G1" }];
  const gen = generateWeeklyTimetable([master], school, [{ id: "seb", name: "Seb", schoolId: S, className: "3A" }],
    [{ id: "matt", name: "Matt" }, { id: "rauzah", name: "Rauzah" }], [], [], wd, move, [], onlyEnded, []);
  assert("groupLane: generator reschedules on an ended lane in its final week (unchanged)",
    [gen.lessons.map(l => [l.id, l.bucket_id, l.day, l.start, l.adjustReason]), gen.missed.length],
    [[["G1", "fmatold1", "Friday", "09:00", "Time changed (interruption)"]], 0]);
}
