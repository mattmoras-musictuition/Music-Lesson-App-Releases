// ============================================================
// BAND DISPLAY CHARACTERIZATION SMOKE TESTS
// Band Session Attribution cluster 6b, commit 2. Pins what the band card,
// its specialist tags, the hover popover and the export first-name line
// produce TODAY, for a legacy band and a new band, before cluster 6b changes
// which members they are fed. These must keep passing unchanged: 6b changes
// the member LIST at the call site, never these builders.
// ============================================================

import { bandCardMemberNames, bandSpecialistTags, bandPopoverMembers } from "./bandDisplay";
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
