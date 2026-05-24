// ============================================================
// TERM WEEKS — canonical derivation
//
// Single source of truth for "what term is it now" and "which weeks
// belong to the current term". Extracted from TallyView.js so Dashboard
// (and any future consumer) can share the same derivation rather than
// reimplementing the term-boundary calendar logic.
//
// Behavioural contract preserved verbatim:
//   - Term 1 anchors at the first Tuesday on/after Jan 27.
//   - Year ends Dec 18 (rounded back to a weekday).
//   - Term boundaries are inferred from term_break interruptions.
//   - termWeeks includes the trailing H1/H2/… holiday weeks of the
//     break that follows the active term, plus the active term itself.
// ============================================================

// Inlined from admin's helpers.js: teacher-app's helpers.js doesn't
// export toLocalDateStr. Single-line YYYY-MM-DD local-date formatter
// — semantically identical to admin's export.
const toLocalDateStr = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

/**
 * Snap a date to its Monday. Mutating-safe (works on a copy).
 * @param {Date|string|number} date
 * @returns {Date}
 */
export function getMondayOf(date) {
  const m = new Date(date);
  const dow = m.getDay();
  m.setDate(m.getDate() + (dow === 0 ? -6 : 1 - dow));
  m.setHours(0, 0, 0, 0);
  return m;
}

/**
 * Build the list of all terms in a 3-year window (year-1, year, year+1)
 * given the term_break interruptions. Term boundaries are inferred:
 * each break ends one term and starts the next.
 * @param {Array<{date:string, endDate?:string}>} termBreaks
 * @param {Date} [now] - Reference "today" for year anchoring. Defaults to new Date().
 * @returns {Array<{key:string, label:string, start:Date, end:Date, year:number, num:number}>}
 */
export function getTerms(termBreaks, now = new Date()) {
  const year = now.getFullYear();
  const getTerm1Start = (y) => {
    const start = new Date(y, 0, 27);
    while (start.getDay() !== 2) start.setDate(start.getDate() + 1);
    return start;
  };
  const allBreaks = [...(termBreaks || [])];
  const terms = [];
  const years = [year - 1, year, year + 1];
  for (const y of years) {
    let termStart = getTerm1Start(y);
    const yearBreaks = allBreaks.filter(tb => {
      const d = new Date(tb.date + "T00:00:00");
      return d.getFullYear() === y || (d.getMonth() === 11 && d.getFullYear() === y);
    });
    let termNum = 1;
    for (const tb of yearBreaks) {
      const breakStart = new Date(tb.date + "T00:00:00");
      const breakEnd = new Date((tb.endDate || tb.date) + "T00:00:00");
      if (breakStart > termStart) {
        const termEnd = new Date(breakStart);
        termEnd.setDate(termEnd.getDate() - 1);
        while (termEnd.getDay() === 0 || termEnd.getDay() === 6) termEnd.setDate(termEnd.getDate() - 1);
        terms.push({ key: `${y}-T${termNum}`, label: `${y} Term ${termNum}`, start: new Date(termStart), end: termEnd, year: y, num: termNum });
        termNum++;
        termStart = new Date(breakEnd);
        termStart.setDate(termStart.getDate() + 1);
        while (termStart.getDay() === 0 || termStart.getDay() === 6) termStart.setDate(termStart.getDate() + 1);
      }
    }
    // Last term of the year
    const yearEnd = new Date(y, 11, 18);
    if (termStart <= yearEnd) {
      while (yearEnd.getDay() === 0 || yearEnd.getDay() === 6) yearEnd.setDate(yearEnd.getDate() - 1);
      terms.push({ key: `${y}-T${termNum}`, label: `${y} Term ${termNum}`, start: new Date(termStart), end: yearEnd, year: y, num: termNum });
    }
  }
  return terms;
}

/**
 * Pick the active term given the full list of terms and a reference date.
 *   - In-term: that term.
 *   - During holidays: the most recently completed term (not the upcoming one).
 *   - Before any term starts: the first upcoming term.
 * @param {Array<{start:Date, end:Date}>} terms
 * @param {Date} now
 * @returns {Object|undefined}
 */
export function getCurrentTerm(terms, now) {
  if (!terms || terms.length === 0) return undefined;
  const inTerm = terms.find(t => now >= t.start && now <= t.end);
  if (inTerm) return inTerm;
  const pastTerms = terms.filter(t => now > t.end);
  if (pastTerms.length > 0) return pastTerms[pastTerms.length - 1];
  return terms.find(t => now < t.start) || terms[terms.length - 1];
}

/**
 * Build the term-weeks list for the active term, including the trailing
 * H1/H2/… holiday weeks of the break that follows it.
 * @param {Object} params
 * @param {Object} params.activeTerm - From getCurrentTerm.
 * @param {Array<{date:string, endDate?:string}>} params.termBreaks
 * @param {Date} params.now
 * @returns {Array<{weekKey:string, weekNum:number, label:string, isHoliday?:boolean}>}
 */
export function getTermWeeks({ activeTerm, termBreaks, now }) {
  if (!activeTerm) return [];
  const weeks = [];
  const monday = getMondayOf(activeTerm.start);
  let w = new Date(monday);
  let weekNum = 1;
  // Always extend at least to today's week, in case the term end date is
  // miscalculated (e.g. due to a malformed term_break interruption entry).
  const todayMonday = getMondayOf(now);
  const loopEnd = todayMonday > activeTerm.end ? todayMonday : activeTerm.end;
  while (w <= loopEnd) {
    const weekKey = toLocalDateStr(w);
    // Check if this week is entirely in a term break
    const fri = new Date(w); fri.setDate(fri.getDate() + 4);
    const inBreak = (termBreaks || []).some(tb => {
      const bs = tb.date; const be = tb.endDate || tb.date;
      return weekKey >= bs && toLocalDateStr(fri) <= be;
    });
    if (!inBreak) weeks.push({ weekKey, weekNum, label: `W${weekNum}` });
    weekNum++;
    w = new Date(w); w.setDate(w.getDate() + 7);
  }
  // Append holiday weeks from the break following this term (H1, H2, …)
  const nextBreak = (termBreaks || []).find(tb => {
    const bs = new Date(tb.date + "T00:00:00");
    return bs > activeTerm.end;
  });
  if (nextBreak) {
    const breakStart = nextBreak.date;
    const breakEnd = nextBreak.endDate || nextBreak.date;
    const breakStartMon = getMondayOf(new Date(breakStart + "T00:00:00"));
    let hw = new Date(breakStartMon);
    let hNum = 1;
    while (toLocalDateStr(hw) <= breakEnd) {
      const hwStr = toLocalDateStr(hw);
      // Only include if this Monday actually falls within the break period
      if (hwStr >= breakStart) {
        weeks.push({ weekKey: hwStr, weekNum: hNum, label: `H${hNum}`, isHoliday: true });
        hNum++;
      }
      hw = new Date(hw); hw.setDate(hw.getDate() + 7);
    }
  }
  return weeks;
}
