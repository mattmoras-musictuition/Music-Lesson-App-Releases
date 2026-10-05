// ============================================================
// BAND REGULAR ABSENCE SMOKE TESTS
// Two "Mark absent ▸" gaps on a band session (owner live checks, 5 Oct 2026):
//   Gap 1 — a Regular member whose band holds no card for them (their card
//           never reached the ledger, e.g. after a "could not be put back")
//           is not offered;
//   Gap 2 — a Regular GROUP is never offered (no whole-group absence).
// Plus the regenerate duplicate: regenerating a week after a Regular band
// absence leaves a second copy of the lesson in the band's ledger.
//
// The characterization block pins today's behaviour before any change. The
// protected modules (bandSessionView.js, bandAbsence.js, bandMemberStates.js)
// never change; the admin side wraps them.
// ============================================================

import { eligibleForAbsence, absentMembers, planMarkAbsent, planUndoAbsence, planRemoveBandSession, carryBandMisses } from "./bandAbsence";
import { sessionMemberRows } from "./bandSessionView";
import { planAttributionSave, applyAttributionLedger, applyStudentAttribution, displaceRegularIntoBands } from "./bandMemberStates";
import { generateMasterLessons } from "./bandForward";
import { adminAbsenceMenu } from "./bandForwardAbsence";
import { EB, EENROL, EMASTER, ESTUDENTS, eentry, eband, ecard, eresolver, egenerate } from "./bandForwardEnforceSmokeTests";
import { withoutBandAbsentCards, regularAbsenceSubjects, regularAbsentSubjects, regularSubjectKeyForMiss, regularNoCardNote, planRegularAbsence, planRegularAbsenceUndo,
  withoutMarkedCards, originRestoresFor, restoreOriginCards, adminRemoveBandSession, adminBandRemovalAbsences, isMarkedBandMiss } from "./bandRegularAbsence";
import { enrolmentIdFor } from "../utils/enrolmentsDB";
import { buildMttImportForWeekSchool } from "../utils/mttImport";
import { lweekDates } from "./bandLedgerSmokeTests";
import { adminAbsentEnrolmentIds, adminMemberAbsenceInfo, adminSessionMemberRows, adminBandCardStatus, adminParentEmailStudentIds,
  absenceItemLabel } from "./bandForwardAbsence";
import { bandPopoverGroups } from "./bandDisplay";
import { bandStudentFirstNames } from "./exportHelpers";
import { getGroupTermDeductionMath, getEnrolmentTermDeductionMath, getOpenCatchupRows } from "../utils/tallyDerive";
import { FB, fstudent, fenrol, fentry, fband, ftally, FWEEKS } from "./bandForwardSmokeTests";
import { GW, GENROL as GENROL_FOR_LIRI, gresolver, soloCard } from "./bandGroupSmokeTests";

// A whole-group band miss as a Regular group absence would write it.
export const groupBandMiss = (bandId, card, extra = {}) => {
  const { teacherId, ...rest } = card;
  return { ...rest, enrolmentId: "e_ivy_uke", reason: "informed_absence", reasonDetail: "", notes: "", makeupEligible: true, madeUp: false,
    cardNote: "", bandLessonId: bandId, ...(teacherId ? { ledgerTeacherId: teacherId } : {}), ledgerCard: card, ...extra };
};

// Regenerate one school's week the way the generate paths do: master filter
// (since commit 6 including withoutBandAbsentCards), generator, then the band
// sweep and the band-miss carry.
export function regenerate(entry, schoolId, weekKey, filter = (cards) => withoutBandAbsentCards(cards, [entry])) {
  const bands = (entry.lessons || []).filter(l => l.isBandSession);
  const master = filter(generateMasterLessons(EMASTER.filter(l => l.schoolId === schoolId), bands, eresolver(), weekKey, null));
  const result = egenerate(master, schoolId, weekKey);
  const lessons = displaceRegularIntoBands([...bands, ...result.lessons], eresolver());
  return { lessons, missed: carryBandMisses(result.missed, entry.missed, lessons) };
}

// ── Commit 1: characterization — pinned against unchanged code ──
export function runRegularAbsenceCharacterizationTests(assert) {
  // Gap 1 — Liri switches "counts against" from Guitar to Piano while her
  // Piano card is not in the week (lost earlier: "could not be put back").
  const r = gresolver();
  const gtr = soloCard("W_GTR", "e_liri_gtr", "Thursday", "09:00");
  const stored = [
    { enrolmentId: "e_liri_pno", studentId: "liri", instrument: "Piano", consumption: null, catchupId: null, consumedWeekKey: null, fee: null, attended: null, writerTeacherId: null },
    { enrolmentId: "e_liri_gtr", studentId: "liri", instrument: "Guitar", consumption: "regular", catchupId: null, consumedWeekKey: GW, fee: null, attended: null, writerTeacherId: null },
  ];
  const band = { id: "B1", isBandSession: true, bandName: "Riptide", schoolId: "S", day: "Thursday", start: "13:30", members: [], memberStates: stored, removedLessons: [gtr] };
  const working = applyStudentAttribution(stored, "liri", "e_liri_pno", "regular", GW);
  const plan = planAttributionSave({ stored, working, missByEnrolment: {}, catchupsForBand: [], weekKey: GW });
  const out = applyAttributionLedger({ lessons: [band], bandLessonId: "B1", regularOn: plan.regularOn, regularOff: plan.regularOff, memberStates: plan.memberStates, resolver: r });
  const saved = out.lessons.find(l => l.id === "B1");
  assert("reg-abs char: counts-against Guitar → Piano with no Piano card — Guitar returns, the band holds nothing, no notice",
    [out.lessons.filter(l => !l.isBandSession).map(l => l.id), saved.removedLessons, out.dropped, saved.memberStates.map(e => [e.instrument, e.consumption])],
    [["W_GTR"], [], [], [["Piano", "regular"], ["Guitar", null]]]);
  assert("reg-abs char: …and she is no longer offered Mark absent (protected gate and admin menu)",
    [eligibleForAbsence(saved, []).length, adminAbsenceMenu(saved, []).eligible.length], [0, 0]);

  // Gap 2 — a Regular group with its card held is never offered.
  const uke = ecard("M_uke", "W_uke");
  const gBand = eband("B1", [eentry("e_libby_uke", "regular", { consumedWeekKey: EB }), eentry("e_ivy_uke", "regular", { consumedWeekKey: EB })], { removedLessons: [uke] });
  assert("reg-abs char: a Regular group with its card held is not offered (protected gate and admin menu)",
    [eligibleForAbsence(gBand, []).length, adminAbsenceMenu(gBand, []).eligible.length], [0, 0]);

  // The protected view sees ONE child of a whole-group band miss.
  const gMissed = [groupBandMiss("B1", uke)];
  const gView = { ...gBand, removedLessons: [], members: [{ studentId: "libby", instrument: "Ukulele" }, { studentId: "ivy", instrument: "Ukulele" }] };
  assert("reg-abs char: protected session view marks only the child named on the group miss absent",
    sessionMemberRows(gView, gMissed).map(row => row.studentId + ":" + row.status), ["libby:attending", "ivy:absent"]);
  assert("reg-abs char: protected absentMembers offers Undo under that one child",
    absentMembers(gView, gMissed).map(e => e.enrolmentId), ["e_ivy_uke"]);

  // Regenerate duplicate — Amy (Regular, card held) is marked absent, then the
  // week is regenerated. Commit 6 deliberately changed the next two pins
  // (the generate paths now skip a lesson a band absence holds).
  const amyCard = ecard("M_amy", "W_amy", { weekDate: "2099-03-12" });
  const aBand = eband("B1", [eentry("e_amy_gtr", "regular", { consumedWeekKey: EB })], { removedLessons: [amyCard] });
  const p = planMarkAbsent({ band: aBand, entry: aBand.memberStates[0], missed: [], enrolments: EENROL });
  const before = { lessons: [p.band], missed: p.misses };
  const regen = regenerate(before, "S", EB);
  const regenBand = regen.lessons.find(l => l.id === "B1");
  const undone = planUndoAbsence({ band: regenBand, entry: regenBand.memberStates[0], missed: regen.missed, catchups: [] });
  assert("reg-abs char: regenerate after a Regular absence → the card is not rebuilt; Undo → one ledger copy (was 1 swept + 2 after Undo)",
    [regenBand.removedLessons.length, regen.missed.filter(m => m.bandLessonId === "B1").length, undone.band.removedLessons.length], [0, 1, 1]);
  const removed = planRemoveBandSession({ lessons: regen.lessons, missed: regen.missed }, "B1");
  assert("reg-abs char: …and removing the band puts exactly one card back, nothing dropped (was 1 dropped: \"Couldn't put back\")",
    [removed.lessons.filter(l => l.enrolmentId === "e_amy_gtr").length, removed.dropped.length], [1, 0]);
}

// ── Commit 2: the planners (bandRegularAbsence.js) ──
export const RS = EB + "|S";
export const RT = EB + "|T";
export const AT = "2099-03-09T10:00:00.000Z";
export const OWED = { reason: "informed_absence", reasonDetail: "sick", notes: "", makeupEligible: true };
export const NOT_OWED = { reason: "uninformed_absence", reasonDetail: "", notes: "", makeupEligible: false };
export const amyReg = () => eentry("e_amy_gtr", "regular", { consumedWeekKey: EB });
export const groupReg = () => [eentry("e_libby_uke", "regular", { consumedWeekKey: EB }), eentry("e_ivy_uke", "regular", { consumedWeekKey: EB })];
export const ctxOf = (wtt, extra = {}) => ({ rowKey: RS, weeklyTimetables: wtt, masterLessons: EMASTER, enrolments: EENROL, resolver: eresolver(), ...extra });
export const planArgs = (wtt, subjectKey, absence = OWED, extra = {}) => ({ weeklyTimetables: wtt, rowKey: RS, bandLessonId: "B1", subjectKey, absence,
  masterLessons: EMASTER, enrolments: EENROL, resolver: eresolver(), at: AT, newId: () => "NEW", ...extra });
const kinds = (band, wtt, extra) => regularAbsenceSubjects(band, ctxOf(wtt, extra)).map(x => [x.key, x.kind, x.offered]);

export function runRegularAbsencePlannerTests(assert) {
  const amyCard = ecard("M_amy", "W_amy", { weekDate: "2099-03-12" });
  const other = ecard("M_amy", "W_zed", { enrolmentId: "e_zed", studentId: "zed", instrument: "Bass", start: "11:00" });
  const bandA = (removedLessons = []) => eband("B1", [amyReg()], { removedLessons });
  const row = (lessons, missed = []) => ({ lessons, missed, generatedAt: "x" });

  // ── Gap 1: classification ──
  let wtt = { [RS]: row([bandA()]) };
  assert("reg-abs subjects: no card anywhere, master card exists → offered, built from the master",
    kinds(bandA(), wtt), [["regular:enrolment:e_amy_gtr", "master", true]]);
  assert("reg-abs subjects: a held solo card is left to the protected gate",
    kinds(bandA([amyCard]), { [RS]: row([bandA([amyCard])]) }), []);
  assert("reg-abs subjects: card in the band's own row → sweep; in another school's row → elsewhere",
    [kinds(bandA(), { [RS]: row([bandA(), amyCard]) }), kinds(bandA(), { [RS]: row([bandA()]), [RT]: row([amyCard]) })],
    [[["regular:enrolment:e_amy_gtr", "sweep", true]], [["regular:enrolment:e_amy_gtr", "elsewhere", true]]]);
  const anyMiss = { id: "OM", enrolmentId: "e_amy_gtr", studentId: "amy", instrument: "Guitar", day: "Thursday", reason: "sick", makeupEligible: true };
  assert("reg-abs subjects: a miss already recorded that week (any row) → not offered",
    [kinds(bandA(), { [RS]: row([bandA()], [anyMiss]) }), kinds(bandA(), { [RS]: row([bandA()]), [RT]: row([], [anyMiss]) })],
    [[["regular:enrolment:e_amy_gtr", "missed", false]], [["regular:enrolment:e_amy_gtr", "missed", false]]]);
  assert("reg-abs subjects: enrolment not active that week → not offered",
    kinds(bandA(), wtt, { enrolments: EENROL.map(e => (e.id === "e_amy_gtr" ? { ...e, endDate: "2099-03-01" } : e)) }), [["regular:enrolment:e_amy_gtr", "inactive", false]]);
  assert("reg-abs subjects (decision b): no master lesson → not offered",
    kinds(bandA(), wtt, { masterLessons: [] }), [["regular:enrolment:e_amy_gtr", "no_master", false]]);
  const closure = [{ type: "public_holiday", schoolId: "all", date: "2099-03-12", affectsClasses: "all" }];
  assert("reg-abs subjects (decision a): a closed lesson day does not change the offer (the band stood in)",
    kinds(bandA(), wtt, { interruptions: closure }), [["regular:enrolment:e_amy_gtr", "master", true]]);
  assert("reg-abs note: no master → why it can't be marked absent; otherwise the plain flag; held → none",
    [regularNoCardNote({ kind: "no_master", instrument: "Piano" }, "Liri"), regularNoCardNote({ kind: "master", instrument: "Piano" }, "Liri"),
      regularNoCardNote({ kind: "master", groupId: "g" }, "Ivy, Libby"), regularNoCardNote({ kind: "held" }, "x")],
    ["No Piano lesson on the master timetable for Liri — can't be marked absent", "The band holds no Piano lesson for Liri this week",
      "The band holds no group lesson for Ivy, Libby this week", ""]);

  // ── Gap 1: Save ──
  let p = planRegularAbsence(planArgs(wtt, "regular:enrolment:e_amy_gtr"));
  let miss = p.rows[RS].missed[0];
  assert("reg-abs save (master): one miss built from the master card — planMarkAbsent's shape, bandNoCard, no ledgerCard",
    [p.kind, miss.id, miss.enrolmentId, miss.day, miss.start, miss.weekDate, miss.adjusted, miss.bandLessonId, miss.bandNoCard, "ledgerCard" in miss,
      "teacherId" in miss, miss.ledgerTeacherId, miss.reason, miss.makeupEligible, miss.madeUp],
    ["master", "NEW", "e_amy_gtr", "Thursday", "09:00", "2099-03-12", false, "B1", true, false, false, "t1", "informed_absence", true, false]);
  let saved = p.rows[RS].lessons.find(l => l.id === "B1");
  assert("reg-abs save (master): nothing enters the ledger; the entry is stamped as an admin action",
    [saved.removedLessons, saved.memberStates[0].adminOverrideAt, saved.memberStates[0].writerTeacherId], [[], AT, null]);
  assert("reg-abs save: an unknown or not-offered subject plans nothing",
    [planRegularAbsence(planArgs(wtt, "regular:enrolment:nope")), planRegularAbsence(planArgs(wtt, "regular:enrolment:e_amy_gtr", OWED, { masterLessons: [] }))], [null, null]);
  let after = { ...wtt, ...p.rows };
  assert("reg-abs save (master): now absent through this module, and offered no more",
    [regularAbsentSubjects(saved, after[RS].missed).map(x => x.key), kinds(saved, after)], [["regular:enrolment:e_amy_gtr"], []]);
  assert("reg-abs: the marked miss's subject key; a held-card miss stays with the protected path",
    [regularSubjectKeyForMiss(saved, miss), regularSubjectKeyForMiss(saved, { ...miss, bandNoCard: undefined, ledgerCard: amyCard }), isMarkedBandMiss(miss)],
    ["regular:enrolment:e_amy_gtr", null, true]);
  let u = planRegularAbsenceUndo({ weeklyTimetables: after, rowKey: RS, bandLessonId: "B1", subjectKey: "regular:enrolment:e_amy_gtr", at: AT });
  assert("reg-abs undo (master): the miss goes and NOTHING is added to the ledger or the grid",
    [u.rows[RS].missed, u.rows[RS].lessons.map(l => l.id), u.rows[RS].lessons[0].removedLessons, u.dropped], [[], ["B1"], [], []]);

  // Sweep: the card is in the band's row → swept, then the normal held-card absence.
  wtt = { [RS]: row([bandA(), amyCard, other]) };
  p = planRegularAbsence(planArgs(wtt, "regular:enrolment:e_amy_gtr"));
  miss = p.rows[RS].missed[0];
  const ref = planMarkAbsent({ band: bandA([amyCard]), entry: amyReg(), missed: [], enrolments: EENROL }).misses[0];
  assert("reg-abs save (sweep): the card leaves the grid into the miss; the miss equals planMarkAbsent's (plus the reason)",
    [p.kind, p.rows[RS].lessons.map(l => l.id), p.rows[RS].lessons[0].removedLessons, miss],
    ["sweep", ["B1", "W_zed"], [], { ...ref, reason: "informed_absence", reasonDetail: "sick", makeupEligible: true }]);
  assert("reg-abs save (sweep): a held-card miss is the protected path's (no subject key)",
    regularSubjectKeyForMiss(p.rows[RS].lessons[0], miss), null);

  // Elsewhere: the card is in school T's row → taken from there, returned there.
  wtt = { [RS]: row([bandA()]), [RT]: row([amyCard]) };
  p = planRegularAbsence(planArgs(wtt, "regular:enrolment:e_amy_gtr", NOT_OWED));
  miss = p.rows[RS].missed[0];
  assert("reg-abs save (elsewhere): the card leaves school T's row; the miss remembers where it came from",
    [p.kind, p.rows[RT].lessons, miss.id, miss.bandCardRow, miss.originCard.id, "ledgerCard" in miss, miss.makeupEligible], ["elsewhere", [], "W_amy", RT, "W_amy", false, false]);
  after = { ...wtt, ...p.rows };
  u = planRegularAbsenceUndo({ weeklyTimetables: after, rowKey: RS, bandLessonId: "B1", subjectKey: "regular:enrolment:e_amy_gtr", at: AT });
  assert("reg-abs undo (elsewhere): the card goes back to school T's row, not into the ledger",
    [u.rows[RT].lessons.map(l => l.id), u.rows[RS].lessons[0].removedLessons, u.rows[RS].missed, u.dropped], [["W_amy"], [], [], []]);
  const taken = { ...after, [RT]: row([ecard("M_amy", "W_other", { enrolmentId: "e_x", studentId: "x", instrument: "Cello" })]) };
  u = planRegularAbsenceUndo({ weeklyTimetables: taken, rowKey: RS, bandLessonId: "B1", subjectKey: "regular:enrolment:e_amy_gtr", at: AT });
  assert("reg-abs undo (elsewhere): slot taken → reported, not doubled",
    [u.rows[RT].lessons.map(l => l.id), u.dropped.map(c => c.id)], [["W_other"], ["W_amy"]]);

  // The live case: Liri's counts-against moved to Piano with no Piano card in the week.
  const liri = [
    { enrolmentId: "e_liri_pno", studentId: "liri", instrument: "Piano", consumption: "regular", catchupId: null, consumedWeekKey: GW, fee: null, attended: null, writerTeacherId: null },
    { enrolmentId: "e_liri_gtr", studentId: "liri", instrument: "Guitar", consumption: null, catchupId: null, consumedWeekKey: null, fee: null, attended: null, writerTeacherId: null },
  ];
  const liriBand = { id: "B1", isBandSession: true, bandName: "Riptide", schoolId: "S", day: "Thursday", start: "13:30", members: [], memberStates: liri, removedLessons: [] };
  const liriMaster = [soloCard("M_PNO", "e_liri_pno", "Monday", "09:00"), soloCard("M_GTR", "e_liri_gtr", "Thursday", "09:00")];
  const liriWtt = { [GW + "|S"]: row([liriBand, soloCard("W_GTR", "e_liri_gtr", "Thursday", "09:00")]) };
  assert("reg-abs (Liri): counts against Piano, no Piano card → offered, built from her Piano master lesson",
    regularAbsenceSubjects(liriBand, { rowKey: GW + "|S", weeklyTimetables: liriWtt, masterLessons: liriMaster, enrolments: GENROL_FOR_LIRI, resolver: gresolver() })
      .map(x => [x.key, x.kind, x.card && x.card.id]), [["regular:enrolment:e_liri_pno", "master", "M_PNO"]]);

  // ── Gap 2: the Regular group ──
  const uke = ecard("M_uke", "W_uke");
  const bandG = (removedLessons = [uke]) => eband("B1", groupReg(), { removedLessons });
  wtt = { [RS]: row([bandG()]) };
  assert("reg-abs group: a Regular group with its card held → one subject, offered",
    regularAbsenceSubjects(bandG(), ctxOf(wtt)).map(x => [x.key, x.kind, x.offered, x.studentIds]), [["regular:group:g_uke", "held", true, ["libby", "ivy"]]]);
  p = planRegularAbsence(planArgs(wtt, "regular:group:g_uke"));
  miss = p.rows[RS].missed[0];
  saved = p.rows[RS].lessons[0];
  assert("reg-abs group save: the group card leaves the ledger as ONE whole-group miss with its ledgerCard",
    [p.rows[RS].missed.length, miss.isGroup, miss.groupId, miss.id, miss.ledgerCard.id, miss.bandLessonId, miss.enrolmentId, saved.removedLessons],
    [1, true, "g_uke", "W_uke", "W_uke", "B1", enrolmentIdFor("ivy", "Ukulele", EENROL, "g_uke"), []]);
  assert("reg-abs group save: every group entry stamped; owed and not owed both recorded",
    [saved.memberStates.map(e => e.adminOverrideAt), planRegularAbsence(planArgs(wtt, "regular:group:g_uke", NOT_OWED)).rows[RS].missed[0].makeupEligible, miss.makeupEligible],
    [[AT, AT], false, true]);
  after = { ...wtt, ...p.rows };
  assert("reg-abs group: absent → listed once for Undo; its miss maps to the group key",
    [regularAbsentSubjects(saved, after[RS].missed).map(x => x.key), regularSubjectKeyForMiss(saved, miss), regularAbsenceSubjects(saved, ctxOf(after)).length],
    [["regular:group:g_uke"], "regular:group:g_uke", 0]);
  u = planRegularAbsenceUndo({ weeklyTimetables: after, rowKey: RS, bandLessonId: "B1", subjectKey: "regular:group:g_uke", at: AT });
  assert("reg-abs group undo: the group card is back in the ledger, the miss gone",
    [u.rows[RS].lessons[0].removedLessons.map(c => c.id), u.rows[RS].missed], [["W_uke"], []]);
  // No held group card: built from the group's master card.
  wtt = { [RS]: row([bandG([])]) };
  p = planRegularAbsence(planArgs(wtt, "regular:group:g_uke"));
  miss = p.rows[RS].missed[0];
  assert("reg-abs group (no held card): built from the group's master card, bandNoCard",
    [p.kind, miss.isGroup, miss.groupId, miss.bandNoCard, miss.start], ["master", true, "g_uke", true, "10:00"]);
  assert("reg-abs group (no held card, card in the row): swept first",
    regularAbsenceSubjects(bandG([]), ctxOf({ [RS]: row([bandG([]), uke]) })).map(x => x.kind), ["sweep"]);

  // ── Removal and restore helpers ──
  const noCard = planRegularAbsence(planArgs({ [RS]: row([bandA()]) }, "regular:enrolment:e_amy_gtr")).rows[RS];
  let rm = adminRemoveBandSession(noCard, "B1");
  assert("reg-abs remove band: a built (bandNoCard) card is not put on the grid; the miss goes",
    [rm.lessons.map(l => l.id), rm.missed, rm.dropped, rm.originRestores], [[], [], [], []]);
  const fromT = planRegularAbsence(planArgs({ [RS]: row([bandA()]), [RT]: row([amyCard]) }, "regular:enrolment:e_amy_gtr")).rows;
  rm = adminRemoveBandSession(fromT[RS], "B1");
  const back = restoreOriginCards({ [RT]: fromT[RT] }, rm.originRestores);
  assert("reg-abs remove band: a card taken from school T goes back to T, not onto the band's grid",
    [rm.lessons.map(l => l.id), back.rows[RT].lessons.map(l => l.id), back.dropped], [[], ["W_amy"], []]);
  assert("reg-abs restore: rows being rebuilt are skipped",
    Object.keys(restoreOriginCards({ [RT]: fromT[RT] }, rm.originRestores, { skip: [RT] }).rows), []);
  const stray = adminBandRemovalAbsences("B1", [...noCard.missed, ...fromT[RS].missed, { ...anyMiss, id: "PLAIN" }]);
  assert("reg-abs stray removal: marked cards filtered, origin restores returned, unrelated misses kept",
    [stray.cards, stray.originRestores.map(x => [x.rowKey, x.card.id]), stray.missed.map(m => m.id)], [[], [[RT, "W_amy"]], ["PLAIN"]]);
  assert("reg-abs: withoutMarkedCards / originRestoresFor",
    [withoutMarkedCards([{ id: "a" }, { id: "b", bandNoCard: true }, { id: "c", bandCardRow: RT }]).map(c => c.id), originRestoresFor(fromT[RS].missed, ["OTHER"])],
    [["a"], []]);
}

// ── Commit 3: the admin wrappers ──
export function runRegularAbsenceWrapperTests(assert) {
  const GROUPS = [{ id: "g_uke", studentIds: ["ivy", "libby"] }];
  const members = [{ studentId: "amy", instrument: "Guitar" }, { studentId: "bob", instrument: "Drums" }, { studentId: "libby", instrument: "Ukulele" }, { studentId: "ivy", instrument: "Ukulele" }];
  const uke = ecard("M_uke", "W_uke");
  const bobCard = ecard("M_bob", "W_bob", { schoolId: "S" });
  const band = eband("B1", [amyReg(), eentry("e_bob_drm", "regular", { consumedWeekKey: EB }), ...groupReg()], { removedLessons: [bobCard, uke], members });
  const wtt = { [RS]: { lessons: [band], missed: [], generatedAt: "x" } };
  const ctx = ctxOf(wtt);

  // Menu: protected members first, then the Regular subjects, a group as ONE item.
  let menu = adminAbsenceMenu(band, [], ctx);
  assert("reg-abs menu: Bob (held) via the protected gate, then Amy (no card) and the group as one item",
    [menu.eligible.map(i => [i.key, !!i.regular]), menu.absent], [[["e_bob_drm", false], ["regular:enrolment:e_amy_gtr", true], ["regular:group:g_uke", true]], []]);
  assert("reg-abs menu: the group is labelled by its members in the group's order; Amy by name",
    menu.eligible.slice(1).map(i => absenceItemLabel(band, i, ESTUDENTS, GROUPS)), ["Amy Ash", "Ivy O'Donnell, Libby Gilby"]);
  assert("reg-abs menu: without a context no Regular subject is offered (v2.47.0 callers unchanged)",
    adminAbsenceMenu(band, []).eligible.map(i => i.key), ["e_bob_drm"]);

  // Both recorded absent.
  let after = { ...wtt, ...planRegularAbsence(planArgs(wtt, "regular:group:g_uke", { ...OWED, reasonDetail: "camp" })).rows };
  after = { ...after, ...planRegularAbsence(planArgs(after, "regular:enrolment:e_amy_gtr", NOT_OWED)).rows };
  const b = after[RS].lessons[0];
  const missed = after[RS].missed;
  menu = adminAbsenceMenu(b, missed, ctxOf(after));
  assert("reg-abs menu: Undo offers ONE group item (never one child's name) and Amy",
    [menu.eligible.map(i => i.key), menu.absent.map(i => i.key)], [["e_bob_drm"], ["regular:enrolment:e_amy_gtr", "regular:group:g_uke"]]);

  // Window lock + sub-line.
  assert("reg-abs window: the lock set holds Amy and BOTH group entries",
    [...adminAbsentEnrolmentIds(b, missed)].sort(), ["e_amy_gtr", "e_ivy_uke", "e_libby_uke"]);
  assert("reg-abs window: every group member's sub-line reads the group's reason; Amy's reads hers",
    [adminMemberAbsenceInfo(b, b.memberStates[2], missed), adminMemberAbsenceInfo(b, b.memberStates[3], missed), adminMemberAbsenceInfo(b, b.memberStates[0], missed)],
    [{ reason: "informed_absence", reasonDetail: "camp" }, { reason: "informed_absence", reasonDetail: "camp" }, { reason: "uninformed_absence", reasonDetail: "" }]);

  // Band card, popover, export and parent emails.
  assert("reg-abs card: Amy and both children absent, Bob attending",
    adminSessionMemberRows(b, missed).map(r => [r.studentId, r.status, r.absenceReasonDetail]),
    [["amy", "absent", ""], ["bob", "attending", ""], ["libby", "absent", "camp"], ["ivy", "absent", "camp"]]);
  assert("reg-abs card: \"N absent\" counts three; parent emails reach Bob only; export lists Bob only",
    [adminBandCardStatus(b, missed).absentN, adminParentEmailStudentIds(b, missed), bandStudentFirstNames(b, ESTUDENTS, missed)], [3, ["bob"], "Bob"]);
  const fns = { displayName: (n) => n, classTeacherName: () => "", reasonLabel: (r, d) => r + (d ? ": " + d : "") };
  assert("reg-abs card: hover popover lists the whole group under Absent",
    bandPopoverGroups(b, missed, ESTUDENTS, fns).absent.map(r => [r.name, r.absenceLabel]),
    [["Amy Ash", "Absent (uninformed_absence)"], ["Libby Gilby", "Absent (informed_absence: camp)"], ["Ivy O'Donnell", "Absent (informed_absence: camp)"]]);

  // Band removal: the held group card goes back on the grid; Amy's built card does not.
  const rm = adminRemoveBandSession(after[RS], "B1");
  assert("reg-abs remove band: the group card and Bob's card go back; Amy's built card does not; all misses go",
    [rm.lessons.map(l => l.id).sort(), rm.missed, rm.dropped], [["W_bob", "W_uke"], [], []]);

  // Tally, catch-ups and invoices downstream of a whole-group band miss (2020 weeks).
  const libby = fstudent("libby"), ivy = fstudent("ivy");
  const eL = fenrol("e_libby_uke", "libby", "Ukulele", { isGroup: true, groupId: "g_uke" });
  const eI = fenrol("e_ivy_uke", "ivy", "Ukulele", { isGroup: true, groupId: "g_uke" });
  const gx = { consumedWeekKey: FB, groupId: "g_uke", isGroup: true };
  const gCard = { id: "MG", isGroup: true, groupId: "g_uke", enrolmentId: "e_ivy_uke", studentId: "ivy", instrument: "Ukulele", schoolId: "S", day: "Thursday", start: "10:00" };
  const gMiss = (makeupEligible) => ({ ...gCard, id: "GM", enrolmentId: "e_ivy_uke", reason: "informed_absence", reasonDetail: "", notes: "", makeupEligible, madeUp: false,
    cardNote: "", bandLessonId: "B1", ledgerCard: gCard });
  const gWtt = (makeupEligible) => ({ [FB + "|S"]: { lessons: [fband("B1", [fentry(eL, "regular", gx), fentry(eI, "regular", gx)])], missed: [gMiss(makeupEligible)] } });
  const d = ftally({ students: [libby, ivy], enrolments: [eL, eI], cards: [gCard], wtt: gWtt(true) });
  assert("reg-abs tally: the group row shows the miss in the band's week (one group row, no per-member rows)",
    [d.view["group|g_uke"][FB], Object.keys(d.view)], ["missed-makeup-owed:GM", ["group|g_uke"]]);
  const open = getOpenCatchupRows({ weeklyTimetables: gWtt(true), enrolments: [eL, eI], students: [libby, ivy], timetable: { lessons: [gCard] }, termWeeks: FWEEKS, catchups: [] });
  assert("reg-abs catch-ups: a catch-up-owed whole-group miss is an ordinary open group catch-up",
    open.map(r => [r.weekKey, r.missed.groupId]), [[FB, "g_uke"]]);
  const prevTerm = { start: "2020-02-03", end: "2020-04-03" };
  const gm = (wttX) => getGroupTermDeductionMath({ weeklyTimetables: wttX, catchups: [], enrolments: [eL, eI], groupId: "g_uke", prevTerm, interruptions: [], nextTermStart: "2020-04-20" });
  assert("reg-abs invoice: whole-group miss — catch-up owed → one group deduction; not owed → none",
    [gm(gWtt(true)).deductions, gm(gWtt(false)).deductions], [1, 0]);
  const solo = (wttX) => getEnrolmentTermDeductionMath({ weeklyTimetables: wttX, catchups: [], enrolmentId: "e_libby_pno", instrument: "Piano", prevTerm, interruptions: [], nextTermStart: "2020-04-20" });
  assert("reg-abs invoice: a whole-group miss never touches a member's solo maths",
    solo(gWtt(true)), { mkpEligPending: 0, catchups: 0, deductions: 0, extras: 0 });

  // A no-card solo absence costs the same as a held-card one.
  const eA = fenrol("e_amy_gtr", "amy", "Guitar");
  const aCard = { id: "W_A", enrolmentId: "e_amy_gtr", studentId: "amy", instrument: "Guitar", schoolId: "S", day: "Thursday", start: "09:00" };
  const aMiss = (extra) => ({ ...aCard, reason: "informed_absence", reasonDetail: "", notes: "", makeupEligible: true, madeUp: false, cardNote: "", bandLessonId: "B1", ...extra });
  const aWtt = (extra) => ({ [FB + "|S"]: { lessons: [fband("B1", [fentry(eA, "regular", { consumedWeekKey: FB })])], missed: [aMiss(extra)] } });
  const am = (wttX) => getEnrolmentTermDeductionMath({ weeklyTimetables: wttX, catchups: [], enrolmentId: "e_amy_gtr", instrument: "Guitar", prevTerm, interruptions: [], nextTermStart: "2020-04-20" });
  assert("reg-abs invoice + tally: a built (no-card) absence and a held-card absence count and show the same",
    [am(aWtt({ bandNoCard: true })), am(aWtt({ ledgerCard: aCard })),
      ftally({ students: [fstudent("amy")], enrolments: [eA], wtt: aWtt({ bandNoCard: true }) }).view["amy|Guitar"][FB]],
    [am(aWtt({ ledgerCard: aCard })), { mkpEligPending: 1, catchups: 0, deductions: 1, extras: 0 }, "missed-makeup-owed:W_A"]);
}

// ── Commit 4: the import builder keeps marked cards off the grid ──
export function runRegularAbsenceImportTests(assert) {
  const amyCard = ecard("M_amy", "W_amy", { weekDate: "2099-03-12" });
  const wtt = { [RS]: { lessons: [eband("B1", [amyReg()])], missed: [], generatedAt: "x" } };
  const noCard = planRegularAbsence(planArgs(wtt, "regular:enrolment:e_amy_gtr")).rows[RS];
  const held = planMarkAbsent({ band: eband("B1", [amyReg()], { removedLessons: [amyCard] }), entry: amyReg(), missed: [], enrolments: EENROL });
  const dayImport = (existingEntry) => buildMttImportForWeekSchool({ mtt: { lessons: EMASTER }, schoolId: "S", weekDates: lweekDates(EB),
    existingEntry, targetDay: "Tuesday", enrolments: EENROL, dropBands: true, catchups: [] });
  assert("reg-abs import: a day import removing the band does not put a built (no-card) lesson back on another day",
    dayImport(noCard).entry.lessons.map(l => l.id), []);
  assert("reg-abs import: …while a held card is still put back (unchanged)",
    dayImport({ lessons: [held.band], missed: held.misses }).entry.lessons.map(l => l.id), ["W_amy"]);
}

// ── Commit 5: the window note ──
export function runRegularAbsenceNoteTests(assert) {
  const note = (band, wtt, key, name, extra) => {
    const subj = regularAbsenceSubjects(band, ctxOf(wtt, extra)).filter(x => x.kind !== "held").find(x => x.key === key);
    return regularNoCardNote(subj, name);
  };
  const bandA = (removedLessons = []) => eband("B1", [amyReg()], { removedLessons });
  const row = (lessons, missed = []) => ({ [RS]: { lessons, missed, generatedAt: "x" } });
  assert("reg-abs note: Regular, no card held → \"The band holds no Guitar lesson for Amy this week\"",
    note(bandA(), row([bandA()]), "regular:enrolment:e_amy_gtr", "Amy"), "The band holds no Guitar lesson for Amy this week");
  assert("reg-abs note (decision b): no master lesson → why it can't be marked absent",
    note(bandA(), row([bandA()]), "regular:enrolment:e_amy_gtr", "Amy", { masterLessons: [] }), "No Guitar lesson on the master timetable for Amy — can't be marked absent");
  const amyCard = ecard("M_amy", "W_amy");
  assert("reg-abs note: card held → no note",
    note(bandA([amyCard]), row([bandA([amyCard])]), "regular:enrolment:e_amy_gtr", "Amy"), "");
  const p = planRegularAbsence(planArgs(row([bandA()]), "regular:enrolment:e_amy_gtr"));
  assert("reg-abs note: recorded absent (band miss) → no note",
    note(p.rows[RS].lessons[0], p.rows, "regular:enrolment:e_amy_gtr", "Amy"), "");
  const bandG = eband("B1", groupReg());
  assert("reg-abs note (group): the group's card not held → the note names its members",
    note(bandG, row([bandG]), "regular:group:g_uke", "Ivy, Libby"), "The band holds no group lesson for Ivy, Libby this week");
}

// ── Commit 6: no duplicate after regenerating ──
export function runRegularAbsenceRegenTests(assert) {
  const at = (entry) => ({ lessons: entry.lessons, missed: entry.missed });
  const count = (lessons, pred) => lessons.filter(pred).length;
  const raw = (cards) => cards;

  // Solo held-card absence: regenerate, then Undo / remove band.
  const amyCard = ecard("M_amy", "W_amy", { weekDate: "2099-03-12" });
  const aBand = eband("B1", [amyReg()], { removedLessons: [amyCard] });
  const p = planMarkAbsent({ band: aBand, entry: amyReg(), missed: [], enrolments: EENROL });
  const solo = { lessons: [p.band], missed: p.misses };
  const regen = regenerate(solo, "S", EB);
  const band = regen.lessons.find(l => l.id === "B1");
  assert("reg-abs regen (solo): no rebuilt card on the grid or in the ledger; the absence is carried",
    [count(regen.lessons, l => l.enrolmentId === "e_amy_gtr" && !l.isBandSession), band.removedLessons.length, regen.missed.length], [0, 0, 1]);
  const undone = planUndoAbsence({ band, entry: band.memberStates[0], missed: regen.missed, catchups: [] });
  const rm = planRemoveBandSession(at(regen), "B1");
  assert("reg-abs regen (solo): regenerate then Undo → one card held; regenerate then remove band → one card, no \"Couldn't put back\"",
    [undone.band.removedLessons.length, count(rm.lessons, l => l.enrolmentId === "e_amy_gtr"), rm.dropped], [1, 1, []]);
  assert("reg-abs regen: other lessons regenerate as before",
    count(regenerate(solo, "S", EB).lessons, l => l.isGroup), count(regenerate(solo, "S", EB, raw).lessons, l => l.isGroup));

  // Whole-group absence.
  const wtt = { [RS]: { lessons: [eband("B1", groupReg(), { removedLessons: [ecard("M_uke", "W_uke")] })], missed: [], generatedAt: "x" } };
  const g = planRegularAbsence(planArgs(wtt, "regular:group:g_uke")).rows[RS];
  const gRegen = regenerate(g, "S", EB);
  const gBand = gRegen.lessons.find(l => l.id === "B1");
  const after = { [RS]: { ...gRegen, generatedAt: "x" } };
  const gu = planRegularAbsenceUndo({ weeklyTimetables: after, rowKey: RS, bandLessonId: "B1", subjectKey: "regular:group:g_uke", at: AT });
  const grm = adminRemoveBandSession(after[RS], "B1");
  assert("reg-abs regen (group): the group card is not rebuilt; Undo → one ledger card; remove band → one card, nothing dropped",
    [count(gRegen.lessons, l => l.isGroup), gBand.removedLessons.length, gu.rows[RS].lessons.find(l => l.id === "B1").removedLessons.length,
      count(grm.lessons, l => l.isGroup), grm.dropped], [0, 0, 1, 1, []]);

  // Built (no-card) absence: the lesson regenerates into the ledger; still one.
  const nc = planRegularAbsence(planArgs({ [RS]: { lessons: [eband("B1", [amyReg()])], missed: [], generatedAt: "x" } }, "regular:enrolment:e_amy_gtr")).rows[RS];
  const ncRegen = regenerate(nc, "S", EB);
  const ncAfter = { [RS]: { ...ncRegen, generatedAt: "x" } };
  const ncu = planRegularAbsenceUndo({ weeklyTimetables: ncAfter, rowKey: RS, bandLessonId: "B1", subjectKey: "regular:enrolment:e_amy_gtr", at: AT });
  const ncrm = adminRemoveBandSession(ncAfter[RS], "B1");
  assert("reg-abs regen (no card): the lesson is generated into the band's ledger; Undo keeps that one; remove band → one card",
    [ncRegen.lessons.find(l => l.id === "B1").removedLessons.length, ncu.rows[RS].lessons.find(l => l.id === "B1").removedLessons.length,
      count(ncrm.lessons, l => l.enrolmentId === "e_amy_gtr"), ncrm.dropped], [1, 1, 1, []]);

  // Day import of the absent lesson's day keeps the other day's band: no copy.
  const imp = buildMttImportForWeekSchool({ mtt: { lessons: EMASTER }, schoolId: "S", weekDates: lweekDates(EB),
    existingEntry: at(solo), targetDay: "Thursday", enrolments: EENROL, dropBands: true, catchups: [] });
  const impBand = imp.entry.lessons.find(l => l.id === "B1");
  assert("reg-abs regen: a day import of Thursday does not rebuild Amy's absent lesson into the kept band's ledger",
    [count(imp.entry.lessons, l => l.enrolmentId === "e_amy_gtr" && !l.isBandSession), impBand.removedLessons.length], [0, 0]);
  assert("reg-abs regen: withoutBandAbsentCards ignores absences of bands no longer in the row, and built absences",
    [withoutBandAbsentCards([amyCard], [{ lessons: [], missed: p.misses }]).length,
      withoutBandAbsentCards([amyCard], [{ lessons: [p.band], missed: [{ ...p.misses[0], ledgerCard: undefined, bandNoCard: true }] }]).length,
      withoutBandAbsentCards([amyCard], [{ lessons: [p.band], missed: p.misses }]).length], [1, 1, 0]);
}
