// ============================================================
// exportScopeSmokeTests.js — the main Export dialog's teacher scope
// (utils/exportScope.js) and the generators it feeds. Fixtures mirror
// Moorabbin Primary week 2026-10-12: Tuesday permanent lane xov9t1ep
// (teacher 3ogbshd6, Rauzah, nine lessons 10:30–15:00), temporary lane
// udrscl4q (teacher 97m7cb1o, Matt, 09:00 and 09:30); Friday lane npm9gxwu
// (Matt). A second school (Solway) is in the same week, as availableWeeks
// merges every school's lessons into one list.
// ============================================================

import { exportWeekContext, buildExportScope } from "../utils/exportScope";
import { visibleLessons } from "../utils/hiddenCards";
import { generateExportHtml, generateTeacherSchedulesHtml, prepareLessonRows, buildGridRows } from "./exportHelpers";

const MB = "moorabbin";
const SW = "solway";
const W2 = "2026-10-12";
const RAUZAH = "3ogbshd6";
const MATT = "97m7cb1o";
const KATE = "kate0001";

export const EXP_TC = [
  { id: "xov9t1ep", schoolId: MB, day: "Tuesday", teacherId: RAUZAH, status: "active", effectiveTo: null, createdAt: "2026-10-10T15:10" },
  { id: "npm9gxwu", schoolId: MB, day: "Friday", teacherId: MATT, status: "active", effectiveTo: null, createdAt: "2026-10-10T15:20" },
  { id: "slwmon01", schoolId: SW, day: "Monday", teacherId: KATE, status: "active", effectiveTo: null, createdAt: "2026-01-01" },
];
export const EXP_TEMP = [
  { id: "udrscl4q", schoolId: MB, day: "Tuesday", weekKey: W2, teacherId: MATT, createdAt: "2026-10-11T09:00" },
  { id: "othweek1", schoolId: MB, day: "Tuesday", weekKey: "2026-10-19", teacherId: KATE, createdAt: "2026-10-11T09:05" },
];
export const EXP_TEACHERS = [
  { id: RAUZAH, name: "Rauzah Hamzah", teacherBreaks: [] },
  { id: MATT, name: "Matt Moras", teacherBreaks: [] },
  { id: KATE, name: "Kate Lin", teacherBreaks: [] },
];
export const EXP_SCHOOLS = [
  { id: MB, name: "Moorabbin Primary", slots: [] },
  { id: SW, name: "Solway Primary", slots: [] },
];

const pad = (n) => String(n).padStart(2, "0");
const at = (mins) => `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
const mk = (id, schoolId, day, bucket_id, startMin) => ({
  id, studentId: "s_" + id, studentName: "Student " + id.toUpperCase(), schoolId,
  schoolName: schoolId === MB ? "Moorabbin Primary" : "Solway Primary",
  day, start: at(startMin), end: at(startMin + 30), bucket_id, instrument: "Piano",
});
const MATT_TUE = [mk("m1", MB, "Tuesday", "udrscl4q", 9 * 60), mk("m2", MB, "Tuesday", "udrscl4q", 9 * 60 + 30)];
const RAUZAH_TUE = Array.from({ length: 9 }, (_, i) => mk("r" + (i + 1), MB, "Tuesday", "xov9t1ep", 10 * 60 + 30 + i * 30));
const MATT_FRI = [mk("f1", MB, "Friday", "npm9gxwu", 9 * 60), mk("f2", MB, "Friday", "npm9gxwu", 9 * 60 + 30)];
const KATE_MON = [mk("k1", SW, "Monday", "slwmon01", 9 * 60)];
const HIDDEN = mk("h1", MB, "Tuesday", "udrscl4q", 15 * 60);   // archived student's card
// The week as availableWeeks builds it: every school's lessons in one list.
export const EXP_WEEK_LESSONS = [...MATT_TUE, ...RAUZAH_TUE, ...MATT_FRI, ...KATE_MON, HIDDEN];
export const EXP_STUDENTS = EXP_WEEK_LESSONS.map(l => ({ id: l.studentId, name: l.studentName, className: "3A", schoolId: l.schoolId, status: l.id === "h1" ? "archived" : "active" }));
export const EXP_WEEK = { weekKey: W2, weekLabel: "Week 2", lessons: EXP_WEEK_LESSONS, missed: [] };
export const EXP_MASTER = [...RAUZAH_TUE, ...MATT_FRI, ...KATE_MON].map(l => ({ ...l, id: "M" + l.id }));

export const ids = (arr) => arr.map(l => l.id);
// A week with no temporary lane at all (Matt's Tuesday cards absent).
export const EXP_WEEK_NOTEMP = { ...EXP_WEEK, lessons: EXP_WEEK_LESSONS.filter(l => l.bucket_id !== "udrscl4q") };
// Short fingerprint of an HTML string, to pin generator output exactly.
export const digest = (str) => { let h = 5381; const t = str || ""; for (let i = 0; i < t.length; i++) h = ((h * 33) ^ t.charCodeAt(i)) >>> 0; return t.length + ":" + h; };

// Same steps as the dialog: visibleLessons on the source, then buildExportScope.
export function expScope({ week = EXP_WEEK, master = EXP_MASTER, schoolId = "", teacherName = "", day = new Set(), temporaryLanes } = {}) {
  const sourceLessons = visibleLessons(week ? week.lessons : master, EXP_STUDENTS);
  const weekContext = temporaryLanes === undefined ? exportWeekContext(week, []) : exportWeekContext(week, [], temporaryLanes);
  return { weekContext, sourceLessons, ...buildExportScope({ sourceLessons, students: EXP_STUDENTS, teachers: EXP_TEACHERS, enrolments: [],
    teacherCoverage: EXP_TC, weekContext, schoolId, teacherName, className: "", day }) };
}

// Teacher Schedules HTML split into one entry per teacher page: [name, [student names]].
export function schedulePages(html) {
  return (html || "").split('page-break-before:always').map(page => [
    (page.match(/<div[^>]*>([A-Z][a-z]+ [A-Z][a-z]+)<\/div>\s*<div[^>]*>Teacher schedule/) || [])[1] || null,
    (page.match(/Student [A-Z0-9]+/g) || []).filter((v, i, a) => a.indexOf(v) === i).sort(),
  ]);
}

// v2.49.15 commit 1 — pins the dialog's output before the one-week-teacher fix.
export function runExportScopeCharacterizationTests(assert) {
  const wk = expScope({ schoolId: MB });
  assert("exportScope: week context for a week source", [wk.weekContext.weekKey, wk.weekContext.laneOverrides, wk.weekContext.missed], [W2, [], []]);
  assert("exportScope: hidden archived card dropped from the source", wk.sourceLessons.some(l => l.id === "h1"), false);
  const ms = expScope({ week: null, schoolId: MB });
  assert("exportScope: master context is lane-only", [ms.weekContext.weekKey, ms.weekContext.laneOverrides, ms.weekContext.missed], [null, null, undefined]);
  assert("exportScope: master teacher list (Moorabbin)", ms.teacherNames, ["Matt Moras", "Rauzah Hamzah"]);
  assert("exportScope: master Rauzah filter", ids(expScope({ week: null, schoolId: MB, teacherName: "Rauzah Hamzah" }).previewLessons), RAUZAH_TUE.map(l => "M" + l.id));
  assert("exportScope: master all-school schedule teachers", expScope({ week: null }).scheduleTeachers, ["Kate Lin", "Matt Moras", "Rauzah Hamzah"]);
  assert("exportScope: day filter keeps only that day", ids(expScope({ schoolId: MB, day: new Set(["Friday"]) }).previewLessons), ["f1", "f2"]);
  assert("exportScope: schedule teacher filter", expScope({ teacherName: "Kate Lin" }).scheduleTeachersFiltered, ["Kate Lin"]);

  // Week of 12 Oct BEFORE the fix: Matt's one-week Tuesday lessons resolve to
  // the day's first permanent lane (Rauzah).
  assert("exportScope: week teacher list (Moorabbin)", wk.teacherNames, ["Matt Moras", "Rauzah Hamzah"]);
  assert("exportScope: pre-fix — Matt's 09:00/09:30 Tuesday resolve to Rauzah",
    MATT_TUE.map(wk.resolveLessonTeacherName), ["Rauzah Hamzah", "Rauzah Hamzah"]);
  assert("exportScope: pre-fix — Rauzah filter includes 09:00/09:30",
    ids(expScope({ schoolId: MB, teacherName: "Rauzah Hamzah" }).previewLessons), ["m1", "m2", ...ids(RAUZAH_TUE)]);
  assert("exportScope: pre-fix — Matt filter is Friday only",
    ids(expScope({ schoolId: MB, teacherName: "Matt Moras" }).previewLessons), ["f1", "f2"]);
  const genOpts = (sc, extra = {}) => ({ teacherCoverage: EXP_TC, enrolments: [], ...sc.weekContext, ...extra });
  const sched = generateTeacherSchedulesHtml(wk.sourceLessons, EXP_STUDENTS, EXP_SCHOOLS, EXP_TEACHERS, genOpts(wk, { schoolId: MB, sourceLabel: "Week 2" }));
  assert("exportScope: pre-fix — Teacher Schedules puts 09:00/09:30 on Rauzah's page", schedulePages(sched),
    [["Matt Moras", ["Student F1", "Student F2"]], ["Rauzah Hamzah", ["Student M1", "Student M2", ...RAUZAH_TUE.map(l => l.studentName)].sort()]]);
  assert("exportScope: pre-fix — list rows name Rauzah for 09:00/09:30",
    prepareLessonRows(MATT_TUE, EXP_STUDENTS, { teachers: EXP_TEACHERS, teacherCoverage: EXP_TC, ...wk.weekContext }).map(r => r.Teacher), ["Rauzah Hamzah", "Rauzah Hamzah"]);

  // Exact output fingerprints (master; week with no temporary lane).
  const msAll = expScope({ week: null });
  const ntAll = expScope({ week: EXP_WEEK_NOTEMP });
  assert("exportScope: master timetable HTML fingerprint",
    digest(generateExportHtml(msAll.sourceLessons, EXP_STUDENTS, EXP_SCHOOLS, EXP_TEACHERS, genOpts(msAll, { title: "Master Timetable — All" }))), EXP_PIN.masterTimetable);
  assert("exportScope: master Teacher Schedules HTML fingerprint",
    digest(generateTeacherSchedulesHtml(msAll.sourceLessons, EXP_STUDENTS, EXP_SCHOOLS, EXP_TEACHERS, genOpts(msAll, { sourceLabel: "Master" }))), EXP_PIN.masterSchedules);
  assert("exportScope: no-temp week timetable HTML fingerprint",
    digest(generateExportHtml(ntAll.sourceLessons, EXP_STUDENTS, EXP_SCHOOLS, EXP_TEACHERS, genOpts(ntAll, { schoolId: MB, title: "Week 2 Timetable — Moorabbin" }))), EXP_PIN.noTempTimetable);
  assert("exportScope: no-temp week Teacher Schedules HTML fingerprint",
    digest(generateTeacherSchedulesHtml(ntAll.sourceLessons, EXP_STUDENTS, EXP_SCHOOLS, EXP_TEACHERS, genOpts(ntAll, { sourceLabel: "Week 2" }))), EXP_PIN.noTempSchedules);
}

// Fingerprints captured from v2.49.14 output (before the one-week-teacher fix).
export const EXP_PIN = { masterTimetable: "21614:4059262462", masterSchedules: "32235:1536097366", noTempTimetable: "19193:2601258823", noTempSchedules: "32235:512634276" };

// v2.49.15 commit 2 — a week source resolves with that week's temporary lanes.
// The WHOLE week (every school) goes through the same steps as the dialog:
// visibleLessons → exportWeekContext(week, laneOverrides, temporaryLanes) →
// buildExportScope, and the generators get the context spread into their opts
// exactly as ExportDialog passes it.
export function runExportTempLaneTests(assert) {
  const genOpts = (sc, extra = {}) => ({ teacherCoverage: EXP_TC, enrolments: [], ...sc.weekContext, ...extra });
  const wk = expScope({ temporaryLanes: EXP_TEMP });
  assert("exportTemp: week context carries only that week's temporary lanes",
    wk.weekContext.temporaryLanes.map(t => t.id), ["udrscl4q"]);
  // a. Teacher list
  assert("exportTemp: a. Matt's 09:00/09:30 Tuesday lessons resolve to Matt",
    MATT_TUE.map(wk.resolveLessonTeacherName), ["Matt Moras", "Matt Moras"]);
  const tue = expScope({ temporaryLanes: EXP_TEMP, schoolId: MB, day: new Set(["Tuesday"]) });
  assert("exportTemp: a. Moorabbin Tuesday teachers are Matt and Rauzah",
    [...new Set(tue.previewLessons.map(tue.resolveLessonTeacherName))].sort(), ["Matt Moras", "Rauzah Hamzah"]);
  assert("exportTemp: a. whole-week teacher list (all schools)", wk.teacherNames, ["Kate Lin", "Matt Moras", "Rauzah Hamzah"]);
  // b. Teacher filter
  assert("exportTemp: b. Rauzah filter excludes 09:00/09:30",
    ids(expScope({ temporaryLanes: EXP_TEMP, schoolId: MB, teacherName: "Rauzah Hamzah" }).previewLessons), ids(RAUZAH_TUE));
  assert("exportTemp: b. Matt filter has 09:00/09:30 plus his Friday",
    ids(expScope({ temporaryLanes: EXP_TEMP, schoolId: MB, teacherName: "Matt Moras" }).previewLessons), ["m1", "m2", "f1", "f2"]);
  assert("exportTemp: b. Matt timetable HTML (teacher filter) lists 09:00/09:30 and Friday",
    ["Student M1", "Student M2", "Student F1", "Student F2", "Student R1"].map(n => (generateExportHtml(wk.sourceLessons, EXP_STUDENTS, EXP_SCHOOLS, EXP_TEACHERS,
      genOpts(wk, { schoolId: MB, teacherName: "Matt Moras", title: "T" })) || "").includes(n)), [true, true, true, true, false]);
  // c. Teacher Schedules
  const sched = generateTeacherSchedulesHtml(wk.sourceLessons, EXP_STUDENTS, EXP_SCHOOLS, EXP_TEACHERS, genOpts(wk, { schoolId: MB, sourceLabel: "Week 2" }));
  assert("exportTemp: c. Teacher Schedules puts 09:00/09:30 on Matt's page, not Rauzah's", schedulePages(sched),
    [["Matt Moras", ["Student F1", "Student F2", "Student M1", "Student M2"]], ["Rauzah Hamzah", RAUZAH_TUE.map(l => l.studentName).sort()]]);
  // d. CSV/XLSX rows. exportLessons is async and downloads a file, so it cannot
  // run here; these are its two row builders fed the opts it now builds.
  const rowOpts = { teachers: EXP_TEACHERS, enrolments: [], teacherCoverage: EXP_TC, laneOverrides: wk.weekContext.laneOverrides,
    weekKey: wk.weekContext.weekKey, missed: wk.weekContext.missed, temporaryLanes: wk.weekContext.temporaryLanes };
  assert("exportTemp: d. XLSX list rows name Matt for 09:00/09:30",
    prepareLessonRows(MATT_TUE, EXP_STUDENTS, rowOpts).map(r => r.Teacher), ["Matt Moras", "Matt Moras"]);
  const grid = buildGridRows(wk.sourceLessons.filter(l => l.schoolId === MB), EXP_STUDENTS, EXP_SCHOOLS[0], EXP_TEACHERS,
    { allDays: true, specialists: null, ...rowOpts });
  const cellTi = (time) => grid.find(r => r.time === time).cells.Tuesday.map(c => c.ti);
  assert("exportTemp: d. CSV/XLSX grid cells name Matt at 9:00/9:30 and Rauzah at 10:30",
    [cellTi("9:00"), cellTi("9:30"), cellTi("10:30")], [["Matt"], ["Matt"], ["Rauzah"]]);
  // e. Master source ignores temporary lanes: output identical to before.
  const ms = expScope({ week: null, temporaryLanes: EXP_TEMP });
  assert("exportTemp: e. master context has no temporary lanes", ms.weekContext.temporaryLanes, []);
  assert("exportTemp: e. master timetable HTML unchanged",
    digest(generateExportHtml(ms.sourceLessons, EXP_STUDENTS, EXP_SCHOOLS, EXP_TEACHERS, genOpts(ms, { title: "Master Timetable — All" }))), EXP_PIN.masterTimetable);
  assert("exportTemp: e. master Teacher Schedules HTML unchanged",
    digest(generateTeacherSchedulesHtml(ms.sourceLessons, EXP_STUDENTS, EXP_SCHOOLS, EXP_TEACHERS, genOpts(ms, { sourceLabel: "Master" }))), EXP_PIN.masterSchedules);
  // f. Hidden archived card (on the temporary lane) stays out.
  assert("exportTemp: f. hidden card not in Matt's preview or schedule",
    [ids(expScope({ temporaryLanes: EXP_TEMP, teacherName: "Matt Moras" }).previewLessons).includes("h1"), sched.includes("Student H1")], [false, false]);
  // g. A week with no temporary lanes: output identical to before.
  const nt = expScope({ week: EXP_WEEK_NOTEMP, temporaryLanes: EXP_TEMP.filter(t => t.weekKey !== W2) });
  assert("exportTemp: g. no-temp week context is empty", nt.weekContext.temporaryLanes, []);
  assert("exportTemp: g. no-temp week timetable HTML unchanged",
    digest(generateExportHtml(nt.sourceLessons, EXP_STUDENTS, EXP_SCHOOLS, EXP_TEACHERS, genOpts(nt, { schoolId: MB, title: "Week 2 Timetable — Moorabbin" }))), EXP_PIN.noTempTimetable);
  assert("exportTemp: g. no-temp week Teacher Schedules HTML unchanged",
    digest(generateTeacherSchedulesHtml(nt.sourceLessons, EXP_STUDENTS, EXP_SCHOOLS, EXP_TEACHERS, genOpts(nt, { sourceLabel: "Week 2" }))), EXP_PIN.noTempSchedules);
}
