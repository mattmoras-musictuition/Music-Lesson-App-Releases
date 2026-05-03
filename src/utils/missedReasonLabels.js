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
  return reason;
}

/**
 * Returns a sentence-case label with detail appended in parens,
 * for prose contexts (email bodies, printable HTML).
 *
 * Examples:
 *   "informed_absence", "had a cold" → "Informed absence (had a cold)"
 *   "uninformed_absence", "" → "Uninformed absence"
 *   "extended_absence", "" → "Extended absence"
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
    : reason === "extended_absence"   ? "Extended absence"
    : reason === "school_interruption" ? "School interruption"
    : reason === "other"              ? "Other"
    : "Missed";
  const detail = (reasonDetail || "").trim();
  return detail ? `${cat} (${detail})` : cat;
}
