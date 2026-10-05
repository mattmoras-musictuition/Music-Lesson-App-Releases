// ============================================================
// BAND FORWARD ABSENCE SMOKE TESTS
// Band Session Attribution phase 3, refinements 1 and 2:
//   R1 — a "Lesson brought forward" member (or whole group) can be marked
//        absent from the band. Catch-up owed gives the later week back;
//        no catch-up keeps it used up and the Tally shows the red X there.
//   R2 — a stale given-up week is flagged (Dashboard chip + window note).
//
// The characterization block pins how the code treats a forward member's
// absence BEFORE any of this exists. The protected modules
// (bandSessionView.js, bandAbsence.js, bandMemberStates.js) never change;
// the admin side wraps them.
// ============================================================

import { eligibleForAbsence, absentMembers, absentEnrolmentIds } from "./bandAbsence";
import { sessionMemberRows, bandCardStatus, parentEmailStudentIds } from "./bandSessionView";
import { planAttributionSave } from "./bandMemberStates";
import { buildForwardIndex, isForwardConsumedCard, forwardConsumes } from "./bandForwardIndex";
import { consumeForwardWeeks, generateMasterLessons, planForwardSave, releaseForwardWeeks } from "./bandForward";
import { restoreDropNotice, restoreCardName } from "./bandMemberStates";
import { adminAbsenceMenu, absenceItemLabel, applyForwardAbsence, planForwardUndo, adminAbsentEnrolmentIds,
  adminMemberAbsenceInfo, isForwardAbsent } from "./bandForwardAbsence";
import { isLessonPresentThisWeek } from "../utils/weeklyPresence";
import { buildMttImportForWeekSchool } from "../utils/mttImport";
import { lweekDates } from "./bandLedgerSmokeTests";
import { getEnrolmentTermDeductionMath } from "../utils/tallyDerive";
import { EB, EX, EENROL, EMASTER, ESTUDENTS, eentry, eband, ecard, eresolver, egenerate, origins } from "./bandForwardEnforceSmokeTests";
import { FB, FX, fstudent, fenrol, fentry, fband, fcard, ftally } from "./bandForwardSmokeTests";

// The three absence shapes a forward entry can carry (refinement 1).
export const OWED = { reason: "informed_absence", reasonDetail: "sick", notes: "", makeupEligible: true };
export const NOT_OWED = { reason: "uninformed_absence", reasonDetail: "", notes: "", makeupEligible: false };

// Amy (solo forward) and the ukulele group (group forward), both giving up EX.
export const amyFwd = (extra = {}) => eentry("e_amy_gtr", "forward", { consumedWeekKey: EX, ...extra });
export const groupFwd = (extra = {}, first = {}) => [
  eentry("e_libby_uke", "forward", { consumedWeekKey: EX, ...extra, ...first }),
  eentry("e_ivy_uke", "forward", { consumedWeekKey: EX, ...extra }),
];

// ── Commit 1: characterization — pinned against unchanged code ──
export function runForwardAbsenceCharacterizationTests(assert) {
  const band = eband("B1", [amyFwd(), ...groupFwd(), eentry("e_bob_drm", "free")]);

  // The absence gate: forward is never offered, never absent.
  assert("fwd-abs char: forward solo and group entries are never offered Mark absent (only the free member is)",
    eligibleForAbsence(band, []).map(e => e.enrolmentId), ["e_bob_drm"]);
  const marked = eband("B1", [amyFwd({ attended: false, absence: NOT_OWED }), ...groupFwd({ attended: false, absence: OWED })]);
  assert("fwd-abs char: a forward entry marked attended:false is not 'absent' to bandAbsence",
    [absentMembers(marked, []).length, [...absentEnrolmentIds(marked, [])]], [0, []]);

  // Existing gap kept as is (out of scope): a Free group is offered per member.
  const freeGroup = eband("B2", [eentry("e_libby_uke", "free"), eentry("e_ivy_uke", "free")]);
  assert("fwd-abs char: a Free group is offered Mark absent one member at a time (unchanged gap)",
    eligibleForAbsence(freeGroup, []).map(e => e.enrolmentId), ["e_libby_uke", "e_ivy_uke"]);

  // Protected session view: a forward attended:false still reads attending.
  const viewBand = { ...marked, members: [{ studentId: "amy", instrument: "Guitar" }, { studentId: "libby", instrument: "Ukulele" }, { studentId: "ivy", instrument: "Ukulele" }] };
  assert("fwd-abs char: the protected session view lists a forward attended:false member as attending",
    sessionMemberRows(viewBand, []).map(r => r.studentId + ":" + r.status), ["amy:attending", "libby:attending", "ivy:attending"]);
  assert("fwd-abs char: the protected card status counts no forward absentee",
    bandCardStatus(viewBand, []).absentN, 0);
  assert("fwd-abs char: the protected parent-email list keeps forward absentees",
    parentEmailStudentIds(viewBand, []), ["amy", "libby", "ivy"]);

  // The attribution window only locks what it is told is absent.
  const plan = planAttributionSave({
    stored: [amyFwd({ attended: false, absence: NOT_OWED })], working: [eentry("e_amy_gtr", "free")],
    missByEnrolment: {}, catchupsForBand: [], weekKey: EB, absentEnrolmentIds: [],
  });
  assert("fwd-abs char: without the lock a forward absentee's role can be changed by Save",
    plan.memberStates[0].consumption, "free");

  // Consumption today: ANY attended:false stops the week being used up.
  const wk = (entries) => buildForwardIndex({ [EB + "|S"]: { lessons: [eband("B1", entries)], missed: [] } });
  const card = ecard("M_amy", "W_amy");
  // Commit 2 deliberately changes the last value: absent with NO catch-up
  // keeps the week used up. Was false.
  assert("fwd-abs char: attended:false gives the week back — except absent with no catch-up (was: any attended:false)",
    [isForwardConsumedCard(card, EX, wk([amyFwd()])), isForwardConsumedCard(card, EX, wk([amyFwd({ attended: false })])),
      isForwardConsumedCard(card, EX, wk([amyFwd({ attended: false, absence: OWED })])), isForwardConsumedCard(card, EX, wk([amyFwd({ attended: false, absence: NOT_OWED })]))],
    [true, false, false, true]);
  // Save's consume step. Commit 2 deliberately changes this: a subject whose
  // absence gave the week back is skipped. Was: the card removed (0 left).
  const rows = { [EX + "|S"]: { lessons: [card], missed: [], generatedAt: "x" } };
  const left = (entries) => ((consumeForwardWeeks(rows, entries).rows[EX + "|S"] || rows[EX + "|S"]).lessons).length;
  assert("fwd-abs char: the Save consume step leaves the card of a catch-up-owed absentee (was: removed it)",
    [left([amyFwd()]), left([amyFwd({ attended: false, absence: OWED })]), left([amyFwd({ attended: false, absence: NOT_OWED })])], [0, 1, 0]);

  // Tally today: the no-catch-up absence ticks nothing in the given-up week.
  const amy = fstudent("amy");
  const eAG = fenrol("e_amy_gtr", "amy", "Guitar");
  const d = ftally({ students: [amy], enrolments: [eAG], wtt: {
    [FB + "|S"]: { lessons: [fband("B1", [fentry(eAG, "forward", { consumedWeekKey: FX, attended: false, absence: NOT_OWED })])], missed: [] } } });
  // Commit 2 makes the week stay used up; commit 5 draws the red X there.
  // Was "blank" (and the forward tick between commits 2 and 5).
  assert("fwd-abs char: Tally — a no-catch-up forward absence is the red X in the given-up week (was blank)",
    d.view["amy|Guitar"][FX], "missed-no-catchup:B1");

  // Invoice math reads neither the band nor the absence.
  assert("fwd-abs char: invoice math identical across none / absent-owed / absent-not-owed",
    forwardAbsenceInvoiceMath(), Array(4).fill(JSON.stringify({ mkpEligPending: 1, catchups: 0, deductions: 1, extras: 0 })));
}

// ── Commit 2: an absence with no catch-up keeps the week used up ──
export function runForwardAbsenceConsumeTests(assert) {
  assert("fwd-abs consume: forwardConsumes — present, unmarked, owed, not owed, bare attended:false, null",
    [forwardConsumes(amyFwd()), forwardConsumes(amyFwd({ attended: true })), forwardConsumes(amyFwd({ attended: false, absence: OWED })),
      forwardConsumes(amyFwd({ attended: false, absence: NOT_OWED })), forwardConsumes(amyFwd({ attended: false })), forwardConsumes(null)],
    [true, true, false, true, false, false]);

  const idxOf = (entries) => buildForwardIndex({ [EB + "|S"]: { lessons: [eband("B1", entries)], missed: [] } });
  const notOwed = idxOf([amyFwd({ attended: false, absence: NOT_OWED }), ...groupFwd({ attended: false, absence: NOT_OWED })]);
  const owed = idxOf([amyFwd({ attended: false, absence: OWED }), ...groupFwd({ attended: false, absence: OWED })]);
  assert("fwd-abs consume: the index carries the absence",
    [notOwed.entries[0].absence, idxOf([amyFwd()]).entries[0].absence], [NOT_OWED, null]);

  // Generation (the shared generate filter), presence and import all follow it.
  const r = eresolver();
  const gen = (idx) => origins(egenerate(generateMasterLessons(EMASTER, [], r, EX, idx), "S", EX).lessons);
  assert("fwd-abs consume: generate — no catch-up leaves the solo and group lessons out; catch-up owed generates them",
    [gen(notOwed), gen(owed)], [[], ["e_amy_gtr", "e_ivy_uke"]]);
  assert("fwd-abs consume: presence — no catch-up counts as scheduled; catch-up owed does not",
    [isLessonPresentThisWeek(EMASTER[0], [], [], { forwardIndex: notOwed, weekKey: EX }), isLessonPresentThisWeek(EMASTER[2], [], [], { forwardIndex: notOwed, weekKey: EX }),
      isLessonPresentThisWeek(EMASTER[0], [], [], { forwardIndex: owed, weekKey: EX })], [true, true, false]);
  const imp = (idx) => buildMttImportForWeekSchool({ mtt: { lessons: EMASTER }, schoolId: "S", weekDates: lweekDates(EX),
    existingEntry: null, enrolments: EENROL, dropBands: true, catchups: [], forwardIndex: idx }).entry.lessons.map(l => l.enrolmentId).sort();
  assert("fwd-abs consume: import — no catch-up leaves the lessons out; catch-up owed imports them",
    [imp(notOwed), imp(owed)], [[], ["e_amy_gtr", "e_ivy_uke"]]);

  // The window Save's consume step: a released subject keeps its card; the
  // other subjects of the same band are still cleared (repair unchanged).
  const wtt = { [EX + "|S"]: { lessons: [ecard("M_amy", "W_amy"), ecard("M_uke", "W_uke")], missed: [], generatedAt: "x" } };
  const ms = [amyFwd({ attended: false, absence: OWED }), ...groupFwd()];
  const fw = planForwardSave({ stored: ms, saved: ms, weeklyTimetables: wtt });
  assert("fwd-abs consume: Save repair clears the group's card but leaves the catch-up-owed absentee's card",
    [fw.rows[EX + "|S"].lessons.map(l => l.id), fw.released.length], [["W_amy"], 0]);
  const fw2 = planForwardSave({ stored: [amyFwd({ attended: false, absence: NOT_OWED })], saved: [amyFwd({ attended: false, absence: NOT_OWED })], weeklyTimetables: wtt });
  assert("fwd-abs consume: Save repair still clears a no-catch-up absentee's card",
    fw2.rows[EX + "|S"].lessons.map(l => l.id), ["W_uke"]);
}

// ── Commit 3: the pure planners (bandForwardAbsence.js) ──
export function runForwardAbsencePlannerTests(assert) {
  const AT = "2099-03-10T10:00:00.000Z";
  const GROUPS = [{ id: "g_uke", studentIds: ["ivy", "libby"] }];
  const regCard = ecard("M_bob", "W_bob");
  const snapAmy = ecard("M_amy", "W_amy");
  const snapUke = ecard("M_uke", "W_uke");
  const band = eband("B1", [
    amyFwd({ forwardCard: snapAmy }),
    ...groupFwd({}, { forwardCard: snapUke }),
    eentry("e_bob_drm", "regular", { consumedWeekKey: EB }),
  ], { removedLessons: [regCard] });

  // Menu: bandAbsence's members first (unchanged), then one item per forward subject.
  let menu = adminAbsenceMenu(band, []);
  assert("fwd-abs menu: eligible = the regular member, then Amy, then the group as ONE item",
    menu.eligible.map(i => i.key), ["e_bob_drm", "fwd:enrolment:e_amy_gtr", "fwd:group:g_uke"]);
  assert("fwd-abs menu: labels — a solo by name, a group by its members in the group's order",
    menu.eligible.map(i => absenceItemLabel(band, i, ESTUDENTS, GROUPS)), ["Bob Bell", "Amy Ash", "Ivy O'Donnell, Libby Gilby"]);
  assert("fwd-abs menu: nothing absent yet; a legacy band gets nothing",
    [menu.absent.length, adminAbsenceMenu({ id: "L", isBandSession: true, members: [] }, []).eligible.length], [0, 0]);

  // Mark absent — catch-up owed: every entry of the subject, the same absence, stamped.
  const g = applyForwardAbsence({ band, subjectKey: "group:g_uke", absence: OWED, at: AT });
  const gEntries = g.band.memberStates.filter(e => e.groupId === "g_uke");
  assert("fwd-abs mark (group, owed): both entries attended:false with one absence, stamped, week and snapshot kept",
    gEntries.map(e => [e.attended, e.absence.makeupEligible, e.adminOverrideAt, e.writerTeacherId, e.consumedWeekKey, e.consumption, e.catchupId]),
    [[false, true, AT, null, EX, "forward", null], [false, true, AT, null, EX, "forward", null]]);
  assert("fwd-abs mark (group, owed): the snapshot stays on the first entry; the later week is released with it",
    [gEntries[0].forwardCard.id, "forwardCard" in gEntries[1], g.released.map(x => [x.subject.key, x.weekKey, x.snapshot.id])],
    [snapUke.id, false, [["group:g_uke", EX, snapUke.id]]]);
  assert("fwd-abs mark: other members, removedLessons and the band otherwise untouched",
    [g.band.memberStates[0], g.band.memberStates[3], g.band.removedLessons], [band.memberStates[0], band.memberStates[3], [regCard]]);
  menu = adminAbsenceMenu(g.band, []);
  assert("fwd-abs menu: an absent group moves to Undo absence as one item",
    [menu.eligible.map(i => i.key), menu.absent.map(i => i.key)], [["e_bob_drm", "fwd:enrolment:e_amy_gtr"], ["fwd:group:g_uke"]]);
  assert("fwd-abs mark: an absent subject cannot be marked again; an unknown subject is null",
    [applyForwardAbsence({ band: g.band, subjectKey: "group:g_uke", absence: OWED, at: AT }), applyForwardAbsence({ band, subjectKey: "group:nope", absence: OWED, at: AT })], [null, null]);

  // Mark absent — no catch-up: nothing released.
  const a = applyForwardAbsence({ band, subjectKey: "enrolment:e_amy_gtr", absence: NOT_OWED, at: AT });
  assert("fwd-abs mark (solo, not owed): attended:false, absence kept, nothing released",
    [a.band.memberStates[0].attended, a.band.memberStates[0].absence, a.released], [false, NOT_OWED, []]);
  assert("fwd-abs mark: the reason defaults to other and makeupEligible is strictly true/false",
    applyForwardAbsence({ band, subjectKey: "enrolment:e_amy_gtr", absence: {}, at: AT }).band.memberStates[0].absence,
    { reason: "other", reasonDetail: "", notes: "", makeupEligible: false });

  // Giving the week back (the caller's releaseForwardRows), and the slot-taken notice.
  const opts = { masterLessons: EMASTER, enrolments: EENROL, newId: () => "NEW" };
  const wtt = { [EX + "|S"]: { lessons: [ecard("M_amy", "W_zed", { enrolmentId: "e_zed", studentId: "zed", instrument: "Bass", start: "11:00" })], missed: [], generatedAt: "x" } };
  const owedAmy = applyForwardAbsence({ band, subjectKey: "enrolment:e_amy_gtr", absence: OWED, at: AT });
  let rel = releaseForwardWeeks(wtt, owedAmy.released, opts);
  assert("fwd-abs release: catch-up owed puts the snapshot back in the given-up week",
    [rel.rows[EX + "|S"].lessons.map(l => l.id).sort(), rel.dropped], [["W_amy", "W_zed"], []]);
  const taken = { [EX + "|S"]: { lessons: [ecard("M_amy", "W_in_slot", { enrolmentId: "e_x", studentId: "x", instrument: "Cello" })], missed: [], generatedAt: "x" } };
  const relTaken = releaseForwardWeeks(taken, owedAmy.released, opts);
  const firstOf = (c) => (ESTUDENTS.find(st => st.id === c.studentId) || { name: "" }).name.split(" ")[0];
  assert("fwd-abs release: slot taken → not put back, named in the usual notice",
    restoreDropNotice(relTaken.dropped, c => restoreCardName(c, firstOf)),
    "Couldn't put back Amy's lesson (Thursday 09:00) — that slot is taken. Re-add it from the Master Timetable if needed.");

  // Undo — restore: the exact prior forward state (bar the admin stamp), the card out again.
  const strip = (e) => { const { adminOverrideAt, writerTeacherId, ...rest } = e; return rest; };
  let u = planForwardUndo({ band: owedAmy.band, subjectKey: "enrolment:e_amy_gtr", weeklyTimetables: rel.rows, weekStillOpen: () => true, at: AT });
  assert("fwd-abs undo (owed): restore — the week is used up again: the card leaves it, the snapshot is retaken",
    [u.kind, u.rows[EX + "|S"].lessons.map(l => l.id), u.band.memberStates[0].forwardCard.id, u.released], ["restore", ["W_zed"], "W_amy", []]);
  assert("fwd-abs undo (owed): the member entry is exactly as before the absence (apart from the admin stamp)",
    strip(u.band.memberStates[0]), strip(band.memberStates[0]));
  assert("fwd-abs undo: stamps the entry as an admin action",
    [u.band.memberStates[0].adminOverrideAt, u.band.memberStates[0].writerTeacherId], [AT, null]);
  u = planForwardUndo({ band: a.band, subjectKey: "enrolment:e_amy_gtr", weeklyTimetables: wtt, weekStillOpen: () => true, at: AT });
  assert("fwd-abs undo (not owed): restore — nothing moves, the entry is exactly as before",
    [u.kind, Object.keys(u.rows), strip(u.band.memberStates[0])], ["restore", [], strip(band.memberStates[0])]);
  u = planForwardUndo({ band: g.band, subjectKey: "group:g_uke", weeklyTimetables: { [EX + "|S"]: { lessons: [snapUke], missed: [], generatedAt: "x" } }, weekStillOpen: () => true, at: AT });
  assert("fwd-abs undo (group): every entry cleared together and the group card leaves the week again",
    [u.band.memberStates.filter(e => e.groupId).map(e => [e.attended, "absence" in e]), u.rows[EX + "|S"].lessons.length], [[[null, false], [null, false]], 0]);
  u = planForwardUndo({ band: owedAmy.band, subjectKey: "group:g_uke", weeklyTimetables: wtt, at: AT });
  assert("fwd-abs undo: a subject that is not absent has nothing to undo",
    u, null);

  // Undo — reset to Not set when the week can no longer be used.
  u = planForwardUndo({ band: a.band, subjectKey: "enrolment:e_amy_gtr", weeklyTimetables: wtt, weekStillOpen: () => false, at: AT });
  assert("fwd-abs undo fallback (not owed): the week fails the open-week rules → Not set, and the used-up week is given back",
    [u.kind, u.band.memberStates[0].consumption, u.band.memberStates[0].consumedWeekKey, u.band.memberStates[0].attended,
      "absence" in u.band.memberStates[0], "forwardCard" in u.band.memberStates[0], u.released.map(x => [x.weekKey, x.snapshot.id])],
    ["reset", null, null, null, false, false, [[EX, "W_amy"]]]);
  u = planForwardUndo({ band: owedAmy.band, subjectKey: "enrolment:e_amy_gtr", weeklyTimetables: wtt, weekStillOpen: () => false, at: AT });
  assert("fwd-abs undo fallback (owed): Not set; the week was already given back, so nothing more is released",
    [u.kind, u.band.memberStates[0].consumption, u.released], ["reset", null, []]);
  u = planForwardUndo({ band: g.band, subjectKey: "group:g_uke", weeklyTimetables: wtt, weekStillOpen: () => false, at: AT });
  assert("fwd-abs undo fallback (group): the whole group goes back to Not set together",
    u.band.memberStates.filter(e => e.groupId).map(e => e.consumption), [null, null]);

  // Window lock + sub-line.
  const ids = adminAbsentEnrolmentIds(g.band, []);
  assert("fwd-abs lock: forward absentees join the window's lock set (bandAbsence's own set unchanged)",
    [...ids].sort(), ["e_ivy_uke", "e_libby_uke"]);
  const plan = planAttributionSave({ stored: g.band.memberStates, working: g.band.memberStates.map(e => (e.groupId ? { ...e, consumption: "free" } : e)),
    missByEnrolment: {}, catchupsForBand: [], weekKey: EB, absentEnrolmentIds: [...ids] });
  assert("fwd-abs lock: Save keeps a locked forward absentee exactly as stored",
    plan.memberStates.filter(e => e.groupId).map(e => [e.consumption, e.attended]), [["forward", false], ["forward", false]]);
  assert("fwd-abs lock: the window's absent sub-line reads the forward absence's reason",
    [adminMemberAbsenceInfo(a.band, a.band.memberStates[0], []), adminMemberAbsenceInfo(band, band.memberStates[0], []), isForwardAbsent(a.band.memberStates[0])],
    [{ reason: "uninformed_absence", reasonDetail: "" }, null, true]);
}

// ── Commit 5: the Tally's red X ──
export function runForwardAbsenceTallyTests(assert) {
  const amy = fstudent("amy");
  const eAG = fenrol("e_amy_gtr", "amy", "Guitar");
  const band = (extra) => fband("B1", [fentry(eAG, "forward", { consumedWeekKey: FX, ...extra })]);
  const run = (wtt, weeks) => ftally({ students: [amy], enrolments: [eAG], wtt, weeks });

  let d = run({ [FB + "|S"]: { lessons: [band({ attended: false, absence: NOT_OWED })], missed: [] } });
  let shim = d.entryMap["amy|Guitar|" + FX];
  assert("fwd-abs tally: no catch-up → red X in the given-up week with the brought-forward hover",
    [d.view["amy|Guitar"][FX], shim.status, shim.makeupEligible, shim.madeUp, shim.forwardHover, shim.reason, shim.bandSession],
    ["missed-no-catchup:B1", "missed", false, false, "Brought forward to week 2 band session — absent, no catch-up", "uninformed_absence", false]);
  assert("fwd-abs tally: the band week and the other weeks are untouched",
    [d.view["amy|Guitar"][FB], d.view["amy|Guitar"]["2020-03-16"]], ["blank", "blank"]);
  assert("fwd-abs tally: tiles count one missed, no catch-up owed, nothing completed",
    [Object.values(d.entryMap).filter(x => x.status === "missed").length, Object.values(d.entryMap).filter(x => x.status === "missed" && x.makeupEligible).length,
      Object.values(d.entryMap).filter(x => x.status === "completed").length], [1, 0, 0]);
  assert("fwd-abs tally: ordinary shim entries carry no forwardHover key",
    "forwardHover" in run({ [FB + "|S"]: { lessons: [band({})], missed: [] } }).entryMap["amy|Guitar|" + FX], false);

  // Not yet past the band day: the X shows at once, like any recorded miss.
  const FUT_B = "2099-03-09", FUT_X = "2099-03-23";
  d = run({ [FUT_B + "|S"]: { lessons: [fband("B1", [fentry(eAG, "forward", { consumedWeekKey: FUT_X, attended: false, absence: NOT_OWED })])], missed: [] } },
    [{ weekKey: FUT_B, label: "W1", weekNum: 1 }, { weekKey: FUT_X, label: "W2", weekNum: 2 }]);
  assert("fwd-abs tally: the X shows as soon as it is recorded (no 6pm wait)",
    d.view["amy|Guitar"][FUT_X], "missed-no-catchup:B1");

  // Catch-up owed: the tick is gone; the regular lesson's own card decides.
  d = run({ [FB + "|S"]: { lessons: [band({ attended: false, absence: OWED })], missed: [] } });
  assert("fwd-abs tally: catch-up owed → no tick, no X (no card back yet)",
    d.view["amy|Guitar"][FX], "blank");
  d = run({ [FB + "|S"]: { lessons: [band({ attended: false, absence: OWED })], missed: [] }, [FX + "|S"]: { lessons: [fcard("OWN_X", eAG)], missed: [] } });
  assert("fwd-abs tally: catch-up owed → the put-back regular lesson ticks as itself",
    d.view["amy|Guitar"][FX], "completed:OWN_X");

  // A recorded miss in the given-up week still wins.
  const miss = { id: "MS", enrolmentId: "e_amy_gtr", studentId: "amy", instrument: "Guitar", schoolId: "S", day: "Thursday", reason: "sick", makeupEligible: true, madeUp: false };
  d = run({ [FB + "|S"]: { lessons: [band({ attended: false, absence: NOT_OWED })], missed: [] }, [FX + "|S"]: { lessons: [], missed: [miss] } });
  assert("fwd-abs tally: a miss in the given-up week beats the forward X",
    d.view["amy|Guitar"][FX], "missed-makeup-owed:MS");

  // Hover fallback when the band's week number can't be resolved.
  d = run({ [FB + "|S"]: { lessons: [band({ attended: false, absence: NOT_OWED })], missed: [] } },
    [{ weekKey: FB, label: "W2", weekNum: 2, isHoliday: true }, { weekKey: FX, label: "W4", weekNum: 4 }]);
  assert("fwd-abs tally: hover names the band's week by date when it has no term week number",
    d.entryMap["amy|Guitar|" + FX].forwardHover, "Brought forward to the band session in the week of " + FB + " — absent, no catch-up");

  // Groups: by groupId, one X for the group row.
  const libby = fstudent("libby"), ivy = fstudent("ivy");
  const eL = fenrol("e_libby_uke", "libby", "Ukulele", { isGroup: true, groupId: "g_uke" });
  const eI = fenrol("e_ivy_uke", "ivy", "Ukulele", { isGroup: true, groupId: "g_uke" });
  const gx = { consumedWeekKey: FX, groupId: "g_uke", isGroup: true, attended: false, absence: NOT_OWED };
  const gCards = [{ id: "MG", isGroup: true, groupId: "g_uke", enrolmentId: "e_ivy_uke", studentId: "ivy", instrument: "Ukulele", schoolId: "S", day: "Thursday", start: "10:00" }];
  d = ftally({ students: [libby, ivy], enrolments: [eL, eI], cards: gCards, wtt: { [FB + "|S"]: { lessons: [fband("B1", [fentry(eL, "forward", gx), fentry(eI, "forward", gx)])], missed: [] } } });
  assert("fwd-abs tally (group): the group row shows the X in the given-up week",
    d.view["group|g_uke"][FX], "missed-no-catchup:B1");
}

// Invoice math for one ordinary miss plus: no band, a forward entry, the
// forward entry absent with catch-up owed, and absent with no catch-up.
export function forwardAbsenceInvoiceMath() {
  const eAG = fenrol("e_amy_gtr", "amy", "Guitar");
  const miss = { id: "MS", enrolmentId: "e_amy_gtr", studentId: "amy", instrument: "Guitar", schoolId: "S", day: "Thursday", reason: "sick", makeupEligible: true, madeUp: false };
  const base = { "2020-03-16|S": { lessons: [], missed: [miss] } };
  const withBand = (extra) => ({ ...base, [FB + "|S"]: { lessons: [fband("B1", [fentry(eAG, "forward", { consumedWeekKey: FX, ...extra })])], missed: [] } });
  const math = (wtt) => JSON.stringify(getEnrolmentTermDeductionMath({ weeklyTimetables: wtt, catchups: [], enrolmentId: "e_amy_gtr", instrument: "Guitar",
    prevTerm: { start: "2020-02-03", end: "2020-04-03" }, interruptions: [], nextTermStart: "2020-04-20" }));
  return [math(base), math(withBand({})), math(withBand({ attended: false, absence: OWED })), math(withBand({ attended: false, absence: NOT_OWED }))];
}
