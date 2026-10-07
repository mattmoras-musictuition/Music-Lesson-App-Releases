// ============================================================
// Hidden archived cards stay out of outputs (v2.49.2): exports, the day
// timetable attached to day-header emails, recipient lists. Selectors in
// utils/hiddenCards.js. Called from runSmokeTests with its `assert`.
// ============================================================

import { visibleLessons, visibleWeeklyTimetables, dayParentRows } from "../utils/hiddenCards";
import { generateExportHtml } from "./exportHelpers";

export function runHiddenCardOutputTests(assert) {
  const studentsWith = ameliaStatus => [
    { id: "amelia", name: "Amelia Tarlamis", className: "3A", schoolId: "sch", status: ameliaStatus,
      parents: [{ name: "Tara Tarlamis", email: "tara@x.com" }] },
    { id: "maia", name: "Maia Lafage", className: "1T", schoolId: "sch", status: "active",
      parents: [{ name: "Luc Lafage", email: "luc@x.com" }] },
    // Sibling pair: Sam archived, Kit active, same parent
    { id: "sam", name: "Sam Reed", className: "4B", schoolId: "sch", status: "archived",
      parents: [{ name: "Jo Reed", email: "jo@x.com" }] },
    { id: "kit", name: "Kit Reed", className: "2B", schoolId: "sch", status: "active",
      parents: [{ name: "Jo Reed", email: "jo@x.com" }] },
  ];
  const archived = studentsWith("archived");
  const restored = studentsWith("active");
  const END = { "09:00": "09:30", "10:00": "10:30", "13:10": "13:40" };
  const NAMES = { amelia: "Amelia Tarlamis", maia: "Maia Lafage", sam: "Sam Reed", kit: "Kit Reed" };
  const card = (id, studentId, start = "09:00") => ({ id, studentId, studentName: NAMES[studentId] || studentId, instrument: "Piano",
    schoolId: "sch", day: "Wednesday", start, end: END[start] });
  const lessons = [
    card("c-amelia", "amelia", "13:10"),
    card("c-maia", "maia", "13:10"),
    card("c-sam", "sam", "09:00"),
    card("c-kit", "kit", "10:00"),
  ];
  const solo = l => (l.studentId ? [l.studentId] : []);

  // Selector
  assert("hiddenOut: visibleLessons drops archived students' solo cards",
    visibleLessons(lessons, archived).map(l => l.id), ["c-maia", "c-kit"]);
  assert("hiddenOut: un-archived student appears again (Sam stays archived)",
    visibleLessons(lessons, restored).map(l => l.id), ["c-amelia", "c-maia", "c-kit"]);

  // Parent recipients
  const parentEmails = sts => dayParentRows(visibleLessons(lessons, sts), sts, solo).map(r => r.email);
  assert("hiddenOut: parent whose only lesson is hidden is not a recipient",
    parentEmails(archived).includes("tara@x.com"), false);
  assert("hiddenOut: parent with a hidden card for one child and a visible lesson for another stays",
    parentEmails(archived).includes("jo@x.com"), true);
  assert("hiddenOut: recipients from visible lessons only, each once",
    parentEmails(archived), ["luc@x.com", "jo@x.com"]);
  assert("hiddenOut: restored student's parent is a recipient again",
    parentEmails(restored).includes("tara@x.com"), true);
  assert("hiddenOut: top-level parentEmail shape is covered and de-duplicated",
    dayParentRows([card("c1", "p"), card("c2", "q")],
      [{ id: "p", parentEmail: "Pat@x.com", parentName: "Pat" }, { id: "q", parentEmail: "pat@x.com" }], solo),
    [{ name: "Pat", email: "Pat@x.com" }]);

  // Day timetable builder (what composeForDay attaches)
  const schools = [{ id: "sch", name: "School", slots: [] }];
  const html = generateExportHtml(visibleLessons(lessons, archived), archived, schools, [],
    { schoolId: "sch", day: "Wednesday", title: "T", teacherCoverage: [], enrolments: [] }) || "";
  assert("hiddenOut: day timetable counts visible lessons only", html.includes("2 lessons"), true);
  assert("hiddenOut: day timetable leaves out the hidden student", html.includes("Amelia"), false);
  assert("hiddenOut: day timetable keeps the visible student", html.includes("Maia"), true);

  // History inputs untouched: the selectors return views, never mutate
  const wtt = { "2026-10-05|sch": { lessons, missed: [{ id: "m1", studentId: "amelia" }] } };
  const before = JSON.stringify(wtt);
  const view = visibleWeeklyTimetables(wtt, archived);
  visibleLessons(lessons, archived);
  assert("hiddenOut: saved weekly data (Tally input) is unchanged by the selectors", JSON.stringify(wtt), before);
  assert("hiddenOut: weekly view keeps misses and drops only hidden cards",
    [view["2026-10-05|sch"].lessons.length, view["2026-10-05|sch"].missed.length], [2, 1]);
}
