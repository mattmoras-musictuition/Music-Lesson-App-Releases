// ============================================================
// migrations/spec1c5.js — Phase 3 Spec 1 Commit 5.0 one-shot transform
//
// Pure function. Does not mutate input. Does not write to
// localStorage for data (only reads the idempotency marker).
// Does not touch React state or Supabase. Caller applies the
// returned weeklyTimetables via setWeeklyTimetables and sets
// the marker after a successful run.
//
// Purpose: extend every WTT missed-entry with the annotation
// field defaults ({reasonDetail, notes, makeupEligible, madeUp,
// cardNote}) and convert display-label `reason` values to
// machine values per TALLY_REASONS.
//
// See SPEC_1_COMMIT_5_tally_derive_and_shape_extension.md §5.0b.
// ============================================================

import { TALLY_REASONS } from "../../constants";

const MIGRATION_MARKER_KEY = "mt-migration-spec1c5-done";

const labelToValue = new Map(TALLY_REASONS.map(r => [r.label, r.value]));
const valueSet = new Set(TALLY_REASONS.map(r => r.value));

function transformReason(reason, currentReasonDetail) {
  const detail = currentReasonDetail || "";
  if (!reason || reason === "") {
    return { reason: "", reasonDetail: detail, bucket: "empty" };
  }
  if (valueSet.has(reason)) {
    return { reason, reasonDetail: detail, bucket: "alreadyMachine" };
  }
  if (labelToValue.has(reason)) {
    return { reason: labelToValue.get(reason), reasonDetail: detail, bucket: "transformed" };
  }
  return { reason: "other", reasonDetail: detail || reason, bucket: "freeTextStashed" };
}

export function runSpec1Commit5Transform({ weeklyTimetables }) {
  if (typeof localStorage !== "undefined" && localStorage.getItem(MIGRATION_MARKER_KEY)) {
    return { skipped: true, reason: "marker set" };
  }

  const stats = {
    entriesProcessed: 0,
    reasonsTransformed: 0,
    reasonsAlreadyMachine: 0,
    reasonsFreeTextStashed: 0,
    fieldsDefaulted: 0,
  };

  const out = {};
  const src = weeklyTimetables || {};

  for (const sk of Object.keys(src)) {
    const weekData = src[sk];

    if (!weekData || !Array.isArray(weekData.missed) || weekData.missed.length === 0) {
      out[sk] = weekData;
      continue;
    }

    const newMissed = weekData.missed.map(m => {
      stats.entriesProcessed++;

      const reasonResult = transformReason(m.reason, m.reasonDetail);
      if (reasonResult.bucket === "transformed") stats.reasonsTransformed++;
      else if (reasonResult.bucket === "alreadyMachine") stats.reasonsAlreadyMachine++;
      else if (reasonResult.bucket === "freeTextStashed") stats.reasonsFreeTextStashed++;

      const patched = { ...m };

      patched.reason = reasonResult.reason;
      patched.reasonDetail = reasonResult.reasonDetail;

      if (m.notes === undefined) { patched.notes = ""; stats.fieldsDefaulted++; }
      if (m.makeupEligible === undefined) { patched.makeupEligible = false; stats.fieldsDefaulted++; }
      if (m.madeUp === undefined) { patched.madeUp = false; stats.fieldsDefaulted++; }
      if (m.cardNote === undefined) { patched.cardNote = ""; stats.fieldsDefaulted++; }

      return patched;
    });

    out[sk] = { ...weekData, missed: newMissed };
  }

  return { weeklyTimetables: out, stats };
}
