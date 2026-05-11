// ============================================================
// TALLY HELPERS
// Pure functions for term week numbering and 6pm-threshold check.
//
// Spec 3 cluster 12b: computeAutoTallyDay, computeExtraTicks, and
// getTermWeeksList retired alongside the App.js auto-tally batch.
// Cluster 8's render-time isCatchupCompleted subsumes the
// catch-up resolution semantic via derived display.
// ============================================================

import { toLocalDateStr, melbourneNow, _getMondayOf } from "./helpers";

// ── Term week computation ─────────────────────────────────────────────────────

export function computeTermWeekNum(weekKey, sortedTermBreaks) {
  const d = new Date(weekKey + "T00:00:00");
  let termStartDay = null, breakEndMonth = -1;
  for (const tb of sortedTermBreaks) {
    const tbEnd = new Date((tb.endDate || tb.date) + "T00:00:00");
    if (tbEnd < d) {
      termStartDay = new Date(tbEnd);
      termStartDay.setDate(termStartDay.getDate() + 1);
      breakEndMonth = tbEnd.getMonth();
    }
  }
  if (!termStartDay || breakEndMonth === 11 || breakEndMonth === 0) {
    const year = d.getFullYear();
    const start = new Date(year, 0, 27);
    while (start.getDay() !== 2) start.setDate(start.getDate() + 1);
    termStartDay = start;
  }
  const diffWeeks = Math.round(
    (_getMondayOf(d).getTime() - _getMondayOf(termStartDay).getTime()) / (7 * 24 * 60 * 60 * 1000)
  );
  return Math.max(1, diffWeeks + 1);
}

export function computeTermKey(dateStr, sortedTermBreaks) {
  const _getT1 = (y) => {
    const s = new Date(y, 0, 27);
    while (s.getDay() !== 2) s.setDate(s.getDate() + 1);
    return s;
  };
  const d = new Date(dateStr + "T00:00:00");
  for (const y of [d.getFullYear() - 1, d.getFullYear(), d.getFullYear() + 1]) {
    let tStart = _getT1(y);
    for (const tb of sortedTermBreaks.filter(tb => new Date(tb.date + "T00:00:00").getFullYear() === y)) {
      const bs = new Date(tb.date + "T00:00:00"), be = new Date((tb.endDate || tb.date) + "T00:00:00");
      if (bs > tStart) {
        const te = new Date(bs); te.setDate(te.getDate() - 1);
        if (d >= tStart && d <= te) return `${y}-T${sortedTermBreaks.indexOf(tb) + 1}`;
        tStart = new Date(be); tStart.setDate(tStart.getDate() + 1);
        while (tStart.getDay() === 0 || tStart.getDay() === 6) tStart.setDate(tStart.getDate() + 1);
      }
    }
    if (d >= tStart) return `${y}-T${sortedTermBreaks.filter(tb => new Date(tb.date + "T00:00:00").getFullYear() === y).length + 1}`;
  }
  return null;
}

// Returns true if the given day has passed 6pm Melbourne time
export function isDayPast6pm(dayName, weekKey) {
  const dayIndex = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"].indexOf(dayName);
  if (dayIndex < 0) return false;
  const dayDate = new Date(weekKey + "T00:00:00");
  dayDate.setDate(dayDate.getDate() + dayIndex);
  const dayDateStr = toLocalDateStr(dayDate);
  const now = melbourneNow();
  const nowStr = toLocalDateStr(now);
  return dayDateStr < nowStr || (dayDateStr === nowStr && now.getHours() >= 18);
}
