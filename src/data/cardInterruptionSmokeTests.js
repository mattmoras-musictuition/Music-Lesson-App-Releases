// ============================================================
// Card interruption warning respects affected classes (utils/constraints.js).
// Group and band cards warn only when at least one member's class matches a
// class-restricted interruption. Called from runSmokeTests with its `assert`.
// ============================================================

import { checkConstraints, interruptionAffectsMembers } from "../utils/constraints";

export function runCardInterruptionTests(assert) {
  const students = [
    { id: "y1", name: "Ada One",   className: "1A", schoolId: "sch" },
    { id: "y2", name: "Ben Two",   className: "2B", schoolId: "sch" },
    { id: "y5", name: "Cal Five",  className: "5T", schoolId: "sch" },
    { id: "nb", name: "Dee Blank", className: "",   schoolId: "sch" },
  ];
  const camp = { id: "camp", title: "Year 5 Camp", type: "interruption", schoolId: "all",
    date: "2026-10-07", endDate: "2026-10-09", affectsClasses: "5T, 5W" };
  const whole = { ...camp, id: "whole", title: "Photo Day", affectsClasses: "all" };
  const slot = { start: "09:00", end: "09:30", type: "class" };
  const ctx = intrs => ({
    weekKey: "2026-10-05", selectedSchool: "sch", currentSchool: { id: "sch", slots: [] },
    weeklyTimetables: {}, teacherCoverage: [], laneOverrides: [], students, enrolments: [],
    teachers: [], schools: [{ id: "sch", name: "School" }], groups: [],
    weekDateMap: { Wednesday: "2026-10-07" }, weekInterruptions: intrs,
    specLookupRef: {}, timetable: null,
  });
  const intrWarnings = (lesson, intrs) =>
    checkConstraints(lesson, "Wednesday", slot, [], ctx(intrs)).filter(w => w.includes("interruption on"));
  const group = ids => ({ id: "g", isGroup: true, groupId: "grp", groupName: "Strings", studentId: ids[0],
    studentName: "Strings", studentIds: ids, schoolId: "sch", day: "Wednesday", start: "09:00", end: "09:30" });
  const band = ids => ({ id: "b", isBandSession: true, schoolId: "sch", day: "Wednesday", start: "09:00", end: "09:30",
    members: ids.map(studentId => ({ studentId, instrument: "Violin" })) });

  // Group cards
  assert("cardIntr: Year 1/2 group + 5T,5W camp -> no warning",
    intrWarnings(group(["y1", "y2"]), [camp]), []);
  assert("cardIntr: mixed group with a 5T member -> warning (no glyph)",
    intrWarnings(group(["y1", "y5"]), [camp]), ["Year 5 Camp — interruption on Wednesday"]);
  assert("cardIntr: group + 'all' interruption -> warning",
    intrWarnings(group(["y1", "y2"]), [whole]), ["Photo Day — interruption on Wednesday"]);
  assert("cardIntr: blank-class member does not count",
    intrWarnings(group(["y1", "nb"]), [camp]), []);
  assert("cardIntr: all-blank group -> no warning for class-restricted",
    intrWarnings(group(["nb"]), [camp]), []);

  // Band cards
  assert("cardIntr: Year 1/2 band + camp -> no warning",
    intrWarnings(band(["y1", "y2"]), [camp]), []);
  assert("cardIntr: band with a 5T member -> warning",
    intrWarnings(band(["y2", "y5"]), [camp]), ["Year 5 Camp — interruption on Wednesday"]);
  assert("cardIntr: band + 'all' interruption -> warning",
    intrWarnings(band(["y1"]), [whole]), ["Photo Day — interruption on Wednesday"]);

  // Single-student cards unchanged
  const solo = sid => ({ id: "s", studentId: sid, studentName: students.find(s => s.id === sid).name,
    instrument: "Piano", schoolId: "sch", day: "Wednesday", start: "09:00", end: "09:30" });
  assert("cardIntr: single Year 5 student -> warning",
    intrWarnings(solo("y5"), [camp]), ["Year 5 Camp — interruption on Wednesday"]);
  assert("cardIntr: single Year 1 student -> no warning",
    intrWarnings(solo("y1"), [camp]), []);

  // Helper directly
  assert("cardIntr: helper treats missing affectsClasses as all",
    interruptionAffectsMembers({ title: "x" }, [], students), true);
}
