// ============================================================
// bandAbsence.js — per-member absence from a NEW band session
// (Band Session Attribution cluster 5b). Pure: no React, no I/O.
//
// A sibling of bandMemberStates.js rather than part of it, so nothing here
// can widen the tallyDerive → bandMemberStates → enrolmentActivity →
// tallyDerive cycle. tallyDerive never imports this module.
//
// How an absence is recorded depends on what the member's slot consumed:
//
//   • regular — their card sits in the band's removedLessons ledger. The
//     absence MOVES that card out of the ledger into the week's missed[],
//     keeping the card's own day/time, stamped with bandLessonId. From there
//     it is an ordinary miss: Tally, catch-up lists and invoicing already
//     read it. memberStates.attended stays null; the stamped miss IS the
//     record. Undo moves it back.
//   • catchup — their own card still stands this week, so a miss would be
//     hidden on the Tally yet deducted on the invoice. Instead the entry is
//     marked attended:false with the reason on `absence`. Catch-up owed ON
//     deletes the band-linked row (re-opening the original miss) and keeps a
//     snapshot of it for undo; OFF leaves the row standing (forfeit).
//   • free — attended:false, nothing else.
//   • not_in_session, unattributed, forward, billed — never absent.
//
// Legacy bands (no memberStates) get none of this.
// ============================================================

import { hasMemberStates, CONSUMPTION, restoreCardsReporting } from "./bandMemberStates";
import { enrolmentIdFor } from "../utils/enrolmentsDB";

const ABSENCE_CAPABLE = new Set([CONSUMPTION.regular, CONSUMPTION.catchup, CONSUMPTION.free]);

// Fields a regular absence adds on top of the card it moved. Stripped again
// on undo, together with ledgerCard itself.
const MISS_FIELDS = ["reason", "reasonDetail", "notes", "makeupEligible", "madeUp", "cardNote", "bandLessonId", "ledgerTeacherId", "ledgerCard"];

/**
 * The regular-absence misses a band has stamped for this member. Matched on
 * the band and the member's enrolment — or, because the miss is re-stamped
 * through enrolmentIdFor exactly like an ordinary miss, on studentId +
 * instrument when duplicate enrolments make the two ids differ. A band has
 * at most one attributed entry per student, so that cannot cross members.
 *
 * @param {Array} missed      The band week's missed[].
 * @param {string} bandId     The band card's id.
 * @param {Object} entry      A memberStates entry.
 * @returns {Array}
 */
export function bandMissesFor(missed, bandId, entry) {
  if (!bandId || !entry) return [];
  return (missed || []).filter(m => m && m.bandLessonId === bandId && (
    m.enrolmentId === entry.enrolmentId
    || (m.studentId === entry.studentId && m.instrument === entry.instrument)
  ));
}

/**
 * The regular entry a band-stamped miss belongs to, or null — the inverse of
 * bandMissesFor, for paths that start from the miss (missed-zone Remove).
 *
 * @param {Object} band
 * @param {Object} miss   A miss with bandLessonId === band.id.
 * @returns {Object|null}
 */
export function bandEntryForMiss(band, miss) {
  if (!hasMemberStates(band) || !miss || miss.bandLessonId !== band.id) return null;
  return (band.memberStates || []).find(e => e && e.consumption === CONSUMPTION.regular
    && bandMissesFor([miss], band.id, e).length > 0) || null;
}

/**
 * True if the member is recorded absent from this band session.
 *
 * @param {Object} band    A band card.
 * @param {Object} entry   One of its memberStates entries.
 * @param {Array} missed   The band week's missed[].
 * @returns {boolean}
 */
export function isMemberAbsent(band, entry, missed) {
  if (!hasMemberStates(band) || !entry) return false;
  if (entry.consumption === CONSUMPTION.regular) return bandMissesFor(missed, band.id, entry).length > 0;
  if (entry.consumption === CONSUMPTION.catchup || entry.consumption === CONSUMPTION.free) return entry.attended === false;
  return false;
}

/**
 * Every absent entry of a band, in memberStates order.
 */
export function absentMembers(band, missed) {
  if (!hasMemberStates(band)) return [];
  return (band.memberStates || []).filter(e => isMemberAbsent(band, e, missed));
}

/**
 * The enrolmentIds of every absent entry — the set the attribution planner
 * and the window's seeding step skip.
 */
export function absentEnrolmentIds(band, missed) {
  return new Set(absentMembers(band, missed).map(e => e.enrolmentId));
}

/**
 * The band's ledger cards belonging to `entry`. Matching mirrors
 * findMemberCards' card test (enrolmentId first, then studentId +
 * instrument for cards predating the stamp).
 */
function ledgerCardsFor(band, entry) {
  return (band.removedLessons || []).filter(c => c && !c.isBandSession && !c.isGroup && (
    c.enrolmentId ? c.enrolmentId === entry.enrolmentId
      : (c.studentId === entry.studentId && c.instrument === entry.instrument)
  ));
}

/**
 * Entries that may be marked absent now: attributed regular, catchup or free,
 * not already absent. A regular member must also have a card in the ledger —
 * their absence is that card, and without one there is nothing to move.
 */
export function eligibleForAbsence(band, missed) {
  if (!hasMemberStates(band)) return [];
  return (band.memberStates || []).filter(e => {
    if (!e || !ABSENCE_CAPABLE.has(e.consumption)) return false;
    if (isMemberAbsent(band, e, missed)) return false;
    if (e.consumption === CONSUMPTION.regular) return ledgerCardsFor(band, e).length > 0;
    return true;
  });
}

/**
 * Menu label for an entry: the student's full name, plus the instrument when
 * the student holds more than one entry on this band.
 */
export function absenceMenuLabel(band, entry, students) {
  const st = (students || []).find(s => s.id === entry.studentId);
  const name = (st && st.name) || entry.studentId || "—";
  const count = (band.memberStates || []).filter(e => e && e.studentId === entry.studentId).length;
  return count > 1 && entry.instrument ? `${name} (${entry.instrument})` : name;
}

// Return memberStates with one entry replaced by fn(entry). fn may drop keys
// by returning a fresh object.
function mapEntry(memberStates, enrolmentId, fn) {
  return (memberStates || []).map(e => (e && e.enrolmentId === enrolmentId ? fn(e) : e));
}

function withoutAbsence(entry) {
  const { absence, absentCatchupSnapshot, ...rest } = entry;
  return { ...rest, attended: null };
}

/**
 * Plan marking a member absent.
 *
 *   regular → { kind: "regular", band, misses } — the band with those cards
 *             out of its ledger, and the misses to append to missed[]. The
 *             caller opens the reason prompt on misses[0] and reverts both on
 *             Cancel. teacherId and writerTeacherId never ride on the miss
 *             (the 6pm drain would match a teacherId + day against any
 *             teacher miss that day; the teacher app treats writerTeacherId
 *             as ownership) — the card is kept whole on ledgerCard and its
 *             teacherId mirrored as ledgerTeacherId.
 *   catchup → { kind: "catchup" } — nothing written until the prompt saves
 *             (applyCatchupAbsence).
 *   free    → { kind: "free", band } — attended:false, no prompt.
 *   else    → null (not eligible).
 *
 * @param {Object} args
 * @param {Object} args.band
 * @param {Object} args.entry
 * @param {Array} args.missed
 * @param {Array} args.enrolments
 */
export function planMarkAbsent({ band, entry, missed, enrolments } = {}) {
  if (!band || !entry) return null;
  if (!eligibleForAbsence(band, missed).some(e => e.enrolmentId === entry.enrolmentId)) return null;

  if (entry.consumption === CONSUMPTION.regular) {
    const cards = ledgerCardsFor(band, entry);
    const ids = new Set(cards.map(c => c.id));
    const misses = cards.map(card => {
      const { teacherId, writerTeacherId, ...rest } = card;
      return {
        ...rest,
        enrolmentId: enrolmentIdFor(card.studentId, card.instrument, enrolments, card.groupId),
        reason: "",
        reasonDetail: "",
        notes: "",
        makeupEligible: false,
        madeUp: false,
        cardNote: "",
        bandLessonId: band.id,
        ...(teacherId ? { ledgerTeacherId: teacherId } : {}),
        ledgerCard: card,
      };
    });
    return {
      kind: "regular",
      band: { ...band, removedLessons: (band.removedLessons || []).filter(c => !ids.has(c && c.id)) },
      misses,
    };
  }
  if (entry.consumption === CONSUMPTION.catchup) return { kind: "catchup" };
  if (entry.consumption === CONSUMPTION.free) {
    return { kind: "free", band: { ...band, memberStates: mapEntry(band.memberStates, entry.enrolmentId, e => ({ ...e, attended: false })) } };
  }
  return null;
}

/**
 * Apply a catch-up member's absence once the reason prompt saves.
 *
 * Owed OFF: the linked row stays (the original miss is forfeited).
 * Owed ON:  the row is deleted and a full snapshot kept on the entry, so undo
 *           can re-insert it under its original id; catchupId goes null.
 * consumedWeekKey is left exactly as it was.
 *
 * @param {Object} args
 * @param {Object} args.band
 * @param {Object} args.entry
 * @param {{reason, reasonDetail, notes, makeupEligible}} args.absence
 * @param {Object|null} args.row   The entry's linked catchups row, if found.
 * @returns {{band: Object, deleteRow: Object|null}}
 */
export function applyCatchupAbsence({ band, entry, absence, row } = {}) {
  const abs = {
    reason: absence.reason || "other",
    reasonDetail: absence.reasonDetail || "",
    notes: absence.notes || "",
    makeupEligible: absence.makeupEligible === true,
  };
  const deleteRow = abs.makeupEligible && row ? row : null;
  const memberStates = mapEntry(band.memberStates, entry.enrolmentId, e => {
    const next = { ...e, attended: false, absence: abs };
    if (deleteRow) { next.absentCatchupSnapshot = { ...deleteRow }; next.catchupId = null; }
    return next;
  });
  return { band: { ...band, memberStates }, deleteRow };
}

/**
 * The card a regular band absence was made from, exactly as it left the
 * ledger (ledgerCard), or rebuilt from the miss for an entry without one.
 */
export function cardFromBandMiss(m) {
  if (m.ledgerCard) return m.ledgerCard;
  const card = { ...m };
  for (const k of MISS_FIELDS) delete card[k];
  if (m.ledgerTeacherId) card.teacherId = m.ledgerTeacherId;
  return card;
}

/**
 * Removing a band session also removes its absences: every miss stamped
 * with this band comes out of missed[], and the regular members' cards are
 * handed back for the caller's occupied-slot restore (the same rule as the
 * ledger). Catch-up absences need nothing here — a deleted row stays deleted
 * and the original miss stays owed.
 *
 * @param {string} bandId
 * @param {Array} missed   The band week's missed[].
 * @returns {{missed: Array, cards: Array}}
 */
export function planBandRemovalAbsences(bandId, missed) {
  const mine = (missed || []).filter(m => m && m.bandLessonId === bandId);
  return {
    missed: (missed || []).filter(m => !(m && m.bandLessonId === bandId)),
    cards: mine.map(cardFromBandMiss),
  };
}

/**
 * "Remove band session" (v2.42.1, extracted): the band card leaves the week,
 * its stamped misses go, and its ledger cards plus its regular absentees'
 * cards go back on the grid under the occupied-slot rule — the ones that
 * can't are returned in `dropped` for the caller's notice.
 *
 * @param {Object} entry          The week+school entry.
 * @param {string} bandLessonId
 * @returns {{lessons: Array, missed: Array, dropped: Array}}
 */
export function planRemoveBandSession(entry, bandLessonId) {
  const band = ((entry && entry.lessons) || []).find(l => l && l.id === bandLessonId);
  const absences = planBandRemovalAbsences(bandLessonId, (entry && entry.missed) || []);
  const restore = [...((band && band.removedLessons) || []), ...absences.cards];
  const r = restoreCardsReporting(((entry && entry.lessons) || []).filter(l => l.id !== bandLessonId), restore);
  return { lessons: r.lessons, missed: absences.missed, dropped: r.dropped };
}

/**
 * Tally tooltip for a caught-up cell whose banking row came from a band.
 * A row whose member was then marked absent (attended false, row kept =
 * forfeited) reads "Forfeited — absent from band session (<band>) — <when>";
 * otherwise the cluster 4b wording. The band is looked up in the row's own
 * week and school; a band that cannot be found gets the unnamed wording.
 *
 * @param {Object} catchup           The banking row (bandLessonId set).
 * @param {Object} weeklyTimetables
 * @param {string} when              formatCatchupCompletionLabel(catchup).
 * @returns {string}
 */
export function bandCatchupTooltip(catchup, weeklyTimetables, when) {
  const band = ((weeklyTimetables && weeklyTimetables[`${catchup.weekKey}|${catchup.schoolId}`]) || {}).lessons
    ?.find(l => l && l.isBandSession && l.id === catchup.bandLessonId) || null;
  const entry = hasMemberStates(band)
    ? band.memberStates.find(e => e && e.catchupId === catchup.id) || null
    : null;
  if (entry && entry.attended === false) {
    return (band.bandName ? `Forfeited — absent from band session (${band.bandName})` : "Forfeited — absent from band session") + " — " + when;
  }
  return (band && band.bandName ? "Caught up in band session: " + band.bandName : "Caught up in band session") + " — " + when;
}

/**
 * Plan undoing a member's absence.
 *
 *   regular → { kind: "regular", band, missed } — stamped misses removed,
 *             their cards back in the ledger exactly as they left it.
 *   free / catchup without a snapshot → { kind, band } — attended null,
 *             absence cleared.
 *   catchup with a snapshot →
 *     • { kind: "catchup", band, insertRow } — re-insert the snapshot under
 *       its ORIGINAL id (at the band's current day/time) and restore
 *       catchupId, when no other row now
 *       resolves the same miss (a row already carrying the snapshot's id —
 *       a failed delete put back — is simply re-linked, insertRow null);
 *     • { kind: "catchup", band, reset: true } — another row has since
 *       settled that miss: the absence is cleared and the member's band
 *       role reset to Not set.
 *
 * @param {Object} args
 * @param {Object} args.band
 * @param {Object} args.entry
 * @param {Array} args.missed    The band week's missed[].
 * @param {Array} args.catchups  The full catchups collection.
 */
export function planUndoAbsence({ band, entry, missed, catchups } = {}) {
  if (!band || !entry || !isMemberAbsent(band, entry, missed)) return null;

  if (entry.consumption === CONSUMPTION.regular) {
    const mine = bandMissesFor(missed, band.id, entry);
    const ids = new Set(mine.map(m => m.id));
    const restored = mine.map(cardFromBandMiss);
    return {
      kind: "regular",
      band: { ...band, removedLessons: [...(band.removedLessons || []), ...restored] },
      missed: (missed || []).filter(m => !ids.has(m && m.id)),
    };
  }

  const snap = entry.consumption === CONSUMPTION.catchup ? entry.absentCatchupSnapshot : null;
  if (!snap) {
    return { kind: entry.consumption, band: { ...band, memberStates: mapEntry(band.memberStates, entry.enrolmentId, withoutAbsence) } };
  }

  const list = catchups || [];
  const settledElsewhere = list.some(c => c && c.id !== snap.id
    && c.resolvesEnrolmentId === snap.resolvesEnrolmentId && c.resolvesWeekKey === snap.resolvesWeekKey);
  if (settledElsewhere) {
    return {
      kind: "catchup",
      reset: true,
      band: {
        ...band,
        memberStates: mapEntry(band.memberStates, entry.enrolmentId, e => ({
          ...withoutAbsence(e), consumption: null, catchupId: null, consumedWeekKey: null,
        })),
      },
    };
  }
  const stillThere = list.some(c => c && c.id === snap.id);
  // The band may have moved since (syncBandLinkedCatchups only moves live
  // rows), so the re-inserted row takes the band's current day and time.
  return {
    kind: "catchup",
    insertRow: stillThere ? null : { ...snap, day: band.day || snap.day, time: band.start || snap.time },
    band: {
      ...band,
      memberStates: mapEntry(band.memberStates, entry.enrolmentId, e => ({ ...withoutAbsence(e), catchupId: snap.id })),
    },
  };
}

/**
 * The absence details for display: reason + detail for the "Absent — …"
 * sub-line, or null when present. Free members carry no reason.
 */
export function memberAbsenceInfo(band, entry, missed) {
  if (!isMemberAbsent(band, entry, missed)) return null;
  if (entry.consumption === CONSUMPTION.regular) {
    const m = bandMissesFor(missed, band.id, entry)[0];
    return { reason: m.reason || null, reasonDetail: m.reasonDetail || "" };
  }
  if (entry.consumption === CONSUMPTION.catchup) {
    return { reason: (entry.absence && entry.absence.reason) || null, reasonDetail: (entry.absence && entry.absence.reasonDetail) || "" };
  }
  return { reason: null, reasonDetail: "" };
}

// ── Regenerate / import (cluster 5b) ────────────────────────────────────
//
// Every week rebuild (regenerate week / day / all schools, MTT import)
// replaces missed[] from the generator. A band absence is not generator
// output, so without this it would silently vanish and the regular member
// would tick the band again.

/**
 * True if `m` is a band absence (a miss stamped with bandLessonId).
 */
export function isBandStampedMiss(m) {
  return !!(m && m.bandLessonId);
}

/**
 * Drop band absences from a list of misses. Used on the informed-absence
 * "pre-absent" sets, which key on studentId and would otherwise pull every
 * one of that student's generated cards for the week into missed.
 */
export function withoutBandMisses(misses) {
  return (misses || []).filter(m => !isBandStampedMiss(m));
}

/**
 * Rebuild a week's missed[] after regeneration or import.
 *
 * Band absences are stripped from `nextMissed` (a day rebuild keeps other
 * days' entries, stamped ones included) and then every band absence from
 * `prevMissed` is carried forward whose band survives in `nextLessons`.
 * A stamped miss whose band did not survive is dropped. Unstamped misses in
 * `prevMissed` are never carried — what happens to them is the caller's
 * existing rule, unchanged.
 *
 * @param {Array} nextMissed   missed[] as the rebuild produced it.
 * @param {Array} prevMissed   missed[] before the rebuild.
 * @param {Array} nextLessons  lessons[] after the rebuild.
 * @returns {Array}
 */
export function carryBandMisses(nextMissed, prevMissed, nextLessons) {
  const bandIds = new Set((nextLessons || []).filter(l => l && l.isBandSession).map(l => l.id));
  const carried = (prevMissed || []).filter(m => isBandStampedMiss(m) && bandIds.has(m.bandLessonId));
  return [...withoutBandMisses(nextMissed), ...carried];
}

// ── Clean MTT re-import (v2.40.1) ───────────────────────────────────────
//
// Re-importing a week (or a day) from the master is a sweeping reset: every
// band card in scope goes, with everything attached to it, exactly as if each
// band had been removed by hand first.

/**
 * Plan the band side of a clean import of one week+school entry.
 *
 * In scope: every band card in the week, or only `day`'s band cards for a day
 * import. Legacy bands (no memberStates) are simply dropped — nothing hangs
 * off them.
 *
 * rowsToDelete — the band-linked catchups rows of the removed bands: the union
 *   of (a) catchupIds in their memberStates and (b) rows whose bandLessonId
 *   is a removed band, restricted to this week + school, de-duplicated.
 *   Deleting them re-opens the misses they settled, as manual removal does.
 *   Catch-ups not linked to a band are never included.
 *
 * restoreCards — cards the import will NOT rebuild, so they must go back on
 *   the grid as "Remove band session" would put them: a day import only
 *   rebuilds that day, so a removed band's ledger cards (and its regular
 *   absences' cards) on OTHER days are returned for the caller's
 *   occupied-slot restore. Always empty for a whole-week import, which
 *   rebuilds every card from the master.
 *
 * @param {Object} entry        The week+school entry before import.
 * @param {Array} catchups      The full catchups collection.
 * @param {Object} opts
 * @param {string|null} [opts.day]  Day import scope; null = whole week.
 * @param {string} opts.weekKey
 * @param {string} opts.schoolId
 * @returns {{lessons: Array, rowsToDelete: Array, restoreCards: Array,
 *   removedBandIds: string[], removedBandCount: number, legacyBandCount: number}}
 */
export function planCleanImport(entry, catchups, { day = null, weekKey, schoolId } = {}) {
  const lessons = (entry && entry.lessons) || [];
  const removed = lessons.filter(l => l && l.isBandSession && (!day || l.day === day));
  const removedIds = new Set(removed.map(b => b.id));

  const linkedIds = new Set();
  for (const b of removed) {
    if (!hasMemberStates(b)) continue;
    for (const e of b.memberStates) if (e && e.catchupId) linkedIds.add(e.catchupId);
  }
  const seen = new Set();
  const rowsToDelete = (catchups || []).filter(c => {
    if (!c || seen.has(c.id)) return false;
    if (c.weekKey !== weekKey || c.schoolId !== schoolId) return false;
    if (!linkedIds.has(c.id) && !removedIds.has(c.bandLessonId)) return false;
    seen.add(c.id);
    return true;
  });

  const restoreCards = !day ? [] : [
    ...removed.flatMap(b => b.removedLessons || []),
    ...((entry && entry.missed) || []).filter(m => m && removedIds.has(m.bandLessonId)).map(cardFromBandMiss),
  ].filter(c => c && c.day !== day);

  return {
    lessons: lessons.filter(l => !(l && removedIds.has(l.id))),
    rowsToDelete,
    restoreCards,
    removedBandIds: [...removedIds],
    removedBandCount: removed.length,
    legacyBandCount: removed.filter(b => !hasMemberStates(b)).length,
  };
}
