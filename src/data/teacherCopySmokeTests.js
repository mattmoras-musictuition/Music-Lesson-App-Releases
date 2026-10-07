// ============================================================
// teacherCopySmokeTests.js — v2.49.3 stale teacher-copy warning.
// ============================================================

import { teacherCopyDays, showTeacherCopyNote, actualsPillHidden, teacherCopyTooltip } from "../utils/teacherCopy";

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
}
