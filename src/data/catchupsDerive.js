/**
 * Derive-time computation over the catchups collection.
 *
 * Catchups state shape comes from loadCatchupsFromSupabase
 * (src/utils/catchupsDB.js). This module is pure — no side effects,
 * no I/O. Consumers pass the catchups[] array (or an individual
 * Catchup object) and receive derived classifications and indices.
 *
 * Spec 3 cluster 4 — see SPEC_3.md §6 and §22.
 *
 * @typedef {import('../utils/catchupsDB').Catchup} Catchup
 */

/**
 * True if ANY of the four resolves_* fields is non-null. The most
 * permissive "is this catchup attached to anything?" predicate —
 * passes for both partially-linked rows (e.g. enrolmentId + weekKey
 * set, but original day/time missing on the source missed[] entry)
 * and fully-linked rows.
 *
 * @param {Catchup} catchup
 * @returns {boolean}
 */
export function isLinkedCatchup(catchup) {
  return (
    catchup.resolvesEnrolmentId != null ||
    catchup.resolvesWeekKey != null ||
    catchup.resolvesOriginalDay != null ||
    catchup.resolvesOriginalTime != null
  );
}

/**
 * True if ALL FOUR resolves_* fields are null. Per Spec 3 §22, this
 * is the invoicing-layer "unlinked Holiday Lesson" definition — these
 * rows become a "Holiday Lessons" line on the parent invoice rather
 * than banking against a missed lesson cell.
 *
 * @param {Catchup} catchup
 * @returns {boolean}
 */
export function isHolidayLesson(catchup) {
  return (
    catchup.resolvesEnrolmentId == null &&
    catchup.resolvesWeekKey == null &&
    catchup.resolvesOriginalDay == null &&
    catchup.resolvesOriginalTime == null
  );
}

/**
 * True if BOTH resolvesEnrolmentId AND resolvesWeekKey are non-null
 * — the practical "does this catchup actually resolve a tally cell?"
 * check. Tally banking (cluster 8) keys exclusively off this pair, so
 * partial linkage missing the original day/time still banks correctly.
 *
 * @param {Catchup} catchup
 * @returns {boolean}
 */
export function isBankingEligible(catchup) {
  return (
    catchup.resolvesEnrolmentId != null &&
    catchup.resolvesWeekKey != null
  );
}

/**
 * True if ALL FOUR resolves_* fields are non-null. Gold-standard
 * linked state — UI labels distinguishing fully-vs-partially-linked
 * use this (vs `isLinkedCatchup`, which permits partial linkage).
 *
 * @param {Catchup} catchup
 * @returns {boolean}
 */
export function isFullyResolved(catchup) {
  return (
    catchup.resolvesEnrolmentId != null &&
    catchup.resolvesWeekKey != null &&
    catchup.resolvesOriginalDay != null &&
    catchup.resolvesOriginalTime != null
  );
}

/**
 * Composite classifier — evaluates all four classifiers plus madeUp
 * once. Use when a consumer needs multiple statuses at once (e.g. an
 * invoice row picker that branches on holidayLesson, then
 * bankingEligible, then madeUp).
 *
 * @param {Catchup} catchup
 * @returns {{
 *   linked: boolean,
 *   holidayLesson: boolean,
 *   bankingEligible: boolean,
 *   fullyResolved: boolean,
 *   madeUp: boolean,
 * }}
 */
export function getCatchupStatus(catchup) {
  return {
    linked: isLinkedCatchup(catchup),
    holidayLesson: isHolidayLesson(catchup),
    bankingEligible: isBankingEligible(catchup),
    fullyResolved: isFullyResolved(catchup),
    madeUp: catchup.madeUp === true,
  };
}

/**
 * Build a banking-cell lookup Map from the catchups collection.
 *
 *   Key:   `${resolvesEnrolmentId}|${resolvesWeekKey}` (banking cell coords)
 *   Value: the catchup row
 *
 * Only banking-eligible rows (per `isBankingEligible`) are indexed.
 * If two catchups resolve the same cell — not present in current
 * production data but theoretically possible — the most recently
 * created row wins. Cluster 8 will read this Map in tallyDerive's
 * render loop to mark a cell as banked.
 *
 * Implementation note: rows are sorted createdAt-descending and
 * inserted with a `!has` guard, so the first set per key (the latest
 * row) sticks. A naïve Map.set without the guard would let an older
 * row overwrite a newer one.
 *
 * @param {Catchup[]} catchups
 * @returns {Map<string, Catchup>}
 */
export function buildBankingIndex(catchups) {
  const eligible = (catchups || []).filter(isBankingEligible);
  const sorted = [...eligible].sort((a, b) => {
    const aT = a.createdAt || "";
    const bT = b.createdAt || "";
    return bT.localeCompare(aT);
  });
  const idx = new Map();
  for (const c of sorted) {
    const key = `${c.resolvesEnrolmentId}|${c.resolvesWeekKey}`;
    if (!idx.has(key)) idx.set(key, c);
  }
  return idx;
}

/**
 * Convenience wrapper for a single banking-cell lookup. Builds the
 * index internally each call — fine for one-off queries; for hot
 * loops, callers should `buildBankingIndex` once and read from the
 * Map directly.
 *
 * @param {Catchup[]} catchups
 * @param {string} enrolmentId
 * @param {string} weekKey
 * @returns {Catchup|null}
 */
export function getBankingCatchupForCell(catchups, enrolmentId, weekKey) {
  if (enrolmentId == null || weekKey == null) return null;
  const idx = buildBankingIndex(catchups);
  return idx.get(`${enrolmentId}|${weekKey}`) || null;
}

/**
 * Filter catchups to those scheduled in a specific week.
 * @param {Catchup[]|null|undefined} catchups
 * @param {string|null|undefined} weekKey
 * @returns {Catchup[]} Filtered array; empty if inputs falsy.
 */
export function getCatchupsForWeek(catchups, weekKey) {
  if (!catchups || !weekKey) return [];
  return catchups.filter((c) => c.weekKey === weekKey);
}

/**
 * Returns all catchups at a specific grid cell (week, day, time).
 * Multiple catchups at the same cell are valid (stacked rendering);
 * caller decides single-vs-stacked render.
 * @param {Catchup[]|null|undefined} catchups
 * @param {string|null|undefined} weekKey
 * @param {string|null|undefined} day  e.g. "Monday"
 * @param {string|null|undefined} time e.g. "10:30"
 * @returns {Catchup[]} Filtered array; empty if any input falsy.
 */
export function getCatchupsForGridCell(catchups, weekKey, day, time) {
  if (!catchups || !weekKey || !day || !time) return [];
  return catchups.filter(
    (c) => c.weekKey === weekKey && c.day === day && c.time === time
  );
}
