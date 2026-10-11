// ============================================================
// dayEmailAttachmentSmokeTests.js — v2.49.12 the weekly day-header email's
// attached day timetable. Every check feeds the WHOLE day's lessons (both
// teachers) through pickDayAttachment and then the real generateExportHtml,
// exactly as composeForDay does. Fixture mirrors Moorabbin Tue 13 Oct 2026:
// Rauzah on permanent lane xov9t1ep (9 lessons), Matt on a temporary lane
// for week 2026-10-12 (2 lessons).
// ============================================================

import { pickDayAttachment, dayHeaderEmailLessons } from "../utils/dayEmailAttachment";
import { lessonBelongsToViewedLane } from "../utils/teacherCoverageDB";
import { dayParentRows } from "../utils/hiddenCards";
import { getLiveTeacherId } from "../utils/helpers";
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
    // v2.49.15 (owner decision) — no longer excluded under every chip: it goes
    // under its own teacher's chip (Matt's), and only there.
    assert("dayEmail: retired-slot lesson in the selected-chip attachment under its teacher's chip only",
      ["tmpmatt1", "xov9t1ep"].map(c => pickDayAttachment({ lessons: withRetired, day: "Tuesday", schoolId: S, weekKey: W2, teacherCoverage: TC, viewedLanes: viewing(c), temporaryLanes: TEMP }).lessons.some(l => l.id === "old1")),
      [true, false]);
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

// ── v2.49.15 — day-header emails include leftover-lane lessons under exactly
//    one chip. The WHOLE Tuesday (Matt's temporary-lane cards, Rauzah's nine,
//    a card on Matt's archived slot — Matt HAS a chip — and a card on Kate's
//    archived slot — Kate has NO chip) goes through dayHeaderEmailLessons (the
//    recipient lists' filter), pickDayAttachment (the selected-chip
//    attachment), dayParentRows and the Staff list's getLiveTeacherId. ──
export function runDayEmailLeftoverTests(assert) {
  const KATE_ARCH = { id: "katearc1", schoolId: S, day: "Tuesday", teacherId: "kate", status: "archived", effectiveTo: null, createdAt: "2025-01-01" };
  const teachers = [...TEACHERS, { id: "kate", name: "Kate Lin", teacherBreaks: [] }];
  const LEFT_MATT = lesson("lm1", "glkw2if8", 15 * 60);
  const LEFT_KATE = lesson("lk1", "katearc1", 15 * 60 + 30);
  const DAY = [...MATT, ...RAUZAH, LEFT_MATT, LEFT_KATE, lesson("w1", "wedlane", 9 * 60, "Wednesday")];
  const students = DAY.map(l => ({ id: "s_" + l.id, name: l.studentName, parents: [{ name: "P " + l.id, email: l.id + "@p.com" }] }));
  const withStudents = DAY.map(l => ({ ...l, studentId: "s_" + l.id }));
  const CHIPS = ["xov9t1ep", "tmpmatt1"];
  const base = { schoolId: S, weekKey: W2, teacherCoverage: TC, temporaryLanes: TEMP, laneOverrides: [] };
  const lists = (lessons, chip, extra = {}) => dayHeaderEmailLessons({ lessons, days: ["Tuesday"], viewedLanes: viewing(chip), ...base, ...extra });
  const attachIds = (lessons, chip, extra = {}) => pickDayAttachment({ lessons, day: "Tuesday", viewedLanes: viewing(chip), ...base, ...extra }).lessons.map(l => l.id);
  const savedHistory = getLaneHistory();
  setLaneHistory([ARCHIVED, KATE_ARCH]);
  try {
    // a. Each leftover card under exactly one chip.
    const under = (id) => CHIPS.filter(c => lists(withStudents, c).some(l => l.id === id));
    assert("dayEmailLeftover: a. Matt's archived-slot card only under Matt's chip", under("lm1"), ["tmpmatt1"]);
    assert("dayEmailLeftover: a. Kate's card (no chip) only under the FIRST chip", under("lk1"), ["xov9t1ep"]);
    assert("dayEmailLeftover: a. remembered chip absent falls back to the first chip — Kate's card still once",
      [lists(withStudents, null).some(l => l.id === "lk1"), lists(withStudents, null).some(l => l.id === "lm1")], [true, false]);
    // b. Recipient lists and the attachment agree, for every chip.
    for (const chip of CHIPS) {
      const listIds = lists(withStudents, chip).map(l => l.id);
      assert(`dayEmailLeftover: b. lists and attachment agree (chip ${chip})`, attachIds(withStudents, chip), listIds);
    }
    const parents = (chip) => dayParentRows(lists(withStudents, chip), students, l => [l.studentId]).map(r => r.email);
    assert("dayEmailLeftover: b. Parents list under Matt's chip", parents("tmpmatt1"), ["m1@p.com", "m2@p.com", "lm1@p.com"]);
    assert("dayEmailLeftover: b. Parents list under Rauzah's chip", parents("xov9t1ep"), [...RAUZAH.map(l => l.id + "@p.com"), "lk1@p.com"]);
    const staff = (chip) => [...new Set(lists(withStudents, chip).map(l => getLiveTeacherId(l, students, [], TC, [], W2, TEMP)))];
    assert("dayEmailLeftover: b. Staff list names each leftover card's own teacher",
      [staff("tmpmatt1"), staff("xov9t1ep")], [["matt"], ["rauzah", "kate"]]);
    // Staff → named teacher attachment: same card, same teacher.
    const toTeacher = (name) => generateExportHtml(pickDayAttachment({ lessons: DAY, day: "Tuesday", viewedLanes: viewing("xov9t1ep"), ...base, forTeacherName: name }).lessons,
      [], SCHOOLS, teachers, { schoolId: S, day: "Tuesday", teacherName: name, title: "T", teacherCoverage: TC, enrolments: [], laneOverrides: [], weekKey: W2, temporaryLanes: TEMP }) || "";
    assert("dayEmailLeftover: b. Staff → Matt includes Matt's leftover card; Staff → Kate includes Kate's",
      [toTeacher("Matt Moras").includes("Student lm1"), toTeacher("Matt Moras").includes("Student lk1"), toTeacher("Kate Lin").includes("Student lk1")], [true, false, true]);
    // c. Cards on applicable lanes: identical to the strict filter.
    for (const chip of CHIPS) {
      const strict = withStudents.filter(l => l.day === "Tuesday" && lessonBelongsToViewedLane(l, viewing(chip), TC, S, W2, TEMP)).map(l => l.id);
      assert(`dayEmailLeftover: c. applicable-lane cards unchanged (chip ${chip})`,
        lists(withStudents, chip).filter(l => l.id !== "lm1" && l.id !== "lk1").map(l => l.id), strict);
    }
    // d. Single-lane day (no temporary lane that week): every Tuesday card, as before.
    const single = lists(withStudents, "tmpmatt1", { weekKey: W3 }).map(l => l.id);
    assert("dayEmailLeftover: d. single-lane day — identical to before (every Tuesday card)", single,
      withStudents.filter(l => l.day === "Tuesday" && lessonBelongsToViewedLane(l, viewing("tmpmatt1"), TC, S, W3, TEMP)).map(l => l.id));
    assert("dayEmailLeftover: d. single-lane day includes the leftover cards (strict already did)", ["lm1", "lk1"].every(id => single.includes(id)), true);
    // e. Clear's set (strict) is unchanged and never includes a leftover card.
    const clearSet = (chip) => withStudents.filter(l => l.day === "Tuesday" && lessonBelongsToViewedLane(l, viewing(chip), TC, S, W2, TEMP)).map(l => l.id);
    assert("dayEmailLeftover: e. Clear under Matt's chip = Matt's 2 cards only", clearSet("tmpmatt1"), ["m1", "m2"]);
    assert("dayEmailLeftover: e. Clear under Rauzah's chip = Rauzah's 9 cards only", clearSet("xov9t1ep"), RAUZAH.map(l => l.id));
    // Counts the owner will see: 9 + Kate's leftover under Rauzah, 2 + Matt's leftover under Matt.
    assert("dayEmailLeftover: chip counts (email) with the two leftover cards", [lists(withStudents, "xov9t1ep").length, lists(withStudents, "tmpmatt1").length], [10, 3]);
    assert("dayEmailLeftover: chip counts (email) without leftover cards are 9 and 2",
      [lists(withStudents.filter(l => l.id !== "lm1" && l.id !== "lk1"), "xov9t1ep").length, lists(withStudents.filter(l => l.id !== "lm1" && l.id !== "lk1"), "tmpmatt1").length], [9, 2]);
  } finally {
    setLaneHistory(savedHistory);
  }
}
