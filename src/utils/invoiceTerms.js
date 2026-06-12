// ============================================================
// invoiceTerms.js
// Term detection from calendar term-break interruptions.
// Pure functions, no side effects, no state.
//
// Relocated verbatim from InvoicingManager.js (v2.18.0 work) so the
// Dashboard's uninvoiced-students alert chip can resolve the current
// term with EXACTLY the same logic Invoicing uses for its default
// term selection (selIdx 0). InvoicingManager imports these back —
// single definition, no copies.
// ============================================================

export function _toDS(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
export function _addDays(ds, n) {
  const d = new Date(ds + "T00:00:00");
  d.setDate(d.getDate() + n);
  return _toDS(d);
}
export function _today() {
  try {
    const tz = localStorage.getItem("mt-timezone") || "Australia/Melbourne";
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  } catch { return _toDS(new Date()); }
}

export function _sortedBreaks(interruptions) {
  return interruptions
    .filter(i => i.type === "term_break")
    .map(i => ({ start: i.date, end: i.endDate || i.date }))
    .sort((a, b) => a.start.localeCompare(b.start));
}

export function detectTerms(interruptions) {
  const breaks = _sortedBreaks(interruptions);
  if (!breaks.length) return [];
  const today = _today();
  const allTerms = [];

  for (let i = 0; i < breaks.length - 1; i++) {
    const start = _addDays(breaks[i].end, 1);
    const end   = _addDays(breaks[i + 1].start, -1);
    if (start > end) continue;
    allTerms.push({ start, end });
  }

  // Term after last known break
  const last = breaks[breaks.length - 1];
  const afterStart = _addDays(last.end, 1);
  if (afterStart >= _addDays(today, -14)) {
    allTerms.push({ start: afterStart, end: _addDays(afterStart, 70), isEst: true });
  }

  // Derive term number from the month the term starts — reliable for Australian schools:
  // Term 1 = Jan–Mar, Term 2 = Apr–Jun, Term 3 = Jul–Sep, Term 4 = Oct–Dec.
  // This doesn't require historical break data (e.g. the summer break) to be stored.
  const labeled = allTerms.map(term => {
    const d = new Date(term.start + "T00:00:00");
    const yr = d.getFullYear();
    const month = d.getMonth() + 1;
    const num = month <= 3 ? 1 : month <= 6 ? 2 : month <= 9 ? 3 : 4;
    return { ...term, label: `Term ${num} ${yr}${term.isEst ? " (est.)" : ""}` };
  });

  return labeled.filter(t => t.end >= today).slice(0, 6);
}

// Reproduces Invoicing's default term selection exactly: detectTerms
// already filters to terms ending today-or-later, and the Invoicing
// dropdown defaults to selIdx 0 — so the "current term" is simply the
// first detected term. Returns null when no term breaks are recorded.
export function resolveCurrentTerm(interruptions) {
  return detectTerms(interruptions || [])[0] || null;
}
