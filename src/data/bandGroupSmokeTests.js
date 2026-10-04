// ============================================================
// BAND GROUP SMOKE TESTS
// Groups in band attribution (v2.43.0) — owner-approved spec change to
// BAND_SESSION_ATTRIBUTION_SPEC.md: a group joins a band as one unit.
//
// The characterization block pins how bands treat groups BEFORE the change:
// group enrolments get no memberStates entry, group cards are never matched
// to an entry, the Tally never band-matches a group row, absence skips group
// cards, and a removed Regular individual's card goes back only when the
// owner clears the departed row. The D15 snapshot (an individuals-only band)
// must build byte-identically at every later commit.
//
// The fixture mirrors the Riptide case: Liri (piano + guitar), Libby (piano,
// plus the ukulele group), Ivy (ukulele group only), Noa (guitar).
// ============================================================

import {
  buildMemberStates, findMemberCards, reconcileMemberStates, studentRows,
  applyStudentAttribution, planAttributionSave, applyAttributionLedger,
  resolveGroupEnrolment, attributionWindowRows, applyGroupAttribution,
  applyRegularDisplacement, isGenerateExcluded, displaceRegularIntoBands,
  withoutLedgeredDuplicates, sweepRegularIntoLedger, restoreDropNotice,
  restoreCardName, isExcludedByBands,
} from "./bandMemberStates";
import { eligibleForAbsence, planRemoveBandSession, planCleanImport } from "./bandAbsence";
import { buildMttImportForWeekSchool } from "../utils/mttImport";
import { lweekDates } from "./bandLedgerSmokeTests";
import { makeEnrolmentResolver } from "../utils/enrolmentActivity";
import { deriveTallyRows } from "../utils/tallyDerive";

export const GW = "2099-03-09";   // a future Monday — week-activity guards never move

export const GENROL = [
  { id: "e_liri_pno",  studentId: "liri",  instrument: "Piano",   startDate: "2020-01-01" },
  { id: "e_liri_gtr",  studentId: "liri",  instrument: "Guitar",  startDate: "2020-02-01" },
  { id: "e_libby_pno", studentId: "libby", instrument: "Piano",   startDate: "2020-01-01" },
  { id: "e_libby_uke", studentId: "libby", instrument: "Ukulele", startDate: "2020-01-01", isGroup: true, groupId: "g_uke" },
  { id: "e_ivy_uke",   studentId: "ivy",   instrument: "Ukulele", startDate: "2020-01-01", isGroup: true, groupId: "g_uke" },
  { id: "e_noa_gtr",   studentId: "noa",   instrument: "Guitar",  startDate: "2020-01-01" },
];
export const gresolver = () => makeEnrolmentResolver(GENROL);

export const GROUP_UKE = { id: "g_uke", name: "Ukulele Group", schoolId: "S", instrument: "Ukulele", studentIds: ["ivy", "libby"], status: "scheduled" };

// The weekly group card exactly as handleAddGroupToMaster shapes it: studentId
// is the FIRST member, enrolmentId is ONE member's group enrolment.
export function groupCard(id = "W_UKE", extra = {}) {
  return { id, isGroup: true, groupId: "g_uke", groupName: "Ukulele Group", studentId: "ivy", studentName: "Ukulele Group",
    studentIds: ["ivy", "libby"], studentNames: ["Ivy O'Donnell", "Libby Gilby"], instrument: "Ukulele", enrolmentId: "e_ivy_uke",
    schoolId: "S", day: "Thursday", start: "10:00", end: "10:30", ...extra };
}
export function soloCard(id, enrolmentId, day, start, extra = {}) {
  const e = GENROL.find(x => x.id === enrolmentId);
  return { id, enrolmentId, studentId: e.studentId, instrument: e.instrument, schoolId: "S", day, start, end: start, ...extra };
}

// Riptide's roster as Edit Band stores it today: four individuals.
export const INDIVIDUAL_MEMBERS = [
  { id: "m1", studentId: "liri",  instrument: "Piano" },
  { id: "m2", studentId: "libby", instrument: "Ukulele" },
  { id: "m3", studentId: "ivy",   instrument: "Ukulele" },
  { id: "m4", studentId: "noa",   instrument: "Guitar" },
];

const blank = (enrolmentId, studentId, instrument) => ({
  enrolmentId, studentId, instrument, consumption: null, catchupId: null,
  consumedWeekKey: null, fee: null, attended: null, writerTeacherId: null,
});

// D15 — the individuals-only build, byte for byte. Never edit this literal:
// if a later change alters it, existing bands have changed shape.
export const D15_SNAPSHOT = JSON.stringify([
  blank("e_liri_pno", "liri", "Piano"),
  blank("e_liri_gtr", "liri", "Guitar"),
  blank("e_libby_pno", "libby", "Piano"),
  blank("e_noa_gtr", "noa", "Guitar"),
]);

// Build without the dev-mode "dropping member" warning reaching the console.
export function quietBuild(members, enrolments, weekKey, opts) {
  const warn = console.warn;
  console.warn = () => {};
  try { return buildMemberStates(members, enrolments, weekKey, opts); } finally { console.warn = warn; }
}

// ── Tally fixture (past week, so a band tick would show) ──
const TW = "2020-03-09";
const TWEEKS = [{ weekKey: TW, label: "W1", weekNum: 1 }];
function tallyView({ wttLessons, wttMissed = [] }) {
  const students = ["liri", "libby", "ivy", "noa"].map(id => ({ id, name: id, schoolId: "S", status: "active" }));
  const mttGroup = { ...groupCard("M_UKE"), day: "Tuesday" };
  const mttSolos = GENROL.filter(e => !e.isGroup).map(e => soloCard("M_" + e.id, e.id, "Monday", "09:00"));
  const { tallyRows } = deriveTallyRows({
    enrolments: GENROL, students, termWeeks: TWEEKS,
    weeklyTimetables: { [TW + "|S"]: { lessons: wttLessons, missed: wttMissed } },
    timetable: { lessons: [mttGroup, ...mttSolos] }, schoolFilter: "all",
  });
  const view = {};
  for (const r of tallyRows) {
    const c = r.cells[TW];
    view[r.lessonKey] = c.state + (c.wttEntry ? ":" + (c.wttEntry.isBandSession ? "band" : c.wttEntry.id) : "");
  }
  return view;
}
export function tallyBand(memberStates, removedLessons, extra = {}) {
  return { id: "B_T", isBandSession: true, bandId: "RIPTIDE", bandName: "Riptide", schoolId: "S", day: "Tuesday", start: "11:00", end: "11:00",
    members: [], removedLessons, ...(memberStates ? { memberStates } : {}), ...extra };
}
export { tallyView };

export function runBandGroupCharacterizationTests(assert) {
  const r = gresolver();

  // 1. buildMemberStates drops group enrolments: Ivy gets nothing, Libby only piano.
  const built = quietBuild(INDIVIDUAL_MEMBERS, GENROL, GW);
  assert("group char: buildMemberStates drops group enrolments (Ivy none, Libby piano only)",
    built.map(e => e.enrolmentId), ["e_liri_pno", "e_liri_gtr", "e_libby_pno", "e_noa_gtr"]);
  assert("group char: D15 snapshot — individuals-only band builds byte-identically",
    JSON.stringify(built), D15_SNAPSHOT);

  // 2. isAttributableCard rejects group cards — even an entry whose enrolmentId
  //    equals the card's own enrolmentId finds nothing.
  const ivyGroupShaped = { ...blank("e_ivy_uke", "ivy", "Ukulele"), consumption: "regular" };
  assert("group char: findMemberCards never returns a group card (isAttributableCard)",
    findMemberCards([groupCard(), soloCard("W_LP", "e_libby_pno", "Monday", "09:00")], ivyGroupShaped, r).map(c => c.id), []);
  assert("group char: an individual entry still finds its solo card beside the group card",
    findMemberCards([groupCard(), soloCard("W_LP", "e_libby_pno", "Monday", "09:00")], blank("e_libby_pno", "libby", "Piano"), r).map(c => c.id), ["W_LP"]);

  // 3. Tally: the group row is never band-matched — legacy or new.
  const legacy = tallyBand(null, [groupCard()], { members: [{ studentId: "ivy", instrument: "Ukulele" }] });
  assert("group char: Tally — legacy band never band-matches the group row",
    tallyView({ wttLessons: [legacy] })["group|g_uke"], "blank");
  const newBand = tallyBand([ivyGroupShaped], [groupCard()]);
  assert("group char: Tally — new band with a Regular group-shaped entry does not tick the group row",
    tallyView({ wttLessons: [newBand] })["group|g_uke"], "blank");

  // 4. eligibleForAbsence skips group cards: a Regular entry whose only ledger
  //    card is a group card is not offered Mark absent.
  assert("group char: eligibleForAbsence skips group ledger cards",
    eligibleForAbsence(newBand, []).map(e => e.enrolmentId), []);

  // 5. Removing a Regular individual from the roster (today's behaviour).
  //    The attribution stays as a departed row until the owner clears it;
  //    clearing + Save puts the ledgered card back.
  const libbyPiano = soloCard("W_LP", "e_libby_pno", "Monday", "09:00");
  const stored = [
    { ...blank("e_libby_pno", "libby", "Piano"), consumption: "regular", consumedWeekKey: GW },
    { ...blank("e_noa_gtr", "noa", "Guitar"), consumption: "free" },
  ];
  const band = { id: "B1", isBandSession: true, bandId: "RIPTIDE", day: "Thursday", start: "13:30", members: INDIVIDUAL_MEMBERS, memberStates: stored, removedLessons: [libbyPiano] };
  const fresh = quietBuild(INDIVIDUAL_MEMBERS.filter(m => m.studentId !== "libby"), GENROL, GW);
  const rec = reconcileMemberStates(stored, fresh);
  assert("group char: removed Regular individual is kept as departed, not dropped",
    [rec.departedEnrolmentIds, studentRows(rec.memberStates, rec.departedEnrolmentIds).find(x => x.studentId === "libby").departed], [["e_libby_pno"], true]);
  const untouched = planAttributionSave({ stored, working: rec.memberStates, missByEnrolment: {}, catchupsForBand: [], weekKey: GW });
  assert("group char: …without Clear, Save leaves her card in the ledger",
    [untouched.regularOff.length, untouched.regularOn.length], [0, 0]);
  const cleared = applyStudentAttribution(rec.memberStates, "libby", "e_libby_pno", null, null);
  const plan = planAttributionSave({ stored, working: cleared, missByEnrolment: {}, catchupsForBand: [], weekKey: GW });
  const out = applyAttributionLedger({ lessons: [band], bandLessonId: "B1", regularOn: plan.regularOn, regularOff: plan.regularOff, memberStates: plan.memberStates, resolver: r });
  assert("group char: …Clear + Save restores the card from the ledger",
    [out.lessons.find(l => l.id === "B1").removedLessons.map(c => c.id), out.lessons.filter(l => !l.isBandSession).map(l => l.id), out.dropped], [[], ["W_LP"], []]);
}

// ── Core (commit 2): building, matching and the shared group ledger card ──

// Riptide after Edit Band "Add group": Libby and Ivy carry the group marker.
export const GROUP_MEMBERS = [
  { id: "m1", studentId: "liri",  instrument: "Piano" },
  { id: "m2", studentId: "libby", instrument: "Ukulele", viaGroupId: "g_uke", groupName: "Ukulele Group" },
  { id: "m3", studentId: "ivy",   instrument: "Ukulele", viaGroupId: "g_uke", groupName: "Ukulele Group" },
  { id: "m4", studentId: "noa",   instrument: "Guitar" },
];
export const gentry = (enrolmentId, studentId, consumption = null, weekKey = GW) => ({
  ...blank(enrolmentId, studentId, "Ukulele"), consumption,
  consumedWeekKey: consumption === "regular" ? weekKey : null, groupId: "g_uke", isGroup: true,
});
const ids = (xs) => (xs || []).map(x => x.id);
const nonBand = (lessons) => ids(lessons.filter(l => !l.isBandSession));
const ledgerOf = (lessons, id = "B1") => ids(lessons.find(l => l.id === id).removedLessons);
const gband = (memberStates, removedLessons = [], extra = {}) => ({ id: "B1", isBandSession: true, bandId: "RIPTIDE", bandName: "Riptide",
  schoolId: "S", day: "Tuesday", start: "13:30", end: "13:30", members: GROUP_MEMBERS, memberStates, removedLessons, ...extra });
const BOTH_REG = [gentry("e_libby_uke", "libby", "regular"), gentry("e_ivy_uke", "ivy", "regular")];

export function runBandGroupCoreTests(assert) {
  const r = gresolver();
  const opts = { groups: [GROUP_UKE] };

  // D5 / D3 / D15 — building
  const built = quietBuild(GROUP_MEMBERS, GENROL, GW, opts);
  assert("group core: marker members get ONE group entry each, no solo entries (Libby has no piano entry)",
    built.map(e => [e.enrolmentId, e.isGroup || false]),
    [["e_liri_pno", false], ["e_liri_gtr", false], ["e_libby_uke", true], ["e_ivy_uke", true], ["e_noa_gtr", false]]);
  assert("group core: a group entry is the existing shape plus groupId and isGroup",
    built[2], gentry("e_libby_uke", "libby"));
  assert("group core: D15 — individuals-only band still builds byte-identically",
    JSON.stringify(quietBuild(INDIVIDUAL_MEMBERS, GENROL, GW, opts)), D15_SNAPSHOT);

  // D5 — resolution and its fallback
  const ivy = GROUP_MEMBERS[2];
  const noGid = (extra = {}) => ({ id: "e_ivy_nogid", studentId: "ivy", instrument: "ukulele", startDate: "2020-01-01", isGroup: true, ...extra });
  const otherE = GENROL.filter(e => e.id !== "e_ivy_uke");
  assert("group core: resolve by groupId",
    resolveGroupEnrolment(ivy, GENROL, GW, { group: GROUP_UKE }).id, "e_ivy_uke");
  assert("group core: fallback — one group row with no groupId and the group's instrument (any case)",
    (resolveGroupEnrolment(ivy, [...otherE, noGid()], GW, { group: GROUP_UKE }) || {}).id, "e_ivy_nogid");
  assert("group core: fallback refuses two candidates, another group's row, and an ended row",
    [resolveGroupEnrolment(ivy, [...otherE, noGid(), noGid({ id: "e_ivy_nogid2" })], GW, { group: GROUP_UKE }),
     resolveGroupEnrolment(ivy, [...otherE, noGid({ groupId: "g_other" })], GW, { group: GROUP_UKE }),
     resolveGroupEnrolment(ivy, [...otherE, noGid({ endDate: "2021-01-01" })], GW, { group: GROUP_UKE })],
    [null, null, null]);
  const unresolved = quietBuild(GROUP_MEMBERS, otherE, GW, opts);
  assert("group core: unresolved group member gets no entry (none invented)",
    unresolved.map(e => e.enrolmentId), ["e_liri_pno", "e_liri_gtr", "e_libby_uke", "e_noa_gtr"]);
  const uRow = attributionWindowRows(unresolved, [], GROUP_MEMBERS).find(x => x.kind === "group");
  assert("group core: …and the window's group row names her as unresolved",
    [uRow.groupName, uRow.studentIds, uRow.unresolvedStudentIds], ["Ukulele Group", ["libby", "ivy"], ["ivy"]]);

  // D6 — matching
  const card = groupCard();
  const libbyPiano = soloCard("W_LP", "e_libby_pno", "Thursday", "09:00");
  assert("group core: every group entry matches the one group card; never a solo card",
    [ids(findMemberCards([card, libbyPiano], BOTH_REG[0], r)), ids(findMemberCards([card, libbyPiano], BOTH_REG[1], r))], [["W_UKE"], ["W_UKE"]]);
  assert("group core: a group entry ignores another group's card and a merged catch-up",
    ids(findMemberCards([groupCard("W_X", { groupId: "g_other" }), groupCard("W_CU", { __isCatchup: true })], BOTH_REG[0], r)), []);

  // D7 — the ledger holds the shared card once
  const lessons = [gband(BOTH_REG), card, libbyPiano];
  const disp = applyRegularDisplacement(lessons, BOTH_REG, [], r);
  assert("group core: group Regular ledgers the card ONCE; Libby's piano untouched",
    [ids(disp.removedLessons), nonBand(disp.lessons)], [["W_UKE"], ["W_LP"]]);
  const stored = BOTH_REG.map(e => ({ ...e, consumption: null, consumedWeekKey: null }));
  const on = planAttributionSave({ stored, working: BOTH_REG, missByEnrolment: {}, catchupsForBand: [], weekKey: GW });
  const onOut = applyAttributionLedger({ lessons: [gband(stored), card, libbyPiano], bandLessonId: "B1", regularOn: on.regularOn, regularOff: on.regularOff, memberStates: on.memberStates, resolver: r });
  assert("group core: Save — whole group becomes Regular → card into the ledger once",
    [ledgerOf(onOut.lessons), nonBand(onOut.lessons), on.inserts.length], [["W_UKE"], ["W_LP"], 0]);

  const ledgered = [gband(BOTH_REG, [card]), libbyPiano];
  const partial = applyAttributionLedger({ lessons: ledgered, bandLessonId: "B1", regularOn: [], regularOff: [BOTH_REG[1]],
    memberStates: [BOTH_REG[0], gentry("e_ivy_uke", "ivy", "free")], resolver: r });
  assert("group core: partial state never restores early (one member still Regular)",
    [ledgerOf(partial.lessons), nonBand(partial.lessons)], [["W_UKE"], ["W_LP"]]);

  // Without the guard the sweep would hide an early restore — except when the
  // card's slot is taken: then it would be reported and LOST. The guard keeps it.
  const blocker = { id: "W_BLOCK", enrolmentId: "e_noa_gtr", studentId: "noa", instrument: "Guitar", schoolId: "S", day: "Thursday", start: "10:00" };
  const partialTaken = applyAttributionLedger({ lessons: [...ledgered, blocker], bandLessonId: "B1", regularOn: [], regularOff: [BOTH_REG[1]],
    memberStates: [BOTH_REG[0], gentry("e_ivy_uke", "ivy", "free")], resolver: r });
  assert("group core: partial state with the slot taken — card stays in the ledger, nothing reported",
    [ledgerOf(partialTaken.lessons), partialTaken.dropped], [["W_UKE"], []]);

  for (const c of ["free", "not_in_session"]) {
    const working = applyGroupAttribution(BOTH_REG, "g_uke", c, GW);
    const plan = planAttributionSave({ stored: BOTH_REG, working, missByEnrolment: {}, catchupsForBand: [], weekKey: GW });
    const out = applyAttributionLedger({ lessons: ledgered, bandLessonId: "B1", regularOn: plan.regularOn, regularOff: plan.regularOff, memberStates: plan.memberStates, resolver: r });
    assert(`group core: whole group → ${c} restores the card ONCE`,
      [ledgerOf(out.lessons), nonBand(out.lessons), out.dropped, plan.memberStates.map(e => [e.consumption, e.consumedWeekKey])],
      [[], ["W_LP", "W_UKE"], [], [[c, null], [c, null]]]);
  }
  const taken = { id: "W_OTHER", enrolmentId: "e_noa_gtr", studentId: "noa", instrument: "Guitar", schoolId: "S", day: "Thursday", start: "10:00" };
  const freeAll = applyGroupAttribution(BOTH_REG, "g_uke", "free", GW);
  const takenOut = applyAttributionLedger({ lessons: [...ledgered, taken], bandLessonId: "B1", regularOn: [], regularOff: BOTH_REG,
    memberStates: freeAll, resolver: r });
  assert("group core: slot taken → group card reported once, left off the grid and out of the ledger",
    [ledgerOf(takenOut.lessons), nonBand(takenOut.lessons), ids(takenOut.dropped)], [[], ["W_LP", "W_OTHER"], ["W_UKE"]]);
  assert("group core: the notice names the group, not its first member",
    restoreDropNotice(takenOut.dropped, c => restoreCardName(c, () => "Ivy")),
    "Couldn't put back Ukulele Group's lesson (Thursday 10:00) — that slot is taken. Re-add it from the Master Timetable if needed.");
  assert("group core: restoreCardName leaves solo cards to firstNameOf",
    restoreCardName(libbyPiano, () => "Libby"), "Libby");

  // D7 / D14 — sweep, regenerate, import, remove, clean import, leftover tray
  assert("group core: repair sweep counts one group card for two entries as consistent (same array)",
    sweepRegularIntoLedger(ledgered, "B1", r) === ledgered, true);
  const notYet = [gband(BOTH_REG), card, libbyPiano];
  assert("group core: repair sweep ledgers an un-ledgered group card once",
    [ledgerOf(sweepRegularIntoLedger(notYet, "B1", r)), nonBand(sweepRegularIntoLedger(notYet, "B1", r))], [["W_UKE"], ["W_LP"]]);

  const master = [{ ...groupCard("M_UKE") }, soloCard("M_LP", "e_libby_pno", "Thursday", "09:00")];
  const generate = (bands) => displaceRegularIntoBands([...bands, ...master.filter(m => !isGenerateExcluded(m, bands, r)).map(m => ({ ...m, id: "G_" + m.id }))], r);
  const regen = generate([gband(BOTH_REG, [card])]);
  assert("group core: regenerate with the card ledgered → no second copy",
    [ledgerOf(regen), nonBand(regen)], [["W_UKE"], ["G_M_LP"]]);
  const regen2 = generate([gband(BOTH_REG)]);
  assert("group core: regenerate with nothing ledgered → generated then ledgered once",
    [ledgerOf(regen2), nonBand(regen2)], [["G_M_UKE"], ["G_M_LP"]]);
  assert("group core: regenerating again is stable",
    [ledgerOf(generate([regen2[0]])), nonBand(generate([regen2[0]]))], [["G_M_UKE"], ["G_M_LP"]]);
  const freeBand = gband(applyGroupAttribution(BOTH_REG, "g_uke", "free", GW));
  assert("group core: a Free / not-set group is never excluded from generate",
    [isGenerateExcluded(master[0], [freeBand], r), isGenerateExcluded(master[0], [gband(stored)], r)], [false, false]);
  assert("group core: isExcludedByBands (new band) excludes the group master card for a Regular group",
    [isExcludedByBands(master[0], [gband(BOTH_REG)], r), isExcludedByBands(master[1], [gband(BOTH_REG)], r)], [true, false]);
  assert("group core: withoutLedgeredDuplicates drops only the ledgered group card",
    ids(withoutLedgeredDuplicates(master, [gband(BOTH_REG, [card])], r)), ["M_LP"]);

  const imp = (bandLedger) => buildMttImportForWeekSchool({ mtt: { lessons: master }, schoolId: "S", weekDates: lweekDates(GW),
    existingEntry: { lessons: [gband(BOTH_REG, bandLedger)], missed: [] }, targetDay: "Thursday", enrolments: GENROL, dropBands: true, catchups: [] });
  const i1 = imp([card]);
  assert("group core: Thursday import with the card ledgered → not re-added",
    [ledgerOf(i1.entry.lessons), i1.entry.lessons.filter(l => !l.isBandSession).map(l => l.groupId || l.enrolmentId)], [["W_UKE"], ["e_libby_pno"]]);
  const i2 = imp([]);
  assert("group core: Thursday import with nothing ledgered → imported then ledgered once",
    [ledgerOf(i2.entry.lessons).length, i2.entry.lessons.filter(l => !l.isBandSession).map(l => l.groupId || l.enrolmentId)], [1, ["e_libby_pno"]]);

  const rm = planRemoveBandSession({ lessons: [gband(BOTH_REG, [card]), libbyPiano], missed: [] }, "B1");
  assert("group core: Remove band session puts the group card back once",
    [ids(rm.lessons), rm.dropped], [["W_LP", "W_UKE"], []]);
  const clean = planCleanImport({ lessons: [gband(BOTH_REG, [card]), libbyPiano], missed: [] }, [], { day: "Tuesday", weekKey: GW, schoolId: "S" });
  assert("group core: clean day import of the band's day hands the other-day group card back once",
    [ids(clean.restoreCards), clean.removedBandIds], [["W_UKE"], ["B1"]]);
  const cleanWeek = planCleanImport({ lessons: [gband(BOTH_REG, [card]), libbyPiano], missed: [] }, [], { weekKey: GW, schoolId: "S" });
  assert("group core: clean whole-week import rebuilds from the master (nothing handed back)",
    cleanWeek.restoreCards, []);

  const tray = applyRegularDisplacement([gband(BOTH_REG), card, libbyPiano], BOTH_REG, [], r);
  assert("group core: placing from a leftover tray re-ledgers the group card once",
    [ids(tray.removedLessons), nonBand(tray.lessons)], [["W_UKE"], ["W_LP"]]);

  // D12 — absence stays unsupported for group entries
  assert("group core: eligibleForAbsence never offers a group entry",
    eligibleForAbsence(gband(BOTH_REG, [card]), []).map(e => e.enrolmentId), []);
}

// ── D8: roster transitions ──
export function runBandGroupRosterTests(assert) {
  const r = gresolver();
  const opts = { groups: [GROUP_UKE] };
  const card = groupCard();
  const libbyPiano = soloCard("W_LP", "e_libby_pno", "Monday", "09:00");

  // Individual converted to group while Regular (today's Riptide).
  const stored = [
    { ...blank("e_liri_pno", "liri", "Piano"), consumption: "regular", consumedWeekKey: GW },
    blank("e_liri_gtr", "liri", "Guitar"),
    { ...blank("e_libby_pno", "libby", "Piano"), consumption: "regular", consumedWeekKey: GW },
    { ...blank("e_noa_gtr", "noa", "Guitar"), consumption: "regular", consumedWeekKey: GW },
  ];
  const band = gband(stored, [libbyPiano]);
  const fresh = quietBuild(GROUP_MEMBERS, GENROL, GW, opts);
  const rec = reconcileMemberStates(stored, fresh);
  assert("group roster: individual → group keeps the old Regular as departed and adds the group entries",
    [rec.memberStates.map(e => e.enrolmentId), rec.departedEnrolmentIds],
    [["e_liri_pno", "e_liri_gtr", "e_libby_pno", "e_noa_gtr", "e_libby_uke", "e_ivy_uke"], ["e_libby_pno"]]);
  const rows = attributionWindowRows(rec.memberStates, rec.departedEnrolmentIds, GROUP_MEMBERS);
  assert("group roster: window shows Liri, Libby (departed piano), Noa, then ONE group row",
    rows.map(x => [x.key, x.departed]), [["liri", false], ["libby", true], ["noa", false], ["group:g_uke", false]]);
  const working = applyGroupAttribution(rec.memberStates, "g_uke", "regular", GW, rec.departedEnrolmentIds);
  assert("group roster: setting the group clears Libby's leftover piano role (one role per student)",
    working.map(e => [e.enrolmentId, e.consumption]),
    [["e_liri_pno", "regular"], ["e_liri_gtr", null], ["e_libby_pno", null], ["e_noa_gtr", "regular"], ["e_libby_uke", "regular"], ["e_ivy_uke", "regular"]]);
  assert("group roster: …and her leftover row disappears from the window",
    attributionWindowRows(working, rec.departedEnrolmentIds, GROUP_MEMBERS).map(x => x.key), ["liri", "noa", "group:g_uke"]);
  const plan = planAttributionSave({ stored, working, missByEnrolment: {}, catchupsForBand: [], weekKey: GW });
  const out = applyAttributionLedger({ lessons: [band, card], bandLessonId: "B1", regularOn: plan.regularOn, regularOff: plan.regularOff, memberStates: plan.memberStates, resolver: r });
  assert("group roster: Save — piano card back, group card into the ledger",
    [ledgerOf(out.lessons), nonBand(out.lessons), out.dropped], [["W_UKE"], ["W_LP"], []]);

  // Group removed while Regular → one departed group row; Clear restores once.
  const gStored = [...stored.filter(e => e.studentId !== "libby"), ...BOTH_REG];
  const gRec = reconcileMemberStates(gStored, quietBuild(INDIVIDUAL_MEMBERS.filter(m => m.studentId !== "libby" && m.studentId !== "ivy"), GENROL, GW, opts));
  const gRows = attributionWindowRows(gRec.memberStates, gRec.departedEnrolmentIds, INDIVIDUAL_MEMBERS.filter(m => m.studentId !== "libby" && m.studentId !== "ivy"));
  const gr = gRows.find(x => x.kind === "group");
  assert("group roster: group removed → one departed group row, still Regular",
    [gRows.filter(x => x.kind === "group").length, gr.departed, gr.consumption, gr.studentIds], [1, true, "regular", ["libby", "ivy"]]);
  const gCleared = applyGroupAttribution(gRec.memberStates, "g_uke", null, GW, gRec.departedEnrolmentIds);
  const gPlan = planAttributionSave({ stored: gStored, working: gCleared, missByEnrolment: {}, catchupsForBand: [], weekKey: GW });
  const gOut = applyAttributionLedger({ lessons: [gband(gStored, [card])], bandLessonId: "B1", regularOn: gPlan.regularOn, regularOff: gPlan.regularOff, memberStates: gPlan.memberStates, resolver: r });
  assert("group roster: …Clear + Save puts the group card back once",
    [ledgerOf(gOut.lessons), nonBand(gOut.lessons)], [[], ["W_UKE"]]);

  // Only the D2 roles are accepted for a group.
  assert("group roster: catch-up / forward / billed are refused for a group (input returned)",
    ["catchup", "forward", "billed"].map(c => applyGroupAttribution(BOTH_REG, "g_uke", c, GW) === BOTH_REG), [true, true, true]);
}
