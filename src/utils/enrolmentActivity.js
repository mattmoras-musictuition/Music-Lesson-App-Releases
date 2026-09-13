// ============================================================
// enrolmentActivity.js — "is this card's enrolment active in this week?"
//
// Extracted verbatim from the v2.31.0 weekly-generation guard
// (weeklyTimetableGenerator.js) so the master-to-weekly copy paths can share
// one implementation instead of growing a copy each. The generator now uses
// this module rather than keeping its own — a shared helper that leaves the
// original in place would just be another copy.
//
// The date predicate is NOT re-derived here. deriveTallyCell IS the predicate:
// called with no WTT entry it returns "inactive" for exactly the weeks the
// tally dashes — startDate after the week's Sunday, or endDate before its
// Monday — and "blank" otherwise. So every consumer of this module agrees with
// the tally by construction. tallyDerive is imported, never modified.
//
// The PAST-WEEK test deliberately does NOT live here. Each caller derives its
// target week differently, and the exemption belongs with whoever knows which
// week is being written. This module answers the date question only, for a
// week key it is handed.
// ============================================================

import { deriveTallyCell } from "./tallyDerive";
import { pickEnrolment } from "./enrolmentPreference";

// Build a card → enrolment resolver over one enrolments array.
//
// Deliberately generous about what counts as a match: enrolmentId is the
// canonical link, but cards predating enrolmentId stamping carry only
// studentId + instrument, and group cards key off groupId. Returns null when
// nothing matches, which every caller treats as "leave the card alone".
//
// Returns a function so the two Maps are built once per pass, not per card.
// v2.34.0 — the key lookup no longer takes whichever row happened to be LAST.
// byKey.set in a loop silently meant last-wins, which was the exact opposite of
// what deriveTallyRows did with the same duplicate set. Because this resolver
// gates weekly generation, a dead row selected here excluded the student's card
// from the generated week AND suppressed them from the amber "not scheduled
// this week" banner that exists to catch precisely that.
//
// Now every row sharing a key is collected and pickEnrolment chooses, so this
// resolver and the tally agree by construction.
//
// The enrolmentId fast path is unchanged: ids are unique, so that lookup is
// unambiguous by construction and needs no preference rule.
export function makeEnrolmentResolver(enrolments) {
  const list = enrolments || [];
  const byId = new Map();
  const candidatesByKey = new Map();
  for (const e of list) {
    byId.set(e.id, e);
    const k = e.isGroup ? `group|${e.groupId}` : `${e.studentId}|${e.instrument}`;
    if (!candidatesByKey.has(k)) candidatesByKey.set(k, []);
    candidatesByKey.get(k).push(e);
  }
  const byKey = new Map();
  for (const [k, candidates] of candidatesByKey) byKey.set(k, pickEnrolment(candidates));

  return (l) => (l && l.enrolmentId && byId.get(l.enrolmentId))
    || byKey.get(l && l.isGroup ? `group|${l.groupId}` : `${l && l.studentId}|${l && l.instrument}`)
    || null;
}

// True when this card must NOT be copied into the given week, because its
// enrolment had not started (or had already ended) then.
//
// Fails open in every ambiguous case — no resolver, no week key, a band
// session, or a card whose enrolment cannot be resolved all return false, so
// the card is copied exactly as it is today. Unresolvable never means excluded.
// A falsy startDate also fails open, inside deriveTallyCell's own guard.
export function isCardInactiveForWeek(lesson, resolver, weekKey) {
  if (!lesson || !resolver || !weekKey) return false;
  if (lesson.isBandSession) return false;          // standing rule: bands exempt
  const enrolment = resolver(lesson);
  if (!enrolment) return false;                    // unresolvable never means excluded
  return deriveTallyCell({ enrolment, week: { weekKey }, wttEntry: null }) === "inactive";
}
