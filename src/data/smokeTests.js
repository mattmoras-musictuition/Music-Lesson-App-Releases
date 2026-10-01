// ============================================================
// SMOKE TESTS
// Runs once at startup in development to catch regressions
// in core logic functions.
// ============================================================

import { timeToMin, getSchoolAcronym } from "../utils/helpers";
import { migrateData } from "../utils/backup";
import { makeEnrolmentResolver } from "../utils/enrolmentActivity";
import {
  buildMemberStates, applyStudentAttribution, defaultAttributions,
  reconcileMemberStates, findMemberCards, isExcludedByBands, studentRows,
  selectableMissesForStudent, planAttributionSave,
  sameDayClashCard, applyRegularDisplacement, restoreLedgerCards,
  consumesEntitlement, attendsSession, canEnterStaging,
} from "./bandMemberStates";
import { isHiddenBehindBandCard, mergeCatchupsIntoLessons } from "./catchupsDerive";
import { runLegacyBandTallyTests, runMemberStateTallyTests } from "./tallyBandSmokeTests";
import { runCatchupScopeTests } from "./catchupScopeSmokeTests";
import { runMttImportCharacterizationTests, runCleanImportPlanTests, runCleanImportWiringTests, runImportMissedLineTests } from "./mttImportSmokeTests";
import { runBandSessionViewTests, runBandCardStatusTests, runUnattributedAlertTests, runParentEmailStudentTests } from "./bandSessionViewSmokeTests";
import { runBandDisplayCharacterizationTests, runBandDisplaySessionTests } from "./bandDisplaySmokeTests";
import { runWeeklyPresenceTests } from "./weeklyPresenceSmokeTests";
import { runDashboardAlertCharacterizationTests } from "./dashboardAlertsSmokeTests";
import { runBandAbsenceCharacterizationTests, runBandAbsenceHelperTests, runBandAbsenceLockTests, runBandAbsenceRegenTests, runBandAbsenceRemovalTests } from "./bandAbsenceSmokeTests";

export function runSmokeTests(logErrorFn) {
  const results = [];
  const assert = (label, actual, expected) => {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    results.push({ label, pass, actual, expected });
  };

  // timeToMin roundtrip
  assert("timeToMin 09:00", timeToMin("09:00"), 540);
  assert("timeToMin 14:30", timeToMin("14:30"), 870);

  // getSchoolAcronym — explicit acronym field takes priority over auto-derivation
  assert("acronym explicit field", getSchoolAcronym({ name: "Solway Primary School", acronym: "SPS" }), "SPS");
  assert("acronym auto-derive",    getSchoolAcronym({ name: "East Bentleigh Primary School" }), "EBPS");
  assert("acronym fallback empty", getSchoolAcronym({ name: "Moorabbin Primary School", acronym: "" }), "MPS");

  // migrateData — students
  const rawStudent = { id: "x", name: "Test", schoolId: "s1", className: "3A", instruments: [{ name: "Piano" }] };
  const migrated = migrateData("students", [rawStudent])[0];
  assert("migrate student notes default", migrated.notes, "");
  assert("migrate student status default", migrated.status, "active");
  assert("migrate student instruments preserved", migrated.instruments[0].name, "Piano");

  // ── Band Session Attribution (cluster 3a) ──────────────────────
  // Fixture enrolments. Amy holds guitar (started first, ENDED before the
  // band's week) plus a live guitar row starting mid-term, and piano.
  const bandWeek = "2026-05-11";
  const enr = [
    { id: "e_amy_gtr_old", studentId: "amy", instrument: "Guitar", startDate: "2026-01-01", endDate: "2026-12-31" },
    { id: "e_amy_gtr_new", studentId: "amy", instrument: "Guitar", startDate: "2026-09-01" },
    { id: "e_amy_pno",     studentId: "amy", instrument: "Piano",  startDate: "2026-02-01" },
    { id: "e_bob_drm",     studentId: "bob", instrument: "Drums",  startDate: "2026-03-01" },
  ];
  const members = [{ studentId: "amy", instrument: "Guitar" }, { studentId: "bob", instrument: "Drums" }];

  // Pick-order fix: the newer guitar row starts AFTER the band's week, so
  // filtering to active rows first must keep the older one. Picking first
  // would have chosen e_amy_gtr_new (latest startDate) and then dropped it.
  const built = buildMemberStates(members, enr, bandWeek);
  assert("memberStates picks week-active guitar row", built.map(e => e.enrolmentId),
    ["e_amy_gtr_old", "e_amy_pno", "e_bob_drm"]);
  assert("memberStates all unattributed", built.every(e => e.consumption === null), true);

  // One consumption per student: attributing piano clears guitar.
  const guitarFirst = applyStudentAttribution(built, "amy", "e_amy_gtr_old", "regular", null);
  const pianoNext = applyStudentAttribution(guitarFirst, "amy", "e_amy_pno", "free", null);
  assert("one consumption per student", pianoNext.filter(e => e.studentId === "amy" && e.consumption != null).map(e => e.enrolmentId),
    ["e_amy_pno"]);
  assert("other students untouched by attribution", pianoNext.find(e => e.studentId === "bob").consumption, null);
  assert("attribution clears whole student on null", 
    applyStudentAttribution(pianoNext, "amy", "e_amy_pno", null, null).filter(e => e.studentId === "amy" && e.consumption != null).length, 0);

  // Defaults: an open miss on the SECOND instrument beats first-enrolled.
  const misses = [
    { enrolmentId: "e_amy_pno", weekKey: "2026-04-20", day: "Wednesday", start: "10:00" },
    { enrolmentId: "e_amy_pno", weekKey: "2026-04-13", day: "Friday",   start: "09:00" },
    { enrolmentId: "e_amy_pno", weekKey: "2026-04-13", day: "Tuesday",  start: "14:00" },
  ];
  const withMiss = defaultAttributions(built, { openMisses: misses, enrolments: enr });
  assert("default catchup targets oldest miss (week, then day)",
    withMiss.filter(d => d.studentId === "amy").map(d => [d.consumption, d.enrolmentId, d.settlesMiss.day]),
    [["catchup", "e_amy_pno", "Tuesday"]]);
  // Bob has no miss → regular on his only (earliest) enrolment.
  assert("default regular when no miss",
    withMiss.filter(d => d.studentId === "bob").map(d => [d.consumption, d.enrolmentId]),
    [["regular", "e_bob_drm"]]);
  // No misses at all → earliest startDate wins (guitar 2026-01-01 over piano 2026-02-01).
  assert("default regular picks earliest startDate",
    defaultAttributions(built, { openMisses: [], enrolments: enr }).filter(d => d.studentId === "amy").map(d => d.enrolmentId),
    ["e_amy_gtr_old"]);
  // An already-attributed student gets no default.
  assert("no default for attributed student",
    defaultAttributions(guitarFirst, { openMisses: misses, enrolments: enr }).map(d => d.studentId), ["bob"]);

  // Reconciliation: add / drop-unattributed / keep-departed-attributed.
  const stored = [
    { enrolmentId: "e_amy_gtr_old", studentId: "amy", instrument: "Guitar", consumption: "regular", catchupId: null, consumedWeekKey: null, fee: null, attended: null, writerTeacherId: null },
    { enrolmentId: "e_amy_pno",     studentId: "amy", instrument: "Piano",  consumption: null,      catchupId: null, consumedWeekKey: null, fee: null, attended: null, writerTeacherId: null },
  ];
  const fresh = [
    { enrolmentId: "e_amy_pno", studentId: "amy", instrument: "Piano", consumption: null, catchupId: null, consumedWeekKey: null, fee: null, attended: null, writerTeacherId: null },
    { enrolmentId: "e_bob_drm", studentId: "bob", instrument: "Drums", consumption: null, catchupId: null, consumedWeekKey: null, fee: null, attended: null, writerTeacherId: null },
  ];
  const rec = reconcileMemberStates(stored, fresh);
  assert("reconcile keeps departed attributed, drops departed unattributed, appends new",
    rec.memberStates.map(e => e.enrolmentId), ["e_amy_gtr_old", "e_amy_pno", "e_bob_drm"]);
  assert("reconcile reports departed", rec.departedEnrolmentIds, ["e_amy_gtr_old"]);
  assert("departed surfaces on the student row",
    studentRows(rec.memberStates, rec.departedEnrolmentIds).find(r => r.studentId === "amy").departed, true);

  // findMemberCards: stamped enrolmentId, and the studentId+instrument fallback.
  const resolver = makeEnrolmentResolver(enr);
  const pianoEntry = built.find(e => e.enrolmentId === "e_amy_pno");
  const weekCards = [
    { id: "L1", enrolmentId: "e_amy_pno", studentId: "amy", instrument: "Piano", day: "Monday" },
    { id: "L2", studentId: "amy", instrument: "Piano", day: "Tuesday" },          // unstamped → fallback
    { id: "L3", studentId: "amy", instrument: "Guitar", day: "Monday" },
    { id: "L4", isBandSession: true, members: [{ studentId: "amy" }] },
    { id: "L5", __isCatchup: true, enrolmentId: "e_amy_pno", studentId: "amy" },
    { id: "L6", isGroup: true, studentIds: ["amy"], enrolmentId: "e_amy_pno" },
  ];
  assert("findMemberCards matches stamped + unstamped, skips band/catchup/group",
    findMemberCards(weekCards, pianoEntry, resolver).map(l => l.id), ["L1", "L2"]);

  // isExcludedByBands: legacy excludes the whole student; a new band excludes
  // only the "regular"-attributed enrolment.
  const legacyBand = { isBandSession: true, members: [{ studentId: "amy" }] };
  const newBand = { isBandSession: true, members: [{ studentId: "amy" }], memberStates: guitarFirst };
  const amyPiano = { id: "M1", enrolmentId: "e_amy_pno", studentId: "amy", instrument: "Piano" };
  const amyGuitar = { id: "M2", enrolmentId: "e_amy_gtr_old", studentId: "amy", instrument: "Guitar" };
  assert("legacy band excludes every card of the student",
    [isExcludedByBands(amyPiano, [legacyBand], resolver), isExcludedByBands(amyGuitar, [legacyBand], resolver)], [true, true]);
  assert("new band excludes only the regular-attributed enrolment",
    [isExcludedByBands(amyPiano, [newBand], resolver), isExcludedByBands(amyGuitar, [newBand], resolver)], [false, true]);
  assert("new band with no attribution excludes nothing",
    isExcludedByBands(amyGuitar, [{ isBandSession: true, members: [{ studentId: "amy" }], memberStates: built }], resolver), false);

  // ── Band attribution: hide test + save plan (cluster 3b) ───────
  // The hide test needs BOTH directions of the link: the band present, and
  // that band still claiming the row.
  const cu = { id: "cu1", bandLessonId: "BL1", weekKey: bandWeek, time: "10:00", day: "Monday" };
  const claiming = { id: "BL1", isBandSession: true, memberStates: [{ enrolmentId: "e_amy_pno", studentId: "amy", catchupId: "cu1", consumption: "catchup" }] };
  const notClaiming = { id: "BL1", isBandSession: true, memberStates: [{ enrolmentId: "e_amy_pno", studentId: "amy", catchupId: null, consumption: null }] };
  assert("hidden when band present AND claims the row", isHiddenBehindBandCard(cu, [claiming]), true);
  assert("visible when band present but claims nothing", isHiddenBehindBandCard(cu, [notClaiming]), false);
  assert("visible when band absent", isHiddenBehindBandCard(cu, []), false);
  assert("visible when band is legacy (no memberStates)",
    isHiddenBehindBandCard(cu, [{ id: "BL1", isBandSession: true }]), false);
  assert("merge hides a claimed catchup, keeps an orphan",
    mergeCatchupsIntoLessons([], [cu, { id: "cu2", bandLessonId: "GONE", weekKey: bandWeek }], bandWeek, [claiming]).map(l => l.id),
    ["cu2"]);

  // selectableMissesForStudent restores the miss the existing row settles.
  const linkedRow = { id: "cu1", bandLessonId: "BL1", resolvesEnrolmentId: "e_amy_pno", resolvesWeekKey: "2026-03-02", resolvesOriginalDay: "Monday", resolvesOriginalTime: "11:00" };
  const amyEntries = built.filter(e => e.studentId === "amy").map(e =>
    e.enrolmentId === "e_amy_pno" ? { ...e, consumption: "catchup", catchupId: "cu1" } : e);
  assert("selectable misses include the already-settled one",
    selectableMissesForStudent(amyEntries, [], [linkedRow]).map(m => [m.enrolmentId, m.weekKey]),
    [["e_amy_pno", "2026-03-02"]]);

  // planAttributionSave — one case per transition.
  const base = (consumption, catchupId) => [
    { enrolmentId: "e_amy_pno", studentId: "amy", instrument: "Piano", consumption, catchupId: catchupId || null, consumedWeekKey: null, fee: null, attended: null, writerTeacherId: null },
  ];
  const missA = { enrolmentId: "e_amy_pno", weekKey: "2026-03-02", day: "Monday", start: "11:00" };
  const missB = { enrolmentId: "e_amy_pno", weekKey: "2026-03-09", day: "Tuesday", start: "09:00" };
  const rowA = { id: "cu1", resolvesEnrolmentId: "e_amy_pno", resolvesWeekKey: "2026-03-02", resolvesOriginalDay: "Monday", resolvesOriginalTime: "11:00" };
  const planOf = (stored, working, missBy, rows) => planAttributionSave({
    stored, working, missByEnrolment: missBy || {}, catchupsForBand: rows || [], weekKey: bandWeek });

  let pl = planOf(base(null), base("regular"));
  assert("unattributed → regular", [pl.inserts.length, pl.deletes.length, pl.regularOn.length, pl.memberStates[0].consumedWeekKey],
    [0, 0, 1, bandWeek]);

  pl = planOf(base(null), base("catchup"), { e_amy_pno: missA });
  assert("unattributed → catchup inserts one row",
    [pl.inserts.length, pl.deletes.length, pl.memberStates[0].consumedWeekKey], [1, 0, "2026-03-02"]);

  pl = planOf(base("catchup", "cu1"), base("catchup", "cu1"), { e_amy_pno: missA }, [rowA]);
  assert("catchup → same miss is a no-op", [pl.inserts.length, pl.deletes.length, pl.changed], [0, 0, false]);

  pl = planOf(base("catchup", "cu1"), base("catchup", "cu1"), { e_amy_pno: missB }, [rowA]);
  assert("catchup → different miss replaces the row",
    [pl.inserts.length, pl.deletes.map(d => d.id)], [1, ["cu1"]]);

  pl = planOf(base("catchup", "cu1"), base("free"), {}, [rowA]);
  assert("catchup → free deletes the row",
    [pl.inserts.length, pl.deletes.map(d => d.id), pl.memberStates[0].catchupId, pl.memberStates[0].consumedWeekKey],
    [0, ["cu1"], null, null]);

  pl = planOf(base("regular"), base("catchup"), { e_amy_pno: missA });
  assert("regular → catchup inserts and releases the card",
    [pl.inserts.length, pl.regularOff.length, pl.regularOn.length], [1, 1, 0]);

  pl = planOf(base("catchup", "cu1"), base(null), {}, [rowA]);
  assert("departed catchup cleared deletes the row",
    [pl.deletes.map(d => d.id), pl.memberStates[0].consumption], [["cu1"], null]);

  assert("no-op save reports unchanged", planOf(base(null), base(null)).changed, false);

  // ── Band attribution: same-day warning + staging round trip (patch 1) ──
  const gtr = { id: "C_G", enrolmentId: "e_amy_gtr_old", studentId: "amy", instrument: "Guitar", day: "Monday", start: "09:00" };
  const pno = { id: "C_P", enrolmentId: "e_amy_pno", studentId: "amy", instrument: "Piano", day: "Monday", start: "10:00" };
  const gtrUnstamped = { id: "C_GU", studentId: "amy", instrument: "Guitar", day: "Monday", start: "09:00" };
  const msRegularGuitar = [{ enrolmentId: "e_amy_gtr_old", studentId: "amy", instrument: "Guitar", consumption: "regular", catchupId: null, consumedWeekKey: null, fee: null, attended: null, writerTeacherId: null }];
  const bandLegacy = { id: "B0", isBandSession: true, members: [{ studentId: "amy" }] };
  const bandUnattr = { id: "B1", isBandSession: true, members: [{ studentId: "amy" }], memberStates: built };
  const bandRegGtr = { id: "B2", isBandSession: true, members: [{ studentId: "amy" }], memberStates: msRegularGuitar };
  const bandCatchup = { id: "B3", isBandSession: true, members: [{ studentId: "amy" }], memberStates: [{ ...msRegularGuitar[0], consumption: "catchup" }] };

  assert("sameDayClashCard: legacy band returns first same-day card",
    sameDayClashCard(bandLegacy, "amy", [pno, gtr])?.id, "C_P");
  assert("sameDayClashCard: unattributed returns first same-day card",
    sameDayClashCard(bandUnattr, "amy", [pno, gtr])?.id, "C_P");
  assert("sameDayClashCard: regular on guitar, only a piano card → null",
    sameDayClashCard(bandRegGtr, "amy", [pno]), null);
  assert("sameDayClashCard: regular on guitar, stamped guitar card survives → that card",
    sameDayClashCard(bandRegGtr, "amy", [pno, gtr])?.id, "C_G");
  assert("sameDayClashCard: regular on guitar, unstamped guitar card matched by instrument",
    sameDayClashCard(bandRegGtr, "amy", [pno, gtrUnstamped])?.id, "C_GU");
  assert("sameDayClashCard: catchup → null",
    sameDayClashCard(bandCatchup, "amy", [pno, gtr]), null);
  assert("sameDayClashCard: no same-day cards → null",
    sameDayClashCard(bandRegGtr, "amy", []), null);

  // Re-displacement when a staged band is placed back on the grid.
  const bobCard = { id: "C_B", enrolmentId: "e_bob_drm", studentId: "bob", instrument: "Drums", day: "Monday", start: "11:00" };
  const twoRegular = [
    { ...msRegularGuitar[0] },
    { enrolmentId: "e_bob_drm", studentId: "bob", instrument: "Drums", consumption: "regular", catchupId: null, consumedWeekKey: null, fee: null, attended: null, writerTeacherId: null },
  ];
  const week = [gtr, pno, bobCard];
  let disp = applyRegularDisplacement(week, twoRegular, [], resolver);
  assert("applyRegularDisplacement: two regular entries take both cards",
    [disp.lessons.map(l => l.id), disp.removedLessons.map(l => l.id)], [["C_P"], ["C_G", "C_B"]]);
  disp = applyRegularDisplacement([pno], twoRegular, [], resolver);
  assert("applyRegularDisplacement: regular entry with no matching card contributes nothing",
    [disp.lessons.map(l => l.id), disp.removedLessons.length], [["C_P"], 0]);
  disp = applyRegularDisplacement(week, [{ ...msRegularGuitar[0], consumption: "catchup" }, { ...msRegularGuitar[0], enrolmentId: "e_amy_pno", instrument: "Piano", consumption: "free" }], [], resolver);
  assert("applyRegularDisplacement: non-regular entries are ignored",
    [disp.lessons.length, disp.removedLessons.length], [3, 0]);

  // Ledger restore on the way into staging — occupied slots are skipped.
  assert("restoreLedgerCards: free slot restores",
    restoreLedgerCards([pno], [gtr]).map(l => l.id), ["C_P", "C_G"]);
  assert("restoreLedgerCards: occupied slot is skipped",
    restoreLedgerCards([{ id: "OTHER", day: "Monday", start: "09:00" }], [gtr]).map(l => l.id), ["OTHER"]);

  // ── Band attribution: "Not in this session" (cluster 3c) ──
  pl = planOf(base(null), base("not_in_session"));
  assert("unattributed → not_in_session: no insert, delete or regularOn",
    [pl.inserts.length, pl.deletes.length, pl.regularOn.length, pl.memberStates[0].consumedWeekKey, pl.changed],
    [0, 0, 0, null, true]);

  pl = planOf(base("catchup", "cu1"), base("not_in_session", "cu1"), {}, [rowA]);
  assert("catchup → not_in_session deletes the row, no insert",
    [pl.inserts.length, pl.deletes.map(d => d.id), pl.memberStates[0].catchupId, pl.memberStates[0].consumedWeekKey],
    [0, ["cu1"], null, null]);

  // regular → not_in_session: the plan releases the card, and the save's
  // ledger step (findMemberCards on the ledger, then the free-slot restore)
  // puts it back on the grid and empties it from the ledger.
  const ledgerPno = { id: "C_LP", enrolmentId: "e_amy_pno", studentId: "amy", instrument: "Piano", day: "Monday", start: "10:00" };
  pl = planOf(base("regular"), base("not_in_session"));
  const offCards = findMemberCards([ledgerPno], pl.regularOff[0], resolver);
  const ledgerAfter = [ledgerPno].filter(l => !offCards.some(c => c.id === l.id));
  assert("regular → not_in_session restores the card from the ledger",
    [pl.regularOff.length, pl.regularOn.length, pl.memberStates[0].consumedWeekKey,
      restoreLedgerCards([], offCards).map(l => l.id), ledgerAfter.length],
    [1, 0, null, ["C_LP"], 0]);

  pl = planOf(base("not_in_session"), base("regular"));
  const onDisp = applyRegularDisplacement([ledgerPno], pl.memberStates, [], resolver);
  assert("not_in_session → regular moves the card into the ledger",
    [pl.regularOn.length, pl.regularOff.length, onDisp.lessons.length, onDisp.removedLessons.map(l => l.id)],
    [1, 0, 0, ["C_LP"]]);

  const bandNotIn = { id: "B4", isBandSession: true, members: [{ studentId: "amy" }], memberStates: [{ ...msRegularGuitar[0], consumption: "not_in_session" }] };
  assert("sameDayClashCard: not_in_session → null",
    sameDayClashCard(bandNotIn, "amy", [pno, gtr]), null);

  const propsNoMiss = defaultAttributions(built, { openMisses: [], enrolments: enr });
  const propsMiss = defaultAttributions(built, { openMisses: [missA], enrolments: enr });
  assert("defaultAttributions never proposes not_in_session",
    [...propsNoMiss, ...propsMiss].some(p => p.consumption === "not_in_session"), false);

  const allValues = ["regular", "catchup", "free", "forward", "billed", "not_in_session", null];
  assert("consumesEntitlement across every value",
    allValues.map(consumesEntitlement), [true, true, false, true, false, false, false]);
  assert("attendsSession across every value, plus a missing entry",
    [...allValues.map(c => attendsSession({ consumption: c })), attendsSession(null)],
    [true, true, true, true, true, false, true, true]);

  // ── Staging tray: bands never enter (owner decision, 30 Sep 2026) ──
  // true only means "not refused as a band"; a non-band card still needs the
  // tray's own fromStaged gate, which placed catch-ups and regular cards lack.
  assert("canEnterStaging: legacy band → false",
    canEnterStaging({ id: "BL", isBandSession: true, members: [{ studentId: "amy" }], removedLessons: [] }), false);
  assert("canEnterStaging: new band with memberStates → false",
    canEnterStaging({ id: "BN", isBandSession: true, members: [{ studentId: "amy" }], memberStates: built }), false);
  assert("canEnterStaging: new band with empty memberStates → false",
    canEnterStaging({ id: "BE", isBandSession: true, members: [], memberStates: [] }), false);
  assert("canEnterStaging: band placed from staging (fromStaged) → false",
    canEnterStaging({ id: "BS", isBandSession: true, fromStaged: true, members: [], memberStates: [] }), false);
  assert("canEnterStaging: catch-up card → true",
    canEnterStaging({ id: "CU", __isCatchup: true, studentId: "amy", instrument: "Guitar", resolvesEnrolmentId: "e_amy_pno" }), true);
  assert("canEnterStaging: regular lesson card → true",
    canEnterStaging({ id: "C_G", enrolmentId: "e_amy_gtr_old", studentId: "amy", instrument: "Guitar", day: "Monday", start: "09:00" }), true);
  assert("canEnterStaging: missing lesson → false", canEnterStaging(null), false);

  // ── Tally band matching (cluster 4b) ──
  runLegacyBandTallyTests(assert);
  runMemberStateTallyTests(assert);
  runCatchupScopeTests(assert);

  // ── Band absence (cluster 5b) ──
  runBandAbsenceCharacterizationTests(assert);
  runBandAbsenceHelperTests(assert);
  runBandAbsenceLockTests(assert);
  runBandAbsenceRegenTests(assert);
  runBandAbsenceRemovalTests(assert);

  // ── Clean MTT re-import (v2.40.1) ──
  runMttImportCharacterizationTests(assert);
  runCleanImportPlanTests(assert);
  runCleanImportWiringTests(assert);
  runImportMissedLineTests(assert);

  // ── Band session view (cluster 6b) ──
  runBandSessionViewTests(assert);
  runBandCardStatusTests(assert);
  runUnattributedAlertTests(assert);
  runParentEmailStudentTests(assert);
  runBandDisplayCharacterizationTests(assert);
  runBandDisplaySessionTests(assert);
  runWeeklyPresenceTests(assert);

  // ── Dashboard alerts (v2.41.1) ──
  runDashboardAlertCharacterizationTests(assert);

  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass);
  if (failed.length > 0) {
    console.warn("Smoke tests: " + passed + "/" + results.length + " passed. Failures:");
    failed.forEach(r => console.warn("  FAIL: " + r.label + " - got " + JSON.stringify(r.actual) + ", expected " + JSON.stringify(r.expected)));
    if (logErrorFn) failed.forEach(r => logErrorFn("Smoke test failed: " + r.label, "got " + r.actual + ", expected " + r.expected));
  } else {
    console.log("Smoke tests: " + passed + "/" + results.length + " passed");
  }
}
