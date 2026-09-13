// ============================================================
// enrolmentPreference.js — choose ONE enrolment out of several.
//
// A student can hold more than one enrolment row for the same instrument.
// That is legitimate by design: ending an enrolment is permanent, so a
// drop-and-resume creates a new row rather than resurrecting the old one
// (refinement D). It also happens accidentally — the CSV and PDF/AI import
// paths blind-append without deduping.
//
// Before v2.34.0 every resolution site picked from a duplicate set by array
// position and they did not agree with each other: deriveTallyRows took the
// FIRST match, makeEnrolmentResolver took the LAST, enrolmentIdFor took the
// first with no endDate filter at all. Same data, three different answers in
// one render — which is how a student's tally cell came to read "Inactive"
// against a row that had ended while their live row sat one index away.
//
// WHY ITS OWN MODULE: this rule belongs conceptually with enrolmentActivity,
// which owns "is this enrolment active for this week". But enrolmentActivity
// imports tallyDerive, and tallyDerive needs this rule — so putting it there
// would make tallyDerive and enrolmentActivity a circular import. This module
// therefore has NO imports at all and is safe for anything to depend on.
//
// THIS IS A PICKER, NOT A RESOLVER. It does not match. It knows nothing about
// studentId, instrument or groupId. It takes an already-matched candidate set
// and chooses one. Every call site keeps its own matching logic.
// ============================================================

// Order a BEFORE b? Returns <0 when a is preferred, >0 when b is, 0 never
// (the id tiebreak is total for distinct rows).
//
// The rule, in order:
//   1. A row with no endDate beats a row with one.
//   2. Among equals, the latest startDate wins.
//   3. Among equals, the lower id wins — arbitrary but STABLE, so the same
//      duplicate set always yields the same answer. Supabase returns rows
//      ordered by (student_id, instrument), which ties for every row in a
//      duplicate set and therefore settles nothing on its own.
//
// A falsy startDate sorts lowest, so a row carrying a real date is preferred
// over one carrying none.
function comparePreference(a, b) {
  const aEnded = a && a.endDate ? 1 : 0;
  const bEnded = b && b.endDate ? 1 : 0;
  if (aEnded !== bEnded) return aEnded - bEnded;   // live (0) before ended (1)

  const aStart = (a && a.startDate) || "";
  const bStart = (b && b.startDate) || "";
  if (aStart !== bStart) return aStart < bStart ? 1 : -1;  // later date first

  const aId = (a && a.id) || "";
  const bId = (b && b.id) || "";
  if (aId !== bId) return aId < bId ? -1 : 1;
  return 0;
}

// Choose the preferred enrolment from an already-matched candidate set.
//
// Returns null ONLY for an empty/absent set. When every candidate has ended it
// still returns one — the latest by startDate — because a fully archived
// student's tally must keep rendering their history. Discarding ended rows
// outright would blank it.
//
// A single-element set returns that element unchanged, always, including when
// it is ended, has no startDate, or is otherwise malformed. This is what keeps
// behaviour byte-identical for the overwhelming majority of students, who hold
// exactly one enrolment per instrument.
export function pickEnrolment(candidates) {
  const list = (candidates || []).filter(Boolean);
  if (list.length === 0) return null;
  if (list.length === 1) return list[0];

  let best = list[0];
  for (let i = 1; i < list.length; i++) {
    if (comparePreference(list[i], best) < 0) best = list[i];
  }
  return best;
}

// Reorder a list so that, within each group of rows sharing a key, the
// preferred row comes FIRST. Rows keep their original relative order
// otherwise, and groups appear in first-seen order.
//
// This exists for consumers that walk enrolments in order and claim a key the
// first time one passes some further test of their own — the tally derivers do
// exactly that, and they must keep their fallback: if the preferred row fails
// that test, the next-best row still gets its turn. Collapsing each group to a
// single row would silently drop that second chance.
//
// `keyOf` is supplied by the caller because different consumers group
// differently (the main tally keys group rows by groupId, the private tally
// has no group concept at all). This module deliberately does not know how any
// of them build a key.
//
// A list with no duplicate keys is returned in its EXACT original order, which
// is what makes this a no-op for the overwhelming majority of students.
export function orderByPreference(list, keyOf) {
  const rows = list || [];
  if (rows.length < 2) return rows;

  const groups = new Map();
  const order = [];
  for (const row of rows) {
    const k = keyOf(row);
    if (!groups.has(k)) { groups.set(k, []); order.push(k); }
    groups.get(k).push(row);
  }
  if (groups.size === rows.length) return rows;  // no duplicates — untouched

  const out = [];
  for (const k of order) {
    const group = groups.get(k);
    if (group.length === 1) { out.push(group[0]); continue; }
    const best = pickEnrolment(group);
    out.push(best);
    for (const row of group) if (row !== best) out.push(row);
  }
  return out;
}
