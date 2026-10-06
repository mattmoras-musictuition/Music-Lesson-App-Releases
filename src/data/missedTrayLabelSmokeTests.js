// ============================================================
// Missed lesson tray reason label (utils/missedReasonLabels.js —
// getMissedTrayLabel). Display only. Called from runSmokeTests with its
// `assert`.
// ============================================================

import { getMissedTrayLabel, getMissedReasonLabel } from "../utils/missedReasonLabels";

export function runMissedTrayLabelTests(assert) {
  const clash = notes => ({ reason: "timetable_clash", reasonDetail: "", notes });
  assert("trayLabel: camp note shows the event name",
    getMissedTrayLabel(clash("No available slot — Year 5 Camp")), "Year 5 Camp");
  assert("trayLabel: generator fallback title shows Timetable clash",
    getMissedTrayLabel(clash("No available slot — Interruption / no slot")), "Timetable clash");
  assert("trayLabel: master break note shows Master break",
    getMissedTrayLabel(clash("Master break conflict")), "Master break");
  assert("trayLabel: missing notes shows Timetable clash",
    getMissedTrayLabel({ reason: "timetable_clash" }), "Timetable clash");
  assert("trayLabel: unrelated reason passes through to the label function",
    getMissedTrayLabel({ reason: "teacher_absent", notes: "No available slot — Year 5 Camp" }), "Teacher Absent");
  assert("trayLabel: other + detail passes through",
    getMissedTrayLabel({ reason: "other", reasonDetail: "Excursion" }), "Excursion");
  assert("trayLabel: unknown raw reason passes through unchanged",
    getMissedTrayLabel({ reason: "Tally removed this week" }), "Tally removed this week");
  assert("trayLabel: no reason -> null", getMissedTrayLabel({ notes: "x" }), null);
  assert("trayLabel: label function maps timetable_clash",
    getMissedReasonLabel("timetable_clash", ""), "Timetable clash");
  const entry = clash("No available slot — Year 5 Camp");
  const before = JSON.stringify(entry);
  getMissedTrayLabel(entry);
  assert("trayLabel: stored entry is not modified", JSON.stringify(entry), before);
}
