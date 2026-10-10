// ============================================================
// laneDisplaySmokeTests.js — v2.49.7 lane display after a day-staff change.
// Fixtures mirror the Moorabbin Tue/Fri swap (Oct 2026): old lanes end-dated
// to week 2 (2026-10-12) with "Keep", the original Matt Tuesday lane archived
// with "Also clear", and new lanes added with no end date.
// ============================================================

import { getDayLanes, getAllocatableLanes, lessonBelongsToViewedLane, lessonOnNonApplicableLane, lessonShownInViewedLane } from "../utils/teacherCoverageDB";

const S = "moorabbin";
const W1 = "2026-10-05";
const W2 = "2026-10-12";
const W3 = "2026-10-19";

export const LANE_FIXTURE = [
  { id: "glkw2if8", schoolId: S, day: "Tuesday", teacherId: "matt",    status: "archived", effectiveTo: null, createdAt: "2026-01-01" },
  { id: "ybayneaf", schoolId: S, day: "Tuesday", teacherId: "matt",    status: "active",   effectiveTo: W2,   createdAt: "2026-10-10T15:00" },
  { id: "xov9t1ep", schoolId: S, day: "Tuesday", teacherId: "rauzah",  status: "active",   effectiveTo: null, createdAt: "2026-10-10T15:10" },
  { id: "ep9xlw5o", schoolId: S, day: "Friday",  teacherId: "rauzah",  status: "active",   effectiveTo: W2,   createdAt: "2026-01-01" },
  { id: "npm9gxwu", schoolId: S, day: "Friday",  teacherId: "matt",    status: "active",   effectiveTo: null, createdAt: "2026-10-10T15:20" },
];

export function runLaneDisplayTests(assert) {
  const tc = LANE_FIXTURE;
  const friNew = { id: "f1", day: "Friday", schoolId: S, bucket_id: "npm9gxwu" };
  const friOld = { id: "f2", day: "Friday", schoolId: S, bucket_id: "ep9xlw5o" };
  const tueNew = { id: "t1", day: "Tuesday", schoolId: S, bucket_id: "xov9t1ep" };
  const legacy = { id: "t2", day: "Friday", schoolId: S };

  // (a) MTT (weekKey null): the end-dated Friday lane no longer counts, so the
  // card placed on the new lane renders — with or without a stored viewed lane,
  // and even when the stored viewed lane is the end-dated one.
  assert("laneDisplay: MTT new-lane card renders (no viewed lane)", lessonBelongsToViewedLane(friNew, {}, tc, S, null), true);
  assert("laneDisplay: MTT new-lane card renders (viewed = end-dated lane)",
    lessonBelongsToViewedLane(friNew, { [S]: { Friday: "ep9xlw5o" } }, tc, S, null), true);
  assert("laneDisplay: MTT Tuesday new-lane card renders", lessonBelongsToViewedLane(tueNew, { [S]: { Tuesday: "ybayneaf" } }, tc, S, null), true);
  assert("laneDisplay: MTT weekKey defaults to null", lessonBelongsToViewedLane(friNew, { [S]: { Friday: "ep9xlw5o" } }, tc, S), true);

  // WTT week 3: past the end date → one applicable lane → everything renders.
  assert("laneDisplay: WTT week 3 new-lane card renders", lessonBelongsToViewedLane(friNew, { [S]: { Friday: "ep9xlw5o" } }, tc, S, W3), true);

  // WTT week 2 (end-date week): both lanes still apply → the chip decides.
  assert("laneDisplay: WTT week 2 viewed new lane shows new card", lessonBelongsToViewedLane(friNew, { [S]: { Friday: "npm9gxwu" } }, tc, S, W2), true);
  assert("laneDisplay: WTT week 2 viewed new lane hides old card", lessonBelongsToViewedLane(friOld, { [S]: { Friday: "npm9gxwu" } }, tc, S, W2), false);
  assert("laneDisplay: WTT week 2 default = first applicable lane", lessonBelongsToViewedLane(friOld, {}, tc, S, W2), true);

  // A stored viewed lane that does not apply to the week falls back to the
  // first applicable lane (week 3: only npm9gxwu; legacy binds to it too).
  assert("laneDisplay: legacy card binds to first applicable lane", lessonBelongsToViewedLane(legacy, { [S]: { Friday: "ep9xlw5o" } }, tc, S, W1), true);
  const twoNew = [...tc, { id: "fri3", schoolId: S, day: "Friday", teacherId: "x", status: "active", effectiveTo: null, createdAt: "2026-10-11" }];
  assert("laneDisplay: non-applicable viewed lane → first applicable lane",
    lessonBelongsToViewedLane(friNew, { [S]: { Friday: "ep9xlw5o" } }, twoNew, S, W3), true);
  assert("laneDisplay: non-applicable viewed lane → other applicable lane hidden",
    lessonBelongsToViewedLane({ ...friNew, bucket_id: "fri3" }, { [S]: { Friday: "ep9xlw5o" } }, twoNew, S, W3), false);

  // (b) Week 1 Tuesday: lessons on the ARCHIVED lane glkw2if8. Two lanes still
  // apply that week (ybayneaf ends W2, xov9t1ep has no end), so the strict
  // filter hides them under either chip; the display rule shows them.
  const tueArchived = { id: "t3", day: "Tuesday", schoolId: S, bucket_id: "glkw2if8", frozenTeacherId: "matt" };
  for (const viewed of ["ybayneaf", "xov9t1ep", null]) {
    const vl = viewed ? { [S]: { Tuesday: viewed } } : {};
    assert(`laneDisplay: archived-lane lesson hidden by strict filter (viewed ${viewed})`, lessonBelongsToViewedLane(tueArchived, vl, tc, S, W1), false);
    assert(`laneDisplay: archived-lane lesson shown in past week (viewed ${viewed})`, lessonShownInViewedLane(tueArchived, vl, tc, S, W1), true);
  }
  assert("laneDisplay: archived lane is non-applicable", lessonOnNonApplicableLane(tueArchived, tc, S, W1), true);
  // A lane ended before the viewed week is non-applicable too (week 3 Friday).
  assert("laneDisplay: ended lane non-applicable after its end week", lessonOnNonApplicableLane(friOld, tc, S, W3), true);
  assert("laneDisplay: ended lane still applicable in its end week", lessonOnNonApplicableLane(friOld, tc, S, W2), false);
  // Display rule never shows the OTHER applicable lane's cards.
  assert("laneDisplay: display rule keeps chip filtering for applicable lanes",
    lessonShownInViewedLane(friOld, { [S]: { Friday: "npm9gxwu" } }, tc, S, W2), false);
  assert("laneDisplay: legacy card (no bucket_id) is never non-applicable", lessonOnNonApplicableLane(legacy, tc, S, W1), false);
  // A temporary lane for the week counts as applicable (unchanged behaviour).
  const temp = [{ id: "tmp1", schoolId: S, day: "Friday", teacherId: "x", weekKey: W2 }];
  assert("laneDisplay: temp-lane lesson is applicable in its week",
    lessonOnNonApplicableLane({ ...friNew, bucket_id: "tmp1" }, tc, S, W2, temp), false);
  // MTT: a master lesson left on an end-dated lane (e.g. restored by Undo) shows.
  assert("laneDisplay: MTT end-dated-lane lesson shows", lessonShownInViewedLane(friOld, {}, tc, S, null), true);

  // (c) MTT Manage Staff lists getDayLanes(..., null): end-dated and archived
  // lanes are not shown as currently assigned.
  const staffIds = (day) => getDayLanes(tc, S, day, [], null).map(l => l.id);
  assert("laneDisplay: Manage Staff Tuesday excludes end-dated + archived", staffIds("Tuesday"), ["xov9t1ep"]);
  assert("laneDisplay: Manage Staff Friday excludes end-dated", staffIds("Friday"), ["npm9gxwu"]);
}

// ── v2.49.14 — master timetable day-header "Allocate to [teacher]" menu offers
//    only lanes that still apply. Fed ALL of the day's lanes (live,
//    active-with-end-date, archived) through getAllocatableLanes, the exact
//    call the menu makes and onAllocatePlace re-checks. ──
export function runAllocateMenuTests(assert) {
  const tc = LANE_FIXTURE;
  const offered = (lanes, day) => getAllocatableLanes(lanes, S, day).map(l => l.id);
  assert("allocateMenu: Tuesday offers only the live lane (not end-dated, not archived)", offered(tc, "Tuesday"), ["xov9t1ep"]);
  assert("allocateMenu: Friday offers only the live lane (end-dated lane created first)", offered(tc, "Friday"), ["npm9gxwu"]);
  // A lane end-dated to a FUTURE week is already on its way out — not offered.
  const futureEnd = tc.map(l => l.id === "npm9gxwu" ? { ...l, effectiveTo: "2026-12-14" } : l);
  assert("allocateMenu: lane with a future end date is not offered", offered(futureEnd, "Friday"), []);
  // A day with two live lanes offers both, in lane order.
  const twoLive = [...tc, { id: "fri2live", schoolId: S, day: "Friday", teacherId: "x", status: "active", effectiveTo: null, createdAt: "2026-10-11" }];
  assert("allocateMenu: two live lanes are both offered", offered(twoLive, "Friday"), ["npm9gxwu", "fri2live"]);
  // Other schools' lanes never leak in.
  const otherSchool = [...tc, { id: "oth1", schoolId: "other", day: "Friday", teacherId: "x", status: "active", effectiveTo: null }];
  assert("allocateMenu: other school's lane not offered", offered(otherSchool, "Friday"), ["npm9gxwu"]);
  // onAllocatePlace guard: an armed lane that has since ended or been archived is refused.
  const stillApplies = (lanes, laneId, day) => getAllocatableLanes(lanes, S, day).some(l => l.id === laneId);
  assert("allocateMenu: armed live lane is placed into", stillApplies(tc, "npm9gxwu", "Friday"), true);
  assert("allocateMenu: armed lane end-dated since arming is refused", stillApplies(tc, "ep9xlw5o", "Friday"), false);
  assert("allocateMenu: armed lane archived since arming is refused", stillApplies(tc, "glkw2if8", "Tuesday"), false);
}
