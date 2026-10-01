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
  bandNameForCatchup, findUnattributedBands, bandCardStatus,
  termWeekKeys, weekOffsetBetween, unattributedAlertDismissKey, undismissedBandIds, unattributedBandsForAlert, parentEmailStudentIds,
} from "./bandSessionView";
import { resolveAnchorTerm } from "../utils/catchupScope";

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

export function runBandCardStatusTests(assert) {
  const legacy = { id: "L", isBandSession: true, members: [{ studentId: "a", instrument: "Guitar" }], removedLessons: [] };
  const mk = (states, members) => newBand("C", members || states.map(e => ({ studentId: e.studentId, instrument: e.instrument })), states);
  const miss = [{ bandLessonId: "C", enrolmentId: "e_a_Guitar", studentId: "a", instrument: "Guitar", reason: "sick" }];
  assert("card status: legacy shows nothing, even with a stamped miss",
    bandCardStatus(legacy, [{ bandLessonId: "L", studentId: "a", instrument: "Guitar" }]), { needsAttribution: false, absentN: 0 });
  assert("card status: freshly placed band → needs attribution",
    bandCardStatus(mk([entry("a", "Guitar", null), entry("b", "Bass", null)]), []), { needsAttribution: true, absentN: 0 });
  assert("card status: partly set → still needs attribution",
    bandCardStatus(mk([entry("a", "Guitar", "free"), entry("b", "Bass", null)]), []), { needsAttribution: true, absentN: 0 });
  assert("card status: all set, nobody absent → nothing",
    bandCardStatus(mk([entry("a", "Guitar", "regular"), entry("b", "Bass", "not_in_session")]), []), { needsAttribution: false, absentN: 0 });
  assert("card status: both lines at once",
    bandCardStatus(mk([entry("a", "Guitar", "regular"), entry("b", "Bass", null), entry("c", "Keys", "free", { attended: false })]), miss),
    { needsAttribution: true, absentN: 2 });
  assert("card status: empty memberStates → nothing", bandCardStatus(newBand("C", [{ studentId: "a" }], []), []), { needsAttribution: false, absentN: 0 });
}

export function runUnattributedAlertTests(assert) {
  assert("alert: termWeekKeys from a mid-week start to the end",
    termWeekKeys({ start: "2099-01-28", end: "2099-02-18" }), ["2099-01-26", "2099-02-02", "2099-02-09", "2099-02-16"]);
  assert("alert: termWeekKeys, no term", termWeekKeys(null), []);
  assert("alert: weekOffsetBetween", [weekOffsetBetween("2099-03-09", "2099-03-23"), weekOffsetBetween("2099-03-09", "2099-02-23"), weekOffsetBetween("2099-03-09", "2099-03-09")], [2, -2, 0]);
  assert("alert: weekOffsetBetween across a DST change", weekOffsetBetween("2020-03-30", "2020-04-13"), 2);

  const key = unattributedAlertDismissKey(["b2", "b1", "b2"]);
  assert("alert: dismiss key is prefixed, sorted, de-duplicated", key, "alert-unattributed-bands|b1,b2");
  assert("alert: undismissed ids — nothing dismissed", undismissedBandIds(["b1", "b2"], {}), ["b1", "b2"]);
  assert("alert: undismissed ids — set dismissed", undismissedBandIds(["b1", "b2"], { [key]: true }), []);
  assert("alert: undismissed ids — a new band comes back alone", undismissedBandIds(["b1", "b2", "b3"], { [key]: true }), ["b3"]);
  assert("alert: undismissed ids — per-row keys add up",
    undismissedBandIds(["b1", "b2"], { [unattributedAlertDismissKey(["b1"])]: true, [unattributedAlertDismissKey(["b2"])]: true }), []);
  assert("alert: other alert keys and false flags are ignored",
    undismissedBandIds(["b1"], { "alert-catchup": true, [unattributedAlertDismissKey(["b1"])]: false }), ["b1"]);

  const un = (id, wk, day) => newBand(id, [{ studentId: "a", instrument: "Guitar" }], [entry("a", "Guitar", null)], { day });
  const wtt = {
    "2099-01-26|S": { lessons: [un("before", "2099-01-26", "Monday")] },
    "2099-02-02|S": { lessons: [un("inTerm1", "2099-02-02", "Thursday"), { id: "leg", isBandSession: true, members: [{ studentId: "a" }], removedLessons: [] }] },
    "2099-04-06|S": { lessons: [un("inTerm2", "2099-04-06", "Monday")] },
    "2099-04-20|S": { lessons: [un("after", "2099-04-20", "Monday")] },
  };
  const term = { start: "2099-02-02", end: "2099-04-10" };
  // v2.41.1 (D1): the scope is every week from the Monday of the anchor term's
  // start onwards, with no end limit. These replace the v2.41.0 term-only cases.
  assert("alert scope: from the term's first Monday on — later weeks included, earlier excluded, legacy excluded",
    unattributedBandsForAlert(wtt, term, {}).map(b => b.bandLessonId), ["inTerm1", "inTerm2", "after"]);
  const wttLater = { ...wtt, "2099-07-20|S": { lessons: [un("laterTerm", "2099-07-20", "Wednesday")] } };
  assert("alert scope: a band in a later term is included",
    unattributedBandsForAlert(wttLater, term, {}).map(b => b.bandLessonId), ["inTerm1", "inTerm2", "after", "laterTerm"]);
  assert("alert scope: a mid-week term start keeps that week's band",
    unattributedBandsForAlert(wtt, { start: "2099-02-04", end: "2099-04-10" }, {}).map(b => b.bandLessonId), ["inTerm1", "inTerm2", "after"]);
  assert("alert scope: fromWeekKey compares ISO week keys",
    findUnattributedBands(wtt, { fromWeekKey: "2099-04-06" }).map(b => b.bandLessonId), ["inTerm2", "after"]);
  assert("alert: no term → nothing", unattributedBandsForAlert(wtt, null, {}), []);
  assert("alert: dismissed set hides the chip",
    unattributedBandsForAlert(wtt, term, { [unattributedAlertDismissKey(["inTerm1", "inTerm2", "after"])]: true }), []);
  const wtt2 = { ...wtt, "2099-03-02|S": { lessons: [un("fresh", "2099-03-02", "Tuesday")] } };
  assert("alert: a new unattributed band reappears after dismissal",
    unattributedBandsForAlert(wtt2, term, { [unattributedAlertDismissKey(["inTerm1", "inTerm2", "after"])]: true }).map(b => b.bandLessonId), ["fresh"]);

  // The Dashboard resolves the anchor term with catch-ups owed's rule.
  const interruptions = [
    { type: "term_break", date: "2099-01-01", endDate: "2099-02-01" },
    { type: "term_break", date: "2099-04-11", endDate: "2099-04-26" },
  ];
  const wtt3 = { ...wtt, "2099-04-27|S": { lessons: [un("nextTerm", "2099-04-27", "Monday")] } };
  const inTerm = resolveAnchorTerm(interruptions, "2099-03-02");
  const inHols = resolveAnchorTerm(interruptions, "2099-04-13");
  assert("alert scope: during term — this term onwards",
    unattributedBandsForAlert(wtt3, inTerm && inTerm.term, {}).map(b => b.bandLessonId), ["inTerm1", "inTerm2", "after", "nextTerm"]);
  assert("alert scope: in the holidays — the just-finished term AND the following term",
    unattributedBandsForAlert(wtt3, inHols && inHols.term, {}).map(b => b.bandLessonId), ["inTerm1", "inTerm2", "after", "nextTerm"]);

  // The owner's case, 1 Oct 2026 (Holidays Week 2, spring break 2026-09-19 →
  // 2026-10-04): a term 4 band must be listed. No real-clock read — today's
  // Monday is passed to resolveAnchorTerm as a string.
  const breaks2026 = [
    { type: "term_break", date: "2026-06-27", endDate: "2026-07-12" },
    { type: "term_break", date: "2026-09-19", endDate: "2026-10-04" },
  ];
  const anchor2026 = resolveAnchorTerm(breaks2026, "2026-09-28");
  const wtt2026 = {
    "2026-06-22|S": { lessons: [un("t2", "2026-06-22", "Monday")] },
    "2026-08-03|S": { lessons: [un("t3", "2026-08-03", "Monday")] },
    "2026-10-12|S": { lessons: [un("t4", "2026-10-12", "Thursday")] },
  };
  assert("alert scope: 1 Oct 2026 anchors on term 3 (holidays)",
    [anchor2026 && anchor2026.inBreak, anchor2026 && anchor2026.term.start, anchor2026 && anchor2026.term.end], [true, "2026-07-13", "2026-09-18"]);
  assert("alert scope: 1 Oct 2026 — v2.41.0's term-only weeks did not reach term 4",
    termWeekKeys(anchor2026.term).includes("2026-10-12"), false);
  assert("alert scope: 1 Oct 2026 — the term 4 band is now listed (term 2 band is not)",
    unattributedBandsForAlert(wtt2026, anchor2026.term, {}).map(b => b.bandLessonId), ["t3", "t4"]);
}

export function runParentEmailStudentTests(assert) {
  assert("day email: individual card", parentEmailStudentIds({ id: "c", studentId: "a" }, []), ["a"]);
  assert("day email: group card", parentEmailStudentIds({ id: "g", isGroup: true, studentIds: ["a", "b"] }, []), ["a", "b"]);
  assert("day email: card without a student", parentEmailStudentIds({ id: "x" }, []), []);
  assert("day email: nothing", parentEmailStudentIds(null, []), []);
  const legacy = { id: "L", isBandSession: true, members: [{ studentId: "a" }, { studentId: "b" }], removedLessons: [] };
  assert("day email: legacy band → members[] as listed", parentEmailStudentIds(legacy, []), ["a", "b"]);
  const band = newBand("B", ["reg", "absReg", "cu", "free", "nis", "unset"].map(s => ({ studentId: s, instrument: "Guitar" })), [
    entry("reg", "Guitar", "regular"), entry("absReg", "Guitar", "regular"),
    entry("cu", "Guitar", "catchup", { attended: false, absence: { reason: "sick" } }),
    entry("free", "Guitar", "free"), entry("nis", "Guitar", "not_in_session"), entry("unset", "Guitar", null),
  ]);
  const missed = [{ bandLessonId: "B", enrolmentId: "e_absReg_Guitar", studentId: "absReg", instrument: "Guitar" }];
  assert("day email: new band → attending + unattributed only", parentEmailStudentIds(band, missed), ["reg", "free", "unset"]);
}
