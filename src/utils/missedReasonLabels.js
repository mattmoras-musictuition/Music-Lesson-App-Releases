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
