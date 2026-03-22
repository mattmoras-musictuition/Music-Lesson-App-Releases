// ============================================================
// CONSTANTS
// All app-wide constants live here. Import what you need.
// ============================================================

export const INSTRUMENTS = [
  "Piano", "Guitar", "Violin", "Viola", "Cello", "Double Bass",
  "Flute", "Clarinet", "Saxophone", "Trumpet", "Trombone", "Tuba",
  "French Horn", "Oboe", "Bassoon", "Drums", "Voice",
  "Ukulele", "Recorder", "Bass Guitar"
];

export const APP_VERSION = "1.7.1";
export const HEADER_HEIGHT = 90; // Height of page banners and logo box
export const TIMEZONE = "Australia/Melbourne";

export const DATA_VERSION = 2;
// v1 → v2: added weekLabel to tallyEntries (was only weekKey)
// Migration runs on load for any stored data missing required fields.

export const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

export const SLOT_TYPES = ["class", "recess", "lunch", "before_school", "after_school"];
export const SLOT_TYPE_LABELS = {
  class: "Class Period",
  recess: "Recess",
  lunch: "Lunch",
  before_school: "Before School",
  after_school: "After School"
};

export const TALLY_REASONS = [
  { value: "informed_absence",    label: "Informed Absence",         makeupEligible: true },
  { value: "uninformed_absence",  label: "Uninformed Absence",       makeupEligible: false },
  { value: "school_interruption", label: "School Interruption",      makeupEligible: true },
  { value: "teacher_absent",      label: "Teacher Absent",           makeupEligible: true },
  { value: "timetable_clash",     label: "Timetable Clash",          makeupEligible: true },
  { value: "other",               label: "Other",                    makeupEligible: null }, // null = user chooses
  { value: "removed_not_charged", label: "Removed – Not Charged",    makeupEligible: false, invisible: true },
  { value: "extended_absence",    label: "Extended Absence",         makeupEligible: false, invisible: true },
];

export const STORAGE_KEYS = {
  schools:                "mt-schools",
  schoolsBak:             "mt-schools-bak",
  students:               "mt-students",
  studentsBak:            "mt-students-bak",
  teachers:               "mt-teachers",
  timetable:              "mt-timetable",
  specialists:            "mt-specialists",
  specialistsBak:         "mt-specialists-bak",
  interruptions:          "mt-interruptions",
  groups:                 "mt-groups",
  weeklyTimetables:       "mt-weekly",
  tallyEntries:           "mt-tally",
  timetableVersions:      "mt-tt-versions",
  masterBreaks:           "mt-master-breaks",
  lastScheduledBackup:    "mt-last-sched-bak",
  backupFolder:           "mt-backup-folder",
  timetableFolder:        "mt-timetable-folder",
  weeklyVersions:         "mt-wtt-versions",
  contacts:               "mt-contacts",
  bands:                  "mt-bands",
  autoProcessedDays:      "mt-auto-processed-days",
  resources:              "mt-resources",
  emailTemplates:         "mt-email-templates",
  userTemplates:          "mt-user-templates",
  lastNewsletterScan:     "mt-last-newsletter-scan",
  tokenUsage:             "mt-token-usage",
  claudeBudget:           "mt-claude-budget",
  claudePersonalContext:  "mt-claude-personal-context",
  claudeMessages:         "mt-claude-messages",
  claudeMemory:           "mt-claude-memory",
  todoItems:              "mt-todo-items",
  emailPinned:            "mt-email-pinned",
  emailSuppress:          "mt-email-suppress",
  emailSummaryCache:      "mt-email-summary-cache",
  inboxCache:             "mt-inbox-cache",
  inboxReadIds:           "mt-inbox-read-ids",
  inboxArchivedIds:       "mt-inbox-archived-ids",
  dashPanels:             "mt-dash-panels",
  alertDismissals:        "mt-alert-dismissals",
  emailCategoryOverrides: "mt-email-category-overrides",
  emailNoReplyOverrides:  "mt-email-noreply-overrides",
  emailManuallyUnpinned:  "mt-email-manually-unpinned",
};

// ── Colour maps ──────────────────────────────────────────────────────────────

export const instruments_colors = {
  Piano: "#ffb3ff", Guitar: "#8cc183", Violin: "#C47A6A", Viola: "#B07CD4",
  Cello: "#D45B5B", Flute: "#5BBDD4", Clarinet: "#D4C65B", Saxophone: "#D48B5B",
  Trumpet: "#C4A05B", Drums: "#ae85ad", Voice: "#6B9FD4", Ukulele: "#ebc382",
  Group: "#D97706", Band: "#9E6B8A", default: "#888"
};

export const colors = {
  bg: "#F8EFED",
  sidebar: "#1B2432",
  sidebarHover: "#263347",
  sidebarActive: "#344565",
  accent: "#C47A6A",
  accentLight: "#F0DEDA",
  accentDark: "#A35E50",
  text: "#2D2D2D",
  textLight: "#6B6B6B",
  textMuted: "#9B9B9B",
  white: "#FFFFFF",
  border: "#E8E5E0",
  borderLight: "#F0EDE8",
  success: "#4A9B6E",
  warning: "#D97706",
  danger: "#C45454",
  cardBg: "#FFFFFF",
  inputBg: "#FFFFFF",
  inputBorder: "#D8D5D0",
  tagBg: "#F0EDE8",
  // Semantic greys / status colours
  gray700: "#374151",
  gray500: "#6B7280",
  gray400: "#9CA3AF",
  amber: "#D97706",
  amberLight: "#FFF7ED",
  amberDark: "#92400E",
  red600: "#DC2626",
  redLight: "#FEF2F2",
  blue600: "#2563EB",
  blueLight: "rgba(52,69,101,0.07)",
  purple700: "#7C3AED",
  purpleLight: "#EDE9F6",
  green600: "#16A34A",
  purple600: "#5B21B6",
  specialistTag: "#8B5CF6",
};

// ── Email template system ────────────────────────────────────────────────────

export const ALL_MERGE_FIELDS = [
  { tag: "{{student_name}}",       label: "Student name" },
  { tag: "{{parent_name}}",        label: "Parent name" },
  { tag: "{{instrument}}",         label: "Instrument" },
  { tag: "{{day}}",                label: "Day" },
  { tag: "{{lesson_time}}",        label: "Lesson time" },
  { tag: "{{week_label}}",         label: "Week label" },
  { tag: "{{teacher_name}}",       label: "Teacher name" },
  { tag: "{{school_name}}",        label: "School name" },
  { tag: "{{class_name}}",         label: "Class name" },
  { tag: "{{absence_reason}}",     label: "Absence reason" },
  { tag: "{{specialist_subject}}", label: "Specialist subject" },
  { tag: "{{band_name}}",          label: "Band name" },
  { tag: "{{sender_name}}",        label: "Sender name" },
];

export const EMAIL_TRIGGERS = [
  { id: "lesson_parent",       label: "Lesson card → Parent",                   recipientHint: "Parent",              fields: ["student_name","parent_name","instrument","day","lesson_time","week_label","teacher_name","school_name","class_name"] },
  { id: "lesson_class_teacher",label: "Lesson card → Class Teacher",            recipientHint: "Class Teacher",       fields: ["student_name","class_name","instrument","day","lesson_time","teacher_name","school_name","week_label"] },
  { id: "lesson_music_teacher",label: "Lesson card → Music Teacher",            recipientHint: "Music Teacher",       fields: ["student_name","instrument","day","lesson_time","week_label","school_name","class_name"] },
  { id: "tally_missed",        label: "Tally → Missed lesson (parent)",         recipientHint: "Parent",              fields: ["student_name","parent_name","instrument","day","lesson_time","week_label","absence_reason","teacher_name","school_name"] },
  { id: "wtt_missed_parent",   label: "Weekly timetable → Missed zone (parent)",recipientHint: "Parent",              fields: ["student_name","parent_name","instrument","day","lesson_time","week_label","teacher_name","school_name"] },
  { id: "wtt_day_header",      label: "Weekly timetable → Day header email",    recipientHint: "Parent or Teacher",   fields: ["day","school_name","week_label","teacher_name"] },
  { id: "contacts_group",      label: "Contacts → Group email",                 recipientHint: "Group",               fields: ["school_name","sender_name"] },
  { id: "contacts_individual", label: "Contacts → Individual contact",          recipientHint: "Contact",             fields: ["school_name","sender_name"] },
  { id: "bands_parent",        label: "Bands → Parent email",                   recipientHint: "Parent",              fields: ["band_name","student_name","parent_name","school_name","week_label"] },
  { id: "timetable_send",      label: "Export → Send timetable",                recipientHint: "Teacher / Parent / Admin", fields: ["school_name","class_name","day","teacher_name","week_label"] },
  { id: "sidebar_compose",     label: "Sidebar → New email (blank)",            recipientHint: "Any",                 fields: ["sender_name","school_name"] },
  { id: "todo_missed_lesson",  label: "To-do → Missed lesson (parent)",         recipientHint: "Parent",              fields: ["student_name","parent_name","instrument","absence_reason","teacher_name","school_name"] },
  { id: "todo_missed_group",   label: "To-do → Missed lesson group (all parents)", recipientHint: "Parent",           fields: ["student_name","parent_name","school_name"] },
  { id: "todo_catchup",        label: "To-do → Catch-up lesson (parent)",       recipientHint: "Parent",              fields: ["student_name","parent_name","instrument","teacher_name","school_name"] },
  { id: "todo_catchup_group",  label: "To-do → Catch-up group (all parents)",   recipientHint: "Parent",              fields: ["student_name","parent_name","school_name"] },
  { id: "todo_pending",        label: "To-do → Pending / trial enrolment (parent)", recipientHint: "Parent",          fields: ["student_name","parent_name","instrument","school_name"] },
  { id: "todo_email",          label: "To-do → Reply to email",                 recipientHint: "Sender",              fields: ["sender_name","school_name"] },
  { id: "todo_reply",          label: "To-do → Reply to email (sub-item)",      recipientHint: "Sender",              fields: ["sender_name","school_name"] },
  { id: "todo_email_group",    label: "To-do → Reply to group email thread",    recipientHint: "Multiple senders",    fields: ["sender_name","school_name"] },
  { id: "todo_contact_parent", label: "To-do → Contact parent (sub-item)",      recipientHint: "Parent",              fields: ["student_name","parent_name","school_name"] },
];

export const TRIGGER_MAP = Object.fromEntries(EMAIL_TRIGGERS.map(t => [t.id, t]));

export const TALLY_EMAIL_TEMPLATES = {
  informed_absence: {
    subject: "{{student_name}}'s {{instrument}} lesson — {{week_label}}",
    body: "Hi {{parent_name}},\n\nJust a note that {{student_name}}'s {{instrument}} lesson on {{day}} ({{week_label}}) has been recorded as an informed absence.\n\nPlease get in touch if you have any questions.\n\nKind regards,",
  },
  uninformed_absence: {
    subject: "{{student_name}}'s {{instrument}} lesson — {{week_label}}",
    body: "Hi {{parent_name}},\n\nI wanted to follow up as {{student_name}} was absent for their {{instrument}} lesson on {{day}} ({{week_label}}) and we hadn't received any prior notice.\n\nCould you please let me know if everything is okay?\n\nKind regards,",
  },
  school_interruption: {
    subject: "{{student_name}}'s {{instrument}} lesson — {{week_label}}",
    body: "Hi {{parent_name}},\n\nJust letting you know that {{student_name}}'s {{instrument}} lesson on {{day}} ({{week_label}}) was missed due to a school interruption.\n\nWe'll be in touch about arranging a makeup lesson.\n\nKind regards,",
  },
  teacher_absent: {
    subject: "{{student_name}}'s {{instrument}} lesson — {{week_label}}",
    body: "Hi {{parent_name}},\n\nI wanted to let you know that {{student_name}}'s {{instrument}} lesson on {{day}} ({{week_label}}) was unfortunately missed as the teacher was unavailable.\n\nWe'll be in touch about arranging a makeup lesson.\n\nKind regards,",
  },
  timetable_clash: {
    subject: "{{student_name}}'s {{instrument}} lesson — {{week_label}}",
    body: "Hi {{parent_name}},\n\n{{student_name}}'s {{instrument}} lesson on {{day}} ({{week_label}}) was missed due to a timetable clash.\n\nWe'll be in touch about arranging a makeup lesson.\n\nKind regards,",
  },
  other: {
    subject: "{{student_name}}'s {{instrument}} lesson — {{week_label}}",
    body: "Hi {{parent_name}},\n\nJust a note regarding {{student_name}}'s {{instrument}} lesson on {{day}} ({{week_label}}).\n\nKind regards,",
  },
};

// ── Bands ────────────────────────────────────────────────────────────────────

export const BAND_LINK_CATEGORIES = ["Chord Chart", "Lyrics", "Track", "Sheet Music", "Other"];
export const BAND_COLOR = instruments_colors.Band;
export const BAND_INSTRUMENTS = ["Guitar", "Bass", "Drums", "Piano", "Voice", "Ukulele"];
export const BAND_INST_ABBR = { Guitar: "gtr", Bass: "bas", Drums: "drm", Piano: "pno", Voice: "vox", Ukulele: "uke" };
