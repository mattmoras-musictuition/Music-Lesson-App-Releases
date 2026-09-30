// ============================================================
// BAND ABSENCE SMOKE TESTS
// Band Session Attribution cluster 5b. Called from runSmokeTests with its
// `assert`.
//
// The characterization block pins how invoicing math, the Tally and the
// attribution planner behave TODAY for the shapes a band absence could
// produce, before any absence code exists. The design deliberately avoids
// some of these shapes (a catch-up member's band-week miss, a catch-up entry
// left with no row) — the tests record why.
//
// As in tallyBandSmokeTests, "past" weeks sit in 2020 and "future" in 2099 so
// the 6pm threshold can never move under a test.
// ============================================================

import { deriveTallyRows, getOpenCatchupRows, getEnrolmentTermDeductionMath } from "../utils/tallyDerive";
import { enrolmentIdFor } from "../utils/enrolmentsDB";
import { buildMemberStates, planAttributionSave, applyStudentAttribution } from "./bandMemberStates";
import {
  isMemberAbsent, absentMembers, absentEnrolmentIds, eligibleForAbsence, absenceMenuLabel,
  planMarkAbsent, applyCatchupAbsence, planUndoAbsence, memberAbsenceInfo,
  isBandStampedMiss, withoutBandMisses, carryBandMisses, bandEntryForMiss,
} from "./bandAbsence";

const PW0 = "2020-03-02";  // week of the original miss
const PW = "2020-03-09";   // the band's week
const FW = "2099-03-09";   // a future week

const WEEKS = [
  { weekKey: PW0, label: "W1", weekNum: 1 },
  { weekKey: PW, label: "W2", weekNum: 2 },
  { weekKey: FW, label: "W3", weekNum: 3 },
];
const TERM = { start: PW0, end: FW };

function student(id) {
  return { id, name: id, schoolId: "S", status: "active" };
}

function enrol(id, studentId, instrument, extra = {}) {
  return { id, studentId, instrument, startDate: "2020-01-01", ...extra };
}

function mtt(e) {
  return { id: "M_" + e.id, enrolmentId: e.id, studentId: e.studentId, instrument: e.instrument, schoolId: "S", day: "Thursday", start: "09:00" };
}

function band(id, extra = {}) {
  return { id, isBandSession: true, bandId: "BAND", bandName: "Band", schoolId: "S", day: "Tuesday", start: "11:00", end: "11:00", members: [], removedLessons: [], ...extra };
}

function ms(e, consumption, extra = {}) {
  return { enrolmentId: e.id, studentId: e.studentId, instrument: e.instrument, consumption, catchupId: null, consumedWeekKey: null, fee: null, attended: null, writerTeacherId: null, ...extra };
}

function card(id, e, extra = {}) {
  return { id, enrolmentId: e.id, studentId: e.studentId, instrument: e.instrument, schoolId: "S", day: "Thursday", start: "09:00", ...extra };
}

function miss(id, e, extra = {}) {
  return { ...card(id, e), reason: "informed_absence", reasonDetail: "", notes: "", makeupEligible: true, madeUp: false, cardNote: "", ...extra };
}

function row(id, e, weekKey, resolvesWeekKey, extra = {}) {
  return {
    id, weekKey, day: "Tuesday", time: "11:00", instrument: e.instrument, schoolId: "S",
    enrolmentId: e.id, resolvesEnrolmentId: e.id, resolvesWeekKey,
    resolvesOriginalDay: "Thursday", resolvesOriginalTime: "09:00", madeUp: false, notes: null,
    createdAt: "2020-03-01", ...extra,
  };
}

function math(wtt, catchups, enrolmentId, instrument) {
  return getEnrolmentTermDeductionMath({
    weeklyTimetables: wtt, catchups, enrolmentId, instrument,
    prevTerm: TERM, interruptions: [], nextTermStart: "2100-01-01",
  });
}

// { lessonKey: { weekKey: "state[:source]" } } plus the per-cell enrolment ids.
function view({ students, enrolments, wtt, cards }) {
  const { tallyRows } = deriveTallyRows({
    enrolments, students, termWeeks: WEEKS, weeklyTimetables: wtt,
    timetable: { lessons: cards || enrolments.map(mtt) }, schoolFilter: "all",
  });
  const out = {};
  for (const r of tallyRows) {
    const key = r.enrolmentId || r.lessonKey;
    out[key] = {};
    for (const w of WEEKS) {
      const c = r.cells[w.weekKey];
      const src = !c.wttEntry ? "" : (c.wttEntry.isBandSession ? "band" : c.wttEntry.id);
      out[key][w.weekKey] = c.state + (src ? ":" + src : "");
    }
  }
  return out;
}

function openRows(input, catchups) {
  return getOpenCatchupRows({
    weeklyTimetables: input.wtt, enrolments: input.enrolments, students: input.students,
    timetable: { lessons: input.cards || input.enrolments.map(mtt) }, termWeeks: WEEKS, catchups,
  }).map(r => r.missed.studentId + "@" + r.weekKey);
}

// ── Characterization (commit 1) — behaviour before any absence code ─────
export function runBandAbsenceCharacterizationTests(assert) {
  const amy = student("amy");
  const eAG = enrol("e_amy_gtr", "amy", "Guitar");

  // Regular member: their card is in the band's ledger, so an absence has to
  // be a miss built from that card. Catch-up owed on → one deduction.
  const regBand = band("BR", {
    members: [{ studentId: "amy", instrument: "Guitar" }],
    memberStates: [ms(eAG, "regular", { consumedWeekKey: PW })],
  });
  const regWtt = (makeupEligible) => ({
    [PW + "|S"]: { lessons: [regBand], missed: [miss("OWN_G", eAG, { bandLessonId: "BR", makeupEligible })] },
  });
  assert("char: regular band-stamped miss, catch-up owed → 1 deduction",
    math(regWtt(true), [], eAG.id, "Guitar"), { mkpEligPending: 1, catchups: 0, deductions: 1, extras: 0 });
  assert("char: regular band-stamped miss, no catch-up → no deduction",
    math(regWtt(false), [], eAG.id, "Guitar"), { mkpEligPending: 0, catchups: 0, deductions: 0, extras: 0 });

  // Catch-up member: their own card stays in the band week. An eligible miss
  // in that same week is hidden by the own card on the Tally and in the owed
  // list, yet the invoice still deducts it. This is the trap the design
  // avoids by never writing a miss for a catch-up member.
  const cuBand = band("BC", {
    members: [{ studentId: "amy", instrument: "Guitar" }],
    memberStates: [ms(eAG, "catchup", { catchupId: "CU", consumedWeekKey: PW0 })],
  });
  const cuInput = {
    students: [amy], enrolments: [eAG],
    wtt: {
      [PW0 + "|S"]: { lessons: [], missed: [miss("M0", eAG)] },
      [PW + "|S"]: { lessons: [card("OWN_G", eAG), cuBand], missed: [miss("BANDMISS", eAG, { bandLessonId: "BC" })] },
    },
  };
  const cuRow = row("CU", eAG, PW, PW0, { bandLessonId: "BC" });
  assert("char: catch-up member's band-week miss is hidden on the Tally (own card wins)",
    view(cuInput)[eAG.id][PW], "completed:OWN_G");
  assert("char: …and absent from the owed list",
    openRows(cuInput, [cuRow]), []);
  assert("char: …but the invoice still deducts it",
    math(cuInput.wtt, [cuRow], eAG.id, "Guitar"), { mkpEligPending: 2, catchups: 1, deductions: 1, extras: 0 });

  // Deleting the band-linked row re-opens the original miss: +1 deduction.
  const plainWtt = {
    [PW0 + "|S"]: { lessons: [], missed: [miss("M0", eAG)] },
    [PW + "|S"]: { lessons: [card("OWN_G", eAG), cuBand], missed: [] },
  };
  assert("char: band-linked row standing covers the miss; deleting it adds a deduction",
    [math(plainWtt, [cuRow], eAG.id, "Guitar").deductions, math(plainWtt, [], eAG.id, "Guitar").deductions], [0, 1]);

  // Free member: attended:false changes nothing anywhere — the band never
  // ticks a free member and invoicing never reads memberStates.
  const freeBand = (attended) => band("BF", {
    members: [{ studentId: "amy", instrument: "Guitar" }],
    memberStates: [ms(eAG, "free", { attended })],
  });
  const freeInput = (attended) => ({
    students: [amy], enrolments: [eAG],
    wtt: { [PW + "|S"]: { lessons: [card("OWN_G", eAG), freeBand(attended)], missed: [] } },
  });
  assert("char: free member attended:false — Tally and invoice identical to attended:null",
    [view(freeInput(false))[eAG.id][PW], math(freeInput(false).wtt, [], eAG.id, "Guitar")],
    [view(freeInput(null))[eAG.id][PW], math(freeInput(null).wtt, [], eAG.id, "Guitar")]);

  // Planner: a catch-up entry whose row is gone (catchupId null) is re-inserted
  // on the next save, even with nothing changed in the window. This is the
  // re-insert trap cluster 5b closes for absent members.
  const stored = [ms(eAG, "catchup", { catchupId: null, consumedWeekKey: PW0 })];
  const m0 = { enrolmentId: eAG.id, weekKey: PW0, day: "Thursday", start: "09:00" };
  const plan = planAttributionSave({ stored, working: stored, missByEnrolment: { [eAG.id]: m0 }, catchupsForBand: [], weekKey: PW });
  assert("char: planAttributionSave re-inserts a row for a catch-up entry with no catchupId",
    [plan.inserts.length, plan.changed, plan.deletes.length], [1, true, 0]);

  // attended survives every consumption change the window can make.
  const absentReg = [ms(eAG, "regular", { consumedWeekKey: PW, attended: false })];
  const toFree = applyStudentAttribution(absentReg, "amy", eAG.id, "free", null);
  const planned = planAttributionSave({ stored: absentReg, working: toFree, missByEnrolment: {}, catchupsForBand: [], weekKey: PW });
  assert("char: attended:false is carried through a consumption change and the save plan",
    [toFree[0].attended, planned.memberStates[0].attended, planned.memberStates[0].consumption], [false, false, "free"]);

  // Duplicate enrolments (same student + instrument, both live). Record which
  // id each path resolves, so absence stamping can match ordinary misses.
  const eOld = enrol("e_dup_old", "amy", "Guitar", { startDate: "2020-01-01" });
  const eNew = enrol("e_dup_new", "amy", "Guitar", { startDate: "2020-02-01" });
  const dupEnrols = [eOld, eNew];
  const stampedId = enrolmentIdFor("amy", "Guitar", dupEnrols);
  const bandId = buildMemberStates([{ studentId: "amy", instrument: "Guitar" }], dupEnrols, PW).map(e => e.enrolmentId);
  const dupWtt = { [PW + "|S"]: { lessons: [], missed: [miss("DM", eNew, { enrolmentId: stampedId })] } };
  const dupView = view({ students: [amy], enrolments: dupEnrols, wtt: dupWtt, cards: [mtt(eNew)] });
  assert("char: duplicate enrolments — enrolmentIdFor and buildMemberStates both pick the later-starting row",
    [stampedId, bandId], ["e_dup_new", ["e_dup_new"]]);
  assert("char: duplicate enrolments — one Tally row (the stamped id) and the invoice for a miss stamped via enrolmentIdFor",
    [Object.keys(dupView).sort(), dupView.e_dup_new && dupView.e_dup_new[PW],
      math(dupWtt, [], "e_dup_new", "Guitar").deductions, math(dupWtt, [], "e_dup_old", "Guitar").deductions],
    [["e_dup_new"], "missed-makeup-owed:DM", 1, 0]);
}

// ── Absence planning helpers (commit 2) ─────────────────────────────────
export function runBandAbsenceHelperTests(assert) {
  const amy = { id: "amy", name: "Amy Adams" };
  const bob = { id: "bob", name: "Bob Brown" };
  const cat = { id: "cat", name: "Cat Chen" };
  const eAG = enrol("e_amy_gtr", "amy", "Guitar");
  const eAP = enrol("e_amy_pno", "amy", "Piano");
  const eBD = enrol("e_bob_drm", "bob", "Drums");
  const eCV = enrol("e_cat_vox", "cat", "Vocals");
  const enrolments = [eAG, eAP, eBD, eCV];

  const ledgerCard = card("OWN_G", eAG, { teacherId: "T_OLD", writerTeacherId: "T_W", cardNote: "bring book", notes: "n" });
  const cuRow = row("CU", eBD, PW, PW0, { bandLessonId: "B" });
  const B = band("B", {
    members: [{ studentId: "amy" }, { studentId: "bob" }, { studentId: "cat" }],
    memberStates: [
      ms(eAG, "regular", { consumedWeekKey: PW }),
      ms(eAP, null),
      ms(eBD, "catchup", { catchupId: "CU", consumedWeekKey: PW0 }),
      ms(eCV, "free"),
    ],
    removedLessons: [ledgerCard],
  });
  const [reg, , cu, fr] = B.memberStates;

  assert("absence: eligible = regular (with ledger card), catchup, free; unattributed excluded",
    eligibleForAbsence(B, []).map(e => e.enrolmentId), ["e_amy_gtr", "e_bob_drm", "e_cat_vox"]);
  assert("absence: legacy band has no absence feature",
    [eligibleForAbsence(band("L", { members: [{ studentId: "amy" }], removedLessons: [ledgerCard] }), []), planMarkAbsent({ band: band("L"), entry: reg, missed: [], enrolments })],
    [[], null]);
  assert("absence: menu label adds the instrument only for a two-enrolment student",
    [absenceMenuLabel(B, reg, [amy, bob, cat]), absenceMenuLabel(B, cu, [amy, bob, cat])], ["Amy Adams (Guitar)", "Bob Brown"]);

  // Regular: the ledger card moves into missed[], stripped of teacher stamps.
  const pr = planMarkAbsent({ band: B, entry: reg, missed: [], enrolments });
  const m = pr.misses[0];
  assert("absence regular: card leaves the ledger, one stamped miss with the card's own day/time",
    [pr.kind, pr.band.removedLessons.length, m.id, m.day, m.start, m.bandLessonId, m.enrolmentId],
    ["regular", 0, "OWN_G", "Thursday", "09:00", "B", "e_amy_gtr"]);
  assert("absence regular: no teacherId / writerTeacherId / isBandSession on the miss; teacherId kept as ledgerTeacherId",
    ["teacherId" in m, "writerTeacherId" in m, "isBandSession" in m, m.ledgerTeacherId], [false, false, false, "T_OLD"]);
  assert("absence regular: detected from the stamped miss; attended untouched",
    [isMemberAbsent(pr.band, reg, pr.misses), absentMembers(pr.band, pr.misses).map(e => e.enrolmentId), pr.band.memberStates[0].attended],
    [true, ["e_amy_gtr"], null]);
  const withReason = [{ ...m, reason: "informed_absence", makeupEligible: true }];
  assert("absence regular: info reads the miss's reason; no longer eligible",
    [memberAbsenceInfo(pr.band, reg, withReason), eligibleForAbsence(pr.band, withReason).map(e => e.enrolmentId)],
    [{ reason: "informed_absence", reasonDetail: "" }, ["e_bob_drm", "e_cat_vox"]]);
  assert("absence regular: bandEntryForMiss finds the member; a foreign or unstamped miss finds none",
    [bandEntryForMiss(pr.band, m) && bandEntryForMiss(pr.band, m).enrolmentId, bandEntryForMiss(pr.band, { ...m, bandLessonId: "X" }), bandEntryForMiss(pr.band, miss("P", eBD))],
    ["e_amy_gtr", null, null]);
  const other = miss("OTHER", eBD);
  const ur = planUndoAbsence({ band: pr.band, entry: reg, missed: [other, ...withReason], catchups: [] });
  assert("absence regular undo: miss removed, the card back in the ledger exactly as it was",
    [ur.missed.map(x => x.id), ur.band.removedLessons], [["OTHER"], [ledgerCard]]);

  // Duplicate enrolments: the miss is stamped via enrolmentIdFor like any
  // miss, and is still found for the member whose entry holds the other id.
  const eOld = enrol("e_dup_old", "amy", "Guitar", { startDate: "2020-01-01" });
  const eNew = enrol("e_dup_new", "amy", "Guitar", { startDate: "2020-02-01" });
  const dupEntry = ms(eOld, "regular");
  const dupBand = band("BD", { memberStates: [dupEntry], removedLessons: [card("DC", eOld)] });
  const dp = planMarkAbsent({ band: dupBand, entry: dupEntry, missed: [], enrolments: [eOld, eNew] });
  assert("absence regular, duplicate enrolments: stamped like handleMissedDrop, still matched to the member",
    [dp.misses[0].enrolmentId, isMemberAbsent(dp.band, dupEntry, dp.misses)], ["e_dup_new", true]);

  // Catch-up: owed OFF keeps the row; owed ON deletes it with a snapshot.
  assert("absence catchup: mark plans a prompt and writes nothing",
    planMarkAbsent({ band: B, entry: cu, missed: [], enrolments }), { kind: "catchup" });
  const off = applyCatchupAbsence({ band: B, entry: cu, absence: { reason: "uninformed_absence", makeupEligible: false }, row: cuRow });
  const offEntry = off.band.memberStates[2];
  assert("absence catchup owed off: row stays, attended false, reason recorded, catchupId kept",
    [off.deleteRow, offEntry.attended, offEntry.absence.reason, offEntry.catchupId, "absentCatchupSnapshot" in offEntry],
    [null, false, "uninformed_absence", "CU", false]);
  const on = applyCatchupAbsence({ band: B, entry: cu, absence: { reason: "informed_absence", makeupEligible: true }, row: cuRow });
  const onEntry = on.band.memberStates[2];
  assert("absence catchup owed on: row deleted, snapshot kept, catchupId null, consumedWeekKey untouched",
    [on.deleteRow.id, onEntry.absentCatchupSnapshot, onEntry.catchupId, onEntry.consumedWeekKey, isMemberAbsent(on.band, onEntry, [])],
    ["CU", cuRow, null, PW0, true]);
  const u1 = planUndoAbsence({ band: on.band, entry: onEntry, missed: [], catchups: [] });
  const u1e = u1.band.memberStates[2];
  assert("absence catchup undo: snapshot re-inserted under its original id, catchupId restored, absence cleared",
    [u1.insertRow, u1e.catchupId, u1e.attended, "absence" in u1e, "absentCatchupSnapshot" in u1e, u1e.consumption],
    [cuRow, "CU", null, false, false, "catchup"]);
  const elsewhere = row("CU2", eBD, FW, PW0);
  const u2 = planUndoAbsence({ band: on.band, entry: onEntry, missed: [], catchups: [elsewhere] });
  const u2e = u2.band.memberStates[2];
  assert("absence catchup undo refused: miss booked elsewhere → reset to Not set, no insert",
    [u2.reset, u2.insertRow, u2e.consumption, u2e.catchupId, u2e.attended, "absence" in u2e, "absentCatchupSnapshot" in u2e],
    [true, undefined, null, null, null, false, false]);
  const u3 = planUndoAbsence({ band: off.band, entry: offEntry, missed: [], catchups: [cuRow] });
  assert("absence catchup undo (owed off): attended null, row untouched",
    [u3.insertRow, u3.band.memberStates[2].attended, u3.band.memberStates[2].catchupId], [undefined, null, "CU"]);

  // Free: attended:false directly, no prompt; undo clears it.
  const pf = planMarkAbsent({ band: B, entry: fr, missed: [], enrolments });
  const uf = planUndoAbsence({ band: pf.band, entry: pf.band.memberStates[3], missed: [], catchups: [] });
  assert("absence free: attended false with no reason, undo back to null",
    [pf.kind, pf.band.memberStates[3].attended, memberAbsenceInfo(pf.band, pf.band.memberStates[3], []), uf.band.memberStates[3].attended],
    ["free", false, { reason: null, reasonDetail: "" }, null]);
}

// ── Attribution window lock (commit 3) ──────────────────────────────────
export function runBandAbsenceLockTests(assert) {
  const eAG = enrol("e_amy_gtr", "amy", "Guitar");
  const eAP = enrol("e_amy_pno", "amy", "Piano");
  const eBD = enrol("e_bob_drm", "bob", "Drums");
  const m0 = { enrolmentId: eBD.id, weekKey: PW0, day: "Thursday", start: "09:00" };

  // The 5a trap, closed: a catch-up absence with owed ON deleted its row
  // (catchupId null). Saving the window again must not re-insert it.
  const cuAbsent = ms(eBD, "catchup", { catchupId: null, consumedWeekKey: PW0, attended: false,
    absence: { reason: "informed_absence", reasonDetail: "", notes: "", makeupEligible: true },
    absentCatchupSnapshot: row("CU", eBD, PW, PW0, { bandLessonId: "B" }) });
  const B = band("B", { memberStates: [cuAbsent] });
  const ids = absentEnrolmentIds(B, []);
  const trap = planAttributionSave({ stored: B.memberStates, working: B.memberStates, missByEnrolment: { [eBD.id]: m0 }, catchupsForBand: [], weekKey: PW, absentEnrolmentIds: ids });
  assert("lock: absent catch-up with no row is NOT re-inserted on save",
    [trap.inserts.length, trap.deletes.length, trap.changed, trap.memberStates[0]], [0, 0, false, cuAbsent]);

  // Even a working copy that tried to change the absent student is ignored.
  const edited = applyStudentAttribution(B.memberStates, "bob", eBD.id, "free", null);
  const ignored = planAttributionSave({ stored: B.memberStates, working: edited, missByEnrolment: {}, catchupsForBand: [], weekKey: PW, absentEnrolmentIds: ids });
  assert("lock: a consumption change on an absent member is ignored by the plan",
    [ignored.changed, ignored.memberStates[0].consumption, ignored.deletes.length], [false, "catchup", 0]);

  // Regular absent (stamped miss): switching the student to Piano or to free
  // must not pull a card out of, or back into, the ledger.
  const reg = ms(eAG, "regular", { consumedWeekKey: PW });
  const RB = band("RB", { memberStates: [reg, ms(eAP, null), ms(eBD, "regular", { consumedWeekKey: PW })] });
  const missed = [miss("OWN_G", eAG, { bandLessonId: "RB" })];
  const rIds = absentEnrolmentIds(RB, missed);
  let working = applyStudentAttribution(RB.memberStates, "amy", eAP.id, "regular", PW);
  working = applyStudentAttribution(working, "bob", eBD.id, "free", null);
  const rp = planAttributionSave({ stored: RB.memberStates, working, missByEnrolment: {}, catchupsForBand: [], weekKey: PW, absentEnrolmentIds: rIds });
  assert("lock: absent regular student keeps both entries as stored (no regularOn / regularOff)",
    [rp.memberStates.slice(0, 2), rp.regularOn.map(e => e.enrolmentId), rp.regularOff.map(e => e.enrolmentId)],
    [RB.memberStates.slice(0, 2), [], ["e_bob_drm"]]);
  assert("lock: the other, present student's change still applies",
    [rp.changed, rp.memberStates[2].consumption], [true, "free"]);

  // No absences → identical plan to the pre-5b call.
  const plain = planAttributionSave({ stored: RB.memberStates, working, missByEnrolment: {}, catchupsForBand: [], weekKey: PW });
  const plainEmpty = planAttributionSave({ stored: RB.memberStates, working, missByEnrolment: {}, catchupsForBand: [], weekKey: PW, absentEnrolmentIds: [] });
  assert("lock: an empty absent set changes nothing",
    plainEmpty, plain);
}

// ── Regenerate / import preservation (commit 4) ─────────────────────────
export function runBandAbsenceRegenTests(assert) {
  const eAG = enrol("e_amy_gtr", "amy", "Guitar");
  const eAP = enrol("e_amy_pno", "amy", "Piano");
  const eBD = enrol("e_bob_drm", "bob", "Drums");
  const B = band("B", { memberStates: [ms(eAG, "regular")] });
  const stamped = miss("OWN_G", eAG, { bandLessonId: "B", reason: "informed_absence" });
  const orphan = miss("OLD_X", eBD, { bandLessonId: "GONE" });
  const plain = miss("PLAIN", eBD, { day: "Monday" });
  const generated = miss("GEN", eAP, { reason: "timetable_clash" });

  assert("regen: isBandStampedMiss / withoutBandMisses",
    [isBandStampedMiss(stamped), isBandStampedMiss(plain), isBandStampedMiss(null), withoutBandMisses([stamped, plain, orphan]).map(m => m.id)],
    [true, false, false, ["PLAIN"]]);
  assert("regen week: a surviving band's absence is carried forward after the generator's misses",
    carryBandMisses([generated], [plain, stamped], [B, card("C", eBD)]).map(m => m.id), ["GEN", "OWN_G"]);
  assert("regen: an absence whose band did not survive is dropped",
    carryBandMisses([], [stamped, orphan], [card("C", eBD)]).map(m => m.id), []);
  assert("regen: unstamped previous misses are never carried (caller's rule unchanged)",
    carryBandMisses([], [plain], [B]).map(m => m.id), []);
  // Day rebuild: nextMissed already holds other days' entries, stamped ones
  // included — they must not be doubled.
  assert("regen day: stamped entries already in nextMissed are not duplicated",
    carryBandMisses([plain, stamped, generated], [plain, stamped], [B]).map(m => m.id), ["PLAIN", "GEN", "OWN_G"]);
  assert("regen: the carried miss is the same object — reason and catch-up flag intact",
    carryBandMisses([], [stamped], [B])[0], stamped);
}
