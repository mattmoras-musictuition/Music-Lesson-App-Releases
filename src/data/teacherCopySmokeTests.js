// ============================================================
// teacherCopySmokeTests.js — v2.49.3 stale teacher-copy warning.
// ============================================================

import { teacherCopyDays, showTeacherCopyNote, actualsPillHidden, teacherCopyTooltip, ghostCardLines } from "../utils/teacherCopy";

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
  assert("ghostCard: band (current)", lines(band, "Rauzah"), { line1: "", line2: " · Rauzah" });
}
