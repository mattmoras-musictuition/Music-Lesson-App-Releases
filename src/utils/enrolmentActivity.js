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

// Build a card → enrolment resolver over one enrolments array.
//
// Deliberately generous about what counts as a match: enrolmentId is the
// canonical link, but cards predating enrolmentId stamping carry only
// studentId + instrument, and group cards key off groupId. Returns null when
// nothing matches, which every caller treats as "leave the card alone".
//
// Returns a function so the two Maps are built once per pass, not per card.
export function makeEnrolmentResolver(enrolments) {
  const list = enrolments || [];
  const byId = new Map();
  const byKey = new Map();
  for (const e of list) {
    byId.set(e.id, e);
    byKey.set(e.isGroup ? `group|${e.groupId}` : `${e.studentId}|${e.instrument}`, e);
  }
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
