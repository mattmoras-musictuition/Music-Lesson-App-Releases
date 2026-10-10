// ============================================================
// tallyFilters.js — v2.49.10 one rule per Tally cell state, shared by the
// summary boxes (counts), the box filter (which rows show) and the
// right-hand Summary column, so the three can never disagree.
//
// Every non-inactive cell is exactly one of:
//   completed   — a lesson recorded (tick)
//   absent      — missed, no make-up owed (red X)
//   unscheduled — missed, make-up owed, nothing booked (orange dot)
//   scheduled   — missed, make-up owed, catch-up booked but not yet
//                 happened (blue dot)
//   madeUp      — marked made up (navy arrow) OR a booked catch-up whose
//                 time has passed (blue tick)
//   blank       — nothing recorded yet
// The catch-up overlay comes from the existing predicates in
// catchupsDerive (isCaughtUpCell / isScheduledCatchupCell); it is not
// re-implemented here.
//
// Options shared by every function:
//   bankingIndex — buildBankingIndex(catchups)
//   now          — passed through to the catch-up predicates (undefined =
//                  their own default, the current time)
//   isPast       — week predicate for Not Yet Marked; defaults to the app
//                  standard isPastWeek (6pm Friday rollover)
// ============================================================

import { isPastWeek } from "./helpers";
import { isCaughtUpCell, isScheduledCatchupCell } from "../data/catchupsDerive";

export const TALLY_PILLS = {
  ABSENT: "absent",
  UNSCHEDULED: "unscheduled",
  SCHEDULED: "scheduled",
  MADE_UP: "madeUp",
  NOT_MARKED: "notMarked",
};

// The state of one cell (entry = an entryMap value, or null for no entry).
export function classifyTallyCell(entry, { bankingIndex, now } = {}) {
  if (!entry) return "blank";
  if (entry.status === "removed") return "inactive";
  if (entry.status === "completed") return "completed";
  if (entry.status !== "missed") return "blank";
  if (entry.madeUp || isCaughtUpCell(entry, bankingIndex, now)) return "madeUp";
  if (!entry.makeupEligible) return "absent";
  return isScheduledCatchupCell(entry, bankingIndex, now) ? "scheduled" : "unscheduled";
}

// True when the cell for `week` counts for `pill`. Holiday weeks never count.
// Not Yet Marked counts blank cells in past weeks only.
export function cellMatchesPill(entry, week, pill, opts = {}) {
  if (!week || week.isHoliday) return false;
  const state = classifyTallyCell(entry, opts);
  if (pill === TALLY_PILLS.NOT_MARKED) {
    const isPast = opts.isPast || isPastWeek;
    return state === "blank" && isPast(week.weekKey);
  }
  return state === pill;
}

// True when at least one of the row's cells counts for `pill`.
export function rowMatchesPill(row, entryMap, termWeeks, pill, opts = {}) {
  return (termWeeks || []).some(w =>
    cellMatchesPill((entryMap || {})[`${row.lessonKey}|${w.weekKey}`] || null, w, pill, opts));
}

// Summary box numbers over the given rows and the term's non-holiday weeks.
// `missed` = absent + unscheduledMakeups + makeupScheduled + madeUp.
export function computeTallyStats(rows, entryMap, termWeeks, opts = {}) {
  const isPast = opts.isPast || isPastWeek;
  const stats = { completed: 0, missed: 0, absent: 0, unscheduledMakeups: 0, makeupScheduled: 0, madeUp: 0, unmarked: 0 };
  const weeks = (termWeeks || []).filter(w => !w.isHoliday);
  for (const r of rows || []) {
    for (const w of weeks) {
      const state = classifyTallyCell((entryMap || {})[`${r.lessonKey}|${w.weekKey}`] || null, opts);
      if (state === "completed") stats.completed++;
      else if (state === "absent") stats.absent++;
      else if (state === "unscheduled") stats.unscheduledMakeups++;
      else if (state === "scheduled") stats.makeupScheduled++;
      else if (state === "madeUp") stats.madeUp++;
      else if (state === "blank" && isPast(w.weekKey)) stats.unmarked++;
    }
  }
  stats.missed = stats.absent + stats.unscheduledMakeups + stats.makeupScheduled + stats.madeUp;
  return stats;
}

// Right-hand Summary column numbers for one row's cells (the entries the
// row renders). Scheduled-not-yet-happened cells count in none of them.
export function rowSummaryCounts(rowEntries, opts = {}) {
  const out = { completed: 0, absent: 0, owed: 0, madeUp: 0 };
  for (const e of rowEntries || []) {
    const state = classifyTallyCell(e, opts);
    if (state === "completed") out.completed++;
    else if (state === "absent") out.absent++;
    else if (state === "unscheduled") out.owed++;
    else if (state === "madeUp") out.madeUp++;
  }
  return out;
}
