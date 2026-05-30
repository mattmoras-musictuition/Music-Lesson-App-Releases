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

export const APP_VERSION = "2.11.1";
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
  { value: "school_interruption", label: "School Interruption",      makeupEligible: true,  invisible: true },
  { value: "teacher_absent",      label: "Teacher Absent",           makeupEligible: true },
  { value: "other",               label: "Other",                    makeupEligible: null }, // null = user chooses
  { value: "removed_not_charged", label: "Removed – Not Charged",    makeupEligible: false, invisible: true },
];

export const STORAGE_KEYS = {
  schools:                "mt-schools",
  schoolsBak:             "mt-schools-bak",
  students:               "mt-students",
  studentsBak:            "mt-students-bak",
  enrolments:             "mt-enrolments",
  teachers:               "mt-teachers",
  teacherCoverage:        "mt-teacher-coverage",
  viewedLanes:            "mt-viewed-lanes",
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
  resources:              "mt-resources",
  documents:              "mt-documents",
  emailTemplates:         "mt-email-templates",
  userTemplates:          "mt-user-templates",
  // Session 97: user-defined custom merge fields. Each entry is
  // { id, name, value }. `name` is the merge token (without braces).
  // `value` may reference other {{fields}} — applyMergeCtx recurses.
  // A custom field whose name matches a built-in takes precedence.
  customMergeFields:      "mt-custom-merge-fields",
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
  lessonChangeDismissals: "mt-lesson-change-dismissals",
  emailCategoryOverrides: "mt-email-category-overrides",
  emailNoReplyOverrides:  "mt-email-noreply-overrides",
  emailManuallyUnpinned:  "mt-email-manually-unpinned",
  darkMode:               "mt-dark-mode",
  missedReasons:          "mt-missed-reasons",
  browserPanelPos:        "mt-browser-pos",
  browserPanelSize:       "mt-browser-size",
  browserPanelUrl:        "mt-browser-url",
  browserPanelBookmarks:  "mt-browser-bookmarks",
  newsletterCheckState:   "mt-newsletter-check-state",
  invoiceSettings:        "mt-invoice-settings",
  invoiceRates:           "mt-invoice-rates",
  invoiceDrafts:          "mt-invoice-drafts",
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

// ── Dark mode colour palette ─────────────────────────────────────────────────
// Mirrors the shape of `colors` exactly so any component can swap them out.
// Sidebar colours are intentionally kept identical — the dark navy sidebar
// already looks at home in dark mode with only a slight deepening.

export const darkColors = {
  bg:              "#1C1A22",   // deep warm-dark background
  sidebar:         "#131118",   // slightly deeper than bg for definition
  sidebarHover:    "#263347",   // same as light
  sidebarActive:   "#344565",   // same as light
  accent:          "#C9A24A",   // muted gold — warm, reads well on dark
  accentLight:     "#2C2410",   // dark-tinted gold for subtle backgrounds
  accentDark:      "#D9B460",   // brighter gold for headings/text on dark bg
  text:            "#E8E3DF",   // warm off-white
  textLight:       "#A09890",   // medium warm grey
  textMuted:       "#6B6560",   // muted grey
  white:           "#FFFFFF",   // literal white — for text/icons on dark buttons
  border:          "#312D35",   // dark border
  borderLight:     "#27242C",   // darker border
  success:         "#4A9B6E",   // same
  warning:         "#D97706",   // same
  danger:          "#C45454",   // same
  cardBg:          "#26222E",   // dark card background
  inputBg:         "#1E1C24",   // dark input background
  inputBorder:     "#3D3942",   // dark input border
  tagBg:           "#2E2A36",   // dark tag background
  gray700:         "#D1D5DB",   // inverted — now light on dark bg
  gray500:         "#9CA3AF",
  gray400:         "#6B7280",
  amber:           "#D97706",
  amberLight:      "#2D2008",   // dark amber background
  amberDark:       "#FCD34D",   // light amber text for dark bg
  red600:          "#F87171",   // lightened for dark bg
  redLight:        "#2D1212",   // dark red background
  blue600:         "#60A5FA",   // lightened for dark bg
  blueLight:       "rgba(96,165,250,0.08)",
  purple700:       "#A78BFA",   // lightened for dark bg
  purpleLight:     "#2D2042",   // dark purple background
  green600:        "#4ADE80",   // lightened for dark bg
  purple600:       "#8B5CF6",
  specialistTag:   "#A78BFA",
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
  // Session 95: invoice_send trigger merge fields — populated by
  // _invoiceMergeCtx in InvoicingManager.js when an invoice is sent.
  { tag: "{{term_label}}",         label: "Term label" },
  { tag: "{{invoice_number}}",     label: "Invoice number" },
  { tag: "{{invoice_date}}",       label: "Invoice date" },
  { tag: "{{due_date}}",           label: "Due date" },
  { tag: "{{total}}",              label: "Invoice total" },
  { tag: "{{bsb}}",                label: "BSB" },
  { tag: "{{account}}",            label: "Account number" },
  { tag: "{{missed_clause}}",      label: "Missed-lessons clause" },
];

export const EMAIL_TRIGGERS = [
  { id: "lesson_parent",       label: "Lesson card → Parent",                   recipientHint: "Parent",              fields: ["student_name","parent_name","instrument","day","lesson_time","week_label","teacher_name","school_name","class_name"] },
  { id: "lesson_class_teacher",label: "Lesson card → Class Teacher",            recipientHint: "Class Teacher",       fields: ["student_name","class_name","instrument","day","lesson_time","teacher_name","school_name","week_label"] },
  { id: "lesson_music_teacher",label: "Lesson card → Music Teacher",            recipientHint: "Music Teacher",       fields: ["student_name","instrument","day","lesson_time","week_label","school_name","class_name"] },
  { id: "tally_missed",        label: "Tally → Missed lesson (parent)",         recipientHint: "Parent",              fields: ["student_name","parent_name","instrument","day","lesson_time","week_label","absence_reason","teacher_name","school_name"] },
  { id: "tally_end_of_term",   label: "Tally → End of term summary (parent)",   recipientHint: "Parent",              fields: ["student_name","parent_name","instrument","teacher_name","school_name","term_label","missed_count","catchup_owed","missed_lessons_detail"] },
  { id: "wtt_missed_parent",   label: "Weekly timetable → Missed zone (parent)",recipientHint: "Parent",              fields: ["student_name","parent_name","instrument","day","lesson_time","week_label","absence_reason","teacher_name","school_name"] },
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
  { id: "alert_missed",        label: "Alert → Missed lesson this week (parent)",recipientHint: "Parent",              fields: ["student_name","parent_name","instrument","day","lesson_time","week_label","absence_reason","teacher_name","school_name"] },
  { id: "alert_catchup",       label: "Alert → Catch-up owed (parent)",          recipientHint: "Parent",              fields: ["student_name","parent_name","instrument","teacher_name","school_name","week_label"] },
  // Session 95: invoice_send was being consumed by InvoicingManager.js but
  // never registered here, so the Templates editor dropdown never offered it.
  // Registering it exposes the trigger in the UI; mergeCtx is built by
  // _invoiceMergeCtx in InvoicingManager.js.
  { id: "invoice_send",        label: "Invoice → Send to parent",               recipientHint: "Parent",              fields: ["parent_name","student_name","instrument","invoice_number","total","due_date","invoice_date","term_label","bsb","account","missed_clause"] },
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
  other: {
    subject: "{{student_name}}'s {{instrument}} lesson — {{week_label}}",
    body: "Hi {{parent_name}},\n\nJust letting you know that {{student_name}}'s {{instrument}} lesson on {{day}} ({{week_label}}) was missed — {{absence_reason}}.\n\nKind regards,",
  },
};

// ── Bands ────────────────────────────────────────────────────────────────────

export const BAND_LINK_CATEGORIES = ["Chord Chart", "Lyrics", "Track", "Sheet Music", "Other"];
export const BAND_COLOR = instruments_colors.Band;
export const BAND_INSTRUMENTS = ["Guitar", "Bass", "Drums", "Piano", "Voice", "Ukulele"];
