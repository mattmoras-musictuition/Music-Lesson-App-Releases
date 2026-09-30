// ============================================================
// BAND SESSION VIEW SMOKE TESTS
// Band Session Attribution cluster 6b. Called from runSmokeTests with its
// `assert`. Pure helpers only; bands are built by hand so every state is
// explicit. Weeks sit in 2020 / 2099 so no real-clock threshold can move a
// result.
// ============================================================

import {
  SESSION_STATUS, sessionMemberRows, sessionMembers, isBandUnattributed,
  attributionProgress, absentCount, bandCoversStudentForPresence,
  bandNameForCatchup, findUnattributedBands,
} from "./bandSessionView";

const W = "2099-03-09";
const PW = "2020-03-09";

function entry(studentId, instrument, consumption, extra = {}) {
  return {
    enrolmentId: `e_${studentId}_${instrument}`, studentId, instrument,
    consumption, catchupId: null, consumedWeekKey: null, fee: null, attended: null, writerTeacherId: null,
    ...extra,
  };
}

function newBand(id, members, memberStates, extra = {}) {
  return { id, isBandSession: true, bandId: "b_" + id, bandName: "Band " + id, schoolId: "S", day: "Thursday", start: "09:00", members, memberStates, removedLessons: [], ...extra };
}

const pick = (rows) => rows.map(r => [r.studentId, r.status]);

export function runBandSessionViewTests(assert) {
  // ── Legacy passthrough ──
  const legacy = { id: "L1", isBandSession: true, bandName: "Old", members: [{ studentId: "amy", instrument: "Guitar" }, { studentId: "bob", instrument: "Drums" }, { studentId: "amy", instrument: "Guitar" }], removedLessons: [] };
  assert("session view: legacy rows are members[] as stored, all attending",
    sessionMemberRows(legacy, []).map(r => [r.studentId, r.instrument, r.status]),
    [["amy", "Guitar", "attending"], ["bob", "Drums", "attending"], ["amy", "Guitar", "attending"]]);
  assert("session view: legacy card list = full members[]", sessionMembers(legacy, []).length, 3);
  assert("session view: legacy never unattributed", isBandUnattributed(legacy), false);
  assert("session view: legacy progress null", attributionProgress(legacy), null);
  assert("session view: legacy absentCount 0 even with a stamped miss",
    absentCount(legacy, [{ bandLessonId: "L1", studentId: "amy", instrument: "Guitar" }]), 0);
  const synthetic = { isBandSession: true, bandId: "b1", bandName: "Menu", members: [{ studentId: "amy", instrument: "Guitar" }] };
  assert("session view: synthetic Add-band-menu lesson takes the legacy path",
    pick(sessionMemberRows(synthetic, [])), [["amy", "attending"]]);
  assert("session view: non-band lesson → no rows", sessionMemberRows({ id: "x", studentId: "amy" }, []), []);

  // ── Empty memberStates ──
  const empty = newBand("E", [{ studentId: "amy", instrument: "Guitar" }], []);
  assert("session view: empty memberStates → member unattributed (assumed present)",
    pick(sessionMemberRows(empty, [])), [["amy", "unattributed"]]);
  assert("session view: empty memberStates is not 'needs attribution'", isBandUnattributed(empty), false);
  assert("session view: empty memberStates progress 0/0", attributionProgress(empty), { set: 0, total: 0 });

  // ── Every state ──
  const members = ["reg", "regAbs", "cu", "cuForfeit", "cuOwed", "free", "freeAbs", "nis", "unset", "fwd", "billed"]
    .map(s => ({ studentId: s, instrument: "Guitar" }));
  const band = newBand("B", members, [
    entry("reg", "Guitar", "regular"),
    entry("regAbs", "Guitar", "regular"),
    entry("cu", "Guitar", "catchup", { catchupId: "c1" }),
    entry("cuForfeit", "Guitar", "catchup", { catchupId: "c2", attended: false, absence: { reason: "sick", reasonDetail: "", notes: "", makeupEligible: false } }),
    entry("cuOwed", "Guitar", "catchup", { catchupId: null, attended: false, absence: { reason: "other", reasonDetail: "camp", notes: "", makeupEligible: true }, absentCatchupSnapshot: { id: "c3" } }),
    entry("free", "Guitar", "free"),
    entry("freeAbs", "Guitar", "free", { attended: false }),
    entry("nis", "Guitar", "not_in_session"),
    entry("unset", "Guitar", null),
    entry("fwd", "Guitar", "forward"),
    entry("billed", "Guitar", "billed"),
  ]);
  const missed = [{ id: "m1", bandLessonId: "B", enrolmentId: "e_regAbs_Guitar", studentId: "regAbs", instrument: "Guitar", reason: "informed_absence", reasonDetail: "" }];
  const rows = sessionMemberRows(band, missed);
  assert("session view: every state resolves", pick(rows), [
    ["reg", "attending"], ["regAbs", "absent"], ["cu", "attending"], ["cuForfeit", "absent"], ["cuOwed", "absent"],
    ["free", "attending"], ["freeAbs", "absent"], ["nis", "not_in_session"], ["unset", "unattributed"],
    ["fwd", "attending"], ["billed", "attending"],
  ]);
  assert("session view: regular absence reason comes from the stamped miss",
    [rows[1].absenceReason, rows[1].absenceReasonDetail], ["informed_absence", ""]);
  assert("session view: catch-up absence reason comes from entry.absence",
    [rows[3].absenceReason, rows[4].absenceReason, rows[4].absenceReasonDetail], ["sick", "other", "camp"]);
  assert("session view: free absence has no reason", rows[6].absenceReason, null);
  assert("session view: isFree marks free members, absent or not",
    rows.filter(r => r.isFree).map(r => r.studentId), ["free", "freeAbs"]);
  assert("session view: card list drops absent and not-in-session",
    sessionMembers(band, missed).map(r => r.studentId), ["reg", "cu", "free", "unset", "fwd", "billed"]);
  assert("session view: absentCount", absentCount(band, missed), 4);
  assert("session view: a miss stamped by ANOTHER band doesn't mark absent",
    pick(sessionMemberRows(band, [{ ...missed[0], bandLessonId: "OTHER" }]))[1], ["regAbs", "attending"]);
  assert("session view: one unset member → needs attribution", isBandUnattributed(band), true);
  assert("session view: progress counts students", attributionProgress(band), { set: 10, total: 11 });

  // ── Multi-instrument collapse ──
  const multi = newBand("M", [{ studentId: "amy", instrument: "Guitar" }], [
    entry("amy", "Guitar", null), entry("amy", "Piano", "not_in_session"),
  ]);
  assert("session view: multi-instrument student is ONE row, decided by the attributed entry",
    sessionMemberRows(multi, []).map(r => [r.studentId, r.instrument, r.status]), [["amy", "Guitar", "not_in_session"]]);
  assert("session view: multi-instrument student counts once in progress", attributionProgress(multi), { set: 1, total: 1 });
  const multiUnset = newBand("MU", [{ studentId: "amy", instrument: "Guitar" }], [entry("amy", "Guitar", null), entry("amy", "Piano", null)]);
  assert("session view: multi-instrument, nothing set → unattributed once",
    [pick(sessionMemberRows(multiUnset, [])), attributionProgress(multiUnset)], [[["amy", "unattributed"]], { set: 0, total: 1 }]);

  // ── A member with no entry (no resolvable enrolment) ──
  const noEntry = newBand("N", [{ studentId: "amy", instrument: "Guitar" }, { studentId: "ghost", instrument: "Bass" }], [entry("amy", "Guitar", "regular")]);
  assert("session view: member with no entry is kept, unattributed",
    pick(sessionMemberRows(noEntry, [])), [["amy", "attending"], ["ghost", "unattributed"]]);
  assert("session view: member with no entry doesn't make the band 'needs attribution'", isBandUnattributed(noEntry), false);

  // ── Departed attributed entry (still in the placement snapshot) ──
  const departed = newBand("D", [{ studentId: "amy", instrument: "Guitar" }, { studentId: "left", instrument: "Keys" }], [
    entry("amy", "Guitar", "regular"), entry("left", "Keys", "free"),
  ]);
  assert("session view: departed attributed member keeps their status",
    pick(sessionMemberRows(departed, [])), [["amy", "attending"], ["left", "attending"]]);

  // ── Joined after placement ──
  const joined = newBand("J", [{ studentId: "amy", instrument: "Guitar" }], [
    entry("amy", "Guitar", "regular"), entry("newbie", "Bass", "not_in_session"), entry("pending", "Sax", null),
  ]);
  assert("session view: joined-after-placement and attributed → appended; unattributed joiner not listed",
    sessionMemberRows(joined, []).map(r => [r.studentId, r.instrument, r.status]),
    [["amy", "Guitar", "attending"], ["newbie", "Bass", "not_in_session"]]);
  assert("session view: an unattributed joiner still makes the band 'needs attribution'", isBandUnattributed(joined), true);

  // ── Duplicate-enrolment miss fallback ──
  const dup = newBand("DU", [{ studentId: "amy", instrument: "Guitar" }], [entry("amy", "Guitar", "regular", { enrolmentId: "e_amy_old" })]);
  const dupMiss = [{ bandLessonId: "DU", enrolmentId: "e_amy_new", studentId: "amy", instrument: "Guitar", reason: "sick" }];
  assert("session view: stamped miss on the other duplicate enrolment still marks absent",
    [pick(sessionMemberRows(dup, dupMiss)), absentCount(dup, dupMiss)], [[["amy", "absent"]], 1]);

  // ── instrument2 ignored safely ──
  const i2 = newBand("I2", [{ studentId: "amy", instrument: "Guitar", instrument2: "Vocals" }], [entry("amy", "Guitar", "regular")]);
  assert("session view: instrument2 doesn't add a row or change the instrument",
    sessionMemberRows(i2, []).map(r => [r.studentId, r.instrument]), [["amy", "Guitar"]]);

  // ── Q7 presence coverage ──
  const cov = (b, sid, inst) => bandCoversStudentForPresence(b, sid, inst);
  assert("Q7: legacy band covers every member, any instrument",
    [cov(legacy, "amy", "Piano"), cov(legacy, "bob"), cov(legacy, "zed", "Guitar")], [true, true, false]);
  assert("Q7: new band covers only regular entries",
    ["reg", "regAbs", "cu", "cuForfeit", "free", "freeAbs", "nis", "unset", "fwd", "billed"].map(s => cov(band, s, "Guitar")),
    [true, true, false, false, false, false, false, false, false, false]);
  assert("Q7: regular covers only its own instrument", [cov(band, "reg", "Piano"), cov(band, "reg")], [false, true]);
  assert("Q7: empty memberStates covers nobody", cov(empty, "amy", "Guitar"), false);
  assert("Q7: non-band never covers", cov({ id: "x", studentId: "reg" }, "reg", "Guitar"), false);

  // ── bandNameForCatchup ──
  const wtt = {
    [`${W}|S`]: { lessons: [band, { id: "noName", isBandSession: true, memberStates: [] }], missed: [] },
  };
  assert("bandNameForCatchup: finds the band in the row's week and school",
    bandNameForCatchup({ bandLessonId: "B", weekKey: W, schoolId: "S" }, wtt), "Band B");
  assert("bandNameForCatchup: band missing → null",
    bandNameForCatchup({ bandLessonId: "gone", weekKey: W, schoolId: "S" }, wtt), null);
  assert("bandNameForCatchup: wrong school → null",
    bandNameForCatchup({ bandLessonId: "B", weekKey: W, schoolId: "T" }, wtt), null);
  assert("bandNameForCatchup: band without a name → null",
    bandNameForCatchup({ bandLessonId: "noName", weekKey: W, schoolId: "S" }, wtt), null);
  assert("bandNameForCatchup: unlinked row → null", bandNameForCatchup({ weekKey: W, schoolId: "S" }, wtt), null);

  // ── findUnattributedBands ──
  const all = {
    [`${W}|S`]: { lessons: [band, { ...legacy, id: "L2" }, newBand("Done", [{ studentId: "amy", instrument: "Guitar" }], [entry("amy", "Guitar", "free")])] },
    [`${W}|T`]: { lessons: [newBand("T1", [{ studentId: "x", instrument: "Bass" }], [entry("x", "Bass", null)], { schoolId: "T", day: "Monday" })] },
    [`${PW}|S`]: { lessons: [newBand("P1", [{ studentId: "y", instrument: "Bass" }], [entry("y", "Bass", null)], { day: "Friday" })] },
  };
  assert("findUnattributedBands: all weeks, date order, legacy and fully-set excluded",
    findUnattributedBands(all).map(b => [b.weekKey, b.schoolId, b.bandLessonId, b.set, b.total]),
    [[PW, "S", "P1", 0, 1], [W, "T", "T1", 0, 1], [W, "S", "B", 10, 11]]);
  assert("findUnattributedBands: week scope",
    findUnattributedBands(all, { weekKeys: [W] }).map(b => b.bandLessonId), ["T1", "B"]);
  assert("findUnattributedBands: school scope",
    findUnattributedBands(all, { schoolIds: ["S"] }).map(b => b.bandLessonId), ["P1", "B"]);
  assert("findUnattributedBands: carries name and day",
    findUnattributedBands(all, { weekKeys: [PW] }).map(b => [b.bandName, b.day]), [["Band P1", "Friday"]]);
  assert("findUnattributedBands: empty input", findUnattributedBands({}), []);
  assert("SESSION_STATUS values", Object.values(SESSION_STATUS), ["attending", "absent", "not_in_session", "unattributed"]);
}
