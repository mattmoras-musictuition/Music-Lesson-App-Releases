// ============================================================
// BAND DISPLAY CHARACTERIZATION SMOKE TESTS
// Band Session Attribution cluster 6b, commit 2. Pins what the band card,
// its specialist tags, the hover popover and the export first-name line
// produce TODAY, for a legacy band and a new band, before cluster 6b changes
// which members they are fed. These must keep passing unchanged: 6b changes
// the member LIST at the call site, never these builders.
// ============================================================

import { bandCardMemberNames, bandSpecialistTags, bandPopoverMembers, bandPopoverGroups } from "./bandDisplay";
import { sessionMembers } from "./bandSessionView";
import { bandStudentFirstNames } from "./exportHelpers";

const STUDENTS = [
  { id: "amy", name: "Amy Smith", className: "3A" },
  { id: "amy2", name: "Amy Jones", className: "4B" },
  { id: "bob", name: "Bob (Robbie) Lee", class_name: "5C" },
  { id: "cat", name: "Cat", className: "" },
];

const MEMBERS = [
  { studentId: "amy", instrument: "Guitar" },
  { studentId: "amy2", instrument: "" },
  { studentId: "bob", instrument: "Drums" },
  { studentId: "gone", instrument: "Bass" },
  { studentId: "cat", instrument: "Vocals" },
];

const LEGACY = { id: "L", isBandSession: true, bandName: "Old", members: MEMBERS, removedLessons: [] };
const NEW = {
  id: "N", isBandSession: true, bandName: "New", members: MEMBERS, removedLessons: [],
  memberStates: [{ enrolmentId: "e_bob", studentId: "bob", instrument: "Drums", consumption: "not_in_session", catchupId: null, consumedWeekKey: null, fee: null, attended: null, writerTeacherId: null }],
};

export function runBandDisplayCharacterizationTests(assert) {
  // Card names: duplicate first names get a surname initial; unknown students skipped.
  const names = ["Amy S. (Guitar)", "Amy J.", "Bob (Drums)", "Cat (Vocals)"];
  assert("band display: card names, legacy members", bandCardMemberNames(LEGACY.members, STUDENTS), names);
  assert("band display: card names, new band members[] (pre-6b input)", bandCardMemberNames(NEW.members, STUDENTS), names);
  assert("band display: card names, single Amy → no initial",
    bandCardMemberNames([{ studentId: "amy", instrument: "Guitar" }], STUDENTS), ["Amy (Guitar)"]);
  assert("band display: card names, empty", bandCardMemberNames([], STUDENTS), []);

  // Specialist tags: minutes-based overlap, "Subject (First)", de-duplicated.
  const spec = {
    "S|3A|Monday": [{ start: 540, end: 600, subject: "Art" }],
    "S|4B|Monday": [{ start: 600, end: 660, subject: "PE" }, { start: 580, end: 590 }],
  };
  assert("band display: specialist tags overlap the slot",
    bandSpecialistTags(MEMBERS, STUDENTS, spec, "S", "Monday", { start: "09:30", end: "10:00" }), ["Art (Amy)", "Specialist (Amy)"]);
  assert("band display: specialist tags, zero-length slot",
    bandSpecialistTags(MEMBERS, STUDENTS, spec, "S", "Monday", { start: "09:15" }), ["Art (Amy)"]);
  assert("band display: specialist tags, no slot → none",
    bandSpecialistTags(MEMBERS, STUDENTS, spec, "S", "Monday", null), []);
  assert("band display: specialist tags, other day → none",
    bandSpecialistTags(MEMBERS, STUDENTS, spec, "S", "Tuesday", { start: "09:30", end: "10:00" }), []);

  // Popover rows.
  const fns = { displayName: (n) => "<" + n + ">", classTeacherName: (st) => (st.id === "amy" ? "Ms T" : "") };
  assert("band display: popover rows", bandPopoverMembers(LEGACY.members, STUDENTS, fns), [
    { name: "<Amy Smith>", instrument: "Guitar", className: "3A", classTeacher: "Ms T" },
    { name: "<Amy Jones>", instrument: "", className: "4B", classTeacher: "" },
    { name: "<Bob (Robbie) Lee>", instrument: "Drums", className: "5C", classTeacher: "" },
    { name: "<Cat>", instrument: "Vocals", className: "", classTeacher: "" },
  ]);

  // Export first names.
  assert("band display: export first names, legacy", bandStudentFirstNames(LEGACY, STUDENTS), "Amy, Amy, Bob, Cat");
  assert("band display: export first names, new band (pre-6b: full roster)", bandStudentFirstNames(NEW, STUDENTS), "Amy, Amy, Bob, Cat");
  assert("band display: export first names, non-band", bandStudentFirstNames({ studentId: "amy" }, STUDENTS), "");
  assert("band display: export first names, no students", bandStudentFirstNames(LEGACY, null), "");
}

// ── Cluster 6b commit 3: the builders fed the SESSION's members ──

const E = (studentId, instrument, consumption, extra = {}) => ({
  enrolmentId: `e_${studentId}`, studentId, instrument, consumption,
  catchupId: null, consumedWeekKey: null, fee: null, attended: null, writerTeacherId: null, ...extra,
});

export function runBandDisplaySessionTests(assert) {
  const fns = { displayName: (n) => n, classTeacherName: () => "", reasonLabel: (r, d) => (r === "sick" ? "Sick" : r) + (d ? ": " + d : "") };
  const strip = (rows) => rows.map(({ isFree, ...rest }) => rest);

  // Legacy: the session list IS members[], so every builder's output is byte-identical.
  assert("6b display: legacy card names unchanged via sessionMembers",
    bandCardMemberNames(sessionMembers(LEGACY, [{ bandLessonId: "L", studentId: "amy", instrument: "Guitar" }]), STUDENTS),
    bandCardMemberNames(LEGACY.members, STUDENTS));
  const spec = { "S|3A|Monday": [{ start: 540, end: 600, subject: "Art" }] };
  assert("6b display: legacy spec tags unchanged via sessionMembers",
    bandSpecialistTags(sessionMembers(LEGACY, []), STUDENTS, spec, "S", "Monday", { start: "09:30", end: "10:00" }),
    bandSpecialistTags(LEGACY.members, STUDENTS, spec, "S", "Monday", { start: "09:30", end: "10:00" }));
  assert("6b display: legacy export names unchanged with missed passed",
    bandStudentFirstNames(LEGACY, STUDENTS, []), bandStudentFirstNames(LEGACY, STUDENTS));
  const legacyGroups = bandPopoverGroups(LEGACY, [], STUDENTS, fns);
  assert("6b display: legacy popover — everyone attending, rows as before",
    [strip(legacyGroups.attending), legacyGroups.absent, legacyGroups.notInSession, legacyGroups.attending.every(r => r.isFree === false)],
    [bandPopoverMembers(LEGACY.members, STUDENTS, fns), [], [], true]);

  // New band: not-in-session, absent regular, absent catch-up drop from the card.
  const band = {
    id: "N2", isBandSession: true, bandName: "New", removedLessons: [],
    members: [
      { studentId: "amy", instrument: "Guitar" }, { studentId: "amy2", instrument: "Keys" },
      { studentId: "bob", instrument: "Drums" }, { studentId: "cat", instrument: "Vocals" },
    ],
    memberStates: [
      E("amy", "Guitar", "regular"),
      E("amy2", "Keys", "catchup", { attended: false, absence: { reason: "sick", reasonDetail: "", notes: "", makeupEligible: false } }),
      E("bob", "Drums", "not_in_session"),
      E("cat", "Vocals", "free"),
    ],
  };
  const missed = [];
  assert("6b display: new band card lists only the session",
    bandCardMemberNames(sessionMembers(band, missed), STUDENTS), ["Amy (Guitar)", "Cat (Vocals)"]);
  assert("6b display: dropping a same-first-name member drops the surname initial",
    bandCardMemberNames(sessionMembers(band, missed), STUDENTS)[0], "Amy (Guitar)");
  assert("6b display: new band export names, week export (missed passed)",
    bandStudentFirstNames(band, STUDENTS, missed), "Amy, Cat");
  assert("6b display: new band export names, no missed → full roster (unchanged default)",
    bandStudentFirstNames(band, STUDENTS), "Amy, Amy, Bob, Cat");
  const regAbsent = [{ bandLessonId: "N2", enrolmentId: "e_amy", studentId: "amy", instrument: "Guitar", reason: "other", reasonDetail: "camp" }];
  assert("6b display: regular absence drops from card and export",
    [bandCardMemberNames(sessionMembers(band, regAbsent), STUDENTS), bandStudentFirstNames(band, STUDENTS, regAbsent)],
    [["Cat (Vocals)"], "Cat"]);

  const g = bandPopoverGroups(band, regAbsent, STUDENTS, fns);
  assert("6b display: popover groups",
    [g.attending.map(r => [r.name, r.isFree]), g.absent.map(r => [r.name, r.absenceLabel]), g.notInSession.map(r => r.name)],
    [[["Cat", true]], [["Amy Smith", "Absent (other: camp)"], ["Amy Jones", "Absent (Sick)"]], ["Bob (Robbie) Lee"]]);
  const freeAbsent = { ...band, memberStates: [E("cat", "Vocals", "free", { attended: false })], members: [{ studentId: "cat", instrument: "Vocals" }] };
  assert("6b display: free absent with no reason reads 'Absent'",
    bandPopoverGroups(freeAbsent, [], STUDENTS, fns).absent.map(r => r.absenceLabel), ["Absent"]);
  const unset = { ...band, memberStates: [E("cat", "Vocals", null)], members: [{ studentId: "cat", instrument: "Vocals" }, { studentId: "gone", instrument: "Bass" }] };
  assert("6b display: unattributed shown as attending; unknown student skipped",
    bandPopoverGroups(unset, [], STUDENTS, fns).attending.map(r => [r.name, r.isFree]), [["Cat", false]]);
}
