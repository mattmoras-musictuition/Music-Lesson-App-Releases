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
} from "./bandMemberStates";
import { eligibleForAbsence } from "./bandAbsence";
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
