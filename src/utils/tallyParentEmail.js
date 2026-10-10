// ============================================================
// tallyParentEmail.js — v2.49.13 the end-of-term parent email a Tally
// school row's Mail button opens (subject + body), as a pure function so it
// can be tested with the row's real inputs.
//
//   rowEntries — the row's FULL term of cells, one per term week in
//                termWeeks order (entryMap value or null), exactly as the
//                row renders them; never a pre-filtered subset.
//   termWeeks  — the term's weeks (holiday weeks included), for labels.
//   opts       — { bankingIndex, now } for the catch-up overlay; the same
//                options the row's Summary column passes rowSummaryCounts.
//
// Group rows pass isGroup + groupLabel; solo rows pass studentName and
// parentFullName (first parent's full name, or "").
// ============================================================

import { getMissedReasonProse } from "./missedReasonLabels";
import { preferredFirstName } from "./emailTemplates";
import { rowSummaryCounts } from "./tallyFilters";

export function buildTallyParentEmail({ rowEntries, termWeeks, isGroup = false, groupLabel = "", studentName = "", parentFullName = "", instrument, termLabel = "" }, opts = {}) {
  const entries = rowEntries || [];
  const rowCompleted = entries.filter(e => e?.status === "completed").length;
  const rowMissed = entries.filter(e => e?.status === "missed").length;
  const missedLines = (termWeeks || [])
    .map((w, wi) => ({ w, entry: entries[wi] }))
    .filter(({ entry }) => entry?.status === "missed")
    .map(({ w, entry }) => {
      const reasonText = getMissedReasonProse(entry.reason, entry.reasonDetail) || "Missed";
      return `  • ${w.label} — ${reasonText}`;
    });
  // v2.49.13 — the orange "owed" number the row's Summary column shows
  // (tallyFilters per-cell rule): a booked catch-up, whether it has happened
  // or not, is not owed; nor is one marked made up. Zero omits the line.
  const catchupOwed = rowSummaryCounts(entries, opts).owed;
  const summary = `Lessons attended: ${rowCompleted}\nLessons missed: ${rowMissed}${missedLines.length ? "\n" + missedLines.join("\n") : ""}${catchupOwed > 0 ? `\nCatch-ups still owed: ${catchupOwed}` : ""}\n\nPlease don't hesitate to get in touch if you have any questions.\n\nKind regards,`;
  if (isGroup) {
    return {
      subject: `${groupLabel} — ${instrument} lessons — ${termLabel} summary`,
      body: `Hi,\n\nI wanted to reach out with a summary of the ${groupLabel} ${instrument} group lessons for ${termLabel}.\n\n${summary}`,
    };
  }
  const parentName = preferredFirstName(parentFullName || "") || "there";
  return {
    subject: `${preferredFirstName(studentName)}'s ${instrument} lessons — ${termLabel} summary`,
    body: `Hi ${parentName},\n\nI wanted to reach out with a summary of ${preferredFirstName(studentName)}'s ${instrument} lessons for ${termLabel}.\n\n${summary}`,
  };
}
