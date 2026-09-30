// ============================================================
// catchupScope.js — which missed lessons a catch-up picker may offer
//
// Single source of truth for every "owed catch-ups" surface: the staging
// tray, the slot and holiday pickers, the band attribution window, the
// Dashboard badge/chip and the AI prompt. Pure: no state, no I/O.
//
// LOCKED RULE (v2.39.0) — offerable misses for a target week W:
//   1. Anchor term T. W inside a term_break → the term just before that
//      break; otherwise the term W sits in. W before the first known term
//      → nothing. "Inside a break" is the Monday test the invoice deduction
//      math uses for holiday catch-ups (tallyDerive getEnrolmentTermDeduction-
//      Math: c.weekKey within prevBreak), so a previous-term miss is only
//      ever offered where placing it will count against that miss.
//   2. Candidates are T's TERM-week misses only — the lifted body of the
//      WeeklyAdjustments "Schedule catchup" memo: getOpenCatchupRows'
//      containment filters, raw-WTT start/time re-join, enrolment-id
//      resolution, and removal of any miss a catchups row already resolves.
//      Terms before T are never offered.
//   3. Sent cutoff. N = the term after T. A student's candidates drop once
//      an invoice with status "sent" and N's label (" (est.)" ignored) has a
//      line for them — by studentId, or by studentName only on legacy lines
//      that carry no studentId.
//
// T and N come from Invoicing's own term detection (invoiceTerms.js), so T
// is exactly the prevTerm buildInvoices deducts when invoicing N. TallyView's
// calendar (termWeeks.getTerms/getCurrentTerm) is deliberately NOT used to
// pick T — the two are kept apart (Spec 4 cluster 7) — only getTermWeeks is
// reused to lay out T's weeks.
// ============================================================

import { getOpenCatchupRows } from "./tallyDerive";
import { getTermWeeks } from "./termWeeks";
import { _sortedBreaks, _addDays, _findPrevTerm, findNextTerm } from "./invoiceTerms";
import { enrolmentIdFor } from "./enrolmentsDB";

/**
 * Parse the raw "mt-invoice-drafts" localStorage string. Missing, empty or
 * malformed input — or anything that isn't an array — reads as no invoices.
 * @param {string|null|undefined} raw
 * @returns {Object[]}
 */
export function parseInvoiceDrafts(raw) {
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter(inv => inv && typeof inv === "object") : [];
  } catch {
    return [];
  }
}

/**
 * "Term 4 2099 (est.)" and "Term 4 2099" name the same term.
 * @param {string} label
 * @returns {string}
 */
export function normalizeTermLabel(label) {
  return String(label || "").replace(/\s*\(est\.\)\s*$/, "").trim();
}

/**
 * Resolve rule 1's anchor term for a target week.
 * @param {Array} interruptions
 * @param {string} weekKey - Monday, YYYY-MM-DD.
 * @returns {{ term: {start:string, end:string}, inBreak: boolean }|null}
 */
export function resolveAnchorTerm(interruptions, weekKey) {
  const breaks = _sortedBreaks(interruptions || []);
  if (!weekKey || breaks.length === 0) return null;
  const holding = breaks.find(b => weekKey >= b.start && weekKey <= b.end);
  if (holding) {
    const term = _findPrevTerm(interruptions, _addDays(holding.end, 1));
    return term ? { term, inBreak: true } : null;
  }
  const nextBreak = breaks.find(b => b.start > weekKey);
  let term;
  if (nextBreak) {
    term = _findPrevTerm(interruptions, _addDays(nextBreak.end, 1));
  } else {
    // After the last known break — the same estimated term detectAllTerms
    // builds (start + 70 days).
    const start = _addDays(breaks[breaks.length - 1].end, 1);
    term = { start, end: _addDays(start, 70) };
  }
  if (!term) return null;
  // Before the first known term: the whole week ends before T begins.
  if (_addDays(weekKey, 6) < term.start) return null;
  return { term, inBreak: false };
}

// Every line of every SENT invoice for `term` (" (est.)" ignored). Rule 3's
// input, shared with nextTermInvoiceSentFor.
function sentInvoiceLinesForTerm(invoices, term) {
  const label = normalizeTermLabel(term && term.label);
  const lines = [];
  for (const inv of (invoices || [])) {
    if (!inv || inv.status !== "sent") continue;
    if (normalizeTermLabel(inv.termLabel) !== label) continue;
    for (const line of (inv.lines || [])) if (line) lines.push(line);
  }
  return lines;
}

// True when a sent invoice for the next term bills this student. A line with
// a studentId matches on that id alone; only a legacy line with none falls
// back to the name.
function studentInvoiceSent(sentLines, studentId, studentName) {
  return sentLines.some(line => line.studentId
    ? line.studentId === studentId
    : (!!studentName && line.studentName === studentName));
}

/**
 * Rule 1–3: every miss a catch-up placed in `targetWeekKey` may settle.
 * Entries are the picker's candidate shape (the shim entry plus weekKey,
 * start/time and a resolved enrolmentId), oldest first. All schools —
 * callers apply their own school filter.
 *
 * @param {Object} params
 * @param {string} params.targetWeekKey
 * @param {Array} params.interruptions
 * @param {Object[]} [params.invoices] - parsed "mt-invoice-drafts".
 * @param {Object} params.weeklyTimetables
 * @param {Array} params.enrolments
 * @param {Array} params.students
 * @param {Object} params.timetable
 * @param {Array} [params.catchups]
 * @param {Array} [params.groups] - lets a group miss drop once every member is invoiced.
 * @returns {{ anchorTerm: Object|null, nextTerm: Object|null, entries: Object[] }}
 */
export function getOfferableMisses({
  targetWeekKey, interruptions, invoices = [], weeklyTimetables, enrolments, students,
  timetable, catchups = [], groups = [],
}) {
  const anchor = resolveAnchorTerm(interruptions, targetWeekKey);
  if (!anchor) return { anchorTerm: null, nextTerm: null, entries: [] };
  const T = anchor.term;
  const termBreaks = (interruptions || [])
    .filter(i => i.type === "term_break")
    .sort((a, b) => a.date.localeCompare(b.date));
  // now = T's last day keeps getTermWeeks from stretching T to today's week.
  const termWeeks = getTermWeeks({
    activeTerm: { start: new Date(T.start + "T00:00:00"), end: new Date(T.end + "T00:00:00") },
    termBreaks,
    now: new Date(T.end + "T00:00:00"),
  });
  const openRows = getOpenCatchupRows({
    weeklyTimetables, enrolments, students, timetable, termWeeks, schoolFilter: "all",
  });

  // ── Lifted from WeeklyAdjustments' unresolvedMissedGroups memo ──
  const candidates = [];
  for (const row of openRows) {
    // Re-join to the raw WTT missed entry to recover start/time, which the
    // shim doesn't carry but handleScheduleCatchup needs for
    // resolvesOriginalTime. Storage key mirrors deriveTallyRows.
    const wttMissed = weeklyTimetables?.[`${row.weekKey}|${row.missed.schoolId}`]?.missed || [];
    const matchDay = row.missed.day;
    const matchById = row.missed.groupId
      ? (m) => m.day === matchDay && m.groupId === row.missed.groupId
      : (m) => m.day === matchDay && m.studentId === row.missed.studentId && m.instrument === row.missed.instrument;
    const rawMissed = wttMissed.find(matchById);
    if (!rawMissed && process.env.NODE_ENV !== "production") {
      console.warn("[catchup picker] start/time re-join missed raw WTT entry", {
        weekKey: row.weekKey, schoolId: row.missed.schoolId, day: matchDay,
        studentId: row.missed.studentId, instrument: row.missed.instrument, groupId: row.missed.groupId,
      });
    }
    const enriched = {
      ...row.missed,
      start: row.missed.start ?? rawMissed?.start ?? null,
      time: row.missed.time ?? rawMissed?.time ?? null,
    };
    const resolvedId = enriched.enrolmentId ?? enrolmentIdFor(enriched.studentId, enriched.instrument, enrolments, enriched.groupId);
    if (!resolvedId) {
      if (process.env.NODE_ENV !== "production") {
        console.warn("[catchup picker] dropping candidate — could not resolve enrolment", {
          studentId: enriched.studentId,
          studentName: enriched.studentName,
          instrument: enriched.instrument,
          weekKey: row.weekKey,
          day: enriched.day,
        });
      }
      continue;
    }
    enriched.enrolmentId = resolvedId;
    if ((catchups || []).some(c => c.resolvesEnrolmentId === resolvedId && c.resolvesWeekKey === row.weekKey)) continue;
    candidates.push(enriched);
  }

  // ── Rule 3: sent cutoff ──
  const N = findNextTerm(interruptions, T.end);
  let entries = candidates;
  if (N) {
    const sentLines = sentInvoiceLinesForTerm(invoices, N);
    if (sentLines.length > 0) {
      const nameOf = (id, fallback) => (students || []).find(s => s.id === id)?.name || fallback || "";
      entries = candidates.filter(e => {
        if (e.isGroup || (!e.studentId && e.groupId)) {
          const members = (groups || []).find(g => g.id === e.groupId)?.studentIds || [];
          if (members.length === 0) return true;
          return !members.every(id => studentInvoiceSent(sentLines, id, nameOf(id)));
        }
        return !studentInvoiceSent(sentLines, e.studentId, nameOf(e.studentId, e.studentName));
      });
    }
  }

  entries = [...entries].sort((a, b) => (a.weekKey || "").localeCompare(b.weekKey || ""));
  return { anchorTerm: T, nextTerm: N, entries };
}

/**
 * Rule 3 for a single student and a single miss: true when the invoice for
 * the term AFTER the miss's anchor term (rule 1) is already sent and bills
 * this student — i.e. re-opening that miss now can no longer be credited on
 * it. Same anchor, same sent-line match as getOfferableMisses.
 *
 * @param {Object} params
 * @param {string} params.weekKey - the miss's week.
 * @param {Array} params.interruptions
 * @param {Object[]} [params.invoices] - parsed "mt-invoice-drafts".
 * @param {string} params.studentId
 * @param {string} [params.studentName]
 * @returns {boolean}
 */
export function nextTermInvoiceSentFor({ weekKey, interruptions, invoices = [], studentId, studentName }) {
  const anchor = resolveAnchorTerm(interruptions, weekKey);
  if (!anchor) return false;
  const N = findNextTerm(interruptions, anchor.term.end);
  if (!N) return false;
  return studentInvoiceSent(sentInvoiceLinesForTerm(invoices, N), studentId, studentName);
}

/**
 * Group offerable entries per enrolment — the "Schedule catchup" picker's
 * shape (lifted from the same memo). Each group's missedEntries are oldest
 * first; groups sort by student name, then instrument.
 * @param {Object[]} entries - from getOfferableMisses.
 * @param {Object} params
 * @param {Array} params.enrolments
 * @param {Array} params.students
 * @returns {Object[]}
 */
export function groupOfferableByEnrolment(entries, { enrolments, students }) {
  const byEnrolment = new Map();
  for (const e of (entries || [])) {
    if (!byEnrolment.has(e.enrolmentId)) byEnrolment.set(e.enrolmentId, []);
    byEnrolment.get(e.enrolmentId).push(e);
  }
  const groups = [];
  for (const [enrolmentId, list] of byEnrolment) {
    if (list.length === 0) continue;
    list.sort((a, b) => (a.weekKey || "").localeCompare(b.weekKey || "")); // oldest first
    const first = list[0];
    const en = (enrolments || []).find(e => e.id === enrolmentId);
    const st = en && !en.isGroup ? (students || []).find(s => s.id === en.studentId) : null;
    const studentName = en?.isGroup
      ? (first.groupName || "Group")
      : (st?.name || first.studentName || "—");
    groups.push({
      enrolmentId,
      studentName,
      instrument: first.instrument || en?.instrument || "",
      schoolId: first.schoolId || "",
      owedCount: list.length,
      missedEntries: list,
    });
  }
  groups.sort((a, b) => {
    const na = a.studentName.toLowerCase();
    const nb = b.studentName.toLowerCase();
    if (na !== nb) return na.localeCompare(nb);
    return (a.instrument || "").localeCompare(b.instrument || "");
  });
  return groups;
}
