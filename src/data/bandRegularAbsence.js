// ============================================================
// bandRegularAbsence.js — "Mark absent ▸" for the Regular members the
// protected gate (bandAbsence.js eligibleForAbsence) cannot offer.
// Pure: no React, no I/O, no clock reads (the caller passes `at`).
//
//   Gap 1 — a SOLO Regular member whose band holds no card for them (their
//           card never reached the ledger). Offered when the enrolment is
//           active that week, nothing is already missed for it that week in
//           any school's row, and there is a lesson to miss:
//             sweep     — the card IS in the band's own row: it is swept into
//                         the ledger first, then the normal held-card absence;
//             elsewhere — the card is in another school's row: that card
//                         becomes the miss and goes back to that row on Undo;
//             master    — no card anywhere: the lesson is built from the
//                         master timetable; the miss carries bandNoCard and
//                         Undo adds nothing to the ledger.
//           No master card at all → not offered (the window says why). A
//           closed lesson day does not matter: the band session stood in.
//   Gap 2 — a Regular GROUP, as one unit: its group card (held, or found as
//           above) becomes ONE whole-group miss.
//
// Every miss has planMarkAbsent's shape (bandAbsence.js) — the card's own
// day/time, enrolmentId, reason fields, bandLessonId, ledgerTeacherId, no
// teacherId/writerTeacherId — plus exactly one of:
//   ledgerCard  — held card (Undo puts it back in the ledger);
//   bandNoCard  — built from the master (Undo adds nothing);
//   bandCardRow + originCard — taken from another row (Undo returns it there).
// bandNoCard / bandCardRow cards must never be put back by the protected
// restore paths; the admin helpers at the bottom filter them out.
// ============================================================

import { bandMissesFor, bandEntryForMiss, planRemoveBandSession, planBandRemovalAbsences } from "./bandAbsence";
import { hasMemberStates, CONSUMPTION, isGroupEntry, findMemberCards, sweepRegularIntoLedger, restoreCardsReporting } from "./bandMemberStates";
import { stampAdminOverride } from "./bandAttendance";
import { deriveTallyCell } from "../utils/tallyDerive";
import { enrolmentIdFor } from "../utils/enrolmentsDB";
import { uid } from "../utils/helpers";

export const REGULAR_KIND = Object.freeze({
  held: "held", sweep: "sweep", elsewhere: "elsewhere", master: "master",
  noMaster: "no_master", inactive: "inactive", missed: "missed",
});
const OFFERED = new Set([REGULAR_KIND.held, REGULAR_KIND.sweep, REGULAR_KIND.elsewhere, REGULAR_KIND.master]);

const DAY_OFFSET = { Monday: 0, Tuesday: 1, Wednesday: 2, Thursday: 3, Friday: 4, Saturday: 5, Sunday: 6 };

function addDays(weekKey, n) {
  const d = new Date(weekKey + "T00:00:00");
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function weekOfRow(rowKey) {
  const bar = (rowKey || "").indexOf("|");
  return bar === -1 ? rowKey || "" : rowKey.slice(0, bar);
}

/** Every "<weekKey>|<school>" row key of `weekKey`, sorted. */
export function weekRowKeys(weeklyTimetables, weekKey) {
  const prefix = weekKey + "|";
  return Object.keys(weeklyTimetables || {}).filter(k => k.startsWith(prefix)).sort();
}

/** True if a miss was taken from another row or built from the master. */
export function isMarkedBandMiss(m) {
  return !!m && !!m.bandLessonId && (m.bandNoCard === true || !!m.bandCardRow);
}

// The subjects of a band: one per solo Regular entry, one per Regular group.
function regularSubjectsOf(band) {
  if (!hasMemberStates(band)) return [];
  const out = [];
  const groups = new Map();
  for (const e of band.memberStates) {
    if (!e || e.consumption !== CONSUMPTION.regular) continue;
    if (isGroupEntry(e)) {
      let g = groups.get(e.groupId);
      if (!g) {
        g = { key: "regular:group:" + e.groupId, groupId: e.groupId, enrolmentId: e.enrolmentId, studentId: e.studentId, instrument: e.instrument || "", entries: [] };
        groups.set(e.groupId, g);
        out.push(g);
      }
      g.entries.push(e);
    } else {
      out.push({ key: "regular:enrolment:" + e.enrolmentId, groupId: null, enrolmentId: e.enrolmentId, studentId: e.studentId, instrument: e.instrument || "", entries: [e] });
    }
  }
  for (const s of out) s.studentIds = [...new Set(s.entries.map(e => e.studentId).filter(Boolean))];
  return out;
}

// The band misses standing for a subject, in the band week's missed[].
function subjectBandMisses(band, subject, missed) {
  if (subject.groupId) return (missed || []).filter(m => m && m.bandLessonId === band.id && m.isGroup === true && m.groupId === subject.groupId);
  return bandMissesFor(missed, band.id, subject.entries[0]);
}

// A miss (any kind, any band or none) for the subject's lesson.
function missBelongs(subject, m) {
  if (!m) return false;
  if (subject.groupId) return m.isGroup === true && m.groupId === subject.groupId;
  return !m.isGroup && (m.enrolmentId === subject.enrolmentId || (m.studentId === subject.studentId && m.instrument === subject.instrument));
}

function isActive(subject, enrolments, weekKey) {
  return subject.entries.some(e => {
    const en = (enrolments || []).find(x => x && x.id === e.enrolmentId);
    return !en || deriveTallyCell({ enrolment: en, week: { weekKey }, wttEntry: null }) !== "inactive";
  });
}

/**
 * Classify every Regular subject of the band that the protected gate does
 * not handle: solo entries with no held card, and every Regular group.
 * Subjects already absent are left out (see regularAbsentSubjects).
 *
 * @param {Object} band
 * @param {Object} ctx
 * @param {string} ctx.rowKey             The band's row ("<weekKey>|<school>").
 * @param {Object} ctx.weeklyTimetables
 * @param {Array} [ctx.masterLessons]
 * @param {Array} [ctx.enrolments]
 * @param {Function|null} [ctx.resolver]  makeEnrolmentResolver(enrolments).
 * @returns {Array<{key, groupId, enrolmentId, studentId, instrument, studentIds, entries,
 *   kind, offered: boolean, card: Object|null, cardRowKey: string|null}>}
 */
export function regularAbsenceSubjects(band, { rowKey, weeklyTimetables, masterLessons = [], enrolments = [], resolver = null } = {}) {
  if (!hasMemberStates(band) || !rowKey) return [];
  const weekKey = weekOfRow(rowKey);
  const rowKeys = weekRowKeys(weeklyTimetables, weekKey);
  const missedHere = ((weeklyTimetables || {})[rowKey] || {}).missed || [];
  const out = [];
  for (const s of regularSubjectsOf(band)) {
    if (subjectBandMisses(band, s, missedHere).length > 0) continue;            // already absent
    const entry = s.entries[0];
    const held = findMemberCards(band.removedLessons, entry, resolver);
    if (held.length > 0) {
      if (!s.groupId) continue;                                                  // solo held: the protected gate
      out.push({ ...s, kind: REGULAR_KIND.held, offered: true, card: held[0], cardRowKey: null });
      continue;
    }
    let kind;
    let card = null;
    let cardRowKey = null;
    if (rowKeys.some(k => ((weeklyTimetables[k] || {}).missed || []).some(m => missBelongs(s, m)))) {
      kind = REGULAR_KIND.missed;
    } else if (!isActive(s, enrolments, weekKey)) {
      kind = REGULAR_KIND.inactive;
    } else {
      for (const k of [rowKey, ...rowKeys.filter(x => x !== rowKey)]) {
        const found = findMemberCards(((weeklyTimetables || {})[k] || {}).lessons, entry, resolver);
        if (found.length > 0) { card = found[0]; cardRowKey = k; break; }
      }
      if (card) kind = cardRowKey === rowKey ? REGULAR_KIND.sweep : REGULAR_KIND.elsewhere;
      else {
        card = findMemberCards(masterLessons, entry, resolver)[0] || null;
        kind = card ? REGULAR_KIND.master : REGULAR_KIND.noMaster;
      }
    }
    out.push({ ...s, kind, offered: OFFERED.has(kind), card, cardRowKey });
  }
  return out;
}

/**
 * Regular subjects recorded absent through this module: every Regular group
 * with a whole-group band miss, and every solo Regular entry whose band miss
 * is marked (bandNoCard / bandCardRow). A solo held-card absence is the
 * protected path's and is not listed.
 */
export function regularAbsentSubjects(band, missed) {
  if (!hasMemberStates(band)) return [];
  return regularSubjectsOf(band).filter(s => {
    const mine = subjectBandMisses(band, s, missed);
    return s.groupId ? mine.length > 0 : mine.some(isMarkedBandMiss);
  });
}

/** The Regular subject key ("regular:…") a band miss belongs to, or null (protected path). */
export function regularSubjectKeyForMiss(band, miss) {
  if (!hasMemberStates(band) || !miss || miss.bandLessonId !== band.id) return null;
  if (miss.isGroup === true) {
    return band.memberStates.some(e => isGroupEntry(e) && e.groupId === miss.groupId && e.consumption === CONSUMPTION.regular)
      ? "regular:group:" + miss.groupId : null;
  }
  if (!isMarkedBandMiss(miss)) return null;
  const entry = bandEntryForMiss(band, miss);
  return entry ? "regular:enrolment:" + entry.enrolmentId : null;
}

/**
 * The window note for a Regular member the band holds no card for, or "".
 * No master lesson → why it can't be marked absent (decision b); otherwise
 * a plain flag.
 */
export function regularNoCardNote(subject, name) {
  if (!subject || subject.kind === REGULAR_KIND.held) return "";
  const who = name || "this student";
  const what = subject.groupId ? "group lesson" : `${subject.instrument || ""} lesson`.trim();
  if (subject.kind === REGULAR_KIND.noMaster) return `No ${what} on the master timetable for ${who} — can't be marked absent`;
  return `The band holds no ${what} for ${who} this week`;
}

// planMarkAbsent's miss shape, from one card.
function missOf(card, band, absence, enrolments, extra) {
  const { teacherId, writerTeacherId, ...rest } = card;
  return {
    ...rest,
    enrolmentId: enrolmentIdFor(card.studentId, card.instrument, enrolments, card.groupId),
    reason: absence.reason || "other",
    reasonDetail: absence.reasonDetail || "",
    notes: absence.notes || "",
    makeupEligible: absence.makeupEligible === true,
    madeUp: false,
    cardNote: "",
    bandLessonId: band.id,
    ...(teacherId ? { ledgerTeacherId: teacherId } : {}),
    ...extra,
  };
}

function stampSubject(band, subject, at) {
  let b = band;
  for (const e of subject.entries) b = stampAdminOverride(b, e.enrolmentId, at);
  return b;
}

/**
 * Record a Regular subject's absence once the reason prompt saves. Re-plans
 * from `weeklyTimetables`, so callers run it inside their state setter.
 *
 * @param {Object} args
 * @param {Object} args.weeklyTimetables
 * @param {string} args.rowKey          The band's row.
 * @param {string} args.bandLessonId
 * @param {string} args.subjectKey      From regularAbsenceSubjects.
 * @param {{reason, reasonDetail, notes, makeupEligible}} args.absence
 * @param {Array} [args.masterLessons]
 * @param {Array} [args.enrolments]
 * @param {Function|null} [args.resolver]
 * @param {string} args.at              ISO timestamp.
 * @param {Function} [args.newId]
 * @returns {{rows: Object, kind: string, misses: Array}|null}
 */
export function planRegularAbsence({ weeklyTimetables, rowKey, bandLessonId, subjectKey, absence = {}, masterLessons = [], enrolments = [],
  resolver = null, at, newId = uid } = {}) {
  const d = (weeklyTimetables || {})[rowKey];
  let lessons = (d && d.lessons) || [];
  let band = lessons.find(l => l && l.id === bandLessonId);
  if (!band) return null;
  const ctx = { rowKey, weeklyTimetables, masterLessons, enrolments, resolver };
  const subject = regularAbsenceSubjects(band, ctx).find(s => s.key === subjectKey && s.offered);
  if (!subject) return null;
  const rows = {};
  let misses;

  if (subject.kind === REGULAR_KIND.held || subject.kind === REGULAR_KIND.sweep) {
    if (subject.kind === REGULAR_KIND.sweep) {
      lessons = sweepRegularIntoLedger(lessons, bandLessonId, resolver);
      band = lessons.find(l => l && l.id === bandLessonId);
    }
    const cards = findMemberCards(band.removedLessons, subject.entries[0], resolver);
    if (cards.length === 0) return null;
    const ids = new Set(cards.map(c => c.id));
    band = { ...band, removedLessons: (band.removedLessons || []).filter(c => !ids.has(c && c.id)) };
    misses = cards.map(c => missOf(c, band, absence, enrolments, { ledgerCard: c }));
  } else if (subject.kind === REGULAR_KIND.elsewhere) {
    const other = weeklyTimetables[subject.cardRowKey];
    rows[subject.cardRowKey] = { ...other, lessons: (other.lessons || []).filter(l => l.id !== subject.card.id) };
    misses = [missOf(subject.card, band, absence, enrolments, { bandCardRow: subject.cardRowKey, originCard: subject.card })];
  } else {
    const m = subject.card;
    const offset = DAY_OFFSET[m.day];
    const built = { ...m, id: newId(), weekDate: offset === undefined ? undefined : addDays(weekOfRow(rowKey), offset), adjusted: false };
    misses = [missOf(built, band, absence, enrolments, { bandNoCard: true })];
  }

  band = stampSubject(band, subject, at);
  rows[rowKey] = { ...d, lessons: lessons.map(l => (l && l.id === bandLessonId ? band : l)), missed: [...((d && d.missed) || []), ...misses] };
  return { rows, kind: subject.kind, misses };
}

/**
 * Undo a Regular subject's absence recorded by planRegularAbsence (or a
 * whole-group band miss): the misses go; a held card goes back in the
 * ledger; a card taken from another row goes back there (slot-free rule —
 * a taken slot is reported in `dropped`); a card built from the master is
 * simply gone. Every entry of the subject is stamped.
 *
 * @returns {{rows: Object, dropped: Array}|null}
 */
export function planRegularAbsenceUndo({ weeklyTimetables, rowKey, bandLessonId, subjectKey, at } = {}) {
  const d = (weeklyTimetables || {})[rowKey];
  let band = ((d && d.lessons) || []).find(l => l && l.id === bandLessonId);
  if (!band) return null;
  const missed = (d && d.missed) || [];
  const subject = regularAbsentSubjects(band, missed).find(s => s.key === subjectKey);
  if (!subject) return null;
  const mine = subjectBandMisses(band, subject, missed);
  const ids = new Set(mine.map(m => m.id));
  const rows = {};
  const dropped = [];
  const ledgerBack = [];
  for (const m of mine) {
    if (m.bandNoCard === true) continue;
    if (m.bandCardRow) {
      const other = rows[m.bandCardRow] || weeklyTimetables[m.bandCardRow];
      if (!other) { dropped.push(m.originCard); continue; }
      const r = restoreCardsReporting(other.lessons || [], [m.originCard]);
      rows[m.bandCardRow] = { ...other, lessons: r.lessons };
      dropped.push(...r.dropped);
      continue;
    }
    if (m.ledgerCard) ledgerBack.push(m.ledgerCard);
  }
  band = stampSubject({ ...band, removedLessons: [...(band.removedLessons || []), ...ledgerBack] }, subject, at);
  rows[rowKey] = { ...d, lessons: d.lessons.map(l => (l && l.id === bandLessonId ? band : l)), missed: missed.filter(m => !ids.has(m && m.id)) };
  return { rows, dropped };
}

// ── Regenerate / day import: no second copy of an absent lesson ───────────
//
// A Regular band absence moves the lesson out of the band's ledger into a
// band-stamped miss that keeps the card (ledgerCard, or originCard). The
// generate paths only skip cards the LEDGER holds (isGenerateExcluded), so
// regenerating the week rebuilt the card and the band sweep put it back in
// the ledger: Undo then held two copies and band removal reported one as
// "Couldn't put back". The filter below drops, before generation, every
// master card whose lesson a surviving band's absence already holds. A
// built (bandNoCard) absence holds no card, so its lesson is generated and
// swept into the ledger as usual — Undo adds nothing, so there is still one.

/** The weekly rows of `weekKey`, any school. */
export function weekRows(weeklyTimetables, weekKey) {
  return weekRowKeys(weeklyTimetables, weekKey).map(k => weeklyTimetables[k]).filter(Boolean);
}

function sameLesson(ref, c) {
  if (c.isGroup || ref.isGroup) return !!c.isGroup && !!ref.isGroup && c.groupId === ref.groupId;
  if (ref.enrolmentId && c.enrolmentId) return ref.enrolmentId === c.enrolmentId;
  return ref.studentId === c.studentId && ref.instrument === c.instrument;
}

/**
 * `cards` without those whose lesson a band absence in `rows` holds. Only
 * misses of bands still in their row count; bandNoCard misses never do.
 * Returns `cards` itself when nothing is dropped.
 *
 * @param {Array} cards  Master (or imported) cards about to be generated.
 * @param {Array} rows   Weekly rows ({ lessons, missed }) to read absences from.
 * @returns {Array}
 */
export function withoutBandAbsentCards(cards, rows) {
  const held = [];
  for (const row of (rows || [])) {
    const bandIds = new Set(((row && row.lessons) || []).filter(l => l && l.isBandSession).map(l => l.id));
    for (const m of ((row && row.missed) || [])) {
      if (m && m.bandLessonId && bandIds.has(m.bandLessonId) && m.bandNoCard !== true) held.push(m.ledgerCard || m.originCard || m);
    }
  }
  const list = cards || [];
  if (held.length === 0) return list;
  const out = list.filter(c => !(c && !c.isBandSession && !c.__isCatchup && held.some(ref => sameLesson(ref, c))));
  return out.length === list.length ? list : out;
}

// ── Keeping marked cards out of the protected restore paths ──────────────

/** Cards to put back that are not marked (cardFromBandMiss keeps the markers). */
export function withoutMarkedCards(cards) {
  return (cards || []).filter(c => !(c && (c.bandNoCard === true || c.bandCardRow)));
}

/**
 * The cards a removed band's "elsewhere" absences took from other rows, to
 * be put back there: [{ rowKey, card }].
 */
export function originRestoresFor(missed, bandIds) {
  const ids = new Set(bandIds || []);
  return (missed || []).filter(m => m && ids.has(m.bandLessonId) && m.bandCardRow && m.originCard)
    .map(m => ({ rowKey: m.bandCardRow, card: m.originCard }));
}

/**
 * Put origin cards back in their own rows (slot-free rule). Rows in `skip`
 * are being rebuilt anyway and are left alone.
 *
 * @returns {{rows: Object, dropped: Array}}
 */
export function restoreOriginCards(weeklyTimetables, restores, { rows = {}, skip = [] } = {}) {
  const out = { ...rows };
  const skipSet = new Set(skip);
  const dropped = [];
  for (const { rowKey, card } of (restores || [])) {
    if (skipSet.has(rowKey)) continue;
    const d = out[rowKey] || (weeklyTimetables || {})[rowKey];
    if (!d) { dropped.push(card); continue; }
    const r = restoreCardsReporting(d.lessons || [], [card]);
    out[rowKey] = { ...d, lessons: r.lessons };
    dropped.push(...r.dropped);
  }
  return { rows: out, dropped };
}

/**
 * planRemoveBandSession for the admin: the band's marked misses go with it,
 * but their cards are not put on the band's grid — a built card is dropped,
 * a taken card is returned in `originRestores` for its own row.
 *
 * @returns {{lessons: Array, missed: Array, dropped: Array, originRestores: Array}}
 */
export function adminRemoveBandSession(entry, bandLessonId) {
  const missed = (entry && entry.missed) || [];
  const marked = missed.filter(m => m && m.bandLessonId === bandLessonId && isMarkedBandMiss(m));
  const out = planRemoveBandSession({ ...entry, missed: missed.filter(m => !marked.includes(m)) }, bandLessonId);
  return { ...out, originRestores: originRestoresFor(marked, [bandLessonId]) };
}

/** planBandRemovalAbsences for the admin (stray staged band): marked cards filtered, origin restores returned. */
export function adminBandRemovalAbsences(bandId, missed) {
  const out = planBandRemovalAbsences(bandId, missed);
  return { missed: out.missed, cards: withoutMarkedCards(out.cards), originRestores: originRestoresFor(missed, [bandId]) };
}
