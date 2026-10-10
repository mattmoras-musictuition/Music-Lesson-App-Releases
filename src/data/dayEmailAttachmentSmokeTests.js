// ============================================================
// dayEmailAttachmentSmokeTests.js — v2.49.12 the weekly day-header email's
// attached day timetable. Every check feeds the WHOLE day's lessons (both
// teachers) through pickDayAttachment and then the real generateExportHtml,
// exactly as composeForDay does. Fixture mirrors Moorabbin Tue 13 Oct 2026:
// Rauzah on permanent lane xov9t1ep (9 lessons), Matt on a temporary lane
// for week 2026-10-12 (2 lessons).
// ============================================================

import { pickDayAttachment } from "../utils/dayEmailAttachment";
import { generateExportHtml } from "./exportHelpers";
import { setLaneHistory, getLaneHistory } from "../utils/teacherCoverageDB";

const S = "moorabbin";
const W2 = "2026-10-12";
const W3 = "2026-10-19";
const RAUZAH_LANE = { id: "xov9t1ep", schoolId: S, day: "Tuesday", teacherId: "rauzah", status: "active", effectiveTo: null, createdAt: "2026-10-10T15:10" };
const TC = [RAUZAH_LANE];
const TEMP = [{ id: "tmpmatt1", schoolId: S, day: "Tuesday", weekKey: W2, teacherId: "matt", createdAt: "2026-10-11T09:00" }];
const ARCHIVED = { id: "glkw2if8", schoolId: S, day: "Tuesday", teacherId: "matt", status: "archived", effectiveTo: null, createdAt: "2026-01-01" };
const SCHOOLS = [{ id: S, name: "Moorabbin Primary", slots: [] }];
const TEACHERS = [
  { id: "matt", name: "Matt Moras", teacherBreaks: [{ schoolId: S, day: "Tuesday", start: "08:55" }] },
  { id: "rauzah", name: "Rauzah Hamzah", teacherBreaks: [{ schoolId: S, day: "Tuesday", start: "12:10" }] },
];

const pad = (n) => String(n).padStart(2, "0");
const at = (mins) => `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
const lesson = (id, bucket_id, startMin, day = "Tuesday") =>
  ({ id, schoolId: S, day, start: at(startMin), end: at(startMin + 30), bucket_id, studentName: "Student " + id, instrument: "Piano" });
const MATT = [lesson("m1", "tmpmatt1", 8 * 60 + 30), lesson("m2", "tmpmatt1", 9 * 60 + 30)];
const RAUZAH = Array.from({ length: 9 }, (_, i) => lesson("r" + (i + 1), "xov9t1ep", 10 * 60 + i * 30));
const WHOLE_DAY = [...MATT, ...RAUZAH, lesson("w1", "wedlane", 9 * 60, "Wednesday")];
const viewing = (laneId) => ({ [S]: { Tuesday: laneId } });

// composeForDay's two steps: pick the lessons, then the real builder.
function attachmentHtml({ lessons = WHOLE_DAY, viewed, forTeacherName = null, tc = TC, temps = TEMP, weekKey = W2 }) {
  const attach = pickDayAttachment({ lessons, day: "Tuesday", schoolId: S, weekKey, teacherCoverage: tc, viewedLanes: viewed, temporaryLanes: temps, forTeacherName });
  return generateExportHtml(attach.lessons, [], SCHOOLS, TEACHERS, {
    schoolId: S, day: "Tuesday", teacherName: attach.teacherName, title: "T",
    teacherCoverage: tc, enrolments: [], laneOverrides: [], weekKey, temporaryLanes: temps, weekLabel: "Week 2",
  }) || "";
}
const breaks = (html) => (html.match(/>Break</g) || []).length;
const summary = (html) => [html.includes("Matt · "), html.includes("Rauzah · "), (html.match(/(\d+) lessons?</) || [])[1] || null, breaks(html)];

export function runDayEmailAttachmentTests(assert) {
  // The pre-v2.49.12 call (whole day, no teacherName) — what the owner saw.
  const before = generateExportHtml(WHOLE_DAY, [], SCHOOLS, TEACHERS, {
    schoolId: S, day: "Tuesday", title: "T", teacherCoverage: TC, enrolments: [], laneOverrides: [], weekKey: W2, temporaryLanes: TEMP, weekLabel: "Week 2" }) || "";
  assert("dayEmail: old call lists all 11 under Rauzah", [before.includes("Rauzah · 11 lessons"), breaks(before)], [true, 2]);

  // ── Staff → a named teacher: that teacher only, whatever the chip ──
  for (const chip of ["tmpmatt1", "xov9t1ep"]) {
    const toMatt = attachmentHtml({ viewed: viewing(chip), forTeacherName: "Matt Moras" });
    assert(`dayEmail: Staff → Matt (chip ${chip}) — Matt, 2 lessons, Matt's break only`,
      [toMatt.includes("Matt · 2 lessons"), breaks(toMatt)], [true, 1]);
    const toRauzah = attachmentHtml({ viewed: viewing(chip), forTeacherName: "Rauzah Hamzah" });
    assert(`dayEmail: Staff → Rauzah (chip ${chip}) — Rauzah, 9 lessons, Rauzah's break only`,
      [toRauzah.includes("Rauzah · 9 lessons"), breaks(toRauzah)], [true, 1]);
  }
  assert("dayEmail: Staff → Matt does not depend on the chip",
    attachmentHtml({ viewed: viewing("tmpmatt1"), forTeacherName: "Matt Moras" }) === attachmentHtml({ viewed: viewing("xov9t1ep"), forTeacherName: "Matt Moras" }), true);

  // ── Parents / Class Teachers / Staff group: the selected chip ──
  const chipMatt = attachmentHtml({ viewed: viewing("tmpmatt1") });
  assert("dayEmail: chip MM — Matt's 2 lessons, Matt's break", [chipMatt.includes("Matt · 2 lessons"), breaks(chipMatt)], [true, 1]);
  const chipRauzah = attachmentHtml({ viewed: viewing("xov9t1ep") });
  assert("dayEmail: chip RH — Rauzah's 9 lessons, Rauzah's break", [chipRauzah.includes("Rauzah · 9 lessons"), breaks(chipRauzah)], [true, 1]);
  assert("dayEmail: chip lessons are exactly that lane's",
    [pickDayAttachment({ lessons: WHOLE_DAY, day: "Tuesday", schoolId: S, weekKey: W2, teacherCoverage: TC, viewedLanes: viewing("tmpmatt1"), temporaryLanes: TEMP }).lessons.map(l => l.id),
     pickDayAttachment({ lessons: WHOLE_DAY, day: "Tuesday", schoolId: S, weekKey: W2, teacherCoverage: TC, viewedLanes: viewing("xov9t1ep"), temporaryLanes: TEMP }).lessons.map(l => l.id)],
    [["m1", "m2"], RAUZAH.map(l => l.id)]);

  // ── Two permanent lanes: split both ways ──
  const MATT_PERM = { id: "mattperm", schoolId: S, day: "Tuesday", teacherId: "matt", status: "active", effectiveTo: null, createdAt: "2026-10-11" };
  const TC2 = [RAUZAH_LANE, MATT_PERM];
  const PERM_DAY = [...MATT.map(l => ({ ...l, bucket_id: "mattperm" })), ...RAUZAH];
  assert("dayEmail: two permanent lanes — chips and staff split both ways",
    [summary(attachmentHtml({ lessons: PERM_DAY, viewed: viewing("mattperm"), tc: TC2, temps: [], weekKey: W3 })),
     summary(attachmentHtml({ lessons: PERM_DAY, viewed: viewing("xov9t1ep"), tc: TC2, temps: [], weekKey: W3 })),
     summary(attachmentHtml({ lessons: PERM_DAY, viewed: viewing("xov9t1ep"), tc: TC2, temps: [], weekKey: W3, forTeacherName: "Matt Moras" })),
     summary(attachmentHtml({ lessons: PERM_DAY, viewed: viewing("mattperm"), tc: TC2, temps: [], weekKey: W3, forTeacherName: "Rauzah Hamzah" }))],
    [[true, false, "2", 1], [false, true, "9", 1], [true, false, "2", 1], [false, true, "9", 1]]);

  // ── A lesson on Matt's retired (archived) slot ──
  const savedHistory = getLaneHistory();
  setLaneHistory([ARCHIVED]);
  try {
    const withRetired = [...WHOLE_DAY, lesson("old1", "glkw2if8", 15 * 60)];
    assert("dayEmail: retired-slot lesson included for Staff → its teacher",
      attachmentHtml({ lessons: withRetired, viewed: viewing("xov9t1ep"), forTeacherName: "Matt Moras" }).includes("Matt · 3 lessons"), true);
    assert("dayEmail: retired-slot lesson excluded from the selected-chip attachment (either chip)",
      ["tmpmatt1", "xov9t1ep"].map(c => pickDayAttachment({ lessons: withRetired, day: "Tuesday", schoolId: S, weekKey: W2, teacherCoverage: TC, viewedLanes: viewing(c), temporaryLanes: TEMP }).lessons.some(l => l.id === "old1")),
      [false, false]);
  } finally {
    setLaneHistory(savedHistory);
  }

  // ── Single-teacher day (no temporary lane that week): unchanged output ──
  const singleDay = [...RAUZAH, lesson("w1", "wedlane", 9 * 60, "Wednesday")];
  const oldSingle = generateExportHtml(singleDay, [], SCHOOLS, TEACHERS, {
    schoolId: S, day: "Tuesday", title: "T", teacherCoverage: TC, enrolments: [], laneOverrides: [], weekKey: W3, temporaryLanes: TEMP, weekLabel: "Week 2" }) || "";
  assert("dayEmail: single-teacher day — attachment identical to before",
    attachmentHtml({ lessons: singleDay, viewed: viewing("tmpmatt1"), weekKey: W3 }) === oldSingle && oldSingle.includes("Rauzah · 9 lessons"), true);
}
