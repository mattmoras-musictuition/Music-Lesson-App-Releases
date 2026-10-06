// ============================================================
// Multi-day calendar event bar (utils/calendarSegments.js). Called from
// runSmokeTests with its `assert`.
// ============================================================

import { getEventSegment, orderDayEvents } from "../utils/calendarSegments";

export function runCalendarSegmentTests(assert) {
  const pick = s => [s.multi, s.joinLeft, s.joinRight, s.showLabel, s.accent];

  // Single-day event: unchanged chip (own corners, accent, label, no joins).
  const single = { id: "s", title: "Assembly", date: "2026-10-07" };
  assert("calSeg: single-day event is a standalone chip",
    pick(getEventSegment(single, "2026-10-07", 2)), [false, false, false, true, true]);
  assert("calSeg: endDate equal to start is single-day",
    pick(getEventSegment({ ...single, endDate: "2026-10-07" }, "2026-10-07", 2)), [false, false, false, true, true]);

  // Wed–Fri camp (interruption shape: date/endDate), one week row.
  const camp = { id: "c", title: "Year 5 Camp", date: "2026-10-07", endDate: "2026-10-09" };
  assert("calSeg: camp Wed = start (accent + label, joins right only)",
    pick(getEventSegment(camp, "2026-10-07", 2)), [true, false, true, true, true]);
  assert("calSeg: camp Thu = middle (joins both sides, no label, no accent)",
    pick(getEventSegment(camp, "2026-10-08", 3)), [true, true, true, false, false]);
  assert("calSeg: camp Fri = end (joins left only, no label)",
    pick(getEventSegment(camp, "2026-10-09", 4)), [true, true, false, false, false]);

  // Calendar event shape (startDate) wrapping Sat → Tue across a week row.
  const trip = { id: "t", title: "Tour", startDate: "2026-10-10", endDate: "2026-10-13" };
  assert("calSeg: wrap — Sun (last column) still joins right, no label",
    pick(getEventSegment(trip, "2026-10-11", 6)), [true, true, true, false, false]);
  assert("calSeg: wrap — Mon (first cell of new row) repeats label, no accent",
    pick(getEventSegment(trip, "2026-10-12", 0)), [true, true, true, true, false]);
  assert("calSeg: wrap — Tue end gets no label",
    pick(getEventSegment(trip, "2026-10-13", 1)), [true, true, false, false, false]);

  // Ordering: multi-day first (earliest start, then longest), singles keep order.
  const a = { id: "a", title: "A", date: "2026-10-08" };
  const b = { id: "b", title: "B", date: "2026-10-08" };
  const long  = { id: "l", title: "L", date: "2026-10-06", endDate: "2026-10-10" };
  const short = { id: "m", title: "M", date: "2026-10-06", endDate: "2026-10-08" };
  assert("calSeg: order puts multi-day before single-day",
    orderDayEvents([a, camp, b]).map(e => e.id), ["c", "a", "b"]);
  assert("calSeg: order multi-day by start, then longest first",
    orderDayEvents([camp, short, long]).map(e => e.id), ["l", "m", "c"]);
  assert("calSeg: order leaves all-single-day days untouched",
    orderDayEvents([b, a]).map(e => e.id), ["b", "a"]);
}
