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
