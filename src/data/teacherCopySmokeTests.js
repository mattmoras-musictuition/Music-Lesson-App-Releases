// ============================================================
// teacherCopySmokeTests.js — v2.49.3 stale teacher-copy warning.
// ============================================================

import { teacherCopyDays, showTeacherCopyNote, actualsPillHidden, teacherCopyTooltip, ghostCardLines, ghostBelongsToView, ghostTeacherId, dayCopyStateForView } from "../utils/teacherCopy";
import { getDayLanes, getDayLaneTeacher } from "../utils/teacherCoverageDB";

export function runTeacherCopyTests(assert) {
  const W = "2026-10-05";
  const ta = {
    [`${W}|s1|tMatt`]: { lessons: [{ day: "Wednesday" }, { day: "Thursday" }, { day: "Thursday" }], missed: [] },
    [`${W}|s1|tAnna`]: { lessons: [], missed: [{ day: "Thursday" }] },
    [`${W}|s2|tMatt`]: { lessons: [{ day: "Friday" }], missed: [] },
    [`2026-10-12|s1|tMatt`]: { lessons: [{ day: "Monday" }], missed: [] },
  };
  assert("teacherCopy: days per teacher for this week + school", teacherCopyDays(ta, W, "s1"), { Wednesday: ["tMatt"], Thursday: ["tMatt", "tAnna"] });
  assert("teacherCopy: other school ignored", teacherCopyDays(ta, W, "s2"), { Friday: ["tMatt"] });
  assert("teacherCopy: empty copy shows nothing", teacherCopyDays({ [`${W}|s1|t`]: { lessons: [], missed: [] } }, W, "s1"), {});
  assert("teacherCopy: missing inputs safe", teacherCopyDays(null, W, "s1"), {});

  assert("teacherCopy: note on today", showTeacherCopyNote("2026-10-07", "2026-10-07"), true);
  assert("teacherCopy: note on a future day", showTeacherCopyNote("2026-10-08", "2026-10-07"), true);
  assert("teacherCopy: no note on a past day", showTeacherCopyNote("2026-10-06", "2026-10-07"), false);

  assert("teacherCopy: pill hidden on past day", actualsPillHidden("2026-10-06", "2026-10-07", 9), true);
  assert("teacherCopy: pill shown today before 6pm", actualsPillHidden("2026-10-07", "2026-10-07", 17), false);
  assert("teacherCopy: pill hidden today from 6pm", actualsPillHidden("2026-10-07", "2026-10-07", 18), true);
  assert("teacherCopy: pill shown on future day after 6pm", actualsPillHidden("2026-10-08", "2026-10-07", 20), false);
  assert("teacherCopy: pill with no date stays shown", actualsPillHidden(undefined, "2026-10-07", 20), false);

  const teachers = [{ id: "tMatt", name: "Matt Moras" }, { id: "tAnna", name: "Anna Lee" }];
  assert("teacherCopy: tooltip names one teacher", teacherCopyTooltip(["tMatt"], teachers).startsWith("Teacher copy stored by Matt Moras. At 6pm the drain replaces this teacher's"), true);
  assert("teacherCopy: tooltip names several", teacherCopyTooltip(["tMatt", "tAnna"], teachers).includes("Matt Moras, Anna Lee") && teacherCopyTooltip(["tMatt", "tAnna"], teachers).includes("these teachers'"), true);
  assert("teacherCopy: unknown teacher labelled", teacherCopyTooltip(["x"], teachers).includes("Unknown teacher"), true);

  runGhostCardLineTests(assert);
  runGhostViewTests(assert);
  runDayCopyStateTests(assert);
}

// Same body as WeeklyAdjustments' getPrefDisplayName (passed in as prefName).
const prefName = (name) => {
  if (!name) return name;
  const m = name.match(/\(([^)]+)\)/);
  if (!m) return name;
  const parts = name.replace(/\s*\([^)]+\)/, "").split(" ");
  parts[0] = m[1];
  return parts.join(" ");
};

// Ghost fixtures shaped like teacher-app planDayImport output: the admin
// card's fields spread, plus the copy stamps.
const copyStamps = (adminId) => ({ writerTeacherId: "tRauzah", sourceLessonId: adminId, importedAt: "2026-10-11T09:00:00.000Z" });

export function runGhostCardLineTests(assert) {
  const students = [{ id: "sJon", name: "Jonathan (Johnny) Smith", className: "3B" }, { id: "sIvy", name: "Ivy Chen" }, { id: "sLib", name: "Libby Gilby" }];
  const solo = { id: "c1", studentId: "sJon", studentName: "Jonathan Smith", instrument: "Guitar", schoolId: "sEBPS", bucket_id: "lane1", day: "Monday", start: "09:00", ...copyStamps("a1") };
  const group = { id: "c2", isGroup: true, groupId: "g1", groupName: "", studentNames: ["Ivy Chen", "Libby Gilby"], studentIds: ["sIvy", "sLib"], instrument: "Ukulele", schoolId: "sEBPS", bucket_id: "lane1", day: "Monday", start: "09:30", ...copyStamps("a2") };
  const band = {
    id: "c3", isBandSession: true, bandId: "b1", bandName: "Riptide", schoolId: "sEBPS", bucket_id: "lane1",
    teacherName: "Rauzah Ahmed", day: "Monday", start: "11:00", end: "11:00",
    members: [{ id: "m1", studentId: "sIvy", instrument: "Vocals" }, { id: "m2", studentId: "sLib", instrument: "Drums" }],
    memberStates: [{ memberId: "m1", studentId: "sIvy", state: "regular" }, { memberId: "m2", studentId: "sLib", state: "regular" }],
    removedLessons: [], ...copyStamps("a3"), originBandLessonId: "a3",
  };
  const lines = (g, teacherFirst) => ghostCardLines(g, { student: g.isGroup ? null : students.find(s => s.id === g.studentId), prefName, teacherFirst });

  assert("ghostCard: solo shows name · class / instrument · teacher", lines(solo, "Rauzah"), { line1: "Johnny Smith · 3B", line2: "Guitar · Rauzah" });
  assert("ghostCard: solo with no live student uses copied name", lines({ ...solo, studentId: "gone" }, "Rauzah"), { line1: "Jonathan Smith", line2: "Guitar · Rauzah" });
  assert("ghostCard: solo with no teacher has no dot", lines(solo, ""), { line1: "Johnny Smith · 3B", line2: "Guitar" });
  assert("ghostCard: group shows first names / instrument · teacher", lines(group, "Rauzah"), { line1: "Ivy, Libby", line2: "Ukulele · Rauzah" });
  assert("ghostCard: band shows its name only, no teacher", lines(band, "Rauzah"), { line1: "Riptide", line2: "" });
  assert("ghostCard: band with no name shows TBC", lines({ ...band, bandName: undefined }, "Rauzah"), { line1: "TBC", line2: "" });
}

// Which ghosts a WTT cell draws. Fixtures: Moorabbin PS Tuesday with two
// lanes (RH, MM) and Wednesday with one (RH). view() builds the helper's
// second argument exactly as WeeklyAdjustments' ghost layer does.
const GW = "2026-10-12";
const ghostTeachers = [{ id: "tRH", name: "Rauzah Ahmed" }, { id: "tMM", name: "Matt Moras" }];
const ghostCoverage = [
  { id: "laneRH", schoolId: "sMPS", day: "Tuesday", teacherId: "tRH", status: "active" },
  { id: "laneMM", schoolId: "sMPS", day: "Tuesday", teacherId: "tMM", status: "active" },
  { id: "laneRHw", schoolId: "sMPS", day: "Wednesday", teacherId: "tRH", status: "active" },
];
let ghostOverrides = [];
const ghostView = (day, viewedLaneId) => {
  const viewedLanes = viewedLaneId ? { sMPS: { [day]: viewedLaneId } } : {};
  const ghostMultiLane = getDayLanes(ghostCoverage, "sMPS", day, [], GW).length >= 2;
  const ghostViewedTeacher = ghostMultiLane ? getDayLaneTeacher(ghostCoverage, ghostTeachers, "sMPS", day, ghostOverrides, GW, viewedLanes, [])?.teacher : null;
  return { viewedTeacherId: ghostViewedTeacher?.id || null, isMultiLane: ghostMultiLane, teacherCoverage: ghostCoverage, laneOverrides: ghostOverrides, weekKey: GW, temporaryLanes: [] };
};
const coverCtx = { teacherCoverage: ghostCoverage, laneOverrides: [], weekKey: GW, temporaryLanes: [] };
const rhStamps = (adminId) => ({ writerTeacherId: "tRH", sourceLessonId: adminId, importedAt: "2026-10-13T09:00:00.000Z" });
const ghostSolo = (day, lane, extra = {}) => ({ id: `gs-${day}`, studentId: "sJon", studentName: "Jonathan Smith", instrument: "Guitar", schoolId: "sMPS", bucket_id: lane, day, start: "09:00", ...rhStamps("a1"), ...extra });
const ghostGroup = (day, lane, extra = {}) => ({ id: `gg-${day}`, isGroup: true, groupId: "g1", groupName: "", studentNames: ["Ivy Chen", "Libby Gilby"], studentIds: ["sIvy", "sLib"], instrument: "Ukulele", schoolId: "sMPS", bucket_id: lane, day, start: "09:30", ...rhStamps("a2"), ...extra });
const ghostBand = (day, lane) => ({
  id: `gb-${day}`, isBandSession: true, bandId: "b1", bandName: "Riptide", schoolId: "sMPS", bucket_id: lane,
  teacherName: "Rauzah Ahmed", day, start: "11:00", end: "11:00",
  members: [{ id: "m1", studentId: "sIvy", instrument: "Vocals" }, { id: "m2", studentId: "sLib", instrument: "Drums" }],
  memberStates: [{ memberId: "m1", studentId: "sIvy", state: "regular" }, { memberId: "m2", studentId: "sLib", state: "regular" }],
  removedLessons: [], ...rhStamps("a3"), originBandLessonId: "a3",
});

export function runGhostViewTests(assert) {
  const wedView = ghostView("Wednesday");
  assert("ghostView: single-lane day shows solo without teacherId", ghostBelongsToView(ghostSolo("Wednesday", "laneRHw"), wedView), true);
  assert("ghostView: single-lane day shows solo with teacherId", ghostBelongsToView(ghostSolo("Wednesday", "laneRHw", { teacherId: "tMM" }), wedView), true);
  assert("ghostView: single-lane day shows group", ghostBelongsToView(ghostGroup("Wednesday", "laneRHw"), wedView), true);
  assert("ghostView: single-lane day shows band", ghostBelongsToView(ghostBand("Wednesday", "laneRHw"), wedView), true);

  const rhView = ghostView("Tuesday", "laneRH");
  const mmView = ghostView("Tuesday", "laneMM");
  assert("ghostView: multi-lane day shows ghost whose teacherId matches the chip", ghostBelongsToView(ghostSolo("Tuesday", "laneRH", { teacherId: "tRH" }), rhView), true);
  assert("ghostView: multi-lane day hides ghost whose teacherId is another chip's", ghostBelongsToView(ghostSolo("Tuesday", "laneRH", { teacherId: "tRH" }), mmView), false);

  // Ghosts without teacherId resolve through their lane (all of today's copies).
  const noWriter = (g) => { const { writerTeacherId: _w, ...rest } = g; return rest; };
  for (const [kind, make] of [["solo", ghostSolo], ["group", ghostGroup], ["band", ghostBand]]) {
    const g = noWriter(make("Tuesday", "laneRH"));
    assert(`ghostView: multi-lane ${kind} in RH's lane shows under RH`, ghostBelongsToView(g, rhView), true);
    assert(`ghostView: multi-lane ${kind} in RH's lane hidden under MM`, ghostBelongsToView(g, mmView), false);
    assert(`ghostView: single-lane ${kind} still shows`, ghostBelongsToView(noWriter(make("Wednesday", "laneRHw")), wedView), true);
  }
  // Writer stamps never beat the lane: an MM-written copy of a card in RH's lane.
  assert("ghostView: lane wins over writer", ghostBelongsToView(ghostSolo("Tuesday", "laneRH", { writerTeacherId: "tMM" }), rhView), true);
  // A cover on RH's lane this week moves its ghosts to the covering teacher.
  ghostOverrides = [{ weekKey: GW, bucketId: "laneRH", overrideTeacherId: "tMM" }];
  const coverView = ghostView("Tuesday", "laneRH");
  ghostOverrides = [];
  assert("ghostView: lane cover resolves to the covering teacher", ghostBelongsToView(noWriter(ghostSolo("Tuesday", "laneRH")), coverView), true);

  // Lane not resolvable → the copy's writer.
  const lost = (extra) => ghostSolo("Tuesday", "laneGone", extra);
  assert("ghostView: unknown lane falls back to writerTeacherId (shown)", ghostBelongsToView(lost(), rhView), true);
  assert("ghostView: unknown lane falls back to writerTeacherId (hidden)", ghostBelongsToView(lost(), mmView), false);
  assert("ghostView: no bucket_id falls back to writerTeacherId", ghostBelongsToView(ghostSolo("Tuesday", undefined), rhView), true);
  const catchup = { id: "gc", studentId: "sJon", instrument: "Guitar", schoolId: "sMPS", day: "Tuesday", start: "10:00", isCatchup: true, _copyTeacherId: "tMM" };
  assert("ghostView: copy key teacher fallback shows under its chip", ghostBelongsToView(catchup, mmView), true);
  assert("ghostView: copy key teacher fallback hidden under other chip", ghostBelongsToView(catchup, rhView), false);
  assert("ghostTeacherId: order teacherId > lane > writer > copy key", [
    ghostTeacherId({ teacherId: "tX", bucket_id: "laneRH", writerTeacherId: "tMM" }, coverCtx),
    ghostTeacherId({ bucket_id: "laneMM", writerTeacherId: "tRH", _copyTeacherId: "tRH" }, coverCtx),
    ghostTeacherId({ bucket_id: "laneGone", writerTeacherId: "tRH", _copyTeacherId: "tMM" }, coverCtx),
    ghostTeacherId({ _copyTeacherId: "tMM" }, coverCtx),
  ], ["tX", "tMM", "tRH", "tMM"]);

  // Nothing resolves → hidden on multi-lane days, shown on single-lane days.
  const orphan = { id: "go", studentId: "sJon", instrument: "Guitar", schoolId: "sMPS", start: "12:00" };
  assert("ghostView: unresolvable ghost hidden on multi-lane day", ghostBelongsToView({ ...orphan, day: "Tuesday" }, rhView), false);
  assert("ghostView: unresolvable ghost shown on single-lane day", ghostBelongsToView({ ...orphan, day: "Wednesday" }, wedView), true);
}

// Day-header copy line + Actuals pill for the viewed chip. Copies keyed
// like teacher_actuals (`${week}|${school}|${teacher}`); view from ghostView,
// the object the screen builds for the column.
const copyOf = (teacherId, lessons, missed = []) => ({ lessons, missed: missed.map(m => ({ ...m, writerTeacherId: teacherId })) });
const rhCopy = { [`${GW}|sMPS|tRH`]: copyOf("tRH", [ghostSolo("Tuesday", "laneRH"), ghostSolo("Wednesday", "laneRHw")]) };
const copyState = (actuals, day, laneId) => dayCopyStateForView(actuals, GW, "sMPS", day, ghostView(day, laneId));

export function runDayCopyStateTests(assert) {
  assert("copyState: single-lane day with a copy shows line + pill", copyState(rhCopy, "Wednesday"), { teacherIds: ["tRH"], pillAvailable: true });
  assert("copyState: single-lane day without a copy has no line, pill as today", copyState({}, "Wednesday"), { teacherIds: null, pillAvailable: true });
  assert("copyState: multi-lane day, RH's copy, RH viewed", copyState(rhCopy, "Tuesday", "laneRH"), { teacherIds: ["tRH"], pillAvailable: true });
  assert("copyState: multi-lane day, RH's copy, MM viewed: no line, pill unavailable", copyState(rhCopy, "Tuesday", "laneMM"), { teacherIds: null, pillAvailable: false });
  assert("copyState: multi-lane day with no copy at all, pill as today", copyState({}, "Tuesday", "laneMM"), { teacherIds: null, pillAvailable: true });

  const both = { ...rhCopy, [`${GW}|sMPS|tMM`]: copyOf("tMM", [ghostSolo("Tuesday", "laneMM", { writerTeacherId: "tMM" })]) };
  assert("copyState: both copied, RH viewed", copyState(both, "Tuesday", "laneRH"), { teacherIds: ["tRH"], pillAvailable: true });
  assert("copyState: both copied, MM viewed", copyState(both, "Tuesday", "laneMM"), { teacherIds: ["tMM"], pillAvailable: true });
  assert("copyState: both copied, single-lane day unchanged", copyState(both, "Wednesday"), { teacherIds: ["tRH"], pillAvailable: true });

  // A copy holding only missed entries for the day still counts (the drain replaces those too).
  const rhMissedOnly = { [`${GW}|sMPS|tRH`]: copyOf("tRH", [], [{ id: "mx", studentId: "sJon", day: "Tuesday", bucket_id: "laneRH" }]) };
  assert("copyState: missed-only copy shows for RH", copyState(rhMissedOnly, "Tuesday", "laneRH"), { teacherIds: ["tRH"], pillAvailable: true });
  assert("copyState: missed-only copy hidden for MM", copyState(rhMissedOnly, "Tuesday", "laneMM"), { teacherIds: null, pillAvailable: false });

  // Entries with no lane or writer resolve to the stored copy's teacher key.
  const keyOnly = { [`${GW}|sMPS|tMM`]: { lessons: [{ id: "gc", studentId: "sJon", day: "Tuesday", start: "10:00", isCatchup: true }], missed: [] } };
  assert("copyState: key teacher fallback, MM viewed", copyState(keyOnly, "Tuesday", "laneMM"), { teacherIds: ["tMM"], pillAvailable: true });
  assert("copyState: key teacher fallback, RH viewed", copyState(keyOnly, "Tuesday", "laneRH"), { teacherIds: null, pillAvailable: false });

  // A cover on RH's lane this week: RH's copy of that lane follows the covering teacher (as ghosts do).
  ghostOverrides = [{ weekKey: GW, bucketId: "laneRH", overrideTeacherId: "tMM" }];
  const coveredView = ghostView("Tuesday", "laneRH");
  ghostOverrides = [];
  assert("copyState: lane cover follows the covering teacher", dayCopyStateForView(rhCopy, GW, "sMPS", "Tuesday", coveredView), { teacherIds: ["tMM"], pillAvailable: true });
}
