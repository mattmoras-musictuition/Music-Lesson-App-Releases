import { TALLY_REASONS } from "../constants";

/**
 * Returns the human-readable label for a missed-lesson reason.
 * For "other" with a custom reasonDetail, returns the custom text.
 * For known TALLY_REASONS values, returns the canonical label.
 * For unknown values (defensive), returns the raw value.
 */
export function getMissedReasonLabel(reason, reasonDetail) {
  if (!reason) return null;
  if (reason === "other") {
    const trimmed = (reasonDetail || "").trim();
    return trimmed || "Other";
  }
  const entry = TALLY_REASONS.find(r => r.value === reason);
  if (entry) return entry.label;
  if (reason === "timetable_clash") return "Timetable clash";
  return reason;
}

/**
 * Missed-lesson tray label. Display only — the stored entry is untouched.
 * A generator miss is saved as reason "timetable_clash" with the original
 * generator text kept in notes ("No available slot — Year 5 Camp",
 * "Master break conflict"), so the event name is recovered from notes.
 * Everything else falls through to getMissedReasonLabel.
 *
 *   { reason: "timetable_clash", notes: "No available slot — Year 5 Camp" } → "Year 5 Camp"
 *   { reason: "timetable_clash", notes: "Master break conflict" }          → "Master break"
 *   { reason: "timetable_clash", notes: "" }                               → "Timetable clash"
 */
export function getMissedTrayLabel(m) {
  if (!m || !m.reason) return null;
  if (m.reason === "timetable_clash") {
    const notes = (m.notes || "").trim();
    const slot = notes.match(/^No available slot\s*[—–-]\s*(.+)$/);
    const name = slot ? slot[1].trim() : "";
    if (name && name !== "Interruption / no slot") return name;
    if (/master break/i.test(notes)) return "Master break";
    return "Timetable clash";
  }
  return getMissedReasonLabel(m.reason, m.reasonDetail);
}

/**
 * Returns a sentence-case label with detail appended in parens,
 * for prose contexts (email bodies, printable HTML).
 *
 * Examples:
 *   "informed_absence", "had a cold" → "Informed absence (had a cold)"
 *   "uninformed_absence", "" → "Uninformed absence"
 *   "other", "Camp" → "Other (Camp)"
 *   null, "" → null
 *
 * Returns null for null/empty reason.
 */
export function getMissedReasonProse(reason, reasonDetail) {
  if (!reason) return null;
  const cat =
      reason === "informed_absence"   ? "Informed absence"
    : reason === "uninformed_absence" ? "Uninformed absence"
    : reason === "teacher_absent"     ? "Teacher absent"
    : reason === "school_interruption" ? "School interruption"
    : reason === "other"              ? "Other"
    : "Missed";
  const detail = (reasonDetail || "").trim();
  return detail ? `${cat} (${detail})` : cat;
}
