// ============================================================
// Multi-day calendar event segments
// One continuous filled bar across every day an event covers. Each day cell
// renders one segment; this decides how that segment joins its neighbours.
// Pure — dates are "YYYY-MM-DD" strings, weeks start Monday (di 0..6).
// ============================================================

/**
 * @param {object} ev  calendar event or interruption (startDate|date, endDate)
 * @param {string} ds  the day cell being rendered
 * @param {number} di  column index within the week row (0 = Monday)
 * @returns {{ multi, isStart, isEnd, joinLeft, joinRight, showLabel, accent }}
 *   joinLeft/joinRight — segment continues into the neighbouring cell (square
 *   corner, bleeds through the cell padding). accent — left stripe, true start
 *   only. showLabel — true start, or the first cell of a week row the event
 *   wraps into.
 */
export function getEventSegment(ev, ds, di) {
  const start = ev.startDate || ev.date;
  const end   = ev.endDate || start;
  if (!start || !end || end <= start) {
    return { multi: false, isStart: true, isEnd: true, joinLeft: false, joinRight: false, showLabel: true, accent: true };
  }
  const isStart = ds <= start;
  const isEnd   = ds >= end;
  return {
    multi: true,
    isStart,
    isEnd,
    joinLeft:  !isStart,
    joinRight: !isEnd,
    showLabel: isStart || di === 0,
    accent:    isStart,
  };
}

/**
 * Stable cell order so a multi-day bar keeps the same row across its days:
 * multi-day events first (earliest start, then longest, then id), then
 * single-day events in their original order.
 */
export function orderDayEvents(evs) {
  const startOf = ev => ev.startDate || ev.date || "";
  const endOf   = ev => ev.endDate || startOf(ev);
  const isMulti = ev => endOf(ev) > startOf(ev);
  return evs
    .map((ev, i) => ({ ev, i }))
    .sort((a, b) => {
      const am = isMulti(a.ev), bm = isMulti(b.ev);
      if (am !== bm) return am ? -1 : 1;
      if (!am) return a.i - b.i;
      const s = startOf(a.ev).localeCompare(startOf(b.ev));
      if (s) return s;
      const e = endOf(b.ev).localeCompare(endOf(a.ev));
      if (e) return e;
      return String(a.ev.id || "").localeCompare(String(b.ev.id || "")) || a.i - b.i;
    })
    .map(x => x.ev);
}
