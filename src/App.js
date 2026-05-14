// ============================================================
// App.js — Root component: MusicTimetableApp
// Refactored from monolithic App.js into modular structure.
// This file contains only the root component and wires together
// all pages, state, data loading, and handlers.
// ============================================================

import React, { useState, useEffect, useRef } from "react";
import { House, Calendar, CalendarDays, LayoutGrid, ClipboardCheck, GraduationCap, Clock, Palette, Building2, Guitar, BookUser, Library, Settings, Piano, MessageSquare, Lightbulb, Receipt } from "lucide-react";

// ── Constants & config ──────────────────────────────────────
import { colors as lightColors, darkColors, DAYS, STORAGE_KEYS, APP_VERSION, DATA_VERSION, TIMEZONE, HEADER_HEIGHT } from "./constants";
import { ThemeProvider } from "./context/ThemeContext";

// ── Auth & Supabase ──────────────────────────────────────────
import { supabase } from "./supabaseClient";
import { LoginScreen } from "./pages/LoginScreen";
import { loadSchoolsFromSupabase, syncSchoolsToSupabase } from "./utils/schoolsDB";
import { loadTeachersFromSupabase, syncTeachersToSupabase } from "./utils/teachersDB";
import { loadTeacherCoverageFromSupabase, findLaneId, getCardTeacherId, getDayLaneTeacher, insertTeacherCoverage, archiveTeacherCoverage } from "./utils/teacherCoverageDB";
import { loadLaneOverridesFromSupabase, upsertLaneOverride, deleteLaneOverride } from "./utils/laneOverridesDB";
import { loadCatchupsFromSupabase, deleteCatchup } from "./utils/catchupsDB";
import { loadStudentsFromSupabase, syncStudentsToSupabase } from "./utils/studentsDB";
import { loadEnrolmentsFromSupabase, syncEnrolmentsToSupabase, enrolmentIdFor, stampEnrolmentIds, instrumentsFromEnrolments } from "./utils/enrolmentsDB";
import { syncEnrolmentsFromInstruments } from "./utils/enrolmentSync";
import { runSpec1Commit5Transform } from "./utils/migrations/spec1c5";
import { loadContactsFromSupabase, syncContactsToSupabase } from "./utils/contactsDB";
import { loadGroupsFromSupabase, syncGroupsToSupabase } from "./utils/groupsDB";
import { loadBandsFromSupabase, syncBandsToSupabase } from "./utils/bandsDB";
import { loadResourcesFromSupabase, syncResourcesToSupabase } from "./utils/resourcesDB";
import { loadDocumentsFromSupabase, syncDocumentsToSupabase } from "./utils/documentsDB";
import { loadInterruptionsFromSupabase, syncInterruptionsToSupabase } from "./utils/interruptionsDB";
import { loadSpecialistsFromSupabase, syncSpecialistsToSupabase } from "./utils/specialistsDB";
import { loadMasterBreaksFromSupabase, syncMasterBreaksToSupabase } from "./utils/masterBreaksDB";
import { loadTallyEntriesFromSupabase, syncTallyEntriesToSupabase } from "./utils/tallyEntriesDB";
import { loadTimetableFromSupabase, syncTimetableToSupabase } from "./utils/timetableDB";
import { loadWeeklyAdjustmentsFromSupabase, syncWeeklyAdjustmentsToSupabase } from "./utils/weeklyAdjustmentsDB";
import { loadTeacherActualsFromSupabase, teacherActualsStorageKey, teacherActualsRowToEntry } from "./utils/teacherActualsDB";

// ── Utilities ───────────────────────────────────────────────
import { uid, melbourneNow, melbourneToday, toLocalDateStr, getCurrentWeekMonday, getTermWeekLabel, timeToMin, to12h, _getMondayOf, loadInstColorsFromSupabase, getLiveTeacherName, getStudentMTTTeacher } from "./utils/helpers";
import { getWttWeekKeysWithActivity, getWeekTallySummary, findOpenCatchups } from "./utils/tallyDerive";
import { computeTermWeekNum, computeTermKey } from "./utils/tallyHelpers";
import { migrateData, loadData, saveData, saveStudents, loadSchools, loadStudents, loadSpecialists, triggerAutoBackup } from "./utils/backup";
import { anthropicFetch, anthropicStreamChat, getAnthropicHeaders, setAnthropicApiKey } from "./utils/api";
import { parseSpecialistNotes, parseStudentNotes } from "./utils/claudeNotes";

// ── Data generators ─────────────────────────────────────────
import { generateMasterTimetable, compactTimetable, scheduleReadyGroups } from "./data/timetableGenerator";
import { printMasterTimetable } from "./data/weeklyTimetableGenerator";
import { runSmokeTests } from "./data/smokeTests";

// ── Shared UI ────────────────────────────────────────────────

// ── Components ───────────────────────────────────────────────
import { ComposeModal } from "./components/ComposeModal";
import { ExportDialog } from "./components/ExportDialog";
import { PageTitle, NavButtons, PAGE_COLORS } from "./components/ui/SharedUI";

// ── Pages ────────────────────────────────────────────────────
import { Dashboard } from "./pages/Dashboard";
import { BrowserPanel } from "./pages/BrowserPanel";
import { SchoolsManager } from "./pages/SchoolsManager";
import { TeachersManager } from "./pages/TeachersManager";
import { GroupsManager } from "./pages/GroupsManager";
import { BandsManager } from "./pages/BandsManager";
import { PendingManager } from "./pages/PendingManager";
import { DocumentsResourcesManager } from "./pages/DocumentsResourcesManager";
import { SpecialistManager } from "./pages/SpecialistManager";
import { CalendarManager } from "./pages/CalendarManager";
import { StudentsManager } from "./pages/StudentsManager";
import { TimetableView } from "./pages/TimetableView";
import { WeeklyAdjustments } from "./pages/WeeklyAdjustments";
import { ContactsManager } from "./pages/ContactsManager";
import { SettingsManager } from "./pages/SettingsManager";
import { TallyView } from "./pages/TallyView";
import { InvoicingManager } from "./pages/InvoicingManager";
import { MessagesView } from "./pages/MessagesView";

// ── Sonnet auto-switch triggers ──────────────────────────────────────────────
// When any of these keywords appear in the user's message, the model is
// temporarily upgraded to Sonnet for that request only, then reverts to Haiku.
// Attachments (images/PDFs) always trigger Sonnet regardless of text content.
const SONNET_AUTO_TRIGGERS = [
  // Document / image parsing
  "newsletter", "scan", "parse", "analyse", "analyze", "ocr",
  "what does this say", "what's in this", "read this", "look at this",
  // Scheduling complexity
  "find a spot", "fit everyone", "schedule all", "resolve conflict",
  "work out the schedule", "can you fit", "conflicts", "constraints",
  // Multi-step ambiguous
  "sort out everything", "sort out last week", "sort it all out",
  "catch me up", "what did i miss", "full rundown", "summary of last",
  // Voice notes (future)
  "voice note", "transcribe",
];

// ── Claude Context Triggers ──────────────────────────────────────────────────
// Keywords that determine which data sections are included in the system prompt.
// Stored in localStorage under "mt-context-triggers"; editable in Settings.
// Matching is case-insensitive substring — "parent" also matches "parents", "parent's".
// Short words (≤3 chars) use word-boundary matching to avoid false positives.
const DEFAULT_CONTEXT_TRIGGERS = {
  contacts:    ["email", "parent", "mum", "dad", "mother", "father", "guardian", "phone", "draft", "write to", "contact", "family", "ring", "call"],
  tally:       ["tally", "missed", "absent", "catch", "make up", "makeup", "owed", "outstanding", "attendance", "how many lesson", "lesson count", "been away"],
  specialists: ["specialist", "pullout", "pull out", "pe", "sport", "art class", "conflict", "overlap", "clash", "double-booked"],
  masterFull:  ["master", "regular schedule", "default schedule", "master timetable", "every week", "recurring", "generate"],
  pastWeeks:   ["last week", "previous week", "week before", "last monday", "last tuesday", "last wednesday", "last thursday", "last friday", "last term"],
  resources:   ["document", "resource", "wwcc", "insurance", "expiry", "expire", "working with children", "certificate"],
  groups:      ["group", "band", "ensemble", "choir"],
  catchup:     ["holiday", "catch-up", "catchup", "studio session", "makeup session", "make up lesson", "holidays"],
};

// Scans user message + recent history for context trigger keywords.
// Returns flags object — each flag = true means include that section.
function detectContextNeeds(message, history, triggers) {
  const t = triggers || DEFAULT_CONTEXT_TRIGGERS;
  // Gather text: current message + last 4 conversation turns
  const recentHistory = (history || []).slice(-8);
  const textToScan = [
    message || "",
    ...recentHistory.map(m => {
      if (typeof m.content === "string") return m.content;
      if (Array.isArray(m.content)) return m.content.filter(c => c.type === "text").map(c => c.text).join(" ");
      return "";
    }),
  ].join(" ").toLowerCase();

  const has = (words) => (words || []).some(w => {
    if (!w) return false;
    // Short words: require word boundary to avoid matching inside other words
    if (w.length <= 3) return new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(textToScan);
    return textToScan.includes(w.toLowerCase());
  });

  return {
    contacts:    has(t.contacts),
    tally:       has(t.tally),
    specialists: has(t.specialists),
    masterFull:  has(t.masterFull),
    pastWeeks:   has(t.pastWeeks),
    resources:   has(t.resources),
    groups:      has(t.groups),
    catchup:     has(t.catchup),
  };
}

// ── Claude Action Tool Definitions ──────────────────────────────────────────
// These are the tools Claude can call to make real changes in the app.
// Execution logic lives in executeTool() inside the component.
const ACTION_TOOLS = [
  {
    name: "mark_lesson_missed",
    description: "Record a missed lesson in the tally for a specific student on a specific date. Only call this when the user explicitly tells you a lesson was missed — never speculatively.",
    input_schema: {
      type: "object",
      properties: {
        studentId:     { type: "string", description: "The student's ID from the student roster" },
        studentName:   { type: "string", description: "Student's full name (for confirmation message)" },
        date:          { type: "string", description: "Date of the missed lesson in YYYY-MM-DD format" },
        instrument:    { type: "string", description: "Instrument or subject for this lesson" },
        reason:        { type: "string", enum: ["student_absent","informed_absence","uninformed_absence","teacher_absent","cancelled","other"], description: "Reason for the missed lesson" },
        reasonDetail:  { type: "string", description: "Optional free-text detail about the reason" },
        makeupEligible:{ type: "boolean", description: "Whether a catch-up lesson is owed. Default true for student_absent/informed_absence/uninformed_absence, false for cancelled." },
        notes:         { type: "string", description: "Optional notes to attach to this tally entry." },
      },
      required: ["studentId", "studentName", "date"],
    },
  },
  {
    name: "bulk_mark_missed",
    description: "Mark all scheduled lessons on a specific date as missed — optionally filtered to one school. Use when the user says an entire school day or teacher's day was cancelled.",
    input_schema: {
      type: "object",
      properties: {
        date:          { type: "string", description: "Date in YYYY-MM-DD format" },
        schoolId:      { type: "string", description: "Optional — only mark lessons at this school. Omit to affect all schools." },
        schoolName:    { type: "string", description: "School name for the confirmation message" },
        reason:        { type: "string", enum: ["student_absent","informed_absence","uninformed_absence","teacher_absent","cancelled","other"] },
        reasonDetail:  { type: "string", description: "Optional free-text detail" },
        makeupEligible:{ type: "boolean", description: "Whether catch-ups are owed. Default false for cancelled, true for others." },
      },
      required: ["date", "reason"],
    },
  },
  {
    name: "add_todo",
    description: "Add an item to the to-do list. When the todo involves a parent or contact, use @FullName in the text and include them in the mentions array — this renders their name as a clickable email link. Use subItems to break the task into independently tickable steps.",
    input_schema: {
      type: "object",
      properties: {
        text:    { type: "string", description: "The to-do item text. Use @FullName (e.g. '@Julia Kahan') for any parent or contact who should be a clickable email link." },
        priority:{ type: "string", enum: ["high","normal"], description: "Priority level. Default normal." },
        mentions: {
          type: "array",
          description: "People mentioned with @ in the text. Each becomes a clickable email link.",
          items: {
            type: "object",
            properties: {
              name:  { type: "string", description: "Full name exactly as written after @ in the text" },
              email: { type: "string", description: "Their email address" },
            },
            required: ["name", "email"],
          },
        },
        subItems: {
          type: "array",
          description: "Optional sub-tasks. Each renders as an independently tickable checkbox under the main item. Use when the task has distinct steps — e.g. emailing three different parents as separate sub-items. Sub-items can also have @mention links.",
          items: {
            type: "object",
            properties: {
              text:     { type: "string", description: "Sub-item text. Use @FullName for anyone who should be a clickable email link." },
              mentions: {
                type: "array",
                description: "People mentioned with @ in this sub-item's text.",
                items: {
                  type: "object",
                  properties: {
                    name:  { type: "string", description: "Full name exactly as written after @ in the sub-item text" },
                    email: { type: "string", description: "Their email address" },
                  },
                  required: ["name", "email"],
                },
              },
            },
            required: ["text"],
          },
        },
      },
      required: ["text"],
    },
  },
  {
    name: "add_reminder",
    description: "Add a reminder to the Reminders panel. A reminder with remindFromWeek stays hidden until Monday of that week, then appears. If eventWeek is set, an alert chip fires in the alerts bar the week before eventWeek, and the reminder stays visible until the end of eventWeek. Use remindFromWeek for 'remind me in week N', eventWeek for the week the event actually happens.",
    input_schema: {
      type: "object",
      properties: {
        text:           { type: "string", description: "The reminder text" },
        remindFromWeek: { type: "number", description: "Term week to START showing this reminder. Hidden until Monday of this week. Use when user says 'remind me in week N'." },
        eventWeek:      { type: "number", description: "The term week the event actually happens. An alert chip fires in the alerts bar the week before this. The reminder stays visible until the end of this week and shows a calendar dot during it." },
        date:           { type: "string", description: "Specific start date (YYYY-MM-DD). Use instead of remindFromWeek when the user gives a specific date." },
        studentName:    { type: "string", description: "Name of the student this reminder relates to, if applicable." },
        notes:          { type: "string", description: "Any additional context or detail to attach to the reminder." },
      },
      required: ["text"],
    },
  },
  {
    name: "draft_email",
    description: "Open the email compose window pre-filled. This ONLY drafts — it never sends automatically. The user must review and press Send themselves. Use for any email-related requests.",
    input_schema: {
      type: "object",
      properties: {
        to:      { type: "string", description: "Recipient email address" },
        subject: { type: "string", description: "Email subject line" },
        body:    { type: "string", description: "Email body text" },
      },
      required: ["subject", "body"],
    },
  },
  {
    name: "cancel_wtt_lesson",
    description: "Mark a lesson as cancelled (unscheduled) for a specific week in the weekly timetable. The lesson stays visible but is crossed out. Use this for genuine cancellations where NO tally entry is needed — e.g. school event, planned absence, teacher unavailable on that day. IMPORTANT: If the student was absent or missed the lesson and a tally entry is needed, use mark_lesson_missed instead — it uses the correct missed zone system and creates the tally entry.",
    input_schema: {
      type: "object",
      properties: {
        studentId:   { type: "string", description: "The student's ID from the roster" },
        studentName: { type: "string", description: "Student's full name (for confirmation)" },
        date:        { type: "string", description: "The date of the lesson to cancel in YYYY-MM-DD format" },
        instrument:  { type: "string", description: "Optional — if the student has multiple lessons on the same day, specify the instrument to cancel the correct one." },
        schoolId:    { type: "string", description: "Optional — the school ID to narrow the search." },
      },
      required: ["studentId", "studentName", "date"],
    },
  },
  {
    name: "mark_student_absent_week",
    description: "Mark all of a student's scheduled lessons in a given week as missed in the tally. Use when the user says a student will be away for the whole week.",
    input_schema: {
      type: "object",
      properties: {
        studentId:     { type: "string", description: "The student's ID from the roster" },
        studentName:   { type: "string", description: "Student's full name (for confirmation)" },
        weekOf:        { type: "string", description: "Any date within the target week in YYYY-MM-DD format. The Monday of that week will be used." },
        reason:        { type: "string", enum: ["student_absent","informed_absence","uninformed_absence","teacher_absent","cancelled","other"], description: "Reason for the missed lessons" },
        reasonDetail:  { type: "string", description: "Optional free-text detail" },
        makeupEligible:{ type: "boolean", description: "Whether catch-ups are owed. Default true for student_absent." },
      },
      required: ["studentId", "studentName", "weekOf", "reason"],
    },
  },
  {
    name: "move_wtt_lesson",
    description: "Move a student's lesson to a different day or time in the weekly timetable. Can move within the same week or to a different week. Use when the user asks to reschedule a specific lesson.",
    input_schema: {
      type: "object",
      properties: {
        studentId:   { type: "string", description: "The student's ID from the roster" },
        studentName: { type: "string", description: "Student's full name (for confirmation)" },
        fromDate:    { type: "string", description: "The current date of the lesson to move in YYYY-MM-DD format" },
        toDate:      { type: "string", description: "The new date for the lesson in YYYY-MM-DD format" },
        toStart:     { type: "string", description: "New start time in the same format as existing lesson times (e.g. '9:00' or '9:30 AM')" },
        toEnd:       { type: "string", description: "New end time (optional — if omitted, the original lesson duration is preserved)" },
        instrument:  { type: "string", description: "Optional — instrument to disambiguate if the student has multiple lessons that week" },
      },
      required: ["studentId", "studentName", "fromDate", "toDate", "toStart"],
    },
  },
  {
    name: "swap_student_lessons",
    description: "Swap the lesson times of two students within the same week in the weekly timetable. Each student takes the other's day and time slot. Use when the user says two students need to swap their lesson times.",
    input_schema: {
      type: "object",
      properties: {
        studentAId:         { type: "string", description: "ID of the first student" },
        studentAName:       { type: "string", description: "First student's full name (for confirmation)" },
        studentBId:         { type: "string", description: "ID of the second student" },
        studentBName:       { type: "string", description: "Second student's full name (for confirmation)" },
        weekOf:             { type: "string", description: "Any date within the target week in YYYY-MM-DD format" },
        studentAInstrument: { type: "string", description: "Optional — instrument for student A if they have multiple lessons that week" },
        studentBInstrument: { type: "string", description: "Optional — instrument for student B if they have multiple lessons that week" },
      },
      required: ["studentAId", "studentAName", "studentBId", "studentBName", "weekOf"],
    },
  },
  {
    name: "update_tally_entry",
    description: "Update an existing missed tally entry — correct the reason, reasonDetail, makeupEligible, or notes. Use when the user wants to adjust an already-recorded entry.",
    input_schema: {
      type: "object",
      properties: {
        studentId:     { type: "string", description: "The student's ID from the roster" },
        studentName:   { type: "string", description: "Student's full name (for confirmation)" },
        weekOf:        { type: "string", description: "Any date within the target week in YYYY-MM-DD format" },
        day:           { type: "string", description: "Day of the lesson (e.g. 'Thursday')" },
        instrument:    { type: "string", description: "Instrument — to disambiguate if the student has multiple lessons that week" },
        reason:        { type: "string", enum: ["student_absent","informed_absence","uninformed_absence","teacher_absent","cancelled","other"], description: "New reason (omit to leave unchanged)" },
        reasonDetail:  { type: "string", description: "New reason detail text (omit to leave unchanged)" },
        makeupEligible:{ type: "boolean", description: "Whether a catch-up is owed (omit to leave unchanged)" },
        notes:         { type: "string", description: "Notes to attach (omit to leave unchanged)" },
      },
      required: ["studentId", "studentName", "weekOf", "day"],
    },
  },
  {
    name: "mark_tally_completed",
    description: "Mark a missed tally entry as completed — the lesson was attended or made up. Changes status from missed to completed.",
    input_schema: {
      type: "object",
      properties: {
        studentId:   { type: "string", description: "The student's ID from the roster" },
        studentName: { type: "string", description: "Student's full name (for confirmation)" },
        weekOf:      { type: "string", description: "Any date within the target week in YYYY-MM-DD format" },
        day:         { type: "string", description: "Day of the lesson (e.g. 'Thursday')" },
        instrument:  { type: "string", description: "Instrument — to disambiguate if the student has multiple lessons that week" },
        madeUp:      { type: "boolean", description: "Whether this counts as a formal make-up lesson (default true)" },
      },
      required: ["studentId", "studentName", "weekOf", "day"],
    },
  },
  {
    name: "delete_tally_entry",
    description: "Permanently delete a tally entry. Use when a lesson was incorrectly recorded as missed and should be removed entirely.",
    input_schema: {
      type: "object",
      properties: {
        studentId:   { type: "string", description: "The student's ID from the roster" },
        studentName: { type: "string", description: "Student's full name (for confirmation)" },
        weekOf:      { type: "string", description: "Any date within the target week in YYYY-MM-DD format" },
        day:         { type: "string", description: "Day of the lesson (e.g. 'Thursday')" },
        instrument:  { type: "string", description: "Instrument — to disambiguate if the student has multiple lessons that week" },
      },
      required: ["studentId", "studentName", "weekOf", "day"],
    },
  },
  {
    name: "add_student",
    description: "Create a new student record with status 'pending'. Use when the user wants to add a new student to the system. The student will appear in the Pending tab and won't be on the timetable until scheduled.",
    input_schema: {
      type: "object",
      properties: {
        name:        { type: "string", description: "Student's full name" },
        schoolId:    { type: "string", description: "ID of the student's school from the schools list" },
        schoolName:  { type: "string", description: "School name (for confirmation)" },
        className:   { type: "string", description: "Student's class/year level (e.g. '3A', 'Year 5')" },
        instruments: {
          type: "array",
          description: "Instruments the student will learn",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Instrument name (e.g. 'Piano', 'Guitar')" },
            },
            required: ["name"],
          },
        },
        parentName:  { type: "string", description: "Primary parent/guardian name" },
        parentEmail: { type: "string", description: "Primary parent/guardian email" },
        parentPhone: { type: "string", description: "Primary parent/guardian phone number" },
        notes:       { type: "string", description: "Any scheduling notes or special requirements" },
      },
      required: ["name", "schoolId", "schoolName"],
    },
  },
  {
    name: "edit_student",
    description: "Update fields on an existing student record. Only include fields you want to change — omitted fields are left unchanged. Use for name corrections, class changes, parent contact updates, notes, or status changes.",
    input_schema: {
      type: "object",
      properties: {
        studentId:   { type: "string", description: "The student's ID from the roster" },
        studentName: { type: "string", description: "Student's current name (for confirmation)" },
        name:        { type: "string", description: "New name (omit to leave unchanged)" },
        schoolId:    { type: "string", description: "New school ID (omit to leave unchanged)" },
        className:   { type: "string", description: "New class/year level (omit to leave unchanged)" },
        instruments: {
          type: "array",
          description: "Replacement instruments list — replaces the entire instruments array. Omit to leave unchanged.",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Instrument name" },
            },
            required: ["name"],
          },
        },
        parentName:  { type: "string", description: "New primary parent/guardian name (omit to leave unchanged)" },
        parentEmail: { type: "string", description: "New primary parent/guardian email (omit to leave unchanged)" },
        parentPhone: { type: "string", description: "New primary parent/guardian phone (omit to leave unchanged)" },
        notes:       { type: "string", description: "New notes — replaces existing notes entirely (omit to leave unchanged)" },
        status:      { type: "string", enum: ["active", "pending"], description: "Change student status. Use 'active' to promote from pending, 'pending' to revert. Do NOT use this to archive — use archive_student instead." },
      },
      required: ["studentId", "studentName"],
    },
  },
  {
    name: "archive_student",
    description: "Archive a student — hides them from all active views (timetable, tally, student list) but keeps their record restorable. Use when a student has left or is no longer active. Do NOT use edit_student with a status field to archive.",
    input_schema: {
      type: "object",
      properties: {
        studentId:   { type: "string", description: "The student's ID from the roster" },
        studentName: { type: "string", description: "Student's name (for confirmation)" },
      },
      required: ["studentId", "studentName"],
    },
  },
  {
    name: "restore_student",
    description: "Restore a previously archived student back to 'pending' status so they appear in the active student list again.",
    input_schema: {
      type: "object",
      properties: {
        studentId:   { type: "string", description: "The student's ID" },
        studentName: { type: "string", description: "Student's name (for confirmation)" },
      },
      required: ["studentId", "studentName"],
    },
  },
  {
    name: "add_teacher",
    description: "Create a new teacher record. The teacher will immediately appear in the teachers list and can be assigned to students.",
    input_schema: {
      type: "object",
      properties: {
        name:        { type: "string", description: "Teacher's full name" },
        email:       { type: "string", description: "Teacher's email address" },
        instruments: {
          type: "array",
          description: "List of instrument names this teacher can teach",
          items: { type: "string", description: "Instrument name (e.g. 'Piano', 'Guitar')" },
        },
        availability: {
          type: "array",
          description: "Days and schools this teacher is available at",
          items: {
            type: "object",
            properties: {
              schoolId:   { type: "string", description: "School ID from the schools list" },
              schoolName: { type: "string", description: "School name (for confirmation)" },
              day:        { type: "string", description: "Day of the week (e.g. 'Monday')" },
              start:      { type: "string", description: "Availability start time (e.g. '9:00')" },
              end:        { type: "string", description: "Availability end time (e.g. '15:30')" },
            },
            required: ["schoolId", "day"],
          },
        },
      },
      required: ["name"],
    },
  },
  {
    name: "edit_teacher",
    description: "Update fields on an existing teacher record. Only include fields you want to change — omitted fields are left unchanged.",
    input_schema: {
      type: "object",
      properties: {
        teacherId:   { type: "string", description: "The teacher's ID from the teachers list" },
        teacherName: { type: "string", description: "Teacher's current name (for confirmation)" },
        name:        { type: "string", description: "New name (omit to leave unchanged)" },
        email:       { type: "string", description: "New email address (omit to leave unchanged)" },
        instruments: {
          type: "array",
          description: "Replacement instruments list — replaces the entire list. Omit to leave unchanged.",
          items: { type: "string", description: "Instrument name" },
        },
        availability: {
          type: "array",
          description: "Replacement availability list — replaces the entire list. Omit to leave unchanged.",
          items: {
            type: "object",
            properties: {
              schoolId: { type: "string", description: "School ID" },
              day:      { type: "string", description: "Day of the week" },
              start:    { type: "string", description: "Availability start time" },
              end:      { type: "string", description: "Availability end time" },
            },
            required: ["schoolId", "day"],
          },
        },
      },
      required: ["teacherId", "teacherName"],
    },
  },
  {
    name: "schedule_wtt_lesson",
    description: "Add a new lesson directly to the weekly timetable for a specific week. Use for one-off lessons that aren't on the regular master timetable — e.g. a catch-up, a trial, or an extra session. Does NOT affect the master timetable.",
    input_schema: {
      type: "object",
      properties: {
        studentId:   { type: "string", description: "Student's ID from the roster" },
        studentName: { type: "string", description: "Student's full name (for confirmation)" },
        teacherId:   { type: "string", description: "Teacher's ID from the teachers list" },
        teacherName: { type: "string", description: "Teacher's name (for confirmation)" },
        schoolId:    { type: "string", description: "School ID from the schools list" },
        schoolName:  { type: "string", description: "School name (for confirmation)" },
        weekOf:      { type: "string", description: "Any date within the target week in YYYY-MM-DD format. The Monday of that week will be used as the week key." },
        day:         { type: "string", description: "Day of the week for the lesson (e.g. 'Tuesday')" },
        start:       { type: "string", description: "Start time of the lesson (e.g. '10:00')" },
        end:         { type: "string", description: "End time of the lesson (e.g. '10:30')" },
        instrument:  { type: "string", description: "Instrument or subject for the lesson" },
      },
      required: ["studentId", "studentName", "teacherId", "teacherName", "schoolId", "schoolName", "weekOf", "day", "start", "end", "instrument"],
    },
  },
];

export default function MusicTimetableApp() {
  // ── Dev mode guard — prevents Supabase sync writes when running via npm run electron:start ──
  const isDev = process.env.NODE_ENV === "development";
  useEffect(() => { if (isDev) console.warn("[DEV MODE] Supabase sync writes are disabled. Data changes will only save to localStorage."); }, []);

  // ── Supabase Auth ────────────────────────────────────────────
  // session: null = not logged in, object = logged in
  // authLoading: true while we wait for getSession() on first mount
  const [session, setSession] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  // Stable string for dependency arrays — only changes on login/logout, not token refresh
  const sessionUserId = session?.user?.id || null;
  // Track sync skip warnings so the user sees them
  const syncSkipCountRef = useRef(0);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session: s }, error }) => {
      if (error) {
        console.warn("[auth] getSession error — signing out:", error.message);
        supabase.auth.signOut().catch(() => {});
        setSession(null);
      } else {
        setSession(s);
      }
      setAuthLoading(false);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
    });
    // Patch window.fetch to catch stale refresh token 400s globally
    const _origFetch = window.fetch;
    window.fetch = async (...args) => {
      const res = await _origFetch(...args);
      try {
        const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
        if (res.status === 400 && url.includes("/auth/v1/token") && url.includes("grant_type=refresh_token")) {
          console.warn("[auth] Refresh token rejected (400) — signing out");
          supabase.auth.signOut().catch(() => {});
        }
      } catch {}
      return res;
    };
    return () => { subscription.unsubscribe(); window.fetch = _origFetch; };
  }, []);

  // ── Supabase connectivity ping ───────────────────────────────
  // Checks reachability on mount and every 60s. Shows offline badge in sidebar
  // so Matt knows the app has silently fallen back to localStorage cache.
  useEffect(() => {
    const ping = async () => {
      try {
        const { error } = await supabase.from("schools").select("id").limit(1);
        setSupabaseOnline(!error);
      } catch {
        setSupabaseOnline(false);
      }
    };
    ping();
    const id = setInterval(ping, 60000);
    return () => clearInterval(id);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Teacher presence (Supabase Realtime Presence) ─────────────
  // Produces two outputs:
  //   1. teacherPresence — array of currently-online teachers, drives the
  //      "online" rows in the sidebar roster.
  //   2. offlineAt — map of teacherId → ISO string recording when a teacher
  //      who was online earlier in THIS admin session dropped out of
  //      presence. Used as the "last seen" timestamp for anyone who went
  //      offline mid-session, because the `teachers` React state is loaded
  //      once at admin startup and won't see the teacher app's heartbeat
  //      writes to teachers.last_seen during the session.
  useEffect(() => {
    const prevOnline = new Set();
    const channel = supabase.channel("teacher-presence", { config: { presence: { key: "admin" } } });
    channel.on("presence", { event: "sync" }, () => {
      const state = channel.presenceState();
      const byTeacher = {};
      const nowOnline = new Set();
      Object.entries(state).forEach(([key, presences]) => {
        if (key === "admin") return;
        const p = presences[presences.length - 1];
        if (p?.teacherId) {
          byTeacher[p.teacherId] = { teacherId: p.teacherId, name: p.name || "Teacher", color: p.color || null, page: p.page || "" };
          nowOnline.add(p.teacherId);
        }
      });
      // Session 95: fuller diagnostic so we can see exactly what admin
      // received in the sync. Was "sync: Object" before — useless when
      // debugging presence reliability issues.
      const justLeft = [...prevOnline].filter(id => !nowOnline.has(id));
      const justJoined = [...nowOnline].filter(id => !prevOnline.has(id));
      console.log("[presence] sync:", {
        onlineCount: nowOnline.size,
        online: Object.values(byTeacher).map(b => `${b.name}:${b.page}`),
        justJoined: [...justJoined],
        justLeft: [...justLeft],
      });
      setTeacherPresence(Object.values(byTeacher));
      // Anyone who was in prevOnline but isn't in nowOnline just left —
      // stamp them with the current time so the roster shows fresh "last seen".
      if (justLeft.length > 0) {
        const now = new Date().toISOString();
        setOfflineAt(prev => {
          const next = { ...prev };
          for (const id of justLeft) next[id] = now;
          return next;
        });
      }
      // Session 93 regression fix: anyone who REAPPEARED in presence — clear
      // their offlineAt entry. Otherwise the roster's effectiveLastSeenIso
      // keeps picking up the old quit-time from offlineAt (it wins the || chain
      // over the fresher liveLastSeen), the freshness check ages it out past
      // 90s, and the teacher shows as offline even though presence has them
      // online.
      if (nowOnline.size > 0) {
        setOfflineAt(prev => {
          let changed = false;
          const next = { ...prev };
          for (const id of nowOnline) {
            if (next[id] !== undefined) { delete next[id]; changed = true; }
          }
          return changed ? next : prev;
        });
      }
      prevOnline.clear();
      nowOnline.forEach(id => prevOnline.add(id));
    });
    channel.subscribe(async (status, err) => {
      console.log(`[presence] admin channel status: ${status}`, err || "");
      // Session 95 BUG 1 FIX: on SUBSCRIBED, track admin's own presence key.
      // This (a) ensures the channel has an active tracker rather than being
      // a pure listener, which tends to give more reliable sync delivery on
      // Supabase Realtime, and (b) on a reconnect, re-tracking forces a
      // fresh sync cycle rather than silently sitting with stale state.
      // The sync handler filters out the "admin" key so it doesn't appear
      // in the teacher roster.
      if (status === 'SUBSCRIBED') {
        try {
          await channel.track({ isAdmin: true, at: new Date().toISOString() });
        } catch (e) {
          console.warn('[presence] admin track failed:', e?.message || e);
        }
      }
    });
    return () => supabase.removeChannel(channel);
  }, []);

  const [page, _setPage] = useState("dashboard");
  const [focusStudentId, setFocusStudentId] = useState(null);
  const [newStudentPrefill, setNewStudentPrefill] = useState(null); // prefill data for new student form
  const [addParentPrefill, setAddParentPrefill] = useState(null);   // { name, email } — nav to students to pick a student then add parent
  const [newContactPrefill, setNewContactPrefill] = useState(null); // { name, email } — nav to contacts school section with prefilled row
  const [focusReturnPage, setFocusReturnPage] = useState(null);
  const [focusGroupId, setFocusGroupId] = useState(null);
  const [focusGroupReturnPage, setFocusGroupReturnPage] = useState(null);
  const [groupsBandsTab, setGroupsBandsTab] = useState("groups"); // "groups" | "bands"
  const [triggerNewGroup, setTriggerNewGroup] = useState(0);
  const [triggerNewBand, setTriggerNewBand] = useState(0);
  // masterBreaks: slot-specific breaks that survive regen { id, schoolId, day, time }
  const [masterBreaks, setMasterBreaks] = useState([]);
  const [pageHistory, setPageHistory] = useState(["dashboard"]);
  const [historyCursor, setHistoryCursor] = useState(0);
  const [resetKey, setResetKey] = useState(0); // increments to signal tab reset
  const mainScrollRef = useRef(null);
  const hoveredScrollRef = useRef(null); // points to whichever scrollable list the cursor is over
  const emailNavRef = useRef({ navigate: null }); // set by Dashboard to expose email keyboard navigation
  const emailListRef = useRef(null); // ref to email scroll container, set by Dashboard
  const filteredEmailsRef = useRef([]); // mirrors filteredEmails, set by Dashboard
  const todoUndoRef = useRef(null); // set by Dashboard — calls undo on todo list
  const sidebarRef = useRef(null);
  const sidebarWheelAttached = useRef(false);
  const sidebarRefCb = React.useCallback((el) => {
    sidebarRef.current = el;
    if (el && !sidebarWheelAttached.current) {
      sidebarWheelAttached.current = true;
      el.addEventListener("wheel", (e) => {
        // Don't hijack scroll if the event originated inside a scrollable child
        // (e.g. the Claude chat panel messages div)
        let target = e.target;
        while (target && target !== el) {
          if (target.scrollHeight > target.clientHeight + 2) {
            // This element is scrollable — let it handle its own scroll
            return;
          }
          target = target.parentElement;
        }
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && mainScrollRef.current) {
          e.preventDefault();
          mainScrollRef.current.scrollTop += e.deltaY;
        }
      }, { passive: false });
    }
  }, []);

  // Save scroll position for the given page into its viewState
  const saveScrollForPage = (pg) => {
    const st = mainScrollRef.current?.scrollTop || 0;
    const map = { timetable: setTtViewState, weekly: setWeeklyViewState, students: setStudentsViewState, schools: setSchoolsViewState, teachers: setTeachersViewState, "groups-bands": setGroupsViewState, tally: setTallyViewState, specialists: setSpecialistsViewState, calendar: setInterruptionsViewState, dashboard: setDashboardViewState, contacts: setContactsViewState, resources: setResourcesViewState, settings: setSettingsViewState, invoicing: setInvoicingViewState, messages: () => {} };
    if (map[pg]) map[pg](prev => ({ ...prev, scrollTop: st }));
  };

  // Restore scroll position for the given page from its viewState
  const getScrollForPage = (pg) => {
    const map = { timetable: ttViewState, weekly: weeklyViewState, students: studentsViewState, schools: schoolsViewState, teachers: teachersViewState, "groups-bands": groupsViewState, tally: tallyViewState, specialists: specialistsViewState, calendar: interruptionsViewState, dashboard: dashboardViewState, contacts: contactsViewState, resources: resourcesViewState, settings: settingsViewState, invoicing: invoicingViewState, messages: {} };
    return (map[pg] || {}).scrollTop || 0;
  };

  const resetViewStateForPage = (pg) => {
    const resets = {
      timetable: () => setTtViewState({ selectedSchool: "", viewMode: "grid", filterTeacher: "", scrollTop: 0, gridScroll: {} }),
      weekly: () => setWeeklyViewState({ selectedSchool: "", weekOffset: 0, showMissedTally: false, scrollTop: 0, gridScroll: {} }),
      students: () => setStudentsViewState({ filter: { school: "", className: "", instrument: "", teacher: "", search: "", hasNote: false, hasWarning: "" }, sortCol: "name", sortDir: "asc", scrollTop: 0 }),
      schools: () => setSchoolsViewState({ scrollTop: 0 }),
      teachers: () => setTeachersViewState({ scrollTop: 0 }),
      "groups-bands": () => setGroupsViewState({ filterSchool: "", scrollTop: 0 }),
      tally: () => setTallyViewState({ selectedSchool: "all", groupBy: "day_school", scrollTop: 0 }),
      specialists: () => setSpecialistsViewState({ filterSchool: "", filterClass: "", filterDay: "", filterSubject: "", scrollTop: 0 }),
      calendar: () => setInterruptionsViewState({ filterSchool: "", filterType: "", scrollTop: 0 }),
      dashboard: () => setDashboardViewState({ scrollTop: 0 }),
      contacts: () => setContactsViewState({ scrollTop: 0 }),
      resources: () => setResourcesViewState({ scrollTop: 0 }),
      settings: () => setSettingsViewState({ scrollTop: 0 }),
      invoicing: () => setInvoicingViewState({ scrollTop: 0 }),
    };
    if (resets[pg]) resets[pg]();
    if (mainScrollRef.current) mainScrollRef.current.scrollTop = 0;
  };

  const setPage = (newPage) => {
    if (newPage === page) {
      setResetKey(k => k + 1);
      resetViewStateForPage(newPage);
      return;
    }
    saveScrollForPage(page);
    const newHistory = [...pageHistory.slice(0, historyCursor + 1), newPage];
    setPageHistory(newHistory);
    setHistoryCursor(newHistory.length - 1);
    _setPage(newPage);
    requestAnimationFrame(() => { if (mainScrollRef.current) mainScrollRef.current.scrollTop = getScrollForPage(newPage); });
  };

  const goBack = () => {
    if (historyCursor <= 0) return;
    saveScrollForPage(page);
    const newCursor = historyCursor - 1;
    setHistoryCursor(newCursor);
    _setPage(pageHistory[newCursor]);
    requestAnimationFrame(() => { if (mainScrollRef.current) mainScrollRef.current.scrollTop = getScrollForPage(pageHistory[newCursor]); });
  };

  const goForward = () => {
    if (historyCursor >= pageHistory.length - 1) return;
    saveScrollForPage(page);
    const newCursor = historyCursor + 1;
    setHistoryCursor(newCursor);
    _setPage(pageHistory[newCursor]);
    requestAnimationFrame(() => { if (mainScrollRef.current) mainScrollRef.current.scrollTop = getScrollForPage(pageHistory[newCursor]); });
  };
  const [schools, setSchools] = useState([]);
  const [students, setStudents] = useState([]);
  const [enrolments, setEnrolments] = useState([]);
  const [teachers, setTeachersRaw] = useState([]);
  const teachersUndoStack = useRef([]);
  const teachersRedoStack = useRef([]);
  const ttPageActionSeq = useRef(0); // global sequence so we always undo most-recent action first
  const setTeachers = (valOrFn) => {
    setTeachersRaw(prev => {
      const newVal = typeof valOrFn === "function" ? valOrFn(prev) : valOrFn;
      teachersUndoStack.current.push({ seq: ++ttPageActionSeq.current, data: JSON.parse(JSON.stringify(prev)) });
      if (teachersUndoStack.current.length > 50) teachersUndoStack.current.shift();
      teachersRedoStack.current = [];
      return newVal;
    });
  };
  // Spec 2 cluster 4a — teacher_coverage lanes (one row per active
  // (school, day, teacher) tuple). No undo wrapper yet; lane mutations
  // arrive with the Add/Remove Staff UI in cluster 9.
  const [teacherCoverage, setTeacherCoverage] = useState([]);
  // Spec 2 cluster 6a — per-week substitution overrides on (week_key, bucket_id).
  // Empty until cluster 6c's substitution UI lands; resolution helper arrives in 6b.
  const [laneOverrides, setLaneOverrides] = useState([]);
  const [catchups, setCatchups] = useState([]);
  // Spec 2 cluster 8a — view-switching state for multi-teacher days.
  // Shape { [schoolId]: { [day]: laneId } }. localStorage-only (Q1).
  const [viewedLanes, setViewedLanes] = useState({});
  const [specialists, setSpecialists] = useState([]);
  const [interruptions, setInterruptions] = useState([]);
  const [groups, setGroups] = useState([]);
  const [bands, setBands] = useState([]);
  const [resources, setResources] = useState([]);
  const [documents, setDocuments] = useState([]);
  const [timetable, setTimetableRaw] = useState(null);
  const timetableUndoStack = useRef([]);
  const timetableRedoStack = useRef([]);
  // Combined undo stack that also captures students state (for pending placement)
  const pendingPlaceUndoStack = useRef([]);
  const pendingPlaceRedoStack = useRef([]);
  const setTimetable = (valOrFn) => {
    setTimetableRaw(prev => {
      const newVal = typeof valOrFn === "function" ? valOrFn(prev) : valOrFn;
      if (prev && prev !== newVal) {
        timetableUndoStack.current.push({ seq: ++ttPageActionSeq.current, data: JSON.parse(JSON.stringify(prev)) });
        if (timetableUndoStack.current.length > 50) timetableUndoStack.current.shift();
        timetableRedoStack.current = [];
      }
      return newVal;
    });
  };
  const undoTimetable = () => {
    if (timetableUndoStack.current.length === 0) return;
    setTimetableRaw(prev => {
      const item = timetableUndoStack.current.pop();
      timetableRedoStack.current.push({ seq: item.seq, data: JSON.parse(JSON.stringify(prev)) });
      return item.data;
    });
  };
  const redoTimetable = () => {
    if (timetableRedoStack.current.length === 0) return;
    setTimetableRaw(prev => {
      const item = timetableRedoStack.current.pop();
      timetableUndoStack.current.push({ seq: item.seq, data: JSON.parse(JSON.stringify(prev)) });
      return item.data;
    });
  };
  const undoTeachers = () => {
    if (teachersUndoStack.current.length === 0) return;
    setTeachersRaw(prev => {
      const item = teachersUndoStack.current.pop();
      teachersRedoStack.current.push({ seq: item.seq, data: JSON.parse(JSON.stringify(prev)) });
      return item.data;
    });
  };
  const redoTeachers = () => {
    if (teachersRedoStack.current.length === 0) return;
    setTeachersRaw(prev => {
      const item = teachersRedoStack.current.pop();
      teachersUndoStack.current.push({ seq: item.seq, data: JSON.parse(JSON.stringify(prev)) });
      return item.data;
    });
  };
  // Unified undo/redo for timetable page — picks the most recently pushed action across all stacks
  const undoTimetablePage = () => {
    const ttTop = timetableUndoStack.current[timetableUndoStack.current.length - 1];
    const teachTop = teachersUndoStack.current[teachersUndoStack.current.length - 1];
    const pendTop = pendingPlaceUndoStack.current[pendingPlaceUndoStack.current.length - 1];
    const tops = [ttTop, teachTop, pendTop].filter(Boolean);
    if (tops.length === 0) return;
    const latest = tops.reduce((a, b) => (b.seq > a.seq ? b : a));
    if (latest === pendTop) {
      const item = pendingPlaceUndoStack.current.pop();
      // Spec 2 cluster 10b Commit 2 — snapshot extended with enrolments + groups
      // so cross-teacher reassigns are reversible. Defensive guards: pre-cluster-10b
      // snapshots have undefined fields, skip those setters.
      pendingPlaceRedoStack.current.push({
        seq: item.seq,
        timetable: JSON.parse(JSON.stringify(timetable)),
        students: JSON.parse(JSON.stringify(students)),
        enrolments: JSON.parse(JSON.stringify(enrolments)),
        groups: JSON.parse(JSON.stringify(groups)),
      });
      setTimetableRaw(item.timetable);
      setStudents(item.students);
      if (item.enrolments !== undefined) setEnrolments(item.enrolments);
      if (item.groups !== undefined) setGroups(item.groups);
    } else if (latest === teachTop) {
      undoTeachers();
    } else {
      undoTimetable();
    }
  };
  const redoTimetablePage = () => {
    const ttTop = timetableRedoStack.current[timetableRedoStack.current.length - 1];
    const teachTop = teachersRedoStack.current[teachersRedoStack.current.length - 1];
    const pendTop = pendingPlaceRedoStack.current[pendingPlaceRedoStack.current.length - 1];
    const tops = [ttTop, teachTop, pendTop].filter(Boolean);
    if (tops.length === 0) return;
    const latest = tops.reduce((a, b) => (b.seq > a.seq ? b : a));
    if (latest === pendTop) {
      const item = pendingPlaceRedoStack.current.pop();
      pendingPlaceUndoStack.current.push({
        seq: item.seq,
        timetable: JSON.parse(JSON.stringify(timetable)),
        students: JSON.parse(JSON.stringify(students)),
        enrolments: JSON.parse(JSON.stringify(enrolments)),
        groups: JSON.parse(JSON.stringify(groups)),
      });
      setTimetableRaw(item.timetable);
      setStudents(item.students);
      if (item.enrolments !== undefined) setEnrolments(item.enrolments);
      if (item.groups !== undefined) setGroups(item.groups);
    } else if (latest === teachTop) {
      redoTeachers();
    } else {
      redoTimetable();
    }
  };
  const ttPageUndoCount = () => timetableUndoStack.current.length + teachersUndoStack.current.length + pendingPlaceUndoStack.current.length;
  const ttPageRedoCount = () => timetableRedoStack.current.length + teachersRedoStack.current.length + pendingPlaceRedoStack.current.length;
  const [weeklyTimetables, setWeeklyTimetablesRaw] = useState({}); // { "2025-W10|schoolId": { lessons, missed, notes } }
  const weeklyUndoStack = useRef([]);
  const weeklyRedoStack = useRef([]);
  const setWeeklyTimetables = (valOrFn) => {
    setWeeklyTimetablesRaw(prev => {
      const newVal = typeof valOrFn === "function" ? valOrFn(prev) : valOrFn;
      try { weeklyUndoStack.current.push(JSON.parse(JSON.stringify(prev))); } catch (e) { /* skip undo entry if state is not serialisable */ }
      if (weeklyUndoStack.current.length > 50) weeklyUndoStack.current.shift();
      weeklyRedoStack.current = [];
      // Prune oldest weeks — keep only the 52 most recent week dates (one full year)
      const allKeys = Object.keys(newVal);
      const uniqueWeekDates = [...new Set(allKeys.map(k => k.split("|")[0]))].sort();
      if (uniqueWeekDates.length > 52) {
        const toKeep = new Set(uniqueWeekDates.slice(-52));
        const pruned = {};
        for (const k of allKeys) { if (toKeep.has(k.split("|")[0])) pruned[k] = newVal[k]; }
        return pruned;
      }
      return newVal;
    });
  };
  const undoWeekly = () => {
    if (weeklyUndoStack.current.length === 0) return;
    setWeeklyTimetablesRaw(prev => {
      try { weeklyRedoStack.current.push(JSON.parse(JSON.stringify(prev))); } catch (e) { /* skip */ }
      return weeklyUndoStack.current.pop();
    });
  };
  const redoWeekly = () => {
    if (weeklyRedoStack.current.length === 0) return;
    setWeeklyTimetablesRaw(prev => {
      try { weeklyUndoStack.current.push(JSON.parse(JSON.stringify(prev))); } catch (e) { /* skip */ }
      return weeklyRedoStack.current.pop();
    });
  };
  // Teacher actuals — read-only mirror of teacher_actuals table for the
  // admin-side ghost layer (see WeeklyAdjustments). Teacher app writes;
  // drain_teacher_actuals cron drains past-day rows into weekly_adjustments
  // at 6pm Melbourne. Subscription-driven, no undo machinery.
  const [teacherActuals, setTeacherActuals] = useState({});
  // shape: { "weekKey|schoolId|teacherId": { lessons, missed, notes, updatedAt } }
  const teacherActualsRef = useRef(teacherActuals);
  const [tallyEntries, setTallyEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  // storageReady is set to true only after initial load confirms data came from storage.
  // Save effects are gated on this ref so an empty load fallback can never overwrite real saved data.
  const storageReady = useRef(false);
  const wttSyncDebounceRef = useRef(null); // debounce timer for weekly timetable Supabase sync
  const wttOwnWrittenAtRef = useRef({}); // { "weekKey|schoolId": updated_at } — timestamps we wrote ourselves
  const wttPollLastSeenRef = useRef({}); // { "weekKey|schoolId": updated_at } — last polled state
  const wttPendingWriteRef = useRef(false); // true while debounce is pending or write is in-flight — poll skips all updates
  // Refs for latest state values — used by auto-tally timer to avoid stale closures
  const weeklyTimetablesRef = useRef({});
  const timetableRef = useRef(null);
  const studentsRef = useRef([]);
  const enrolmentsRef = useRef([]);
  const interruptionsRef = useRef([]);
  const tallyEntriesRef = useRef([]);
  const schoolsRef = useRef([]);
  const [notification, setNotification] = useState(null);
  const [quickAddTodoTrigger, setQuickAddTodoTrigger] = useState(0);
  const [quickAddReminderTrigger, setQuickAddReminderTrigger] = useState(0);
  // Defined immediately after setNotification to prevent temporal dead zone in HMR
  // Toast colours: guitar green (success), coral/accent (warning), danger red (danger)
  const TOAST_COLORS = {
    success: "#8cc183",
    warning: "#C47A6A",
    danger:  "#C45454",
  };
  const notify = (msg, type = "success", duration = 3500) => {
    setNotification({ msg, type });
    setTimeout(() => setNotification(null), duration);
    if (type === "warning" || type === "danger") playUISound("toast_warning");
  };
  const [composeEmail, setComposeEmail] = useState(null); // null | { to[], from, subject, body }
  const [composeQueue, setComposeQueue] = useState([]); // queued sequential emails
  const [autoSendQueue, setAutoSendQueue] = useState([]); // { to, from, subject, bodyHtml, label }[]
  const autoSendTimerRef = React.useRef(null);
  const autoSendActiveRef = React.useRef(false);

  // ── Supabase connectivity ────────────────────────────────────
  // null = checking on startup, true = reachable, false = offline/fallback
  const [supabaseOnline, setSupabaseOnline] = useState(null);
  const [syncBadgeStartup, setSyncBadgeStartup] = useState(true);

  // ── Sidebar Claude panel ─────────────────────────────────────
  const [claudePanelOpen, setClaudePanelOpen] = useState(false);
  const [claudeInput, setClaudeInput] = useState("");
  // Undo for Claude Actions — stores a single pre-action snapshot
  const [hasClaudeUndo, setHasClaudeUndo] = useState(false);
  const claudeActionSnapshotRef = useRef(null);
  const [claudeMessages, setClaudeMessages] = useState(() => {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.claudeMessages) || "[]"); } catch(e) { return []; }
  });
  const [claudeLoading, setClaudeLoading] = useState(false);
  const [claudeAttachment, setClaudeAttachment] = useState(null);
  const [claudeDragOver, setClaudeDragOver] = useState(false);
  const [claudeMemory, setClaudeMemory] = useState(() => {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.claudeMemory) || "[]"); } catch(e) { return []; }
  });
  const [contextTriggers, setContextTriggers] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("mt-context-triggers") || "null");
      // Merge saved over defaults so new categories added later still appear
      return saved ? { ...DEFAULT_CONTEXT_TRIGGERS, ...saved } : DEFAULT_CONTEXT_TRIGGERS;
    } catch { return DEFAULT_CONTEXT_TRIGGERS; }
  });
  // Expose defaults to SettingsManager reset button (no import needed)
  React.useEffect(() => { window._getDefaultContextTriggers = () => ({ ...DEFAULT_CONTEXT_TRIGGERS }); }, []);
  const [claudeRememberOpen, setClaudeRememberOpen] = useState(false);
  const [claudeRememberInput, setClaudeRememberInput] = useState("");

  // ── Browser panel ─────────────────────────────────────────────
  const [browserPanelOpen, setBrowserPanelOpen] = useState(false);
  const [newsletterCheckState, setNewsletterCheckState] = useState(() => {
    try { return JSON.parse(localStorage.getItem("mt-newsletter-check-state") || "{}"); } catch { return {}; }
  });
  const browserPanelBadge = Object.values(newsletterCheckState).filter(v => v.hasNew).length;
  const clearNewsletterBadge = (schoolId) => {
    setNewsletterCheckState(prev => {
      if (!prev[schoolId]?.hasNew) return prev;
      const next = { ...prev, [schoolId]: { ...prev[schoolId], hasNew: false } };
      try { localStorage.setItem("mt-newsletter-check-state", JSON.stringify(next)); } catch {}
      return next;
    });
  };

  // Daily newsletter archive check — runs once at/after 10am Melbourne time per day
  useEffect(() => {
    const melbourneHour = () => {
      try { return parseInt(new Date().toLocaleString("en-US", { timeZone: "Australia/Melbourne", hour: "numeric", hour12: false }), 10); }
      catch { return new Date().getHours(); }
    };
    const runCheck = async () => {
      if (!window.electronAPI?.newsletterCheck) return;
      const schoolsWithUrls = schools.filter(s => s.newsletterUrl);
      if (!schoolsWithUrls.length) return;
      const today = new Date().toLocaleDateString("en-AU");
      let newState = { ...newsletterCheckState };
      let changed = false;
      for (const school of schoolsWithUrls) {
        const prev = newState[school.id] || {};
        if (prev.lastChecked === today) continue; // already done today
        try {
          const result = await window.electronAPI.newsletterCheck(school.newsletterUrl);
          if (!result.ok) continue;
          const sig = result.content.slice(0, 500) + String(result.content.length);
          newState[school.id] = { ...prev, lastChecked: today, contentSignature: sig, hasNew: !!(prev.contentSignature && sig !== prev.contentSignature) };
          changed = true;
        } catch {}
      }
      if (changed) {
        setNewsletterCheckState(newState);
        try { localStorage.setItem("mt-newsletter-check-state", JSON.stringify(newState)); } catch {}
      }
    };
    if (melbourneHour() >= 10) runCheck();
    const interval = setInterval(() => { if (melbourneHour() >= 10) runCheck(); }, 60 * 60 * 1000);
    return () => clearInterval(interval);
  }, [schools]); // eslint-disable-line react-hooks/exhaustive-deps
  const claudeInputRef = useRef(null);
  const claudeFileInputRef = useRef(null);
  const claudeMessagesEndRef = useRef(null);

  // ── Claude panel position + size (floating, persisted) ────────
  const DEFAULT_CLAUDE_W = 340;
  const DEFAULT_CLAUDE_H = 480;
  const [claudePanelPos, setClaudePanelPos] = useState(() => {
    try {
      const v = JSON.parse(localStorage.getItem("mt-claude-panel-pos"));
      if (v && typeof v.x === "number") {
        // Clamp to visible window so a stale off-screen position can't trap the panel
        return {
          x: Math.max(0, Math.min(v.x, (window.innerWidth || 1200) - 120)),
          y: Math.max(50, Math.min(v.y, (window.innerHeight || 800) - 40)),
        };
      }
    } catch {}
    return { x: 248, y: Math.max(0, (window.innerHeight || 800) - DEFAULT_CLAUDE_H) };
  });
  const [claudePanelSize, setClaudePanelSize] = useState(() => {
    try {
      const v = JSON.parse(localStorage.getItem("mt-claude-panel-size"));
      if (v && typeof v.w === "number") {
        // Clamp to window size so a stale oversized value can't trap the panel
        return {
          w: Math.min(v.w, (window.innerWidth || 1200) - 16),
          h: Math.min(v.h, (window.innerHeight || 800) - 16),
        };
      }
    } catch {}
    return { w: DEFAULT_CLAUDE_W, h: DEFAULT_CLAUDE_H };
  });
  const claudePanelDragRef = useRef(null);  // { startMouseX, startMouseY, startX, startY }
  const claudePanelResizeRef = useRef(null); // { handle, startMouseX, startMouseY, startX, startY, startW, startH }

  // Claude panel drag + resize global handlers
  // MIN_Y keeps the panel below the Electron title bar / drag region
  const CLAUDE_PANEL_MIN_Y = 50;
  useEffect(() => {
    const onMove = (e) => {
      const dx = e.clientX - (claudePanelDragRef.current?.startMouseX ?? e.clientX);
      const dy = e.clientY - (claudePanelDragRef.current?.startMouseY ?? e.clientY);
      if (claudePanelDragRef.current) {
        const newX = Math.max(0, Math.min(window.innerWidth - 120, claudePanelDragRef.current.startX + dx));
        const newY = Math.max(CLAUDE_PANEL_MIN_Y, Math.min(window.innerHeight - 40, claudePanelDragRef.current.startY + dy));
        setClaudePanelPos({ x: newX, y: newY });
      }
      if (claudePanelResizeRef.current) {
        const { handle, startMouseX, startMouseY, startX, startY, startW, startH } = claudePanelResizeRef.current;
        const rdx = e.clientX - startMouseX;
        const rdy = e.clientY - startMouseY;
        let nx = startX, ny = startY, nw = startW, nh = startH;
        const MIN_W = 280, MIN_H = 320;
        const MAX_W = window.innerWidth - 16;
        const MAX_H = window.innerHeight - CLAUDE_PANEL_MIN_Y - 16;
        if (handle.includes("e")) nw = Math.min(MAX_W, Math.max(MIN_W, startW + rdx));
        if (handle.includes("w")) { nw = Math.min(MAX_W, Math.max(MIN_W, startW - rdx)); nx = Math.max(0, startX + startW - nw); }
        if (handle.includes("s")) nh = Math.min(MAX_H, Math.max(MIN_H, startH + rdy));
        if (handle.includes("n")) { nh = Math.min(MAX_H, Math.max(MIN_H, startH - rdy)); ny = Math.max(CLAUDE_PANEL_MIN_Y, startY + startH - nh); }
        // Final clamp: ensure panel stays within window bounds after resize
        nw = Math.min(nw, window.innerWidth - nx);
        nh = Math.min(nh, window.innerHeight - ny);
        setClaudePanelPos({ x: nx, y: ny });
        setClaudePanelSize({ w: nw, h: nh });
      }
    };
    const onUp = () => {
      if (claudePanelDragRef.current) {
        try { localStorage.setItem("mt-claude-panel-pos", JSON.stringify(claudePanelPos)); } catch {}
        claudePanelDragRef.current = null;
      }
      if (claudePanelResizeRef.current) {
        try {
          localStorage.setItem("mt-claude-panel-pos", JSON.stringify(claudePanelPos));
          localStorage.setItem("mt-claude-panel-size", JSON.stringify(claudePanelSize));
        } catch {}
        claudePanelResizeRef.current = null;
      }
    };
    // Re-clamp panel when window is resized or fullscreen is toggled
    const onResize = () => {
      setClaudePanelPos(p => ({
        x: Math.max(0, Math.min(p.x, window.innerWidth - 120)),
        y: Math.max(CLAUDE_PANEL_MIN_Y, Math.min(p.y, window.innerHeight - 40)),
      }));
      setClaudePanelSize(s => ({
        w: Math.min(s.w, window.innerWidth - 16),
        h: Math.min(s.h, window.innerHeight - CLAUDE_PANEL_MIN_Y - 16),
      }));
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("resize", onResize);
    };
  }, [claudePanelPos, claudePanelSize]);

  // Auto-scroll chat to bottom when messages change
  useEffect(() => {
    claudeMessagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [claudeMessages, claudeLoading]);

  // Persist last 20 messages across sessions
  useEffect(() => {
    try {
      const toSave = claudeMessages.slice(-20).map(m => ({
        role: m.role,
        // Store only text for persisted messages — strip base64 attachments to keep storage lean
        content: typeof m.content === "string" ? m.content : (m.displayText || ""),
        displayText: m.displayText,
      }));
      localStorage.setItem(STORAGE_KEYS.claudeMessages, JSON.stringify(toSave));
    } catch(e) {}
  }, [claudeMessages]);

  const claudeDragCounter = useRef(0);
  useEffect(() => {
    const onEnter = (e) => {
      if (e.dataTransfer?.types?.includes("Files") || window._pendingAttachmentDrag) {
        claudeDragCounter.current += 1;
        setClaudeDragOver(true);
      }
    };
    const onLeave = () => {
      claudeDragCounter.current = Math.max(0, claudeDragCounter.current - 1);
      if (claudeDragCounter.current === 0) setClaudeDragOver(false);
    };
    const onReset = () => { claudeDragCounter.current = 0; setClaudeDragOver(false); };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onReset);
    window.addEventListener("dragend", onReset);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onReset);
      window.removeEventListener("dragend", onReset);
    };
  }, []);

  // ── Token usage tracker ──────────────────────────────────────
  // Stored as { "YYYY-MM": { inputTokens, outputTokens } }
  // Pricing (per million tokens): Haiku $0.80 in / $4 out, Sonnet $3 in / $15 out
  const MODEL_COSTS = {
    "claude-haiku-4-5-20251001": { in: 0.80, out: 4.00 },
    "claude-sonnet-4-6":         { in: 3.00, out: 15.00 },
  };
  const [tokenUsage, setTokenUsage] = useState(() => {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.tokenUsage) || "{}"); } catch(e) { return {}; }
  });
  const [sessionTokens, setSessionTokens] = useState({ inputTokens: 0, outputTokens: 0, costUSD: 0 });
  const [claudeBudget, setClaudeBudget] = useState(() => {
    try { return parseFloat(localStorage.getItem(STORAGE_KEYS.claudeBudget) || "10"); } catch(e) { return 10; }
  });
  const [claudePersonalContext, setClaudePersonalContext] = useState(() => {
    try { return localStorage.getItem(STORAGE_KEYS.claudePersonalContext) || ""; } catch(e) { return ""; }
  });
  const [emailStyle, setEmailStyle] = useState(() => {
    try { return localStorage.getItem("mt-email-style") || ""; } catch(e) { return ""; }
  });
  const [messengerDisplayName, setMessengerDisplayName] = useState(() => {
    try { return localStorage.getItem("mt-messenger-name") || ""; } catch { return ""; }
  });
  const [messengerBubbleColour, setMessengerBubbleColour] = useState(() => {
    try { return localStorage.getItem("mt-messenger-colour") || "#C47A6A"; } catch { return "#C47A6A"; }
  });
  const [messageBadgeCount, setMessageBadgeCount] = useState(0);
  const [teacherPresence, setTeacherPresence] = useState([]); // [{ teacherId, name, color, page }]
  // offlineAt tracks teachers who dropped out of presence during THIS admin
  // session. { [teacherId]: ISO timestamp }. Preferred over teachers.lastSeen
  // for anyone who was online this session — see presence useEffect for why.
  const [offlineAt, setOfflineAt] = useState({});
  // liveLastSeen mirrors teachers.last_seen, refreshed every 30s. Used by
  // the sidebar roster for two purposes: (1) the timestamp display itself
  // (so it stays current as teachers heartbeat), and (2) freshness-based
  // offline detection — if a teacher's last_seen is older than ~90s, treat
  // them as offline regardless of what Realtime presence says. Necessary
  // because presence's heartbeat-timeout disconnect detection can take
  // 30-90s for unclean app quits, and even Sign Out's WebSocket leave
  // frame doesn't always make it out before the renderer process dies.
  const [liveLastSeen, setLiveLastSeen] = useState({});
  // tick exists purely to force a roster re-render every 15s so the
  // freshness check (now - last_seen < 90s) re-evaluates against the
  // current wall clock. Without it, a teacher who quit silently would
  // stay shown as online until something else triggered a re-render.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(n => n + 1), 15000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const { data } = await supabase.from("teachers").select("id, last_seen");
        if (cancelled || !data) return;
        const map = {};
        for (const row of data) map[row.id] = row.last_seen;
        setLiveLastSeen(map);
      } catch (_) { /* non-fatal — display gracefully degrades */ }
    };
    poll();
    const id = setInterval(poll, 30000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);
  const [claudeModel, setClaudeModel] = useState(() => {
    try { return localStorage.getItem("mt-claude-model") || "claude-haiku-4-5-20251001"; } catch(e) { return "claude-haiku-4-5-20251001"; }
  });
  // true when the current request was auto-upgraded to Sonnet (reverts after response)
  const [claudeAutoSonnet, setClaudeAutoSonnet] = useState(false);
  const [apiStatus, setApiStatus] = useState("unknown"); // "ok" | "missing" | "error" | "unknown"

  // ── Voice notes ────────────────────────────────────────────────
  const [voiceNotes, setVoiceNotes] = useState(() => {
    try { return JSON.parse(localStorage.getItem("mt-voice-notes") || "[]"); } catch(e) { return []; }
  });
  const [voiceNotesModalOpen, setVoiceNotesModalOpen] = useState(false);
  const [isRecordingNote, setIsRecordingNote] = useState(false);
  const [isVoiceChat, setIsVoiceChat] = useState(false);
  const [clearVoiceNotesConfirm, setClearVoiceNotesConfirm] = useState(false);
  const [editingNoteId, setEditingNoteId] = useState(null);
  const [editingNoteText, setEditingNoteText] = useState("");
  const [playingNoteId, setPlayingNoteId] = useState(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const speechRecognitionRef = useRef(null);
  const voiceTranscriptRef = useRef("");
  const isRecordingRef = useRef(false);   // mirrors isRecordingNote — readable in stale closures
  const isVoiceChatRef = useRef(false);   // mirrors isVoiceChat — readable in stale closures
  const claudeSendRef = useRef(null); // set inside Claude panel IIFE each render

  // Persist voice notes (transcripts only — audio blobs stay in memory)
  useEffect(() => {
    try {
      const toSave = voiceNotes.map(({ audioDataUrl, ...rest }) => rest);
      localStorage.setItem("mt-voice-notes", JSON.stringify(toSave));
    } catch(e) {}
  }, [voiceNotes]);

  // ── Shared voice notes from teachers (Supabase) ─────────────────
  const [sharedVoiceNotes, setSharedVoiceNotes] = useState([]);

  useEffect(() => {
    let sub;
    const load = async () => {
      const { data } = await supabase.from("voice_notes").select("*").order("created_at", { ascending: false });
      setSharedVoiceNotes(data || []);
    };
    load();
    sub = supabase.channel("admin-voice-notes")
      .on("postgres_changes", { event: "*", schema: "public", table: "voice_notes" }, load)
      .subscribe();
    return () => { supabase.removeChannel(sub); };
  }, []);

  // ── teacher_actuals: initial load + realtime subscription ──────
  // Event-payload-driven (not full-reload) — applies the changed row
  // directly to the local map. DELETE handler is critical: the 6pm
  // drain cron deletes drained rows, which makes the corresponding
  // ghost entries fade automatically as the data has merged into
  // weekly_adjustments.
  useEffect(() => {
    let sub;
    const load = async () => {
      const data = await loadTeacherActualsFromSupabase();
      setTeacherActuals(data);
    };
    load();
    sub = supabase
      .channel("admin-teacher-actuals")
      .on("postgres_changes",
          { event: "*", schema: "public", table: "teacher_actuals" },
          (payload) => {
            setTeacherActuals((prev) => {
              const next = { ...prev };
              if (payload.eventType === "DELETE") {
                const old = payload.old;
                if (old?.week_key && old?.school_id && old?.teacher_id) {
                  delete next[teacherActualsStorageKey(old.week_key, old.school_id, old.teacher_id)];
                }
                return next;
              }
              const row = payload.new;
              if (!row?.week_key || !row?.school_id || !row?.teacher_id) {
                return prev;
              }
              next[teacherActualsStorageKey(row.week_key, row.school_id, row.teacher_id)] = teacherActualsRowToEntry(row);
              return next;
            });
          })
      .subscribe();
    return () => { supabase.removeChannel(sub); };
  }, []);

  const recordUsage = React.useCallback((model, inputTokens, outputTokens) => {
    const monthKey = new Date().toISOString().slice(0, 7); // "YYYY-MM"
    const costs = MODEL_COSTS[model] || MODEL_COSTS["claude-sonnet-4-6"];
    const cost = (inputTokens / 1e6) * costs.in + (outputTokens / 1e6) * costs.out;
    setSessionTokens(prev => ({
      inputTokens: prev.inputTokens + inputTokens,
      outputTokens: prev.outputTokens + outputTokens,
      costUSD: prev.costUSD + cost,
    }));
    setTokenUsage(prev => {
      const month = prev[monthKey] || { inputTokens: 0, outputTokens: 0, costUSD: 0 };
      const updated = {
        ...prev,
        [monthKey]: {
          inputTokens: month.inputTokens + inputTokens,
          outputTokens: month.outputTokens + outputTokens,
          costUSD: month.costUSD + cost,
        }
      };
      try { localStorage.setItem(STORAGE_KEYS.tokenUsage, JSON.stringify(updated)); } catch(e) {}
      return updated;
    });
  }, []);

  // Wire module-level openCompose() and openComposeQueue() to state setters
  useEffect(() => {
    // Always stamp a unique _queueKey so ComposeModal remounts fresh every time,
    // guaranteeing clean state and an up-to-date emailPool from current data.
    window._openComposeModal = (opts) => setComposeEmail({ ...opts, _queueKey: `compose-${Date.now()}` });
    window._openComposeQueue = (items) => {
      if (items.length === 0) return;
      const keyed = items.map((item, i) => ({ ...item, _queueKey: `${item.to?.[0]}-${i}-${Date.now()}` }));
      const [first, ...rest] = keyed;
      setComposeEmail(first);
      setComposeQueue(rest);
    };
    window._autoSendBatch = (items) => {
      if (!items || items.length === 0) return;
      setAutoSendQueue(prev => [...prev, ...items]);
    };
    // Bridge for Dashboard to send attachment to Claude panel
    window._claudeAcceptAttachment = (attData) => {
      setClaudeAttachment(attData);
      setClaudePanelOpen(true);
    };
  }, [setComposeEmail, setComposeQueue]);

  const [apiKey, setApiKey] = useState(() => {
    try { return localStorage.getItem("mt-api-key") || ""; } catch(e) { return ""; }
  });

  // ── Dark mode ────────────────────────────────────────────────
  const [darkMode, setDarkMode] = useState(() => {
    try { return localStorage.getItem(STORAGE_KEYS.darkMode) === "true"; } catch(e) { return false; }
  });
  const toggleDarkMode = () => setDarkMode(prev => !prev);

  const DEFAULT_SOUND_SETTINGS = { emailSend: true, emailReceive: true, drag: true, claude: true, tally: true, backup: true, notifications: true, messageSend: true, messageReceive: true };
  const [soundSettings, setSoundSettings] = useState(() => {
    try {
      const saved = localStorage.getItem("mt-sound-settings");
      if (saved) return { ...DEFAULT_SOUND_SETTINGS, ...JSON.parse(saved) };
    } catch {}
    return { ...DEFAULT_SOUND_SETTINGS };
  });
  const soundSettingsRef = React.useRef(soundSettings);
  React.useEffect(() => { soundSettingsRef.current = soundSettings; }, [soundSettings]);

  const playSound = React.useCallback((filename) => {
    const cat = filename === "email-send.mp3" ? "emailSend"
      : filename === "email-receive.mp3"   ? "emailReceive"
      : filename === "message-send.mp3"    ? "messageSend"
      : filename === "message-receive.mp3" ? "messageReceive"
      : "notifications";
    if (!soundSettingsRef.current[cat]) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      fetch(`sounds/${filename}`)
        .then(r => r.arrayBuffer())
        .then(buf => ctx.decodeAudioData(buf))
        .then(decoded => {
          const src = ctx.createBufferSource();
          src.buffer = decoded;
          src.connect(ctx.destination);
          src.start(0);
          src.onended = () => { try { ctx.close(); } catch {} };
        })
        .catch(() => { try { ctx.close(); } catch {} });
    } catch {}
  }, []);

  const playUISound = React.useCallback((id) => {
    const catMap = { queue_complete: "notifications", tally: "tally", backup: "backup", drag_snap: "drag", toast_success: "notifications", toast_warning: "notifications", claude_response: "claude" };
    if (!soundSettingsRef.current[catMap[id] || "notifications"]) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const t = ctx.currentTime;
      const tone = (freq, start, duration, vol = 0.15, type = "sine") => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.connect(g); g.connect(ctx.destination);
        o.type = type; o.frequency.value = freq;
        g.gain.setValueAtTime(0, start);
        g.gain.linearRampToValueAtTime(vol, start + 0.03);
        g.gain.exponentialRampToValueAtTime(0.001, start + duration);
        o.start(start); o.stop(start + duration + 0.05);
      };
      if (id === "queue_complete") {
        [[523.25, 0], [659.25, 0.13], [783.99, 0.26]].forEach(([f, s]) => tone(f, t + s, 0.45, 0.18));
      } else if (id === "tally") {
        [[440, 0], [554.37, 0.18]].forEach(([f, s]) => tone(f, t + s, 0.65, 0.13));
      } else if (id === "backup") {
        const o = ctx.createOscillator(); const g = ctx.createGain();
        o.connect(g); g.connect(ctx.destination); o.type = "sine";
        o.frequency.setValueAtTime(392, t); o.frequency.linearRampToValueAtTime(523.25, t + 0.12);
        g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.14, t + 0.04);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
        o.start(t); o.stop(t + 0.55);
      } else if (id === "drag_snap") {
        const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.08), ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 3);
        const src = ctx.createBufferSource(); const g = ctx.createGain();
        const filter = ctx.createBiquadFilter();
        filter.type = "bandpass"; filter.frequency.value = 600; filter.Q.value = 1.2;
        src.buffer = buf; src.connect(filter); filter.connect(g); g.connect(ctx.destination);
        g.gain.setValueAtTime(0.55, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
        src.start(t); src.stop(t + 0.1);
      } else if (id === "toast_success") {
        tone(880, t, 0.2, 0.09);
      } else if (id === "toast_warning") {
        tone(330, t, 0.08, 0.11); tone(330, t + 0.1, 0.08, 0.11);
      } else if (id === "claude_response") {
        [[659.25, 0], [783.99, 0.1]].forEach(([f, s]) => tone(f, t + s, 0.5, 0.1));
      }
      setTimeout(() => ctx.close(), 2000);
    } catch {}
  }, []);

  // Preview a sound by category key — always plays, ignores settings check
  const previewSound = React.useCallback((key) => {
    const idMap = { emailSend: "email-send.mp3", emailReceive: "email-receive.mp3", messageSend: "message-send.mp3", messageReceive: "message-receive.mp3", drag: "drag_snap", claude: "claude_response", tally: "tally", backup: "backup", notifications: "queue_complete" };
    const target = idMap[key];
    if (!target) return;
    if (target.includes(".")) {
      // File-based sound
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        fetch(`sounds/${target}`)
          .then(r => r.arrayBuffer())
          .then(buf => ctx.decodeAudioData(buf))
          .then(decoded => {
            const src = ctx.createBufferSource();
            src.buffer = decoded; src.connect(ctx.destination); src.start(0);
            src.onended = () => { try { ctx.close(); } catch {} };
          })
          .catch(() => { try { ctx.close(); } catch {} });
      } catch {}
    } else {
      // Synthesised — call playUISound but bypass the settings check by temporarily forcing it
      const prev = soundSettingsRef.current;
      soundSettingsRef.current = { email: true, drag: true, claude: true, tally: true, backup: true, notifications: true };
      playUISound(target);
      soundSettingsRef.current = prev;
    }
  }, [playUISound]);

  React.useEffect(() => {
    try { localStorage.setItem("mt-sound-settings", JSON.stringify(soundSettings)); } catch(e) {}
  }, [soundSettings]);
  // Persist dark mode preference
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEYS.darkMode, darkMode ? "true" : "false"); } catch(e) {}
  }, [darkMode]);
  // Active colour palette — used throughout App.js render; all pages get it via ThemeContext
  const colors = darkMode ? darkColors : lightColors;

  // Inject @keyframes spin for loading spinners (once on mount)
  useEffect(() => {
    if (!document.getElementById("mt-global-styles")) {
      const el = document.createElement("style");
      el.id = "mt-global-styles";
      el.textContent = "@keyframes spin { to { transform: rotate(360deg); } } @keyframes mmm-flash { from { opacity: 1; } to { opacity: 0.15; } } .mt-email-body a { color: #7C6FAD; } .mt-email-body blockquote { border-left: 3px solid #e5e7eb; margin: 8px 0; padding-left: 12px; color: #6b7280; } .mt-email-body table { max-width: 100%; } .mt-email-body img { display: none !important; } .mt-email-body * { max-width: 100%; box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif !important; }";
      document.head.appendChild(el);
    }
  }, []);
  useEffect(() => {
    setAnthropicApiKey(apiKey);
    setApiStatus(apiKey.trim() ? "unknown" : "missing");
  }, [apiKey]);

  // Persistent view state (survives tab switches)
  const [ttViewState, setTtViewState] = useState({ selectedSchool: "", viewMode: "grid", filterTeacher: "", scrollTop: 0 });
  const [weeklyViewState, setWeeklyViewState] = useState({ selectedSchool: "", weekOffset: 0, showMissedTally: false, scrollTop: 0 });
  const [sharedSchool, setSharedSchool] = useState("");
  const [sharedTimetableScroll, setSharedTimetableScroll] = useState({ gridScroll: {} });
  const [studentsViewState, setStudentsViewState] = useState({ filter: { school: "", className: "", instrument: "", teacher: "", search: "", hasNote: false, hasWarning: "" }, sortCol: "name", sortDir: "asc", scrollTop: 0 });
  const [schoolsViewState, setSchoolsViewState] = useState({ scrollTop: 0 });
  const [teachersViewState, setTeachersViewState] = useState({ scrollTop: 0 });
  const [groupsViewState, setGroupsViewState] = useState({ filterSchool: "", scrollTop: 0 });
  const [tallyViewState, setTallyViewState] = useState({ selectedSchool: "all", groupBy: "day_school", scrollTop: 0 });
  const [specialistsViewState, setSpecialistsViewState] = useState({ filterSchool: "", filterClass: "", filterDay: "", filterSubject: "", scrollTop: 0 });
  const [interruptionsViewState, setInterruptionsViewState] = useState({ filterSchool: "", filterType: "", scrollTop: 0 });
  const [dashboardViewState, setDashboardViewState] = useState({ scrollTop: 0 });
  const [contactsViewState, setContactsViewState] = useState({ scrollTop: 0 });
  const [resourcesViewState, setResourcesViewState] = useState({ scrollTop: 0 });
  const [settingsViewState, setSettingsViewState] = useState({ scrollTop: 0 });
  const [invoicingViewState, setInvoicingViewState] = useState({ scrollTop: 0 });
  const [contacts, setContacts] = useState([]);
  const [errorLog, setErrorLog] = useState([]); // [{ts, message, detail}] capped at 30
  const logError = React.useCallback((message, detail = "") => {
    setErrorLog(prev => [{ id: uid(), ts: new Date().toISOString(), message, detail }, ...prev].slice(0, 30));
  }, []);

  // Spec 2 cluster 6c — substitution UI handlers. Upsert / delete a
  // (week_key, bucket_id) lane override row and splice the result into
  // local laneOverrides state so resolution helpers see it immediately.
  const handleSetLaneOverride = React.useCallback(async (weekKey, bucketId, overrideTeacherId) => {
    const existing = laneOverrides.find(o => o.weekKey === weekKey && o.bucketId === bucketId);
    try {
      const row = await upsertLaneOverride({ existingId: existing?.id, weekKey, bucketId, overrideTeacherId, userId: sessionUserId });
      setLaneOverrides(prev => existing
        ? prev.map(o => o.id === existing.id ? row : o)
        : [...prev, row]);
    } catch (err) {
      logError("Lane override upsert failed", err.message);
    }
  }, [laneOverrides, sessionUserId, logError]);

  const handleClearLaneOverride = React.useCallback(async (weekKey, bucketId) => {
    const existing = laneOverrides.find(o => o.weekKey === weekKey && o.bucketId === bucketId);
    if (!existing) return;
    try {
      await deleteLaneOverride({ id: existing.id });
      setLaneOverrides(prev => prev.filter(o => o.id !== existing.id));
    } catch (err) {
      logError("Lane override delete failed", err.message);
    }
  }, [laneOverrides, logError]);

  // Spec 2 cluster 8a — view-switching: store the active lane id for a
  // (schoolId, day) so chip clicks survive page navigation. Persisted via
  // the viewedLanes sync useEffect.
  const handleSwitchLane = React.useCallback((schoolId, day, laneId) => {
    setViewedLanes(prev => ({ ...prev, [schoolId]: { ...(prev[schoolId] || {}), [day]: laneId } }));
  }, []);

  // Spec 2 cluster 9a — Add Staff. Inserts a new active teacher_coverage row
  // and appends to local state (created_at-asc loader order keeps the new
  // lane last on next reload, matching local append semantics).
  const handleAddStaff = React.useCallback(async (schoolId, day, teacherId) => {
    if (!sessionUserId) return;
    try {
      const newLane = await insertTeacherCoverage({ schoolId, day, teacherId, userId: sessionUserId });
      setTeacherCoverage(prev => [...prev, newLane]);
    } catch (err) {
      logError("Add staff failed", err.message);
      try { notify("Failed to add staff", "error"); } catch (_) {}
    }
  }, [sessionUserId, logError]);

  // Spec 2 cluster 9b — Remove Staff. Archives the lane row (status='archived')
  // then sweeps MTT + WTT current/future-week lessons (regular + catchup keys)
  // bound to that lane. Past weeks are preserved unconditionally (Q3=a).
  // lane_overrides rows are left intact (Q12=a — orphan rows are inert since
  // the bucket is gone from the active set). Catchup keys are matched
  // regardless of school suffix because catchup lessons carry per-lesson
  // schoolId and bucket_id is unique per lane (Q4=a).
  //
  // Cluster 9b follow-up: lessonBelongsToLane mirrors the cluster 8a/8b
  // renderer filter (TimetableView L788, WeeklyAdjustments L856) so legacy
  // lessons without bucket_id (pre-cluster-4c data) bind to the first-added
  // active lane on (school, day) and get swept correctly. Cluster 13 dedupe
  // candidate.
  const handleRemoveStaff = React.useCallback(async (lane) => {
    if (!sessionUserId) return;
    if (!lane) return;
    const teacher = teachers.find(t => t.id === lane.teacherId);
    const school = schools.find(s => s.id === lane.schoolId);
    const teacherName = teacher?.name || "(unknown teacher)";
    const schoolName = school?.name || "(unknown school)";

    // Cluster 8a/8b parity: legacy lessons without bucket_id bind to the
    // first-added active lane on (school, day). Loader sort is created_at
    // ASC + id (cluster 9a Q9 fix), so dayLanes[0] is the first-added.
    const dayLanes = (teacherCoverage || []).filter(c =>
      c.schoolId === lane.schoolId && c.day === lane.day && c.status === "active"
    );
    const isFirstAddedLane = dayLanes.length > 0 && dayLanes[0].id === lane.id;

    // Stamped: match by bucket_id. Legacy: match by (day, schoolId) +
    // first-added binding. Mirrors TimetableView L788 / WeeklyAdjustments L856.
    const lessonBelongsToLane = (l) => {
      if (l.bucket_id) return l.bucket_id === lane.id;
      if (l.day !== lane.day) return false;
      if (l.schoolId !== lane.schoolId) return false;
      return isFirstAddedLane;
    };

    // Spec 3 cluster 11b-A — catchup attribution to the lane uses the
    // catchup's enrolment's teacherId, not the lessonBelongsToLane
    // bucket_id/first-added heuristic. Future-safe for multi-teacher-
    // per-day scenarios.
    const currentMondayStr = toLocalDateStr(getCurrentWeekMonday());
    const catchupBelongsToLane = (c) => {
      if (c.weekKey < currentMondayStr) return false;
      if (c.day !== lane.day) return false;
      if (c.schoolId !== lane.schoolId) return false;
      const enrol = enrolments.find(e => e.id === c.enrolmentId);
      return enrol?.teacherId === lane.teacherId;
    };

    // Lesson count: MTT + WTT current+future + catchups current+future.
    const mttCount = (timetable?.lessons || []).filter(lessonBelongsToLane).length;
    let wttCount = 0;
    Object.entries(weeklyTimetables || {}).forEach(([key, data]) => {
      const [weekKey, suffix] = key.split("|");
      if (suffix !== lane.schoolId) return;
      if (weekKey < currentMondayStr) return;
      wttCount += (data.lessons || []).filter(lessonBelongsToLane).length;
    });
    const catchupCount = (catchups || []).filter(catchupBelongsToLane).length;
    const total = mttCount + wttCount + catchupCount;

    // Q9=b — count=0 fallback wording.
    const modalText = total === 0
      ? `Remove ${teacherName} from ${lane.day}s at ${schoolName}? No lessons are currently scheduled.`
      : `Remove ${teacherName} from ${lane.day}s at ${schoolName}? ${total} current and future lessons will be unscheduled.`;

    if (!window.confirm(modalText)) return;

    // Archive — only step that can throw.
    try {
      await archiveTeacherCoverage({ id: lane.id });
    } catch (e) {
      try { notify(`Failed to remove ${teacherName}`, "error"); } catch (_) {}
      if (logError) logError("Remove staff failed", e?.message);
      return;
    }

    // Local-state sweep — synchronous filters, can't fail individually.
    setTeacherCoverage(prev => prev.filter(l => l.id !== lane.id));
    setTimetable(prev => {
      if (!prev) return prev;
      return { ...prev, lessons: (prev.lessons || []).filter(l => !lessonBelongsToLane(l)) };
    });
    setWeeklyTimetables(prev => {
      const next = { ...prev };
      Object.entries(next).forEach(([key, data]) => {
        const [weekKey, suffix] = key.split("|");
        if (suffix !== lane.schoolId) return;
        if (weekKey < currentMondayStr) return;
        next[key] = { ...data, lessons: (data.lessons || []).filter(l => !lessonBelongsToLane(l)) };
      });
      return next;
    });

    // Spec 3 cluster 11b-A — catchups for this lane are deleted from the
    // canonical catchups Supabase table. Each delete is individually
    // try/catch'd so one failure doesn't abort the rest; setCatchups
    // runs once after the loop for atomic local state update.
    const catchupsToRemove = (catchups || []).filter(catchupBelongsToLane);
    if (catchupsToRemove.length > 0) {
      for (const c of catchupsToRemove) {
        try {
          await deleteCatchup({ id: c.id });
        } catch (e) {
          logError(`Failed to delete catchup ${c.id} during lane removal`, e?.message || String(e));
        }
      }
      setCatchups(prev => prev.filter(c => !catchupBelongsToLane(c)));
    }

    try { notify(`Removed ${teacherName} from ${lane.day}s`); } catch (_) {}
  }, [sessionUserId, teachers, schools, teacherCoverage, timetable, weeklyTimetables, catchups, setCatchups, enrolments, deleteCatchup, logError]);

  // Load data on mount — uses test data as fallback when storage is empty
  useEffect(() => {
    (async () => {
      // ── Schools: try Supabase first, fall back to localStorage ──
      // On first migration run, Supabase will be empty → falls back to
      // localStorage. The first save then syncs local data up to Supabase.
      let s;
      try {
        const supabaseSchools = await loadSchoolsFromSupabase();
        if (supabaseSchools.length > 0) {
          s = supabaseSchools;
          saveData(STORAGE_KEYS.schools, s); // keep localStorage cache fresh
        } else {
          // Supabase empty (first migration run) — load from localStorage
          s = migrateData("schools", await loadSchools());
        }
      } catch (err) {
        // Offline or Supabase error — fall back to localStorage cache
        logError("Failed to load schools from Supabase", err.message);
        s = migrateData("schools", await loadSchools());
      }
      // ── Students: try Supabase first, fall back to localStorage ──
      let st;
      try {
        const supabaseStudents = await loadStudentsFromSupabase();
        if (supabaseStudents.length > 0) {
          st = supabaseStudents;
          saveData(STORAGE_KEYS.students, st); // keep localStorage cache fresh
        } else {
          // Supabase empty (first migration run) — load from localStorage
          st = migrateData("students", await loadStudents());
        }
      } catch (err) {
        // Offline or Supabase error — fall back to localStorage cache
        logError("Failed to load students from Supabase", err.message);
        st = migrateData("students", await loadStudents());
      }

      // ── Enrolments: try Supabase first, fall back to localStorage ──
      let en;
      try {
        const supabaseEnrolments = await loadEnrolmentsFromSupabase();
        if (supabaseEnrolments.length > 0) {
          en = supabaseEnrolments;
          saveData(STORAGE_KEYS.enrolments, en);
        } else {
          en = await loadData(STORAGE_KEYS.enrolments, []);
        }
      } catch (err) {
        logError("Failed to load enrolments from Supabase", err.message);
        en = await loadData(STORAGE_KEYS.enrolments, []);
      }

      // ── Teachers: try Supabase first, fall back to localStorage ──
      let t;
      try {
        const supabaseTeachers = await loadTeachersFromSupabase();
        if (supabaseTeachers.length > 0) {
          t = supabaseTeachers;
          saveData(STORAGE_KEYS.teachers, t);
        } else {
          t = migrateData("teachers", await loadData(STORAGE_KEYS.teachers, []));
        }
      } catch (err) {
        logError("Failed to load teachers from Supabase", err.message);
        t = migrateData("teachers", await loadData(STORAGE_KEYS.teachers, []));
      }
      // ── Teacher coverage (lanes): try Supabase first, fall back to localStorage ──
      let tc;
      try {
        const supabaseTeacherCoverage = await loadTeacherCoverageFromSupabase();
        if (supabaseTeacherCoverage.length > 0) {
          tc = supabaseTeacherCoverage;
          saveData(STORAGE_KEYS.teacherCoverage, tc);
        } else {
          tc = await loadData(STORAGE_KEYS.teacherCoverage, []);
        }
      } catch (err) {
        logError("Failed to load teacher_coverage from Supabase", err.message);
        tc = await loadData(STORAGE_KEYS.teacherCoverage, []);
      }
      // ── Lane overrides: Supabase only (no localStorage cache — week-keyed substitution data) ──
      let lo;
      try {
        lo = await loadLaneOverridesFromSupabase();
      } catch (err) {
        logError("Failed to load lane_overrides from Supabase", err.message);
        lo = [];
      }
      // ── Catchups: Supabase only (no localStorage cache — week-keyed user data) ──
      let cu;
      try {
        cu = await loadCatchupsFromSupabase();
      } catch (err) {
        logError("Failed to load catchups from Supabase", err.message);
        cu = [];
      }
      // ── Viewed lanes: localStorage only (cluster 8a — view-switching, no Supabase) ──
      let vl;
      try {
        vl = await loadData(STORAGE_KEYS.viewedLanes, {});
      } catch (err) {
        logError("Failed to load viewedLanes from localStorage", err.message);
        vl = {};
      }
      // ── Specialists: try Supabase first, fall back to localStorage ──
      let sp;
      try {
        const supabaseSpecialists = await loadSpecialistsFromSupabase();
        if (supabaseSpecialists.length > 0) {
          sp = supabaseSpecialists;
          saveData(STORAGE_KEYS.specialists, sp); // keep localStorage cache fresh
        } else {
          // Supabase empty (first migration run) — load from localStorage
          sp = await loadSpecialists();
        }
      } catch (err) {
        // Offline or Supabase error — fall back to localStorage cache
        logError("Failed to load specialists from Supabase", err.message);
        sp = await loadSpecialists();
      }
      // ── Interruptions: try Supabase first, fall back to localStorage ──
      let ir;
      try {
        const supabaseInterruptions = await loadInterruptionsFromSupabase();
        if (supabaseInterruptions.length > 0) {
          ir = supabaseInterruptions;
          saveData(STORAGE_KEYS.interruptions, ir);
        } else {
          ir = await loadData(STORAGE_KEYS.interruptions, []);
        }
      } catch (err) {
        logError("Failed to load interruptions from Supabase", err.message);
        ir = await loadData(STORAGE_KEYS.interruptions, []);
      }
      // ── Groups: try Supabase first, fall back to localStorage ──
      let gr;
      try {
        const supabaseGroups = await loadGroupsFromSupabase();
        if (supabaseGroups.length > 0) {
          gr = supabaseGroups;
          saveData(STORAGE_KEYS.groups, gr);
        } else {
          gr = migrateData("groups", await loadData(STORAGE_KEYS.groups, []));
        }
      } catch (err) {
        logError("Failed to load groups from Supabase", err.message);
        gr = migrateData("groups", await loadData(STORAGE_KEYS.groups, []));
      }

      // ── Bands: try Supabase first, fall back to localStorage ──
      let bn;
      try {
        const supabaseBands = await loadBandsFromSupabase();
        if (supabaseBands.length > 0) {
          bn = supabaseBands;
          saveData(STORAGE_KEYS.bands, bn);
        } else {
          bn = await loadData(STORAGE_KEYS.bands, []);
        }
      } catch (err) {
        logError("Failed to load bands from Supabase", err.message);
        bn = await loadData(STORAGE_KEYS.bands, []);
      }
      // ── Resources: try Supabase first, fall back to localStorage ──
      let rc;
      try {
        const supabaseResources = await loadResourcesFromSupabase();
        if (supabaseResources.length > 0) {
          rc = supabaseResources;
          saveData(STORAGE_KEYS.resources, rc);
        } else {
          rc = await loadData(STORAGE_KEYS.resources, []);
        }
      } catch (err) {
        logError("Failed to load resources from Supabase", err.message);
        rc = await loadData(STORAGE_KEYS.resources, []);
      }

      // ── Documents: try Supabase first, fall back to localStorage ──
      let dc;
      try {
        const supabaseDocuments = await loadDocumentsFromSupabase();
        if (supabaseDocuments.length > 0) {
          dc = supabaseDocuments;
          saveData(STORAGE_KEYS.documents, dc);
        } else {
          dc = await loadData(STORAGE_KEYS.documents, []);
        }
      } catch (err) {
        logError("Failed to load documents from Supabase", err.message);
        dc = await loadData(STORAGE_KEYS.documents, []);
      }
      // ── Master timetable: try Supabase first, fall back to localStorage ──
      let tt;
      try {
        const supabaseTt = await loadTimetableFromSupabase();
        if (supabaseTt !== null) {
          tt = supabaseTt;
          saveData(STORAGE_KEYS.timetable, tt); // keep localStorage cache fresh
        } else {
          // Supabase empty (first migration run) — load from localStorage
          tt = await loadData(STORAGE_KEYS.timetable, null);
        }
      } catch (err) {
        // Offline or Supabase error — fall back to localStorage cache
        logError("Failed to load timetable from Supabase", err.message);
        tt = await loadData(STORAGE_KEYS.timetable, null);
      }
      // ── Weekly timetables: try Supabase first, fall back to localStorage ──
      let wt;
      try {
        const supabaseWt = await loadWeeklyAdjustmentsFromSupabase();
        if (Object.keys(supabaseWt).length > 0) {
          wt = supabaseWt;
          saveData(STORAGE_KEYS.weeklyTimetables, wt); // keep localStorage cache fresh
        } else {
          // Supabase empty (first migration run) — load from localStorage
          wt = await loadData(STORAGE_KEYS.weeklyTimetables, {});
        }
      } catch (err) {
        // Offline or Supabase error — fall back to localStorage cache
        logError("Failed to load weekly timetables from Supabase", err.message);
        wt = await loadData(STORAGE_KEYS.weeklyTimetables, {});
      }
      // ── Tally entries: try Supabase first, fall back to localStorage ──
      let tally;
      try {
        const { data: { session: currentSession } } = await supabase.auth.getSession();
        const supabaseTally = await loadTallyEntriesFromSupabase(currentSession?.user?.id);
        if (supabaseTally && supabaseTally.length > 0) {
          tally = supabaseTally;
          saveData(STORAGE_KEYS.tallyEntries, tally); // keep localStorage cache fresh
        } else {
          // Supabase empty (first migration run) — load from localStorage
          tally = migrateData("tallyEntries", await loadData(STORAGE_KEYS.tallyEntries, []));
        }
      } catch (err) {
        // Offline or Supabase error — fall back to localStorage cache
        logError("Failed to load tally entries from Supabase", err.message);
        tally = migrateData("tallyEntries", await loadData(STORAGE_KEYS.tallyEntries, []));
      }
      // ── Master breaks: try Supabase first, fall back to localStorage ──
      let mb;
      try {
        const supabaseMasterBreaks = await loadMasterBreaksFromSupabase();
        if (supabaseMasterBreaks.length > 0) {
          mb = supabaseMasterBreaks;
          saveData(STORAGE_KEYS.masterBreaks, mb); // keep localStorage cache fresh
        } else {
          // Supabase empty (first migration run) — load from localStorage
          mb = await loadData(STORAGE_KEYS.masterBreaks, []);
        }
      } catch (err) {
        // Offline or Supabase error — fall back to localStorage cache
        logError("Failed to load master breaks from Supabase", err.message);
        mb = await loadData(STORAGE_KEYS.masterBreaks, []);
      }
      // ── Contacts: try Supabase first, fall back to localStorage ──
      let ct;
      try {
        const supabaseContacts = await loadContactsFromSupabase();
        if (supabaseContacts.length > 0) {
          ct = supabaseContacts;
          saveData(STORAGE_KEYS.contacts, ct);
        } else {
          ct = await loadData(STORAGE_KEYS.contacts, []);
        }
      } catch (err) {
        logError("Failed to load contacts from Supabase", err.message);
        ct = await loadData(STORAGE_KEYS.contacts, []);
      }
      // Only seed ALL collections if this is a truly fresh install (no schools saved yet).
      // If schools exist, the user has real data — missing collections default to empty
      // rather than seed data, so a storage hiccup can't overwrite real data with demo data.
      setSchools(s);
      setStudents(st);
      setEnrolments(en);
      setTeachersRaw(t);
      setTeacherCoverage(tc);
      setLaneOverrides(lo);
      setCatchups(cu);
      setViewedLanes(vl);
      setSpecialists(sp);
      setInterruptions(ir);
      setGroups(gr.length > 0 ? gr : []);
      setBands(bn || []);
      setResources(rc || []);
      setDocuments(dc || []);
      setTimetableRaw(tt);
      setWeeklyTimetablesRaw(wt);
      setTallyEntries(tally);
      setMasterBreaks(mb || []);
      setContacts(ct || []);
      // ── Instrument colour overrides: load from Supabase ──
      try { await loadInstColorsFromSupabase(); }
      catch (err) { logError("Failed to load instrument colours from Supabase", err.message); }
      setLoading(false);
      // Show sync badge for 10s after app finishes loading
      setTimeout(() => setSyncBadgeStartup(false), 10000);
      // Run smoke tests once after load (validates pure functions + migration)
      runSmokeTests(logError);
      // Clear undo stacks after load — nothing before this point should be undoable
      timetableUndoStack.current = [];
      timetableRedoStack.current = [];
      teachersUndoStack.current = [];
      teachersRedoStack.current = [];
      weeklyUndoStack.current = [];
      weeklyRedoStack.current = [];
      ttPageActionSeq.current = 0;
      // Delay storageReady so auto-save effects don't fire during initial state hydration.
      // Load all persisted data on startup
      setTimeout(() => { storageReady.current = true; }, 500);
    })();
  }, []);

  // ── Reactive reconciliation: keep lessons in sync with live student/teacher data ──
  // Lessons store frozen snapshots (studentName, teacherId, teacherName) at creation
  // time. If Matt renames a student, changes their teacher, or tweaks their instrument,
  // existing lessons don't automatically reflect it. The admin UI uses live lookups so
  // Matt sees correct data locally, but the teacher app and Supabase read the stored
  // snapshots directly — so any drift breaks them.
  //
  // This effect walks every lesson (master + all weekly) and rewrites any stale
  // snapshot field from the current student + teacher records:
  //   - studentName         ← student.name
  //   - teacherId/Name      ← student.instruments[<matching>].teacherId + teacher.name
  //
  // Instrument matching is case- and whitespace-tolerant. Orphaned lessons (student
  // record has no matching instrument, student missing, teacher missing, or instrument
  // has no assigned teacher) are NOT auto-fixed — they're surfaced via a warning toast
  // and detailed console log so Matt can review and correct them manually.
  //
  // Runs on initial startup (700ms delay to wait past the storageReady timer) AND
  // reactively whenever students, teachers, or timetable change. Idempotent — returns
  // the same state reference if nothing needs fixing, so it never causes a re-render
  // or wasted sync on already-clean data.
  // Session 97: track the last surfaced orphan count so we don't refire the
  // toast every time the reconciler runs (which is on every students/teachers/
  // timetable change — i.e. every drag in TimetableView). The toast was firing
  // constantly with the same number and getting truncated inside the page-
  // header button area where toasts render. Now we only nudge Matt when the
  // orphan count GROWS — a fresh issue appearing — and stay silent otherwise.
  // The full list is still logged to the console every run for diagnosis.
  const initialReconcileDoneRef = useRef(false);
  const lastOrphanCountRef = useRef(0);
  // Session 97.1: hoist the orphan list to state so the Settings "Data Health"
  // section can render it with per-row actions (Go to student / Delete lesson).
  // The reconciler populates this on every run; the UI reads it live.
  const [orphanedLessons, setOrphanedLessons] = useState([]);
  useEffect(() => {
    if (students.length === 0 || teachers.length === 0) return;
    if (!timetable || !timetable.lessons) return;

    const delay = initialReconcileDoneRef.current ? 0 : 700;
    const t = setTimeout(() => {
      initialReconcileDoneRef.current = true;

      const normalize = (s) => (s || "").trim().toLowerCase();

      // Cluster 12a: surgical strip — was a two-job reconciler (orphan detection + live
      // stamped-field sync). Live-sync arm removed because nothing reads stamped
      // teacherId/teacherName post-cluster-12a (lane resolves at render time). Orphan
      // detection retained — it's the Session 97.1 Settings → Data Health surface,
      // independent of cluster 12.
      const checkOrphan = (lesson) => {
        if (lesson.isGroup) return null; // groups carry their own teacherId; skip

        const stu = students.find(s => s.id === lesson.studentId);
        if (!stu) return { reason: "student not found" };

        const inst = instrumentsFromEnrolments(stu.id, enrolments).find(
          i => normalize(i.name) === normalize(lesson.instrument)
        );
        if (!inst) return { reason: "instrument not in student record" };
        if (!inst.teacherId) return { reason: "instrument has no assigned teacher" };

        const teacher = teachers.find(tc => tc.id === inst.teacherId);
        if (!teacher) return { reason: "assigned teacher not found" };

        return null;
      };

      const orphans = [];

      // Master timetable — orphan-only walk; setter callback used purely to access
      // fresh state without adding timetable to deps. Always returns prev unchanged.
      setTimetableRaw(prev => {
        if (prev?.lessons) {
          for (const l of prev.lessons) {
            const r = checkOrphan(l);
            if (r) orphans.push({ where: "master", lessonId: l.id, studentId: l.studentId, schoolId: l.schoolId, studentName: l.studentName, instrument: l.instrument, day: l.day, start: l.start, reason: r.reason });
          }
        }
        return prev;
      });

      // Weekly timetables — same orphan-only walk.
      setWeeklyTimetablesRaw(prev => {
        for (const key of Object.keys(prev || {})) {
          const entry = prev[key];
          if (!entry || !entry.lessons) continue;
          for (const l of entry.lessons) {
            const r = checkOrphan(l);
            if (r) orphans.push({ where: key, lessonId: l.id, studentId: l.studentId, schoolId: l.schoolId, studentName: l.studentName, instrument: l.instrument, day: l.day, start: l.start, reason: r.reason });
          }
        }
        return prev;
      });

      if (orphans.length > 0) {
        console.warn(`[reconcile] Found ${orphans.length} orphaned lesson(s) — needs review:`, orphans);
        // Session 97: only toast when the count grows (a NEW orphan), not on
        // every reconciler tick. Repeated equal counts mean the user is just
        // moving things around — the orphans haven't changed.
        if (orphans.length > lastOrphanCountRef.current) {
          const delta = orphans.length - lastOrphanCountRef.current;
          try { notify(`${delta} new orphaned lesson${delta === 1 ? "" : "s"} (${orphans.length} total) — Settings → Data Health to review`, "warning", 5000); } catch (_) {}
        }
      }
      lastOrphanCountRef.current = orphans.length;
      // Session 97.1: publish to state so the Settings UI can render the list
      // with click-to-resolve actions. Runs outside the >0 guard so resolving
      // the last orphan clears the list properly. Shallow-compare to avoid
      // unnecessary re-renders on every reconciler tick.
      setOrphanedLessons(prev => {
        if (prev.length !== orphans.length) return orphans;
        for (let i = 0; i < orphans.length; i++) {
          if (prev[i]?.lessonId !== orphans[i].lessonId || prev[i]?.where !== orphans[i].where) return orphans;
        }
        return prev;
      });
    }, delay);
    return () => clearTimeout(t);
  }, [students, teachers, timetable]);

  // Auto-save — NEVER save an empty array for any real data collection.
  // This ensures a failed/empty storage read can never silently destroy saved data.
  // sessionUserId in deps ensures a resync fires when session becomes available.
  useEffect(() => {
    if (!storageReady.current || schools.length === 0) return;
    // Keep localStorage as cache
    saveData(STORAGE_KEYS.schools, schools);
    saveData(STORAGE_KEYS.schoolsBak, schools);
    // Sync to Supabase (add, edit, and delete handled in syncSchoolsToSupabase)
    if (sessionUserId && !isDev) {
      syncSchoolsToSupabase(schools, sessionUserId)
        .catch(err => logError("Schools Supabase sync failed", err.message));
    } else if (storageReady.current) {
      console.warn("[sync] Schools saved to localStorage only — no Supabase session");
      syncSkipCountRef.current++;
    }
  }, [schools, sessionUserId]);
  useEffect(() => {
    if (!storageReady.current || students.length === 0) return;
    saveStudents(students);
    if (sessionUserId && !isDev) {
      syncStudentsToSupabase(students, sessionUserId)
        .catch(err => logError("Students Supabase sync failed", err.message));
    } else if (storageReady.current) {
      console.warn("[sync] Students saved to localStorage only — no Supabase session");
      syncSkipCountRef.current++;
    }
  }, [students, sessionUserId]);
  useEffect(() => {
    if (!storageReady.current || enrolments.length === 0) return;
    saveData(STORAGE_KEYS.enrolments, enrolments);
    if (sessionUserId && !isDev) {
      syncEnrolmentsToSupabase(enrolments, sessionUserId)
        .catch(err => logError("Enrolments Supabase sync failed", err.message));
    } else if (storageReady.current) {
      console.warn("[sync] Enrolments saved to localStorage only — no Supabase session");
      syncSkipCountRef.current++;
    }
  }, [enrolments, sessionUserId]);
  // Spec 2 cluster 8a — viewedLanes is localStorage only; no Supabase sync.
  useEffect(() => {
    if (!storageReady.current) return;
    saveData(STORAGE_KEYS.viewedLanes, viewedLanes);
  }, [viewedLanes]);
  useEffect(() => {
    if (!storageReady.current || teachers.length === 0) return;
    saveData(STORAGE_KEYS.teachers, teachers);
    if (sessionUserId && !isDev) {
      syncTeachersToSupabase(teachers, sessionUserId)
        .catch(err => logError("Teachers Supabase sync failed", err.message));
    } else if (storageReady.current) {
      console.warn("[sync] Teachers saved to localStorage only — no Supabase session");
      syncSkipCountRef.current++;
    }
  }, [teachers, sessionUserId]);
  useEffect(() => { if (storageReady.current && specialists.length > 0) { saveData(STORAGE_KEYS.specialists, specialists); saveData(STORAGE_KEYS.specialistsBak, specialists); if (sessionUserId && !isDev) syncSpecialistsToSupabase(specialists, sessionUserId).catch(err => logError("Specialists Supabase sync failed", err.message)); else if (!isDev) console.warn("[sync] Specialists — no Supabase session"); } }, [specialists, sessionUserId]);
  useEffect(() => { if (storageReady.current && interruptions.length > 0) { saveData(STORAGE_KEYS.interruptions, interruptions); if (sessionUserId && !isDev) syncInterruptionsToSupabase(interruptions, sessionUserId).catch(err => logError("Interruptions Supabase sync failed", err.message)); else if (!isDev) console.warn("[sync] Interruptions — no Supabase session"); } }, [interruptions, sessionUserId]);
  useEffect(() => { if (storageReady.current) { saveData(STORAGE_KEYS.groups, groups); if (sessionUserId && !isDev) syncGroupsToSupabase(groups, sessionUserId).catch(err => logError("Groups Supabase sync failed", err.message)); else if (groups.length > 0 && !isDev) console.warn("[sync] Groups — no Supabase session"); } }, [groups, sessionUserId]);
  useEffect(() => { if (storageReady.current) { saveData(STORAGE_KEYS.bands, bands); if (sessionUserId && !isDev) syncBandsToSupabase(bands, sessionUserId).catch(err => logError("Bands Supabase sync failed", err.message)); else if (bands.length > 0 && !isDev) console.warn("[sync] Bands — no Supabase session"); } }, [bands, sessionUserId]);
  useEffect(() => { if (storageReady.current) { saveData(STORAGE_KEYS.resources, resources); if (sessionUserId && !isDev) syncResourcesToSupabase(resources, sessionUserId).catch(err => logError("Resources Supabase sync failed", err.message)); else if (resources.length > 0 && !isDev) console.warn("[sync] Resources — no Supabase session"); } }, [resources, sessionUserId]);
  useEffect(() => { if (storageReady.current) { saveData(STORAGE_KEYS.documents, documents); if (sessionUserId && !isDev) syncDocumentsToSupabase(documents, sessionUserId).catch(err => logError("Documents Supabase sync failed", err.message)); else if (documents.length > 0 && !isDev) console.warn("[sync] Documents — no Supabase session"); } }, [documents, sessionUserId]);
  useEffect(() => {
    if (!storageReady.current) return;
    saveData(STORAGE_KEYS.timetable, timetable);
    if (sessionUserId && !isDev) {
      syncTimetableToSupabase(timetable, sessionUserId)
        .catch(err => logError("Timetable Supabase sync failed", err.message));
    } else {
      console.warn("[sync] Timetable — no Supabase session");
    }
  }, [timetable, sessionUserId]);
  useEffect(() => {
    if (!storageReady.current) return;
    // Save WTT entries to the localStorage cache
    saveData(STORAGE_KEYS.weeklyTimetables, weeklyTimetables);
    // Debounce Supabase sync by 2s to avoid hammering on rapid local state changes.
    if (sessionUserId && !isDev) {
      if (wttSyncDebounceRef.current) clearTimeout(wttSyncDebounceRef.current);
      // Mark a pending write immediately — poll will skip all updates until this clears
      wttPendingWriteRef.current = true;
      const uid = sessionUserId; // capture for async closure
      wttSyncDebounceRef.current = setTimeout(() => {
        wttSyncDebounceRef.current = null;
        syncWeeklyAdjustmentsToSupabase(weeklyTimetables, uid)
          .then(upserted => {
            if (upserted) {
              upserted.forEach(r => {
                const k = `${r.week_key}|${r.school_id}`;
                wttOwnWrittenAtRef.current[k] = r.updated_at;
              });
            }
          })
          .catch(err => logError("Weekly timetables Supabase sync failed", err.message))
          .finally(() => {
            // Write complete (success or failure) — poll can resume
            wttPendingWriteRef.current = false;
          });
      }, 2000);
    } else {
      console.warn("[sync] Weekly timetables — no Supabase session");
    }
  }, [weeklyTimetables, sessionUserId]);

  // Spec 1 Commit 5.0 — one-shot WTT shape transform
  useEffect(() => {
    if (!storageReady.current) return;
    if (localStorage.getItem("mt-migration-spec1c5-done")) return;
    if (Object.keys(weeklyTimetables || {}).length === 0) return;
    const result = runSpec1Commit5Transform({ weeklyTimetables });
    if (result.skipped) return;
    setWeeklyTimetables(result.weeklyTimetables);
    try { localStorage.setItem("mt-migration-spec1c5-done", new Date().toISOString()); } catch (e) {}
    console.log("[migration] Spec 1 Commit 5 transform applied:", result.stats);
  }, [weeklyTimetables]);

  // ── Polling: pick up cross-device admin writes + 6pm cron drain output ──
  // Polls weekly_adjustments every 4 seconds. The teacher app writes to
  // teacher_actuals (separate table) — see the admin-teacher-actuals
  // subscription above for the realtime read of teacher-side data.
  // Skips rows this app just wrote (own-write tracking) and rows we've
  // already processed (last-seen tracking).
  useEffect(() => {
    const poll = async () => {
      // Skip the entire poll cycle if we have a write pending or in-flight —
      // prevents the poll from overwriting the admin's own unsaved changes
      if (wttPendingWriteRef.current) return;
      try {
        const { data, error } = await supabase
          .from("weekly_adjustments")
          .select("week_key, school_id, lessons, missed, notes, generated_at, breaks, updated_at");
        if (error || !data) return;
        let changed = false;
        const updates = {};
        for (const row of data) {
          const k = `${row.week_key}|${row.school_id}`;
          // Skip if this updated_at is one we wrote ourselves
          if (wttOwnWrittenAtRef.current[k] === row.updated_at) continue;
          // Skip if we've already processed this version
          if (wttPollLastSeenRef.current[k] === row.updated_at) continue;
          wttPollLastSeenRef.current[k] = row.updated_at;
          updates[k] = {
            lessons:     row.lessons      || [],
            missed:      row.missed       || [],
            notes:       row.notes        || "",
            generatedAt: row.generated_at || "",
            breaks:      row.breaks       || [],
          };
          changed = true;
        }
        if (changed) {
          setWeeklyTimetables(prev => ({ ...prev, ...updates }));
        }
      } catch (_) {}
    };
    const id = setInterval(poll, 4000);
    return () => clearInterval(id);
  }, []);


  useEffect(() => {
    const trialStudents = students.filter(s => s.status === "trial");
    if (trialStudents.length === 0) return;
    const now = melbourneNow();
    const nowStr = toLocalDateStr(now);
    const hour = now.getHours();
    const promotedIds = new Set();
    for (const s of trialStudents) {
      // Find any trial lesson for this student across all weekly timetables
      for (const [storageKey, data] of Object.entries(weeklyTimetables)) {
        const lessons = data.lessons || [];
        const trialLesson = lessons.find(l => l.studentId === s.id && l.isTrial);
        if (!trialLesson) continue;
        // Find the date of this lesson day within its week
        const wk = storageKey.split("|")[0]; // monday of that week
        const dayIndex = ["Monday","Tuesday","Wednesday","Thursday","Friday"].indexOf(trialLesson.day);
        if (dayIndex < 0) continue;
        const lessonDate = new Date(wk + "T00:00:00");
        lessonDate.setDate(lessonDate.getDate() + dayIndex);
        const lessonDateStr = toLocalDateStr(lessonDate);
        // Promote if lesson date is past, or is today after 6pm
        if (lessonDateStr < nowStr || (lessonDateStr === nowStr && hour >= 18)) {
          promotedIds.add(s.id);
          break;
        }
      }
    }
    if (promotedIds.size > 0) {
      setStudents(prev => prev.map(s => promotedIds.has(s.id) ? { ...s, status: "pending" } : s));
    }
  }, [weeklyTimetables]);
  useEffect(() => { if (storageReady.current && tallyEntries.length > 0) { saveData(STORAGE_KEYS.tallyEntries, tallyEntries); if (sessionUserId && !isDev) syncTallyEntriesToSupabase(tallyEntries, sessionUserId).catch(err => logError("Tally entries Supabase sync failed", err.message)); else if (!isDev) console.warn("[sync] Tally entries — no Supabase session"); } }, [tallyEntries, sessionUserId]);
  useEffect(() => { if (storageReady.current) { saveData(STORAGE_KEYS.masterBreaks, masterBreaks); if (sessionUserId && !isDev) syncMasterBreaksToSupabase(masterBreaks, sessionUserId).catch(err => logError("Master breaks Supabase sync failed", err.message)); else if (masterBreaks.length > 0 && !isDev) console.warn("[sync] Master breaks — no Supabase session"); } }, [masterBreaks, sessionUserId]);

  // Keep refs in sync with latest state (for use in timer/backfill without stale closures)
  useEffect(() => { weeklyTimetablesRef.current = weeklyTimetables; }, [weeklyTimetables]);
  useEffect(() => { teacherActualsRef.current = teacherActuals; }, [teacherActuals]);
  useEffect(() => { timetableRef.current = timetable; }, [timetable]);
  useEffect(() => { studentsRef.current = students; }, [students]);
  useEffect(() => { enrolmentsRef.current = enrolments; }, [enrolments]);
  useEffect(() => { interruptionsRef.current = interruptions; }, [interruptions]);
  useEffect(() => { tallyEntriesRef.current = tallyEntries; }, [tallyEntries]);
  useEffect(() => { schoolsRef.current = schools; }, [schools]);

  // Spec 3 cluster 12b — auto-tally batch retired. Cluster 8's render-time
  // isCatchupCompleted in catchupsDerive.js subsumes the catchup-resolution
  // semantic via derived display; the persisted WTT.missed madeUp / makeupEligible
  // patches the batch produced are no longer the source of truth.

  useEffect(() => { if (storageReady.current) saveData(STORAGE_KEYS.contacts, contacts); if (storageReady.current && sessionUserId && !isDev) { syncContactsToSupabase(contacts, sessionUserId).catch(err => logError("Contacts Supabase sync failed", err.message)); } else if (storageReady.current && contacts.length > 0 && !isDev) { console.warn("[sync] Contacts — no Supabase session"); } }, [contacts, sessionUserId]);

  // Auto-backup to localStorage whenever important data changes (silent, always available)
  useEffect(() => {
    if (!storageReady.current) return;
    triggerAutoBackup({ version: 1, exportedAt: new Date().toISOString(), schools, students, teachers, specialists, interruptions, groups, timetable, weeklyTimetables, contacts, bands });
  }, [schools, students, teachers, timetable, weeklyTimetables]);


  // ── Scheduled backup 4× per day at 6-hour intervals ──────────
  useEffect(() => {
    const MS_6H = 6 * 60 * 60 * 1000;

    const doScheduledBackup = async () => {
      try {
        const ttVersions = await loadData(STORAGE_KEYS.timetableVersions, []);
        const userTemplates = await loadData(STORAGE_KEYS.userTemplates, []);
        const emailTemplates = await loadData(STORAGE_KEYS.emailTemplates, {});
        let aiEmailRules = {};
        try { const raw = localStorage.getItem("mt-ai-email-rules"); if (raw) aiEmailRules = JSON.parse(raw); } catch(e) {}
        const backup = {
          version: DATA_VERSION, exportedAt: new Date().toISOString(),
          schools, students, teachers, specialists, interruptions, groups,
          timetable, weeklyTimetables, timetableVersions: ttVersions,
          contacts, bands, masterBreaks, resources,
          userTemplates, emailTemplates, aiEmailRules,
        };
        const json = JSON.stringify(backup, null, 2);
        const now = melbourneNow();
        const dateStr = toLocalDateStr(now);
        const hh = String(now.getHours()).padStart(2, "0");
        const mm = String(now.getMinutes()).padStart(2, "0");
        const filename = `timetabling-auto-${dateStr}-${hh}${mm}.json`;
        if (window.electronAPI) {
          const savedFolder = localStorage.getItem(STORAGE_KEYS.backupFolder);
          const result = await window.electronAPI.writeBackup(filename, json, savedFolder || null);
          if (!result.ok) throw new Error(result.error);
          localStorage.setItem(STORAGE_KEYS.lastScheduledBackup, new Date().toISOString());
          playUISound("backup");
        } else {
          const blob = new Blob([json], { type: "application/json" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url; a.download = filename;
          document.body.appendChild(a); a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
          localStorage.setItem(STORAGE_KEYS.lastScheduledBackup, new Date().toISOString());
          playUISound("backup");
        }
      } catch(e) {
        logError("Scheduled backup failed", e.message);
      }
    };

    const checkAndBackup = () => {
      if (!storageReady.current || !schools.length) return;
      const lastStr = localStorage.getItem(STORAGE_KEYS.lastScheduledBackup);
      const last = lastStr ? new Date(lastStr) : null;
      const overdue = !last || (Date.now() - last.getTime()) > MS_6H;
      if (overdue) doScheduledBackup();
    };

    const onOpenTimer = setTimeout(checkAndBackup, 2000);
    const interval = setInterval(checkAndBackup, 60 * 1000);
    return () => { clearTimeout(onOpenTimer); clearInterval(interval); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schools.length, storageReady.current]);


  // Sync localStorage when user changes backup folder via the Backup menu
  React.useEffect(() => {
    if (!window.electronAPI || !window.electronAPI.onBackupFolderChanged) return;
    const unsub = window.electronAPI.onBackupFolderChanged((folder) => {
      localStorage.setItem(STORAGE_KEYS.backupFolder, folder);
    });
    return unsub;
  }, []);

  // Listen for update status from electron-updater
  React.useEffect(() => {
    if (!window.electronAPI || !window.electronAPI.onUpdateStatus) return;
    const unsub = window.electronAPI.onUpdateStatus((status) => {
      if (status.error) {
        console.error("[updater] error:", status.error);
        setUpdateProgress(null);
      }
      if (status.downloading) {
        setUpdateProgress(status.percent);
      } else if (status.ready) {
        setUpdateProgress(100);
        setUpdateInfo({ version: status.version, available: true, ready: true });
      } else if (status.available) {
        setUpdateInfo({ version: status.version, available: true });
        setUpdateProgress(0);
      } else {
        // No update available — show flash confirmation
        setUpdateProgress(null);
        setNoUpdateFlash(true);
        setTimeout(() => setNoUpdateFlash(false), 2500);
      }
    });
    return unsub;
  }, []);

  // Clock tick — update every 10s (only showing H:MM, no need for 1s precision)
  React.useEffect(() => {
    const tick = () => { const n = melbourneNow(); const h = n.getHours(); const h12 = h % 12 || 12; setClockTime(h12 + ":" + String(n.getMinutes()).padStart(2, "0")); };
    tick();
    const id = setInterval(tick, 10000);
    return () => clearInterval(id);
  }, []);

  // Auto-check for updates on launch
  React.useEffect(() => {
    if (window.electronAPI && window.electronAPI.checkForUpdates) {
      setTimeout(() => window.electronAPI.checkForUpdates(), 3000);
    }
  }, []);


  // Auto-send queue processor — sends one email every 5s with undo window
  useEffect(() => {
    if (autoSendQueue.length === 0 || autoSendActiveRef.current) return;
    autoSendActiveRef.current = true;
    autoSendTimerRef.current = setTimeout(async () => {
      setAutoSendQueue(prev => {
        if (prev.length === 0) { autoSendActiveRef.current = false; return prev; }
        const [first, ...rest] = prev;
        (async () => {
          try {
            if (window.electronAPI?.gmailSend) {
              // Session 95: pass attachments through. Prior version stripped
              // them entirely — bulk invoice sends were going out with no PDF
              // attached. Also pass cc/bcc if queue items carry them (for
              // future callers; invoices don't use these).
              const result = await window.electronAPI.gmailSend({
                to: first.to,
                from: first.from || undefined,
                cc: first.cc && first.cc.length > 0 ? first.cc : undefined,
                bcc: first.bcc && first.bcc.length > 0 ? first.bcc : undefined,
                subject: first.subject,
                bodyHtml: first.bodyHtml || first.body || "",
                attachments: first.attachments && first.attachments.length > 0 ? first.attachments : undefined,
              });
              if (!result.ok) notify(`Send failed for ${first.label || first.to}: ${result.error}`, "danger");
            }
          } catch(e) { notify(`Send error: ${e.message}`, "danger"); }
          if (rest.length === 0) playUISound("queue_complete");
          autoSendActiveRef.current = false;
        })();
        return rest;
      });
    }, 5000);
    return () => clearTimeout(autoSendTimerRef.current);
  }, [autoSendQueue]); // eslint-disable-line react-hooks/exhaustive-deps

  const readClaudeFile = (file) => {
    if (!file) return;
    const isImage = file.type.startsWith("image/");
    const isPdf = file.type === "application/pdf";
    if (!isImage && !isPdf) { notify("Claude can read images and PDFs — other file types aren't supported yet.", "warning"); return; }
    const reader = new FileReader();
    reader.onload = (e) => {
      const base64 = e.target.result.split(",")[1];
      setClaudeAttachment({ filename: file.name, base64, mediaType: file.type, kind: isImage ? "image" : "pdf" });
      setClaudePanelOpen(true);
      setTimeout(() => claudeInputRef.current?.focus(), 50);
    };
    reader.readAsDataURL(file);
  };

  // ── Undo last Claude Action ──────────────────────────────────
  // Restores a single pre-action snapshot of the four state slices
  // that Claude Actions can mutate: tally, weekly timetable, students, teachers.
  const undoClaudeAction = () => {
    const snap = claudeActionSnapshotRef.current;
    if (!snap) return;
    setWeeklyTimetablesRaw(snap.weeklyTimetables);
    setStudents(snap.students);
    setTeachersRaw(snap.teachers);
    claudeActionSnapshotRef.current = null;
    setHasClaudeUndo(false);
    notify("Claude action undone", "success");
  };

  // ── Claude system prompt builder ─────────────────────────────
  // ── Claude Actions — execute a tool call from the Claude panel ──────────
  // Returns a result string that gets sent back to Claude as a tool_result.
  const executeTool = (name, input) => {
    try {
      // ── Shared date helpers ──────────────────────────────────────────────
      const buildDateParts = (dateStr) => {
        const dateObj = new Date(dateStr + "T00:00:00");
        const dow = dateObj.getDay();
        const dayName = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][dow];
        const monday = _getMondayOf(dateObj);
        const weekKey = toLocalDateStr(monday);
        const tBreaks = interruptions.filter(i => i.type === "term_break").sort((a,b) => a.date.localeCompare(b.date));
        const weekNum = computeTermWeekNum(dateStr, tBreaks);
        const termKey = computeTermKey(dateStr, tBreaks);
        const weekLabel = weekNum ? `Week ${weekNum}` : `Week of ${weekKey}`;
        return { dayName, weekKey, weekNum, termKey, weekLabel };
      };

      // ── mark_lesson_missed ───────────────────────────────────────────────
      if (name === "mark_lesson_missed") {
        const { studentId, studentName, date, instrument, reason, reasonDetail, makeupEligible, notes } = input;
        const { dayName, weekKey, weekNum, termKey, weekLabel } = buildDateParts(date);
        const student = students.find(s => s.id === studentId);
        const eligible = makeupEligible !== undefined
          ? makeupEligible
          : (reason !== "school_interruption" && reason !== "cancelled");

        // Map reason value → display label (matches TALLY_REASONS in constants.js)
        const REASON_DISPLAY = {
          student_absent:      "Absent",
          informed_absence:    "Informed Absence",
          uninformed_absence:  "Uninformed Absence",
          school_interruption: "School Interruption",
          teacher_absent:      "Teacher Absent",
          cancelled:           "Cancelled",
          other:               "Other",
        };
        const displayReason = reasonDetail || REASON_DISPLAY[reason] || reason || "";

        // Find the lesson in the WTT lessons array
        let foundKey = null;
        let foundLesson = null;
        for (const [sk, data] of Object.entries(weeklyTimetables || {})) {
          const [sk_week, sk_school] = sk.split("|");
          if (sk_week !== weekKey) continue;
          const lesson = (data.lessons || []).find(l =>
            l.studentId === studentId &&
            l.day === dayName &&
            !l.isCancelled &&
            (!instrument || l.instrument?.toLowerCase() === instrument.toLowerCase())
          );
          if (lesson) { foundKey = sk; foundLesson = lesson; break; }
        }

        if (!foundLesson) return `No active lesson found for ${studentName}${instrument ? ` (${instrument})` : ""} on ${dayName} ${date} — nothing recorded.`;

        const instr = foundLesson.instrument || instrument || (student ? instrumentsFromEnrolments(student.id, enrolments)[0]?.name : "") || "";
        const lessonKey = `${studentId}|${instr}`;

        // Duplicate check — scan the same WTT entry's missed array for an existing match
        const foundData = weeklyTimetables[foundKey];
        const alreadyMissed = (foundData?.missed || []).some(m =>
          m.studentId === studentId &&
          m.day === dayName &&
          (!instr || m.instrument?.toLowerCase() === instr.toLowerCase())
        );
        if (alreadyMissed) return `Already have a missed entry for ${studentName} on ${dayName} ${date} — nothing added.`;

        // Move lesson from lessons → missed array with full structured payload (post-Commit-5)
        setWeeklyTimetables(prev => {
          const data = prev[foundKey];
          if (!data) return prev;
          const missedEntry = {
            ...foundLesson,
            enrolmentId: enrolmentIdFor(foundLesson.studentId, foundLesson.instrument, enrolments, foundLesson.groupId),
            reason: reason || "other",
            reasonDetail: reasonDetail || "",
            notes: notes || "",
            makeupEligible: eligible,
            madeUp: false,
            cardNote: "",
          };
          return {
            ...prev,
            [foundKey]: {
              ...data,
              lessons: data.lessons.filter(l => l.id !== foundLesson.id),
              missed: [...(data.missed || []), missedEntry],
            }
          };
        });

        notify(`Marked ${studentName} absent — ${dayName}`, "info");
        return `Done — ${studentName}'s ${instr ? instr + " lesson" : "lesson"} on ${dayName} ${date} moved to missed zone. Reason: ${displayReason || "none"}. Catch-up ${eligible ? "is owed" : "is not owed"}.`;
      }

      // ── bulk_mark_missed ─────────────────────────────────────────────────
      if (name === "bulk_mark_missed") {
        const { date, schoolId, schoolName, reason, reasonDetail, makeupEligible } = input;
        const { dayName, weekKey, weekNum, termKey, weekLabel } = buildDateParts(date);
        const eligible = makeupEligible !== undefined ? makeupEligible : (reason !== "school_interruption" && reason !== "cancelled");
        const REASON_DISPLAY = {
          student_absent: "Absent", informed_absence: "Informed Absence",
          uninformed_absence: "Uninformed Absence", school_interruption: "School Interruption",
          teacher_absent: "Teacher Absent", cancelled: "Cancelled", other: "Other",
        };
        const displayReason = reasonDetail || REASON_DISPLAY[reason] || reason || "";
        // Collect lessons to move per storage key
        const toMoveBySk = {}; // sk → [lesson, ...]
        for (const [sk, weeklyData] of Object.entries(weeklyTimetables)) {
          const parts = sk.split("|");
          if (parts[0] !== weekKey) continue;
          const lessonSchoolId = parts[1];
          if (schoolId && lessonSchoolId !== schoolId) continue;
          for (const lesson of (weeklyData.lessons || [])) {
            if (lesson.day !== dayName || lesson.isCancelled) continue;
            const lessonKey = lesson.isGroup ? `group|${lesson.groupId}` : `${lesson.studentId}|${lesson.instrument}`;
            if (!lessonKey || lessonKey === "|") continue;
            const alreadyMissed = (weeklyData.missed || []).some(m => {
              const mKey = m.isGroup ? `group|${m.groupId}` : `${m.studentId}|${m.instrument}`;
              return mKey === lessonKey && m.day === dayName;
            });
            if (alreadyMissed) continue;
            if (!toMoveBySk[sk]) toMoveBySk[sk] = [];
            toMoveBySk[sk].push(lesson);
          }
        }
        const movedCount = Object.values(toMoveBySk).reduce((n, arr) => n + arr.length, 0);
        if (movedCount === 0) return `No lessons found for ${schoolName || "that school"} on ${dayName} ${date} — nothing to mark.`;
        // Move lessons from lessons → missed array with full structured payload (post-Commit-5)
        setWeeklyTimetables(prev => {
          const next = { ...prev };
          for (const [sk, lessonsToMove] of Object.entries(toMoveBySk)) {
            const data = next[sk];
            if (!data) continue;
            const moveIds = new Set(lessonsToMove.map(l => l.id));
            const missedEntries = lessonsToMove.map(l => ({
              ...l,
              enrolmentId: enrolmentIdFor(l.studentId, l.instrument, enrolments, l.groupId),
              reason: reason || "other",
              reasonDetail: reasonDetail || "",
              notes: "",
              makeupEligible: eligible,
              madeUp: false,
              cardNote: "",
            }));
            next[sk] = {
              ...data,
              lessons: data.lessons.filter(l => !moveIds.has(l.id)),
              missed: [...(data.missed || []), ...missedEntries],
            };
          }
          return next;
        });
        notify(`Marked ${movedCount} lessons missed — ${dayName}`, "info");
        return `Done — moved ${movedCount} lesson${movedCount !== 1 ? "s" : ""} to missed zone on ${dayName} ${date}${schoolName ? ` at ${schoolName}` : ""}. Catch-ups ${eligible ? "are" : "are not"} owed.`;
      }

      // ── add_todo ─────────────────────────────────────────────────────────
      if (name === "add_todo") {
        const { text, priority, mentions, subItems } = input;
        const existing = JSON.parse(localStorage.getItem(STORAGE_KEYS.todoItems) || "[]");
        const newItem = {
          id: uid(), text, done: false,
          priority: priority || "normal",
          createdAt: new Date().toISOString(),
          ...(mentions?.length ? { mentions } : {}),
          ...(subItems?.length ? {
            subItems: subItems.map(s => ({
              id: uid(),
              text: s.text,
              done: false,
              ...(s.mentions?.length ? { mentions: s.mentions } : {}),
            }))
          } : {}),
        };
        localStorage.setItem(STORAGE_KEYS.todoItems, JSON.stringify([newItem, ...existing]));
        window.dispatchEvent(new CustomEvent("mt-todos-updated"));
        notify("To-do item added", "info");
        const subNote = subItems?.length ? ` (${subItems.length} sub-item${subItems.length !== 1 ? "s" : ""})` : "";
        return `Added to-do: "${text}"${subNote}`;
      }

      // ── add_reminder ─────────────────────────────────────────────────────
      if (name === "add_reminder") {
        const { text, remindFromWeek, eventWeek, date, studentName, notes } = input;
        // Helper: compute Monday date of a given term week number
        const getWeekMonday = (weekNum) => {
          const tBreaks = [...interruptions].filter(i => i.type === "term_break").sort((a,b) => b.date.localeCompare(a.date));
          const today2 = toLocalDateStr(melbourneNow());
          let termStart = null;
          for (const br of tBreaks) {
            const tbEnd = br.endDate || br.date;
            if (tbEnd < today2) {
              const ts = new Date(tbEnd + "T00:00:00"); ts.setDate(ts.getDate() + 1);
              while (ts.getDay() === 6 || ts.getDay() === 0) ts.setDate(ts.getDate() + 1);
              termStart = ts; break;
            }
          }
          if (!termStart) { const y = new Date().getFullYear(); const s = new Date(y, 0, 27); while (s.getDay() !== 2) s.setDate(s.getDate() + 1); termStart = s; }
          const d = new Date(termStart); d.setDate(d.getDate() + (weekNum - 1) * 7);
          return toLocalDateStr(d);
        };
        // Compute start date: from remindFromWeek if given, otherwise use date field
        const startDate = remindFromWeek ? getWeekMonday(remindFromWeek) : date;
        // eventWeek → stored as `week` (used by Dashboard for calendar dot + visibility end + alert chip)
        // If no eventWeek but remindFromWeek given, use remindFromWeek as the event week too
        // (reminder visible for just that one week, no prior-week alert chip)
        const effectiveEventWeek = eventWeek || (remindFromWeek ? remindFromWeek : undefined);
        const entry = {
          id: uid(),
          text: text.trim(),
          createdAt: new Date().toISOString(),
          ...(startDate           !== undefined ? { date: startDate }                    : {}),
          ...(effectiveEventWeek  !== undefined ? { week: String(effectiveEventWeek) }   : {}),
          ...(studentName         !== undefined ? { studentName }                        : {}),
          ...(notes               !== undefined ? { notes }                              : {}),
        };
        const existing = JSON.parse(localStorage.getItem("mt-reminders") || "[]");
        localStorage.setItem("mt-reminders", JSON.stringify([entry, ...existing]));
        window.dispatchEvent(new CustomEvent("mt-reminders-updated"));
        notify("Reminder added", "info");
        const metaParts = [
          remindFromWeek ? `visible from Week ${remindFromWeek}` : null,
          eventWeek && eventWeek !== remindFromWeek ? `event Week ${eventWeek} (alert fires Week ${eventWeek - 1})` : null,
          !remindFromWeek && !eventWeek && date ? `from ${date}` : null,
          studentName || null,
        ].filter(Boolean);
        return `Added reminder: "${text}"${metaParts.length ? ` [${metaParts.join(", ")}]` : ""}`;
      }

      // ── draft_email ──────────────────────────────────────────────────────
      if (name === "draft_email") {
        const { to, subject, body } = input;
        if (window._openComposeModal) {
          window._openComposeModal({
            to: to ? [to] : [],
            subject: subject || "",
            body: body || "",
            triggerId: "claude_action",
            mergeCtx: null,
            attachments: null,
          });
          return `Email draft opened — review and send when ready. Subject: "${subject}"`;
        }
        return `Could not open compose window — try opening it manually.`;
      }

      // ── cancel_wtt_lesson ────────────────────────────────────────────────
      if (name === "cancel_wtt_lesson") {
        const { studentId, studentName, date, instrument, schoolId } = input;
        const { dayName, weekKey } = buildDateParts(date);
        // Find the lesson
        let foundKey = null;
        let foundIdx = -1;
        for (const [sk, data] of Object.entries(weeklyTimetables || {})) {
          const [sk_weekKey, sk_schoolId] = sk.split("|");
          if (sk_weekKey !== weekKey) continue;
          if (schoolId && sk_schoolId !== schoolId) continue;
          const idx = (data.lessons || []).findIndex(l =>
            l.studentId === studentId &&
            l.day === dayName &&
            !l.isCancelled &&
            (!instrument || l.instrument?.toLowerCase() === instrument.toLowerCase())
          );
          if (idx !== -1) { foundKey = sk; foundIdx = idx; break; }
        }
        if (foundKey === null) return `No active lesson found for ${studentName}${instrument ? ` (${instrument})` : ""} on ${dayName} ${date} — nothing changed.`;
        const foundLesson = weeklyTimetables[foundKey]?.lessons?.[foundIdx] || {};
        const instr = foundLesson.instrument || instrument || "";
        // Mark as cancelled (crossed out, stays in lessons array — unscheduled for this week)
        // NOTE: This does NOT create a tally entry. Cancellation = unscheduled, not absent.
        // Use mark_lesson_missed instead if the student was absent and a tally entry is needed.
        setWeeklyTimetables(prev => {
          const data = prev[foundKey];
          if (!data) return prev;
          const updatedLessons = (data.lessons || []).map((l, i) =>
            i === foundIdx ? { ...l, isCancelled: true, adjusted: true } : l
          );
          return { ...prev, [foundKey]: { ...data, lessons: updatedLessons } };
        });
        notify(`Cancelled ${studentName}'s ${instr ? instr + " lesson" : "lesson"} — ${dayName}`, "info");
        return `Done — ${studentName}'s ${instr ? instr + " lesson" : "lesson"} on ${dayName} ${date} cancelled (unscheduled for this week). No tally entry created.`;
      }

      // ── mark_student_absent_week ─────────────────────────────────────────
      if (name === "mark_student_absent_week") {
        const { studentId, studentName, weekOf, reason, reasonDetail, makeupEligible } = input;
        const { weekKey } = buildDateParts(weekOf);
        const eligible = makeupEligible !== undefined ? makeupEligible : (reason !== "school_interruption" && reason !== "cancelled");
        const tBreaks = interruptions.filter(i => i.type === "term_break").sort((a,b) => a.date.localeCompare(b.date));
        const weekNum = computeTermWeekNum(weekKey, tBreaks);
        const termKey = computeTermKey(weekKey, tBreaks);
        const weekLabel = weekNum ? `Week ${weekNum}` : `Week of ${weekKey}`;
        const REASON_DISPLAY = {
          student_absent: "Absent", informed_absence: "Informed Absence",
          uninformed_absence: "Uninformed Absence", school_interruption: "School Interruption",
          teacher_absent: "Teacher Absent", cancelled: "Cancelled", other: "Other",
        };
        const displayReason = reasonDetail || REASON_DISPLAY[reason] || reason || "";
        const toMoveBySk = {};
        for (const [sk, data] of Object.entries(weeklyTimetables || {})) {
          const [sk_weekKey, sk_schoolId] = sk.split("|");
          if (sk_weekKey !== weekKey) continue;
          for (const lesson of (data.lessons || [])) {
            if (lesson.studentId !== studentId || lesson.isCancelled) continue;
            const lessonKey = `${lesson.studentId}|${lesson.instrument}`;
            const alreadyMissed = (data.missed || []).some(m =>
              m.studentId === lesson.studentId &&
              m.instrument === lesson.instrument &&
              m.day === lesson.day
            );
            if (alreadyMissed) continue;
            if (!toMoveBySk[sk]) toMoveBySk[sk] = [];
            toMoveBySk[sk].push(lesson);
          }
        }
        const movedCount = Object.values(toMoveBySk).reduce((n, arr) => n + arr.length, 0);
        if (movedCount === 0) return `No unrecorded lessons found for ${studentName} in the week of ${weekKey} — nothing added.`;
        // Move lessons to missed zone with full structured payload (post-Commit-5)
        setWeeklyTimetables(prev => {
          const next = { ...prev };
          for (const [sk, lessonsToMove] of Object.entries(toMoveBySk)) {
            const data = next[sk];
            if (!data) continue;
            const moveIds = new Set(lessonsToMove.map(l => l.id));
            const missedEntries = lessonsToMove.map(l => ({
              ...l,
              enrolmentId: enrolmentIdFor(l.studentId, l.instrument, enrolments, l.groupId),
              reason: reason || "other",
              reasonDetail: reasonDetail || "",
              notes: "",
              makeupEligible: eligible,
              madeUp: false,
              cardNote: "",
            }));
            next[sk] = {
              ...data,
              lessons: data.lessons.filter(l => !moveIds.has(l.id)),
              missed: [...(data.missed || []), ...missedEntries],
            };
          }
          return next;
        });
        notify(`Marked ${studentName} absent — ${movedCount} lesson${movedCount !== 1 ? "s" : ""}`, "info");
        return `Done — moved all ${movedCount} of ${studentName}'s lessons to missed zone for the week of ${weekKey}. Catch-ups ${eligible ? "are" : "are not"} owed.`;
      }

      // ── move_wtt_lesson ──────────────────────────────────────────────────
      if (name === "move_wtt_lesson") {
        const { studentId, studentName, fromDate, toDate, toStart, toEnd, instrument } = input;
        const { dayName: fromDay, weekKey: fromWeek } = buildDateParts(fromDate);
        const { dayName: toDay, weekKey: toWeek } = buildDateParts(toDate);
        // Find the lesson in the source week
        let foundKey = null;
        let foundLesson = null;
        for (const [sk, data] of Object.entries(weeklyTimetables || {})) {
          const [sk_week] = sk.split("|");
          if (sk_week !== fromWeek) continue;
          const lesson = (data.lessons || []).find(l =>
            l.studentId === studentId &&
            l.day === fromDay &&
            !l.isCancelled &&
            (!instrument || l.instrument?.toLowerCase() === instrument.toLowerCase())
          );
          if (lesson) { foundKey = sk; foundLesson = lesson; break; }
        }
        if (!foundLesson) return `No active lesson found for ${studentName}${instrument ? ` (${instrument})` : ""} on ${fromDay} ${fromDate} — nothing changed.`;
        const [, foundSchoolId] = foundKey.split("|");
        const toKey = `${toWeek}|${foundSchoolId}`;
        const updatedLesson = {
          ...foundLesson,
          day: toDay,
          start: toStart,
          end: toEnd || foundLesson.end,
          adjusted: true,
        };
        // Match by studentId+day+instrument — avoids id-matching issues with catch-up lessons
        const matchesFound = (l) =>
          l.studentId === studentId &&
          l.day === fromDay &&
          (!instrument || l.instrument?.toLowerCase() === instrument.toLowerCase());
        if (fromWeek === toWeek) {
          // Same week — update in place (first match only)
          setWeeklyTimetables(prev => {
            const data = prev[foundKey];
            if (!data) return prev;
            let applied = false;
            const lessons = (data.lessons || []).map(l => {
              if (!applied && matchesFound(l)) { applied = true; return updatedLesson; }
              return l;
            });
            return { ...prev, [foundKey]: { ...data, lessons } };
          });
        } else {
          // Different weeks — remove from source week (first match only), add to target week
          setWeeklyTimetables(prev => {
            const next = { ...prev };
            const srcData = next[foundKey];
            if (srcData) {
              let removed = false;
              next[foundKey] = { ...srcData, lessons: (srcData.lessons || []).filter(l => {
                if (!removed && matchesFound(l)) { removed = true; return false; }
                return true;
              })};
            }
            const tgtData = next[toKey] || { lessons: [] };
            next[toKey] = { ...tgtData, lessons: [...(tgtData.lessons || []), updatedLesson] };
            return next;
          });
        }
        const instr = foundLesson.instrument || instrument || "";
        notify(`Moved ${studentName}'s lesson → ${toDay} ${toStart}`, "info");
        return `Done — ${studentName}'s ${instr ? instr + " lesson" : "lesson"} moved from ${fromDay} ${fromDate} (${foundLesson.start}) to ${toDay} ${toDate} (${toStart}).`;
      }

      // ── swap_student_lessons ─────────────────────────────────────────────
      if (name === "swap_student_lessons") {
        const { studentAId, studentAName, studentBId, studentBName, weekOf, studentAInstrument, studentBInstrument } = input;
        const { weekKey } = buildDateParts(weekOf);
        // Find lesson A
        let keyA = null, lessonA = null;
        for (const [sk, data] of Object.entries(weeklyTimetables || {})) {
          const [sk_week] = sk.split("|");
          if (sk_week !== weekKey) continue;
          const l = (data.lessons || []).find(l =>
            l.studentId === studentAId && !l.isCancelled &&
            (!studentAInstrument || l.instrument?.toLowerCase() === studentAInstrument.toLowerCase())
          );
          if (l) { keyA = sk; lessonA = l; break; }
        }
        // Find lesson B
        let keyB = null, lessonB = null;
        for (const [sk, data] of Object.entries(weeklyTimetables || {})) {
          const [sk_week] = sk.split("|");
          if (sk_week !== weekKey) continue;
          const l = (data.lessons || []).find(l =>
            l.studentId === studentBId && !l.isCancelled &&
            (!studentBInstrument || l.instrument?.toLowerCase() === studentBInstrument.toLowerCase())
          );
          if (l) { keyB = sk; lessonB = l; break; }
        }
        if (!lessonA) return `No active lesson found for ${studentAName} in the week of ${weekKey} — nothing changed.`;
        if (!lessonB) return `No active lesson found for ${studentBName} in the week of ${weekKey} — nothing changed.`;
        // Capture timing from each lesson
        const timingA = { day: lessonA.day, start: lessonA.start, end: lessonA.end, slotId: lessonA.slotId, slotName: lessonA.slotName };
        const timingB = { day: lessonB.day, start: lessonB.start, end: lessonB.end, slotId: lessonB.slotId, slotName: lessonB.slotName };
        setWeeklyTimetables(prev => {
          const next = { ...prev };
          // Apply B's timing to A's lesson — match by studentId+day+instrument (first match only)
          const dataA = next[keyA];
          if (dataA) {
            let doneA = false;
            next[keyA] = { ...dataA, lessons: (dataA.lessons || []).map(l => {
              if (!doneA && l.studentId === studentAId && l.day === timingA.day &&
                  (!studentAInstrument || l.instrument?.toLowerCase() === studentAInstrument.toLowerCase())) {
                doneA = true; return { ...l, ...timingB, adjusted: true };
              }
              return l;
            })};
          }
          // Apply A's timing to B's lesson (use updated next[keyB] in case keyA === keyB)
          const dataB = next[keyB];
          if (dataB) {
            let doneB = false;
            next[keyB] = { ...dataB, lessons: (dataB.lessons || []).map(l => {
              if (!doneB && l.studentId === studentBId && l.day === timingB.day &&
                  (!studentBInstrument || l.instrument?.toLowerCase() === studentBInstrument.toLowerCase())) {
                doneB = true; return { ...l, ...timingA, adjusted: true };
              }
              return l;
            })};
          }
          return next;
        });
        notify(`Swapped ${studentAName} ↔ ${studentBName}`, "info");
        return `Done — swapped lessons: ${studentAName} (${timingA.day} ${timingA.start}) now has ${timingB.day} ${timingB.start}, and ${studentBName} (${timingB.day} ${timingB.start}) now has ${timingA.day} ${timingA.start}. Both marked as adjusted.`;
      }

      // ── update_tally_entry ────────────────────────────────────────────────
      if (name === "update_tally_entry") {
        const { studentId, studentName, weekOf, day, instrument, reason, reasonDetail, makeupEligible, notes } = input;
        const { weekKey } = buildDateParts(weekOf);
        // Find the WTT entry containing the missed record
        let foundKey = null, foundMissed = null;
        for (const [sk, data] of Object.entries(weeklyTimetables)) {
          const [sk_weekKey, sk_schoolId] = sk.split("|");
          if (sk_weekKey !== weekKey) continue;
          const m = (data.missed || []).find(mm =>
            mm.studentId === studentId &&
            mm.day === day &&
            (!instrument || mm.instrument?.toLowerCase() === instrument.toLowerCase())
          );
          if (m) { foundKey = sk; foundMissed = m; break; }
        }
        if (!foundMissed) return `No missed-lesson entry found for ${studentName} on ${day} in the week of ${weekKey} — nothing changed.`;
        setWeeklyTimetables(prev => {
          const data = prev[foundKey];
          if (!data) return prev;
          return {
            ...prev,
            [foundKey]: {
              ...data,
              missed: (data.missed || []).map(m => m.id !== foundMissed.id ? m : {
                ...m,
                ...(reason         !== undefined ? { reason }         : {}),
                ...(reasonDetail   !== undefined ? { reasonDetail }   : {}),
                ...(makeupEligible !== undefined ? { makeupEligible } : {}),
                ...(notes          !== undefined ? { notes }          : {}),
              })
            }
          };
        });
        const changes = [
          reason         !== undefined ? `reason → ${reason}` : null,
          reasonDetail   !== undefined ? `detail → "${reasonDetail}"` : null,
          makeupEligible !== undefined ? `catch-up owed → ${makeupEligible}` : null,
          notes          !== undefined ? `notes updated` : null,
        ].filter(Boolean).join(", ");
        notify(`Updated missed entry — ${studentName}`, "info");
        return `Done — updated ${studentName}'s ${foundMissed.instrument || ""} missed-lesson entry for ${day} (${weekKey}): ${changes || "no fields changed"}.`;
      }

      // ── mark_tally_completed ──────────────────────────────────────────────
      if (name === "mark_tally_completed") {
        const { studentId, studentName, weekOf, day, instrument, madeUp } = input;
        const { weekKey } = buildDateParts(weekOf);
        let foundKey = null, foundMissed = null;
        for (const [sk, data] of Object.entries(weeklyTimetables)) {
          const [sk_weekKey, sk_schoolId] = sk.split("|");
          if (sk_weekKey !== weekKey) continue;
          const m = (data.missed || []).find(mm =>
            mm.studentId === studentId &&
            mm.day === day &&
            (!instrument || mm.instrument?.toLowerCase() === instrument.toLowerCase())
          );
          if (m) { foundKey = sk; foundMissed = m; break; }
        }
        if (!foundMissed) return `No missed-lesson entry found for ${studentName} on ${day} in the week of ${weekKey} — nothing changed.`;
        const isMadeUp = madeUp !== false;
        setWeeklyTimetables(prev => {
          const data = prev[foundKey];
          if (!data) return prev;
          if (isMadeUp) {
            // Stamp madeUp: true on the missed entry (catch-up resolved)
            return {
              ...prev,
              [foundKey]: {
                ...data,
                missed: (data.missed || []).map(m => m.id !== foundMissed.id ? m : { ...m, madeUp: true })
              }
            };
          } else {
            // Move from missed back to lessons (attendance confirmed, not a catch-up)
            return {
              ...prev,
              [foundKey]: {
                ...data,
                lessons: [...(data.lessons || []), { ...foundMissed }],
                missed: (data.missed || []).filter(m => m.id !== foundMissed.id)
              }
            };
          }
        });
        notify(`Marked completed — ${studentName}`, "info");
        return `Done — ${studentName}'s ${foundMissed.instrument || ""} lesson on ${day} (${weekKey}) marked as completed${isMadeUp ? " (made up)" : ""}.`;
      }

      // ── delete_tally_entry ────────────────────────────────────────────────
      if (name === "delete_tally_entry") {
        const { studentId, studentName, weekOf, day, instrument } = input;
        const { weekKey } = buildDateParts(weekOf);
        let foundKey = null, foundMissed = null;
        for (const [sk, data] of Object.entries(weeklyTimetables)) {
          const [sk_weekKey, sk_schoolId] = sk.split("|");
          if (sk_weekKey !== weekKey) continue;
          const m = (data.missed || []).find(mm =>
            mm.studentId === studentId &&
            mm.day === day &&
            (!instrument || mm.instrument?.toLowerCase() === instrument.toLowerCase())
          );
          if (m) { foundKey = sk; foundMissed = m; break; }
        }
        if (!foundMissed) return `No missed-lesson entry found for ${studentName} on ${day} in the week of ${weekKey} — nothing deleted.`;
        setWeeklyTimetables(prev => {
          const data = prev[foundKey];
          if (!data) return prev;
          return {
            ...prev,
            [foundKey]: {
              ...data,
              missed: (data.missed || []).filter(m => m.id !== foundMissed.id)
            }
          };
        });
        notify(`Deleted missed entry — ${studentName}`, "info");
        return `Done — deleted ${studentName}'s ${foundMissed.instrument || ""} missed-lesson entry for ${day} (${weekKey}).`;
      }

      // ── add_student ──────────────────────────────────────────────────────
      if (name === "add_student") {
        const { name: studentName, schoolId, schoolName, className, instruments, parentName, parentEmail, parentPhone, notes } = input;
        const newStudent = {
          id: uid(),
          name: studentName,
          status: "pending",
          schoolId: schoolId || "",
          className: className || "",
          instruments: (instruments || []).map(i => ({ name: i.name })),
          ...(parentName  ? { parentName }  : {}),
          ...(parentEmail ? { parentEmail } : {}),
          ...(parentPhone ? { parentPhone } : {}),
          ...(notes       ? { notes }       : {}),
          createdAt: new Date().toISOString(),
        };
        setStudents(prev => [...prev, newStudent]);
        // Mirror instruments[] into enrolments — form-side path does this via
        // commitSaveStudent; AI tools bypassed it pre-7.1.1.5 and produced
        // the missing-enrolment cases logged in session 117.
        const todayISO = new Date().toISOString().split("T")[0];
        setEnrolments(prev => syncEnrolmentsFromInstruments({
          studentId: newStudent.id,
          newInstruments: newStudent.instruments || [],
          enrolments: prev,
          todayDate: todayISO,
        }));
        const instStr = (instruments || []).map(i => i.name).join(", ") || "no instruments set yet";
        notify(`Added student: ${studentName}`, "success");
        return `Done — created pending student: ${studentName} at ${schoolName}${className ? `, ${className}` : ""}. Instruments: ${instStr}. They will appear in the Pending tab, ready to be scheduled.`;
      }

      // ── edit_student ─────────────────────────────────────────────────────
      if (name === "edit_student") {
        const { studentId, studentName, name: newName, schoolId, className, instruments, parentName, parentEmail, parentPhone, notes, status } = input;
        // Existence check only — the mutation below matches by id inside the
        // setter, not by index, so we don't capture findIndex's idx.
        if (!students.some(s => s.id === studentId)) return `No student found with ID ${studentId} — nothing changed.`;
        const patch = {};
        if (newName      !== undefined) patch.name        = newName;
        if (schoolId     !== undefined) patch.schoolId    = schoolId;
        if (className    !== undefined) patch.className   = className;
        if (parentName   !== undefined) patch.parentName  = parentName;
        if (parentEmail  !== undefined) patch.parentEmail = parentEmail;
        if (parentPhone  !== undefined) patch.parentPhone = parentPhone;
        if (notes        !== undefined) patch.notes       = notes;
        if (status       !== undefined) patch.status      = status;
        if (instruments  !== undefined) patch.instruments = instruments.map(i => ({ name: i.name }));
        if (Object.keys(patch).length === 0) return `No fields provided — nothing changed for ${studentName}.`;
        setStudents(prev => prev.map(s => s.id !== studentId ? s : { ...s, ...patch }));
        // Mirror instruments[] into enrolments only when instruments was in the
        // input. Skipping the guard would treat name-only edits as "remove all
        // instruments" and silently end-date every active enrolment.
        if (instruments !== undefined) {
          const todayISO = new Date().toISOString().split("T")[0];
          setEnrolments(prev => syncEnrolmentsFromInstruments({
            studentId,
            newInstruments: patch.instruments,
            enrolments: prev,
            todayDate: todayISO,
          }));
        }
        const changes = Object.entries(patch).map(([k, v]) => {
          if (k === "instruments") return `instruments → ${v.map(i => i.name).join(", ")}`;
          if (k === "schoolId") { const sn = schools.find(s => s.id === v)?.name || v; return `school → ${sn}`; }
          return `${k} → ${v}`;
        }).join(", ");
        notify(`Updated student: ${studentName}`, "success");
        return `Done — updated ${studentName}: ${changes}.`;
      }

      // ── archive_student ───────────────────────────────────────────────────
      if (name === "archive_student") {
        const { studentId, studentName } = input;
        if (!students.some(s => s.id === studentId)) return `No student found with ID ${studentId} — nothing changed.`;
        const todayISO = new Date().toISOString().split("T")[0];
        setStudents(prev => prev.map(s => s.id !== studentId ? s : { ...s, status: "archived", archivedAt: new Date().toISOString() }));
        // Match commitSaveStudent's archive branch: stamp endDate on every
        // active enrolment for this student.
        setEnrolments(prev => prev.map(e =>
          e.studentId === studentId && !e.endDate ? { ...e, endDate: todayISO } : e
        ));
        // Match the StudentsManager-prop onArchiveStudent card cleanup
        // (App.js:6200). The AI tool path was missing this pre-Spec-1; without
        // it, archived students kept visible MTT/WTT cards.
        if (timetable) setTimetable(prev => ({ ...prev, lessons: (prev.lessons || []).filter(l => l.studentId !== studentId), unscheduled: (prev.unscheduled || []).filter(u => u.student?.id !== studentId) }));
        setWeeklyTimetables(prev => {
          const next = { ...prev };
          for (const key of Object.keys(next)) {
            const entry = next[key];
            if (!entry) continue;
            next[key] = { ...entry, lessons: (entry.lessons || []).filter(l => l.studentId !== studentId) };
          }
          return next;
        });
        notify(`Archived student: ${studentName}`, "success");
        return `Done — ${studentName} has been archived. They are hidden from all active views but can be restored from the Students page.`;
      }

      // ── restore_student ───────────────────────────────────────────────────
      if (name === "restore_student") {
        const { studentId, studentName } = input;
        const existing = students.find(s => s.id === studentId);
        if (!existing) return `No student found with ID ${studentId} — nothing changed.`;
        if (existing.status !== "archived") return `${studentName} is not archived (current status: ${existing.status}) — nothing changed.`;
        setStudents(prev => prev.map(s => s.id !== studentId ? s : { ...s, status: "pending", archivedAt: undefined }));
        // Symmetric with archive_student: clear endDate ONLY on enrolments that
        // were end-dated by the matching archive event. Enrolments ended on
        // other dates stay ended (refinement D — endDate is permanent).
        // archivedAt is a full ISO timestamp; endDate is date-only — strip to
        // date for the same-day match.
        if (existing.archivedAt) {
          const archiveDate = existing.archivedAt.split("T")[0];
          setEnrolments(prev => prev.map(e =>
            e.studentId === studentId && e.endDate === archiveDate
              ? { ...e, endDate: undefined }
              : e
          ));
        }
        notify(`Restored student: ${studentName}`, "success");
        return `Done — ${studentName} has been restored to pending status and will appear in the student list again.`;
      }

      // ── add_teacher ──────────────────────────────────────────────────────
      if (name === "add_teacher") {
        const { name: teacherName, email, instruments, availability } = input;
        const newTeacher = {
          id: uid(),
          name: teacherName,
          email: email || "",
          instruments: (instruments || []).map(i => typeof i === "string" ? { name: i } : i),
          availability: (availability || []).map(a => ({
            schoolId: a.schoolId,
            day: a.day,
            start: a.start || "9:00",
            end: a.end || "15:30",
          })),
          createdAt: new Date().toISOString(),
        };
        setTeachers(prev => [...prev, newTeacher]);
        const instStr = (instruments || []).join(", ") || "none set";
        const availStr = (availability || []).map(a => {
          const sn = schools.find(s => s.id === a.schoolId)?.name || a.schoolId;
          return `${a.day} @ ${sn}`;
        }).join(", ") || "none set";
        notify(`Added teacher: ${teacherName}`, "success");
        return `Done — created teacher: ${teacherName}${email ? ` <${email}>` : ""}. Instruments: ${instStr}. Availability: ${availStr}.`;
      }

      // ── edit_teacher ─────────────────────────────────────────────────────
      if (name === "edit_teacher") {
        const { teacherId, teacherName, name: newName, email, instruments, availability } = input;
        const idx = teachers.findIndex(t => t.id === teacherId);
        if (idx === -1) return `No teacher found with ID ${teacherId} — nothing changed.`;
        const patch = {};
        if (newName      !== undefined) patch.name         = newName;
        if (email        !== undefined) patch.email        = email;
        if (instruments  !== undefined) patch.instruments  = instruments.map(i => typeof i === "string" ? { name: i } : i);
        if (availability !== undefined) patch.availability = availability.map(a => ({
          schoolId: a.schoolId,
          day: a.day,
          start: a.start || "9:00",
          end: a.end || "15:30",
        }));
        if (Object.keys(patch).length === 0) return `No fields provided — nothing changed for ${teacherName}.`;
        setTeachers(prev => prev.map((t, i) => i !== idx ? t : { ...t, ...patch }));
        const changes = Object.entries(patch).map(([k, v]) => {
          if (k === "instruments") return `instruments → ${v.map(i => i.name).join(", ")}`;
          if (k === "availability") return `availability → ${v.map(a => { const sn = schools.find(s => s.id === a.schoolId)?.name || a.schoolId; return `${a.day} @ ${sn}`; }).join(", ")}`;
          return `${k} → ${v}`;
        }).join(", ");
        notify(`Updated teacher: ${teacherName}`, "success");
        return `Done — updated ${teacherName}: ${changes}.`;
      }

      // ── schedule_wtt_lesson ──────────────────────────────────────────────
      if (name === "schedule_wtt_lesson") {
        const { studentId, studentName, teacherId, teacherName, schoolId, schoolName, weekOf, day, start, end, instrument } = input;
        const { weekKey } = buildDateParts(weekOf);
        // Compute the actual calendar date for this day within the week
        const monday = new Date(weekKey + "T00:00:00");
        const dayIndex = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"].indexOf(day);
        let weekDate = null;
        if (dayIndex !== -1) {
          const d = new Date(monday);
          d.setDate(monday.getDate() + dayIndex);
          weekDate = toLocalDateStr(d);
        }
        const storageKey = `${weekKey}|${schoolId}`;
        const newLesson = {
          id: uid(),
          studentId, studentName,
          teacherId, teacherName,
          schoolId, schoolName,
          day, start, end,
          instrument,
          enrolmentId: enrolmentIdFor(studentId, instrument, enrolments),
          adjusted: true,
          adjustReason: "Manually scheduled via Claude",
          ...(weekDate ? { weekDate } : {}),
        };
        setWeeklyTimetables(prev => {
          const entry = prev[storageKey] || { lessons: [], missed: [], notes: "", generatedAt: new Date().toISOString() };
          return {
            ...prev,
            [storageKey]: { ...entry, lessons: [...(entry.lessons || []), newLesson] }
          };
        });
        notify(`Scheduled ${studentName} — ${day} ${start}`, "success");
        return `Done — added ${studentName}'s ${instrument} lesson to the WTT: ${day} ${start}–${end} (week of ${weekKey}, ${schoolName}, teacher: ${teacherName}). Marked as adjusted.`;
      }

      return `Unknown tool: ${name}`;
    } catch(e) {
      return `Tool error (${name}): ${e.message}`;
    }
  };

  const buildClaudeSystemPrompt = (currentPage, ctx = {}) => {
    const now = melbourneNow();
    const todayStr = toLocalDateStr(now);
    const dayName = now.toLocaleDateString("en-AU", { weekday: "long", timeZone: TIMEZONE });
    const termBreaks = interruptions.filter(i => i.type === "term_break").sort((a, b) => a.date.localeCompare(b.date));
    const weekNum = computeTermWeekNum(todayStr, termBreaks);
    const activeStudents = students.filter(s => s.status === "active");
    const pendingStudents = students.filter(s => s.status === "pending" || s.status === "trial");
    const allLessons = timetable?.lessons || [];
    // Hoist weekend detection — used both in Current Context note and in WTT display logic
    const rawMonday = getCurrentWeekMonday();
    const dowToday = now.getDay(); // 0=Sun, 6=Sat

    const lines = [];

    // ── Memory (persistent facts) ──
    if (claudeMemory.length > 0) {
      lines.push("## Remembered Facts");
      lines.push("These are things the user has specifically asked you to remember across sessions:");
      claudeMemory.forEach(m => lines.push(`- ${m}`));
      lines.push("");
    }

    // ── Personal context (user-written) ──
    if (claudePersonalContext.trim()) {
      lines.push("## About Me");
      lines.push(claudePersonalContext.trim());
      lines.push("");
    }

    // ── Universal base ──
    lines.push("## Current Context");
    lines.push(`Today is ${dayName} ${todayStr}${weekNum ? `, Term Week ${weekNum}` : ""}.`);
    lines.push(`You are the AI assistant built into the user's music lesson scheduling app.`);
    lines.push(`Current tab: ${currentPage}`);
    // Weekend date convention note — only shown on Sat/Sun to avoid cluttering weekday prompts
    if (dowToday === 6 || dowToday === 0) {
      const lastMonday = toLocalDateStr((() => { const d = new Date(rawMonday); d.setDate(d.getDate() - 7); return d; })());
      const thisMonday = toLocalDateStr((() => { const d = new Date(rawMonday); d.setDate(d.getDate() + 7); return d; })());
      const nextMonday = toLocalDateStr((() => { const d = new Date(rawMonday); d.setDate(d.getDate() + 14); return d; })());
      lines.push(`WEEKEND DATE CONVENTION: Today is ${dayName}. Interpret date references as follows:`);
      lines.push(`  - "last week" = the Mon-Fri block just finished (week of ${lastMonday})`);
      lines.push(`  - "this week" = the upcoming Mon-Fri block (week of ${thisMonday})`);
      lines.push(`  - "next week" = the Mon-Fri block after that (week of ${nextMonday})`);
      lines.push(`  - "this Monday/Tuesday/etc" = the day in the upcoming Mon-Fri block`);
      lines.push(`  - "next Monday/Tuesday/etc" = the day in the week after the upcoming block`);
      lines.push(`Apply this consistently for all date reasoning, WTT lookups, and tool calls.`);
    }
    lines.push("");

    // ── Term dates ──
    if (termBreaks.length > 0) {
      lines.push("## Term Dates");
      termBreaks.forEach(b => {
        const end = b.endDate && b.endDate !== b.date ? `–${b.endDate}` : "";
        lines.push(`  - ${b.title || "Term break"}: ${b.date}${end}`);
      });
      lines.push("");
    }

    // ── Master breaks (school-specific slot exclusions) ──
    if (masterBreaks && masterBreaks.length > 0) {
      lines.push("## School-Specific Master Breaks");
      lines.push("(These are recurring slot exclusions — e.g. a school that never teaches during a certain slot.)");
      const bySchool = {};
      masterBreaks.forEach(b => {
        const schoolName = schools.find(s => s.id === b.schoolId)?.name || b.schoolId;
        if (!bySchool[schoolName]) bySchool[schoolName] = [];
        bySchool[schoolName].push(b);
      });
      Object.entries(bySchool).forEach(([schoolName, breaks]) => {
        const breakStrs = breaks.map(b => `${b.day} ${b.time}`).join(", ");
        lines.push(`  - ${schoolName}: ${breakStrs}`);
      });
      lines.push("");
    }

    // ── Schools ──
    lines.push("## Schools");
    schools.forEach(s => {
      lines.push(`School: ${s.name} (id: ${s.id})`);
      (s.slots || []).forEach(sl => {
        const type = sl.type && sl.type !== "class" ? ` [${sl.type}]` : "";
        lines.push(`  Slot: ${sl.name || sl.start} | ${sl.start}–${sl.end}${type}`);
      });
    });
    lines.push("");

    // ── Teachers ──
    lines.push("## Teachers");
    teachers.forEach(t => {
      const instrs = (t.instruments || []).map(i => i.name || i).filter(Boolean).join(", ");
      const avail = (t.availability || []).map(a => {
        const schoolName = schools.find(s => s.id === a.schoolId)?.name || a.schoolId;
        return `${a.day} @ ${schoolName}`;
      }).join(", ");
      lines.push(`Teacher: ${t.name} (id: ${t.id})${t.email ? ` <${t.email}>` : ""}`);
      if (instrs) lines.push(`  Instruments: ${instrs}`);
      if (avail) lines.push(`  Teaches: ${avail}`);
    });
    lines.push("");

    // ── Full student roster (always — not tab-gated) ──
    lines.push("## All Active Students");
    activeStudents.forEach(s => {
      const school = schools.find(sc => sc.id === s.schoolId)?.name || "";
      const instrs = instrumentsFromEnrolments(s.id, enrolments).map(i => {
        const mttT = i.isGroup ? null : getStudentMTTTeacher(s.id, i.name, timetable, students, teachers, enrolments, teacherCoverage);
        return `${i.name}${mttT?.teacherName ? ` (teacher: ${mttT.teacherName})` : ""}`;
      });
      const studentLessons = allLessons.filter(l => l.studentId === s.id);
      const schedule = studentLessons.length > 0
        ? studentLessons.map(l => `${l.day} ${l.start}`).join(", ")
        : "unscheduled";
      // Collect parent/guardian entries
      const parentLines = [];
      if (s.parentName || s.parentEmail || s.parentPhone) {
        parentLines.push([s.parentName, s.parentEmail, s.parentPhone].filter(Boolean).join(" | "));
      }
      if (Array.isArray(s.parents)) {
        s.parents.forEach(p => {
          const pp = [p.name, p.email, p.phone].filter(Boolean).join(" | ");
          if (pp) parentLines.push(pp);
        });
      }
      lines.push(`Student: ${s.name} (id: ${s.id})`);
      lines.push(`  School: ${school || "unknown"}${s.className ? ` | Class: ${s.className}` : ""}`);
      if (instrs.length > 0) lines.push(`  ${instrs.length === 1 ? "Instrument" : "Instruments"}: ${instrs.join(", ")}`);
      lines.push(`  Schedule: ${schedule}`);
      if (s.notes) lines.push(`  Note: ${s.notes}`);
      parentLines.forEach(pl => lines.push(`  Parent/Guardian: ${pl}`));
    });
    lines.push("");

    // ── Pending / trial students with setup details ──
    if (pendingStudents.length > 0) {
      lines.push("## Pending / Trial Students");
      lines.push("(Trial students have a one-off lesson booked in a specific week. They auto-promote to Pending status after their trial lesson day at 6pm. Pending students are waiting to be added to the regular timetable.)");
      pendingStudents.forEach(s => {
        const school = schools.find(sc => sc.id === s.schoolId)?.name || "";
        const instrs = instrumentsFromEnrolments(s.id, enrolments).map(i => {
          const mttT = i.isGroup ? null : getStudentMTTTeacher(s.id, i.name, timetable, students, teachers, enrolments, teacherCoverage);
          return `${i.name}${mttT?.teacherName ? ` with ${mttT.teacherName}` : ""}`;
        }).join(", ");

        // For trial students, check weeklyTimetables for their trial lesson
        // (trial lessons are stored per-week, not in the master timetable)
        let scheduleNote;
        if (s.status === "trial") {
          let trialLesson = null;
          let trialWeekKey = null;
          for (const [storageKey, data] of Object.entries(weeklyTimetables || {})) {
            const lesson = (data.lessons || []).find(l => l.studentId === s.id && l.isTrial);
            if (lesson) {
              trialLesson = lesson;
              trialWeekKey = storageKey.split("|")[0];
              break;
            }
          }
          scheduleNote = trialLesson
            ? `trial lesson: ${trialLesson.day} ${trialLesson.start} (week of ${trialWeekKey})`
            : "trial lesson NOT YET SCHEDULED";
        } else {
          const studentLessons = allLessons.filter(l => l.studentId === s.id);
          scheduleNote = studentLessons.length > 0
            ? `scheduled: ${studentLessons.map(l => `${l.day} ${l.start}`).join(", ")}`
            : "NOT YET SCHEDULED";
        }

        const noteLine = s.notes ? ` — note: ${s.notes}` : "";
        const pendingParentLines = [];
        if (s.parentName || s.parentEmail || s.parentPhone) {
          pendingParentLines.push([s.parentName, s.parentEmail, s.parentPhone].filter(Boolean).join(" | "));
        }
        if (Array.isArray(s.parents)) {
          s.parents.forEach(p => {
            const pp = [p.name, p.email, p.phone].filter(Boolean).join(" | ");
            if (pp) pendingParentLines.push(pp);
          });
        }
        lines.push(`Student: ${s.name} (id: ${s.id}) [${s.status.toUpperCase()}]`);
        lines.push(`  School: ${school || "unknown"}${s.className ? ` | Class: ${s.className}` : ""}`);
        if (instrs) lines.push(`  Instruments: ${instrs}`);
        lines.push(`  ${scheduleNote}`);
        if (s.notes) lines.push(`  Note: ${s.notes}`);
        pendingParentLines.forEach(pl => lines.push(`  Parent/Guardian: ${pl}`));
      });
      lines.push("");
    }

    // ── Students awaiting scheduling (from timetable engine) ──
    const unscheduledList = timetable?.unscheduled || [];
    if (unscheduledList.length > 0) {
      lines.push("## Students Awaiting Scheduling");
      unscheduledList.forEach(u => {
        const s = u.student || u;
        const school = schools.find(sc => sc.id === s.schoolId)?.name || "";
        lines.push(`  - ${s.name}${school ? ` — ${school}` : ""} (${u.instrument || "unknown instrument"})`);
      });
      lines.push("");
    }

    // ── Master timetable — full detail only when needed ──
    // Show full detail on timetable page, when ctx.masterFull triggered, or when no WTT exists.
    // Otherwise show a compact summary — WTT below is already the live source of truth.
    const wttHasAnyCurrentData = Object.entries(weeklyTimetables || {}).some(([k, data]) =>
      (data.lessons || []).some(l => !l.isCancelled)
    );
    if (ctx.masterFull || currentPage === "timetable" || !wttHasAnyCurrentData) {
      lines.push("## Master Timetable");
      if (allLessons.length === 0) {
        lines.push("No lessons scheduled yet.");
      } else {
        const bySchool = {};
        allLessons.forEach(l => {
          const sn = schools.find(s => s.id === l.schoolId)?.name || l.schoolId;
          if (!bySchool[sn]) bySchool[sn] = [];
          bySchool[sn].push(l);
        });
        Object.entries(bySchool).forEach(([sn, ls]) => {
          lines.push(`${sn}:`);
          const byDay = {};
          ls.forEach(l => { if (!byDay[l.day]) byDay[l.day] = []; byDay[l.day].push(l); });
          ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].forEach(day => {
            if (byDay[day]) {
              byDay[day].sort((a, b) => (a.start || "").localeCompare(b.start || ""));
              byDay[day].forEach(l => {
                let who;
                if (l.isGroup) {
                  const grp = groups.find(g => g.id === l.groupId);
                  const members = grp ? (grp.studentIds || []).map(sid => students.find(s => s.id === sid)?.name).filter(Boolean).join(", ") : "";
                  who = l.groupName || "Group";
                  if (members) who += ` [members: ${members}]`;
                } else {
                  who = l.studentName;
                }
                const tName = getLiveTeacherName(l, students, teachers, enrolments, teacherCoverage);
                lines.push(`  ${day} ${l.start}${String.fromCharCode(8211)}${l.end}: ${who} (${l.instrument}) ${String.fromCharCode(8212)} ${tName}`);
              });
            }
          });
        });
      }
      lines.push("");
    } else if (allLessons.length > 0) {
      // Compact summary — WTT is the live source of truth
      const mttBySchool = {};
      allLessons.forEach(l => {
        const sn = schools.find(s => s.id === l.schoolId)?.name || l.schoolId;
        if (!mttBySchool[sn]) mttBySchool[sn] = 0;
        mttBySchool[sn]++;
      });
      const mttSummary = Object.entries(mttBySchool).map(([sn, n]) => `${sn}: ${n} lessons`).join(", ");
      lines.push("## Master Timetable");
      lines.push(`(${allLessons.length} lessons total — ${mttSummary}. WTT below is the live source of truth. Ask if you need full master detail.)`);
      lines.push("");
    }

    // ── Weekly timetable history — current week always; 1 past week only if ctx.pastWeeks ──
    // On weekends, look ahead to the upcoming Monday (planning reference week)
    const currentMonday = (dowToday === 6 || dowToday === 0)
      ? (() => { const d = new Date(rawMonday); d.setDate(d.getDate() + 7); return d; })()
      : rawMonday;
    const currentWeekKey = toLocalDateStr(currentMonday);
    // All regular WTT week keys, sorted ascending
    const allWttWeekKeys = [...new Set(
      Object.keys(weeklyTimetables || {})
        .map(k => k.split("|")[0])
    )].sort();
    // Find the last 2 past weeks with active lessons (only included when ctx.pastWeeks)
    const pastWttWeeks = ctx.pastWeeks ? [...allWttWeekKeys].reverse().filter(wk =>
      wk !== currentWeekKey &&
      Object.entries(weeklyTimetables || {}).some(([k, data]) =>
        k.startsWith(wk + "|") &&
        (data.lessons || []).some(l => !l.isCancelled)
      )
    ).slice(0, 2).reverse() : [];
    // Also include the current week if it has lessons
    const currentWttEntries = Object.entries(weeklyTimetables || {})
      .filter(([k]) => k.startsWith(currentWeekKey + "|"));
    const currentWttHasLessons = currentWttEntries.some(([, data]) =>
      (data.lessons || []).some(l => !l.isCancelled)
    );
    const weeksToShow = currentWttHasLessons && !pastWttWeeks.includes(currentWeekKey)
      ? [...pastWttWeeks, currentWeekKey]
      : pastWttWeeks;
    const renderWttEntries = (entries, wttWeekKey) => {
      const wttBySchool = {};
      entries.forEach(([storageKey, data]) => {
        const schoolId = storageKey.split("|")[1];
        const schoolName = schools.find(s => s.id === schoolId)?.name || schoolId;
        wttBySchool[schoolName] = data;
      });
      Object.entries(wttBySchool).forEach(([schoolName, data]) => {
        lines.push(`${schoolName}:`);
        const activeLessons = (data.lessons || []).filter(l => !l.isCancelled);
        const cancelledLessons = (data.lessons || []).filter(l => l.isCancelled);
        const wttByDay = {};
        activeLessons.forEach(l => { if (!wttByDay[l.day]) wttByDay[l.day] = []; wttByDay[l.day].push(l); });
        ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].forEach(day => {
          if (wttByDay[day]) {
            wttByDay[day].sort((a, b) => (a.start || "").localeCompare(b.start || ""));
            wttByDay[day].forEach(l => {
              const flags = [];
              if (l.adjusted) flags.push("adjusted");
              if (l.isTrial) flags.push("trial");
              if (l.isGroup) flags.push("group");
              const who = l.isGroup ? (l.groupName || "Group") : (l.studentName || "");
              const tName = getLiveTeacherName(l, students, teachers, enrolments, teacherCoverage, laneOverrides, wttWeekKey);
              lines.push(`  ${day} ${l.start}${String.fromCharCode(8211)}${l.end}: ${who} (${l.instrument || "?"}) ${String.fromCharCode(8212)} ${tName}${flags.length ? ` [${flags.join(", ")}]` : ""}`);
            });
          }
        });
        if (cancelledLessons.length > 0) {
          const cancelStrs = cancelledLessons.map(l => `${l.studentName || l.groupName || "?"} ${l.day} ${l.start}`).join(", ");
          lines.push(`  Cancelled: ${cancelStrs}`);
        }
        if (data.notes) lines.push(`  Notes: ${data.notes}`);
      });
    };
    if (weeksToShow.length > 0) {
      lines.push("## Weekly Timetable Records");
      lines.push("(Actual timetables as they ran each week — use these as source of truth for time-specific questions. Most recent week last.)");
      weeksToShow.forEach(wk => {
        const isCurrentWk = wk === currentWeekKey;
        const entries = Object.entries(weeklyTimetables || {}).filter(([k]) => k.startsWith(wk + "|"));
        const termWk = computeTermWeekNum(wk, termBreaks);
        const label = isCurrentWk ? `Week of ${wk} (THIS WEEK)` : `Week of ${wk}${termWk ? ` — Term Week ${termWk}` : ""}`;
        lines.push(`### ${label}`);
        renderWttEntries(entries, wk);
      });
      lines.push("");
    }

    // ── Holiday catch-up schedule — only when relevant ──
    const catchupsByWeek = {};
    for (const c of (catchups || [])) {
      if (!catchupsByWeek[c.weekKey]) catchupsByWeek[c.weekKey] = [];
      catchupsByWeek[c.weekKey].push(c);
    }
    const sortedCatchupWeekKeys = Object.keys(catchupsByWeek).sort();
    if (sortedCatchupWeekKeys.length > 0 && (ctx.catchup || currentPage === "weekly")) {
      lines.push("## Holiday Catch-up Schedule");
      lines.push("(Make-up lessons scheduled during school holidays, at the home studio.)");
      sortedCatchupWeekKeys.forEach(wk => {
        const ws = catchupsByWeek[wk];
        lines.push(`Week of ${wk}:`);
        const cpByDay = {};
        ws.forEach(c => { if (!cpByDay[c.day]) cpByDay[c.day] = []; cpByDay[c.day].push(c); });
        ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].forEach(day => {
          if (cpByDay[day]) {
            cpByDay[day].sort((a, b) => (a.time || "").localeCompare(b.time || ""));
            cpByDay[day].forEach(c => {
              const enrol = enrolments.find(e => e.id === c.enrolmentId);
              const studentName = students.find(s => s.id === enrol?.studentId)?.name || "";
              const teacherName = teachers.find(t => t.id === enrol?.teacherId)?.name || "";
              const startMin = timeToMin(c.time || "00:00");
              const endMin = startMin + (c.durationMinutes ?? 30);
              const endStr = `${String(Math.floor(endMin / 60)).padStart(2, "0")}:${String(endMin % 60).padStart(2, "0")}`;
              lines.push(`  ${day} ${c.time}${String.fromCharCode(8211)}${endStr}: ${studentName} (${c.instrument || "?"}) ${String.fromCharCode(8212)} ${teacherName}`);
            });
          }
        });
      });
      lines.push("");
    }

    // ── Groups — only when relevant ──
    if (groups.length > 0 && (ctx.groups || ["groups-bands", "weekly", "timetable"].includes(currentPage))) {
      lines.push("## Groups");
      groups.forEach(g => {
        const school = schools.find(s => s.id === g.schoolId)?.name || "";
        const teacher = teachers.find(t => t.id === g.teacherId)?.name || "";
        const memberNames = (g.studentIds || []).map(sid => students.find(s => s.id === sid)?.name).filter(Boolean).join(", ");
        const status = g.status || "forming";
        lines.push(`Group: ${g.name}`);
        lines.push(`  School: ${school || "unknown"} | Teacher: ${teacher || "unassigned"} | Instrument: ${g.instrument || "unknown"} | Status: ${status}`);
        if (memberNames) lines.push(`  Members: ${memberNames}`);
      });
      lines.push("");
    }

    // ── Bands — only when relevant ──
    if (bands && bands.length > 0 && (ctx.groups || ["groups-bands"].includes(currentPage))) {
      lines.push("## Bands");
      bands.forEach(b => {
        const school = schools.find(s => s.id === b.schoolId)?.name || "";
        const teacher = teachers.find(t => t.id === b.teacherId)?.name || "";
        const memberNames = (b.studentIds || b.memberIds || b.members || []).map(m => {
          const id = typeof m === "string" ? m : m?.id || m?.studentId;
          return id ? students.find(s => s.id === id)?.name : (m?.name || null);
        }).filter(Boolean).join(", ");
        lines.push(`Band: ${b.name}`);
        const bandDetails = [school ? `School: ${school}` : "", teacher ? `Teacher: ${teacher}` : "", b.instrument ? `Instrument: ${b.instrument}` : ""].filter(Boolean).join(" | ");
        if (bandDetails) lines.push(`  ${bandDetails}`);
        if (memberNames) lines.push(`  Members: ${memberNames}`);
      });
      lines.push("");
    }

    // ── Specialist timetable — only on relevant pages or when keywords detected ──
    if (specialists.length > 0 && (ctx.specialists || ["timetable", "weekly", "specialists"].includes(currentPage))) {
      lines.push("## Specialist Timetable");
      lines.push("(These are the regular recurring specialist classes per school. When a student's music lesson overlaps with one of these, a purple tag appears on their lesson card.)");
      const bySchool = {};
      specialists.forEach(sp => {
        const schoolName = schools.find(s => s.id === sp.schoolId)?.name || sp.schoolId;
        if (!bySchool[schoolName]) bySchool[schoolName] = [];
        bySchool[schoolName].push(sp);
      });
      Object.entries(bySchool).forEach(([schoolName, entries]) => {
        lines.push(`${schoolName}:`);
        const byClass = {};
        entries.forEach(sp => {
          if (!byClass[sp.className]) byClass[sp.className] = [];
          byClass[sp.className].push(sp);
        });
        Object.entries(byClass).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true })).forEach(([className, slots]) => {
          const slotStrs = slots
            .sort((a, b) => ["Monday","Tuesday","Wednesday","Thursday","Friday"].indexOf(a.day) - ["Monday","Tuesday","Wednesday","Thursday","Friday"].indexOf(b.day) || a.start.localeCompare(b.start))
            .map(sp => `${sp.day} ${sp.start}–${sp.end} ${sp.subject}`)
            .join(", ");
          lines.push(`  Class ${className}: ${slotStrs}`);
        });
      });
      lines.push("");
    }

    // ── Contacts — only when email/parent keywords detected or on contacts/dashboard page ──
    if (contacts.length > 0 && (ctx.contacts || ["contacts", "dashboard"].includes(currentPage))) {
      lines.push("## Contacts");
      contacts.forEach(c => {
        const student = students.find(s => s.id === c.studentId);
        const link = student ? ` (${student.name}'s contact)` : "";
        const schoolName = c.schoolId ? schools.find(s => s.id === c.schoolId)?.name || c.schoolId : "";
        lines.push(`Contact: ${c.name}${link}`);
        const emailPhone = [c.email || "no email", c.phone ? `ph: ${c.phone}` : ""].filter(Boolean).join(" | ");
        lines.push(`  ${emailPhone}`);
        const details = [c.role ? `role: ${c.role}` : "", schoolName ? `school: ${schoolName}` : "", c.className ? `class: ${c.className}` : ""].filter(Boolean).join(" | ");
        if (details) lines.push(`  ${details}`);
      });
      lines.push("");
    }

    // ── Tally — full current term, only when tally keywords detected or on tally page ──
    // Legacy data source (tallyEntries) only contained past/current weeks because auto-tally
    // writes after the fact. WTT contains all generated weeks including future-planned ones.
    // Filter to past/current to preserve legacy temporal scope — future weeks have scheduled
    // lessons that haven't happened yet, so reporting them as "completed" would be wrong.
    // currentWeekKey is in scope from the WTT history block above (line ~3684).
    const allWeekKeys = getWttWeekKeysWithActivity({ weeklyTimetables })
      .filter(k => k <= currentWeekKey);
    if (ctx.tally || currentPage === "tally") {
      // Full current term — find weeks after the most recent term break end
      const lastBreakEnd = termBreaks.filter(b => (b.endDate || b.date) < todayStr).sort((a, b) => b.date.localeCompare(a.date))[0];
      const termStartKey = lastBreakEnd ? (() => { const d = new Date((lastBreakEnd.endDate || lastBreakEnd.date) + "T00:00:00"); d.setDate(d.getDate() + 1); while (d.getDay() === 6 || d.getDay() === 0) d.setDate(d.getDate() + 1); return toLocalDateStr(d); })() : null;
      const termWeekKeys = termStartKey ? allWeekKeys.filter(k => k >= termStartKey) : allWeekKeys.slice(-10);
      lines.push("## Tally — Current Term");
      if (termWeekKeys.length === 0) {
        lines.push("No tally entries recorded yet.");
      } else {
        termWeekKeys.forEach(wk => {
          // Note: `completed` semantic shift — legacy tallyEntries counted per-attendee
          // (group lesson with N students = N completed entries); helper counts per-slot
          // (group lesson = 1 completed entry). AI prompt wording "X completed" is neutral;
          // numbers shrink post-migration but no surrounding-text edit needed.
          const summary = getWeekTallySummary({ weeklyTimetables, weekKey: wk, schools, termBreaks });
          lines.push(`${summary.label}: ${summary.completed} completed, ${summary.missed.length} missed`);
          summary.missed.forEach(e => {
            const catchupStatus = e.makeupEligible && !e.madeUp ? " | catch-up owed" : e.madeUp ? " | caught up" : "";
            lines.push(`  Missed: ${e.studentName} (${e.instrument})${e.schoolName ? ` at ${e.schoolName}` : ""} | ${e.day}${catchupStatus}${e.reason ? ` | reason: ${e.reason}` : ""}`);
          });
        });
      }
      lines.push("");
    }

    // ── Outstanding catch-ups (all time, not yet made up) — always shown if any exist ──
    // No upper-bound filter (unlike site 3859); the "all time" semantics are intentional.
    const catchupsOwed = findOpenCatchups({ weeklyTimetables });
    if (catchupsOwed.length > 0) {
      lines.push("## Outstanding Catch-ups");
      catchupsOwed.forEach(r => {
        const label = getTermWeekLabel(r.weekKey, termBreaks) || r.weekKey;
        lines.push(`  - ${r.missed.studentName} (${r.missed.instrument}), ${label}`);
      });
      lines.push("");
    }

    // ── Upcoming interruptions — all future (always — not tab-gated) ──
    const allUpcoming = interruptions
      .filter(i => i.type !== "term_break" && i.type !== "teacher_event" && i.date >= todayStr)
      .sort((a, b) => a.date.localeCompare(b.date));
    if (allUpcoming.length > 0) {
      lines.push("## Upcoming Interruptions");
      allUpcoming.forEach(i => {
        const school = schools.find(s => s.id === i.schoolId)?.name || "";
        lines.push(`  - ${i.date}${i.endDate && i.endDate !== i.date ? `–${i.endDate}` : ""}: ${i.title}${school ? ` (${school})` : ""}${i.affectsClasses && i.affectsClasses !== "all" ? ` — affects ${i.affectsClasses}` : ""}`);
      });
      lines.push("");
    }

    // ── Calendar / teacher events — next 60 days ──
    const calendarCutoff = (() => { const d = new Date(now); d.setDate(d.getDate() + 60); return toLocalDateStr(d); })();
    const calEvents = interruptions
      .filter(i => i.type === "teacher_event" && i.date >= todayStr && i.date <= calendarCutoff)
      .sort((a, b) => a.date.localeCompare(b.date));
    if (calEvents.length > 0) {
      lines.push("## Upcoming Calendar Events (next 60 days)");
      calEvents.forEach(i => {
        const teacher = teachers.find(t => t.id === i.teacherId)?.name || "";
        lines.push(`  - ${i.date}${i.endDate && i.endDate !== i.date ? `–${i.endDate}` : ""}: ${i.title}${teacher ? ` (${teacher})` : ""}${i.startTime ? ` ${i.startTime}${i.endTime ? `–${i.endTime}` : ""}` : ""}`);
      });
      lines.push("");
    }

    // ── To-do list (live from localStorage) ──
    try {
      const todoRaw = localStorage.getItem("mt-todos") || localStorage.getItem("mt-todo-items") || localStorage.getItem("mt-todo") || "[]";
      const allTodos = JSON.parse(todoRaw);
      const activeTodos = allTodos.filter(t => !t.done && !t.completed && !t.archived);
      if (activeTodos.length > 0) {
        lines.push("## To-Do List (active items)");
        activeTodos.forEach(t => {
          const due = t.dueDate || t.due || "";
          const group = t.group || t.category || "";
          lines.push(`  - ${t.text || t.title || t.label}${due ? ` [due: ${due}]` : ""}${group ? ` [${group}]` : ""}`);
        });
        lines.push("");
      }
    } catch(e) {}

    // ── Documents & Resources — only when keywords detected or on resources page ──
    const allDocs = [...(documents || []), ...(resources || [])];
    if (allDocs.length > 0 && (ctx.resources || currentPage === "resources")) {
      lines.push("## Documents & Resources");
      (documents || []).forEach(d => {
        const school = d.schoolId ? schools.find(s => s.id === d.schoolId)?.name || "" : "";
        const teacher = d.teacherId ? teachers.find(t => t.id === d.teacherId)?.name || "" : "";
        const expiry = d.expiry || d.expiryDate ? ` — expires: ${d.expiry || d.expiryDate}` : "";
        lines.push(`  - [Document] ${d.label || d.name}${d.type ? ` (${d.type})` : ""}${school ? ` — ${school}` : ""}${teacher ? `, ${teacher}` : ""}${expiry}`);
      });
      (resources || []).forEach(r => {
        lines.push(`  - [Resource] ${r.label || r.name}${r.category ? ` (${r.category})` : ""}${r.description ? ` — ${r.description}` : ""}`);
      });
      lines.push("");
    }

    // ── Active reminders (live from localStorage) ──
    try {
      const rawReminders = JSON.parse(localStorage.getItem("mt-reminders") || "[]");
      const activeReminders = rawReminders.filter(r => {
        if (r.date) return r.date >= todayStr;
        if (r.week) {
          const wn = parseInt(r.week);
          if (!isNaN(wn)) {
            let termStart = (() => { const y = new Date().getFullYear(); const s = new Date(y, 0, 27); while (s.getDay() !== 2) s.setDate(s.getDate() + 1); return s; })();
            for (const br of termBreaks) {
              if ((br.endDate || br.date) < todayStr) {
                const d = new Date(br.endDate || br.date); d.setDate(d.getDate() + 1);
                while (d.getDay() === 6 || d.getDay() === 0) d.setDate(d.getDate() + 1);
                termStart = d; break;
              }
            }
            const fri = new Date(termStart); fri.setDate(fri.getDate() + (wn - 1) * 7 + 4);
            return toLocalDateStr(fri) >= todayStr;
          }
        }
        return true; // undated reminders always show
      });
      if (activeReminders.length > 0) {
        lines.push("## Current Reminders");
        lines.push("(These are active items the user has pinned in their Reminders panel. Treat them as current priorities or things they want to keep in mind.)");
        activeReminders.forEach(r => {
          const meta = [
            r.week ? `Week ${r.week}` : r.date ? r.date : null,
            r.time || null,
            r.schoolId ? schools.find(s => s.id === r.schoolId)?.name || null : null,
            r.className || null,
            r.studentName || null,
            r.notes || null,
          ].filter(Boolean).join(", ");
          lines.push(`  - ${r.text}${meta ? ` [${meta}]` : ""}`);
        });
        lines.push("");
      }
    } catch(e) {}

    // ── Recent inbox (live from localStorage) ──
    try {
      const inboxCache = JSON.parse(localStorage.getItem(STORAGE_KEYS.inboxCache) || "null");
      const readIds = new Set(JSON.parse(localStorage.getItem(STORAGE_KEYS.inboxReadIds) || "[]"));
      const archivedIds = new Set(JSON.parse(localStorage.getItem(STORAGE_KEYS.inboxArchivedIds) || "[]"));
      if (Array.isArray(inboxCache?.emails) && inboxCache.emails.length > 0) {
        const unread = inboxCache.emails
          .filter(e => !readIds.has(e.id) && !archivedIds.has(e.id))
          .slice(0, 10);
        const recent = inboxCache.emails
          .filter(e => !archivedIds.has(e.id))
          .slice(0, 5);
        const emailsToShow = unread.length > 0 ? unread : recent;
        if (emailsToShow.length > 0) {
          lines.push(`## Recent Inbox${unread.length > 0 ? ` (${unread.length} unread)` : " (all read)"}`);
          lines.push("(Most recent emails at the time of this message. Body text included where available.)");
          emailsToShow.forEach(e => {
            const isUnread = !readIds.has(e.id);
            const from = e.fromName || e.from || "Unknown";
            const subj = e.subject || "(no subject)";
            const bodyLimit = isUnread ? 500 : 200;
            const bodyText = (e.body || e.snippet || "").replace(/\s+/g, " ").trim();
            const body = bodyText.slice(0, bodyLimit);
            const truncated = bodyText.length > bodyLimit;
            const threadNote = e.threadCount > 1 ? ` [${e.threadCount}-message thread]` : "";
            const readFlag = isUnread ? " [UNREAD]" : "";
            lines.push(`  - ${readFlag}From: ${from} | Subject: ${subj}${threadNote}`);
            if (body) lines.push(`    "${body}${truncated ? "…" : ""}"`);
          });
          lines.push("");
        }
      }
    } catch(e) {}

    // ── Behavioural instructions ──
    lines.push("## Instructions");
    lines.push("- Be concise and practical. This is a working tool, not a chat app.");
    lines.push("- You have access to the user's live schedule data above — use it. Don't ask for information you already have.");
    lines.push("- When the user asks about students, lessons, or schedules, refer to the actual data provided.");
    lines.push("- Format responses with short paragraphs or brief bullet points. Avoid long prose.");
    lines.push("- If asked to draft an email, keep it friendly, professional, and brief.");
    lines.push("- Dates are in Melbourne, Australia time (AEDT/AEST).");
    lines.push("- School slots are listed with a type tag: [lunch] and [recess] indicate what is happening in the school's day at that time. Music lessons CAN and DO occur during lunch and recess slots — these tags are context only, not restrictions.");
    lines.push("- TIMETABLE SOURCE PRIORITY: When a question refers to a specific time period — 'last week', 'this week', 'next week', 'on Monday', 'last Tuesday', 'Term Week 9', or any specific date — always answer from the Weekly Timetable (WTT) data, not the Master Timetable. The WTT reflects what actually ran or is scheduled to run. The Master Timetable is the default recurring schedule and should only be used when the question is explicitly about it (e.g. 'find a spot on the master', 'does the master have room for...', 'what does the regular schedule say'). If WTT data is not available for the week in question, say so — do not silently fall back to the master.");
    lines.push("- If WTT data is missing for a specific day or school, always check the Upcoming Interruptions and Term Dates data before concluding no information is available. A missing day in the WTT often means a public holiday, school event, or term break cancelled lessons — say so if the interruption data confirms it.");
    lines.push("- IMPORTANT: If you do not have WTT data for a particular week or day, say 'I don't have timetable data for that period' — never say or imply that no lessons ran or that the day was empty. Absence of data is not evidence that nothing happened.");
    lines.push("- Always be explicit about the source and confidence of your answers. If you are working from incomplete data, say so. If you are inferring rather than reading directly from the data, say so. Never present a guess or assumption as a fact. It is always better to say 'I don't have that information' than to fill a gap with something that might be wrong.");
    lines.push("- The 'missed lesson zone' is the area at the bottom of the Weekly Timetable grid. It shows lessons that were scheduled but not attended. When the user says 'move it to the missed zone', 'mark as missed', or 'put it in the missed zone', use mark_lesson_missed — it moves the lesson card from the active timetable to the missed zone AND records it in the tally in one step. You do NOT need cancel_wtt_lesson as well.");
    lines.push("");
    lines.push("## Specialist Timetable Overrides");
    lines.push("When the user shares an image or description of an adjusted specialist timetable, follow this process exactly:");
    lines.push("1. Identify the school and the affected weeks from the image and the user's description.");
    lines.push("2. If anything is unclear or ambiguous — a class name, a time, a subject — stop and ask the user to clarify before continuing. Do not guess.");
    lines.push("3. Once you have enough information, compare the adjusted timetable against the regular specialist schedule shown above.");
    lines.push("4. Produce a dry-run report in this format:");
    lines.push("   - Plain English summary: school name, affected weeks, reason (e.g. Swimming carnival, NAPLAN).");
    lines.push("   - Per-class diff: for each change, state what the regular schedule has vs what the adjusted timetable shows. Use plain language: 'Class 3A — Tuesday 9:00–9:50 changes from PE/Sport → Swimming', 'Class 5/6B — Wednesday slot removed', 'Class Prep A — Friday 2:00–2:50 Swimming added (not in regular schedule)'.");
    lines.push("   - Affected students: list any students whose current music lessons overlap with changed slots. State the student name, class, day and time.");
    lines.push("5. End with: 'Let me know when you've checked these and I'll be ready for the next one.' Do not offer to apply changes.");
    lines.push("The data structure you are proposing changes to is called weekSpecialistOverrides, keyed by weekKey|schoolId (e.g. '2025-05-12|school-id'). Each entry has a reason string and an entries array of { className, day, start, end, subject }. These override the regular specialist schedule for that week only — only classes/days mentioned are overridden, the rest fall back to the regular schedule.");
    lines.push("This is a DRY RUN ONLY phase. You describe what would change. You do not apply changes.");

    // ── Claude Actions ─────────────────────────────────────────────────────
    lines.push("");
    lines.push("## Actions You Can Take");
    lines.push("You have tools that make real changes to the app. Use them carefully:");
    lines.push("- mark_lesson_missed: Move a lesson to the missed zone in the WTT AND record it in the tally. This is the correct tool for any lesson missed due to student absence, school interruption, teacher absence, or any reason where a tally record is needed. The lesson card is physically moved from the active timetable to the missed zone (same as dragging it manually). Available reasons: informed_absence (student notified in advance — sets reminder for week prior), uninformed_absence (no notice given), teacher_absent, cancelled, other. Note: school interruptions should now be recorded via the Calendar tab as an interruption event — use that instead of a tally entry for school-wide events.");
    lines.push("- bulk_mark_missed: Move ALL lessons on a given date (or school+date) to the missed zone at once. Same as mark_lesson_missed but for an entire day.");
    lines.push("- add_todo: Add an item to the to-do list. IMPORTANT: Whenever the todo involves a parent or contact, always look up their actual name and email from the student/contacts data above, use @FullName in the text (e.g. 'Email @Julia Kahan about missed lessons'), and include them in the mentions array. Never use relational descriptions like 'Noah's mum' — always use the person's actual name. This applies to any parent or contact mention in any todo item, without exception. Use subItems when the task has distinct steps — e.g. 'Invoice parents — sub-items: email @William Little, email @Loretta Uberti, email @Claudia Featherstone'. Each sub-item gets its own tickable checkbox. Sub-items can also have @mention links.");
    lines.push("- add_reminder: Add a reminder to the Reminders panel. Key fields: remindFromWeek (term week to start showing — hidden until Monday of that week), eventWeek (the week the event actually happens — alert chip fires in the alerts bar the week before this, reminder visible until end of this week), date (specific start date instead of remindFromWeek), studentName, notes. Example: 'Remind me in week 6 that Charlie is away in week 8' → remindFromWeek: 6, eventWeek: 8, studentName: 'Charlie' → reminder appears Week 6, alert fires Week 7, reminder disappears end of Week 8.");
    lines.push("- draft_email: Open the email compose window pre-filled. This ONLY drafts — it never sends. Always use this tool rather than writing out email text, even if the user asks you to 'write' or 'send' an email.");
    lines.push("- cancel_wtt_lesson: Mark a lesson as cancelled (crossed out/unscheduled) for a week WITHOUT creating a tally entry. Use ONLY for genuine cancellations where no absence record is needed — e.g. school decided not to run lessons, teacher day off with no cover. For student absences, use mark_lesson_missed instead.");
    lines.push("- mark_student_absent_week: Move ALL of a student's lessons for a given week to the missed zone and record them in the tally. Use when a student will be away all week.");
    lines.push("- move_wtt_lesson: Move a student's lesson to a different day or time in the WTT. Can move within the same week or to a different week. The student's school stays fixed. Specify fromDate (current lesson date), toDate (new date), and toStart (new start time). If the student has multiple lessons that week, specify instrument to disambiguate.");
    lines.push("- swap_student_lessons: Swap the lesson times of two students within the same week. Each gets the other's day and start/end time. Both are marked as adjusted. Specify weekOf (any date in the target week). Use studentAInstrument / studentBInstrument if either student has multiple lessons that week.");
    lines.push("- update_tally_entry: Edit an existing missed tally entry — change the reason, reasonDetail, makeupEligible (catch-up owed), or notes. Identify the entry by studentId + weekOf + day. Optionally add instrument if the student has multiple lessons that week. Only include fields you want to change.");
    lines.push("- mark_tally_completed: Mark an existing missed tally entry as completed (e.g. the lesson was made up or attendance was confirmed). Identify by studentId + weekOf + day. Set madeUp: true if it was a formal make-up lesson.");
    lines.push("- delete_tally_entry: Permanently remove a tally entry. Use ONLY when a lesson was incorrectly recorded as missed. Identify by studentId + weekOf + day. Always confirm with the user before calling this — deletions cannot be undone.");
    lines.push("- add_student: Create a new student record with status 'pending'. They will appear in the Pending tab, not the regular timetable, until scheduled. Always include schoolId (from the schools list above), instruments (just the names — teacher assignment is decided by lane placement in the master timetable), and parent contact details if provided. Never invent IDs — use the actual IDs from the data above.");
    lines.push("- edit_student: Update any field on an existing student — name, school, class, instruments, parent contact, notes, or status (active/pending only). Only include fields you want to change. Teacher assignment cannot be set here — it is derived from the student's lane on the master timetable. Do NOT use status to archive — use archive_student instead.");
    lines.push("- archive_student: Archive a student who has left or is no longer active. They disappear from all active views (timetable, tally, student list) but their record is preserved and restorable. Use this instead of edit_student when a student is leaving.");
    lines.push("- restore_student: Restore a previously archived student back to pending status so they reappear in the student list.");
    lines.push("- add_teacher: Create a new teacher record. Include name, email, instruments (list of instrument name strings), and availability (array of {schoolId, day, start, end} for each day they teach). Use school IDs from the schools list above.");
    lines.push("- edit_teacher: Update any field on a teacher — name, email, instruments, or availability. Providing instruments or availability replaces the entire list for that field.");
    lines.push("- schedule_wtt_lesson: Add a one-off lesson directly to the weekly timetable for a specific week. Does NOT affect the master timetable. Required fields: studentId, teacherId, schoolId, weekOf, day, start, end, instrument. Use for catch-ups, trials, or any extra lesson outside the regular schedule.");
    lines.push("");
    lines.push("Action rules:");
    lines.push("1. Only call an action tool when the user has EXPLICITLY asked you to perform that specific action.");
    lines.push("2. If you are making a judgement call — e.g. deciding who to email, which date to use, or inferring intent — describe your plan in text first and ask for confirmation BEFORE calling any tool.");
    lines.push("3. For directly instructed bulk actions ('mark all Monday lessons missed'), just do it — no need to list every individual item for approval.");
    lines.push("4. Never auto-send emails — draft_email always opens the compose window for the user to review and send themselves.");
    lines.push("5. After executing a tool, briefly confirm what was done in your reply.");
    lines.push("6. Confirmations must include the student name, instrument, date/day, and outcome — never just 'Done' or 'Got it'. If two tools were called (e.g. cancel + tally sync), confirm both actions in one sentence.");
    lines.push("7. ATTEMPT TOOLS — do not reason yourself out of trying. If a tool seems relevant and the user has asked for the action, call it. A tool result (even an error or 'not found') is always more useful than a refusal to try. The user would rather see 'No lesson found for that date' from the tool than a paragraph explaining why you didn't call it. Catch-up lessons, trial lessons, and adjusted lessons are all valid targets for WTT tools — always attempt before concluding a tool won't work.");

    return lines.join("\n");
  };

  // ── Add to Claude long-term memory (callable from any page) ──
  const onAddMemory = (text) => {
    if (!text || !text.trim()) return;
    const updated = [...claudeMemory, text.trim()];
    setClaudeMemory(updated);
    try { localStorage.setItem(STORAGE_KEYS.claudeMemory, JSON.stringify(updated)); } catch(e) {}
    notify("Added to Claude memory ✦", "success");
  };


  const handleRestore = (data) => {
    if (data.schools) { const ms = migrateData("schools", data.schools); setSchools(ms); saveData(STORAGE_KEYS.schools, ms); saveData(STORAGE_KEYS.schoolsBak, ms); }
    if (data.students) { const mst = migrateData("students", data.students); setStudents(mst); saveStudents(mst); }
    if (data.teachers) { const mt = migrateData("teachers", data.teachers); setTeachers(mt); saveData(STORAGE_KEYS.teachers, mt); }
    if (data.specialists) { setSpecialists(data.specialists); saveData(STORAGE_KEYS.specialists, data.specialists); saveData(STORAGE_KEYS.specialistsBak, data.specialists); }
    if (data.interruptions) { setInterruptions(data.interruptions); saveData(STORAGE_KEYS.interruptions, data.interruptions); }
    if (data.groups) { const mg = migrateData("groups", data.groups); setGroups(mg); saveData(STORAGE_KEYS.groups, mg); }
    if (data.timetable !== undefined) { setTimetableRaw(data.timetable); saveData(STORAGE_KEYS.timetable, data.timetable); }
    if (data.weeklyTimetables) { setWeeklyTimetables(data.weeklyTimetables); saveData(STORAGE_KEYS.weeklyTimetables, data.weeklyTimetables); }
    if (data.timetableVersions) saveData(STORAGE_KEYS.timetableVersions, data.timetableVersions);
    if (data.contacts) { setContacts(data.contacts); saveData(STORAGE_KEYS.contacts, data.contacts); }
    if (data.bands) { setBands(data.bands); saveData(STORAGE_KEYS.bands, data.bands); }
    if (data.masterBreaks) { setMasterBreaks(data.masterBreaks); saveData(STORAGE_KEYS.masterBreaks, data.masterBreaks); }
    if (data.resources) { setResources(data.resources); saveData(STORAGE_KEYS.resources, data.resources); }
    if (data.userTemplates) saveData(STORAGE_KEYS.userTemplates, data.userTemplates);
    if (data.emailTemplates) saveData(STORAGE_KEYS.emailTemplates, data.emailTemplates);
    if (data.aiEmailRules) { try { localStorage.setItem("mt-ai-email-rules", JSON.stringify(data.aiEmailRules)); } catch(e) {} }
    notify("Data restored from backup!");
  };

  // Shared backup handler — accessible from Settings page and Cmd+Shift+B shortcut
  const handleBackup = React.useCallback(async () => {
    const ttVersions = await loadData(STORAGE_KEYS.timetableVersions, []);
    const userTemplates = await loadData(STORAGE_KEYS.userTemplates, []);
    const emailTemplates = await loadData(STORAGE_KEYS.emailTemplates, {});
    let aiEmailRules = {};
    try { const raw = localStorage.getItem("mt-ai-email-rules"); if (raw) aiEmailRules = JSON.parse(raw); } catch(e) {}
    const backup = {
      version: DATA_VERSION, exportedAt: new Date().toISOString(),
      schools, students, teachers, specialists, interruptions, groups,
      timetable, weeklyTimetables, timetableVersions: ttVersions,
      contacts, bands, masterBreaks, resources,
      userTemplates, emailTemplates, aiEmailRules,
    };
    const json = JSON.stringify(backup, null, 2);
    const defaultName = "timetabling-backup-" + melbourneToday() + ".json";
    if (window.electronAPI) {
      // Show save dialog so user can choose location
      const result = await window.electronAPI.saveFileDialog(defaultName, json);
      if (result.ok) { playUISound("backup"); notify("Backup saved ✓ — " + result.filePath.split("/").slice(-2).join("/")); return true; }
      else if (result.canceled) { return false; }
      else { notify("Backup failed: " + (result.error || "Unknown error"), "danger"); return false; }
    } else {
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = defaultName;
      document.body.appendChild(a); a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      playUISound("backup");
      notify("Backup downloaded!");
      return true;
    }
  }, [schools, students, teachers, specialists, interruptions, groups, timetable, weeklyTimetables, contacts, bands, masterBreaks, resources, notify]);

  // Cmd+Shift+B from Electron menu — works from any page
  React.useEffect(() => {
    if (!window.electronAPI) return;
    const unsub = window.electronAPI.onMenuBackup(() => handleBackup());
    return unsub;
  }, [handleBackup]);

  const activeStudents = students.filter(s => s.status === "active");
  const pendingStudents = students.filter(s => s.status === "pending" || s.status === "trial");

  // Track unacknowledged constraint warnings across both timetable tabs (for nav badges)
  const [ttConstraintWarnings, setTtConstraintWarnings] = React.useState({});
  const [ttAckedConstraints, setTtAckedConstraints] = React.useState(new Set());
  const [weeklyConstraintWarnings, setWeeklyConstraintWarnings] = React.useState({});
  const [weeklyAckedConstraints, setWeeklyAckedConstraints] = React.useState(new Set());
  const ttWarningCount = Object.keys(ttConstraintWarnings).filter(id => !ttAckedConstraints.has(id)).length;
  const weeklyWarningCount = Object.keys(weeklyConstraintWarnings).filter(id => !weeklyAckedConstraints.has(id)).length;
  const [dashBadges, setDashBadges] = useState({ alerts: 0, email: 0 });

  const [generating, setGenerating] = useState(false);
  const [updateInfo, setUpdateInfo] = useState(null); // null | { version, available }
  const [updateProgress, setUpdateProgress] = useState(null); // null | 0-100
  const [noUpdateFlash, setNoUpdateFlash] = useState(false); // briefly show "No new updates"
  const [clockTime, setClockTime] = useState(() => { const n = melbourneNow(); const h = n.getHours(); const h12 = h % 12 || 12; return h12 + ":" + String(n.getMinutes()).padStart(2, "0"); });

  const handleGenerateTimetable = async () => {
    setGenerating(false); // reset in case previous run got stuck
    if (schools.length === 0) { notify("Add at least one school first", "warning"); return; }
    const allSchedulable = students.filter(s => s.status === "active");
    if (allSchedulable.length === 0) { notify("Add at least one active student first", "warning"); return; }
    if (teachers.length === 0) { notify("Add at least one teacher first", "warning"); return; }

    // Data validation warnings
    const warnings = [];
    const noTeacher = allSchedulable.filter(s => !instrumentsFromEnrolments(s.id, enrolments).some(i => i.teacherId));
    if (noTeacher.length > 0) warnings.push(`${noTeacher.length} student${noTeacher.length > 1 ? "s" : ""} without assigned teacher: ${noTeacher.slice(0, 5).map(s => s.name).join(", ")}${noTeacher.length > 5 ? "..." : ""}`);
    const noInstrument = allSchedulable.filter(s => instrumentsFromEnrolments(s.id, enrolments).length === 0);
    if (noInstrument.length > 0) warnings.push(`${noInstrument.length} student${noInstrument.length > 1 ? "s" : ""} without instruments: ${noInstrument.slice(0, 5).map(s => s.name).join(", ")}${noInstrument.length > 5 ? "..." : ""}`);
    const noSlots = schools.filter(s => !s.slots || s.slots.length === 0);
    if (noSlots.length > 0) warnings.push(`${noSlots.length} school${noSlots.length > 1 ? "s" : ""} without time slots: ${noSlots.map(s => s.name).join(", ")}`);
    const noAvail = teachers.filter(t => !t.availability || t.availability.length === 0);
    if (noAvail.length > 0) warnings.push(`${noAvail.length} teacher${noAvail.length > 1 ? "s" : ""} without availability: ${noAvail.map(t => t.name).join(", ")}`);
    if (warnings.length > 0) {
      notify("⚠ " + warnings.join(" · "), "warning");
    }

    try {

    // Check if any active students have notes that need AI parsing
    const studentsWithNotes = allSchedulable.filter(s => s.notes && s.notes.trim());
    const specialistsWithNotes = specialists.filter(s => s.notes && s.notes.trim());
    let enrichedStudents = [...students];
    let enrichedSpecialists = specialists;

    if (studentsWithNotes.length > 0 || specialistsWithNotes.length > 0) {
      setGenerating(true);
      try {
        enrichedSpecialists = await parseSpecialistNotes(specialists, specialistsWithNotes, recordUsage);
        enrichedStudents    = await parseStudentNotes(students, studentsWithNotes, enrichedSpecialists, schools, recordUsage);
      } catch (err) {
        console.error("Note parsing error:", err);
        notify("⚠ Note parsing skipped: " + err.message, "warning");
      }
      setGenerating(false);
    }

    // Schedule eligible groups FIRST (equal priority — they compete for slots before individuals)
    // Eligible = any group with enough members, regardless of status
    const eligibleGroups = groups.filter(g => (g.studentIds || []).length >= g.minSize && g.status !== "scheduled");
    const groupLessons = eligibleGroups.length > 0
      ? scheduleReadyGroups(eligibleGroups.map(g => ({ ...g, status: "ready" })), [], schools, students, teachers, enrichedSpecialists, teacherCoverage)
      : { scheduled: [], failed: [] };

    // Generate individual lessons around the group lessons
    const result = generateMasterTimetable(schools, enrichedStudents, teachers, enrolments, enrichedSpecialists, {
      existingLessons: groupLessons.scheduled,
      teacherCoverage
    });
    result.unscheduled = [...result.unscheduled, ...groupLessons.failed];


    // Update group statuses
    const scheduledGroupIds = new Set(groupLessons.scheduled.map(l => l.groupId));
    if (scheduledGroupIds.size > 0) {
      setGroups(prev => prev.map(g => scheduledGroupIds.has(g.id) ? { ...g, status: "scheduled" } : g));
    }

    compactTimetable(result, schools, students, teachers, enrolments, specialists, teacherCoverage);
    // Post-compaction double-booking check
    for (let i = result.lessons.length - 1; i >= 0; i--) {
      const l = result.lessons[i];
      const lTid = getCardTeacherId(l, teacherCoverage);
      const conflict = result.lessons.find((o, j) => {
        if (j >= i) return false;
        const oTid = getCardTeacherId(o, teacherCoverage);
        return lTid && oTid && oTid === lTid && o.day === l.day &&
          timeToMin(o.start) < timeToMin(l.end) && timeToMin(l.start) < timeToMin(o.end);
      });
      if (conflict) {
        const conflictTeacherName = teachers.find(t => t.id === lTid)?.name || "(unknown)";
        result.unscheduled.push({ student: students.find(s => s.id === l.studentId) || { id: l.studentId, name: l.studentName, schoolId: l.schoolId }, instrument: l.instrument, reason: `Double-booking: ${conflictTeacherName} on ${l.day} at ${l.start}` });
        result.lessons.splice(i, 1);
      }
    }
    // Seed masterBreaks from teacher-level break settings only.
    // School-level breaks (school.teacherBreaks) are rendered as spanning rows — not cards.
    const seededBreaks = [];
    for (const school of schools) {
      const schoolSlotTimes = (school.slots || []).map(s => s.start);
      // School-wide break time ranges — mark those slot times so we can exclude them
      const schoolBreakTimes = new Set();
      for (const b of (school.teacherBreaks || [])) {
        const bStart = timeToMin(b.start), bEnd = timeToMin(b.end);
        for (const t of schoolSlotTimes) {
          if (timeToMin(t) >= bStart && timeToMin(t) < bEnd) schoolBreakTimes.add(t);
        }
      }
      // Recess/lunch slot types also count as school-level breaks
      for (const s of (school.slots || [])) {
        if (s.type === "recess" || s.type === "lunch") schoolBreakTimes.add(s.start);
      }
      // Teacher-level breaks → per-day draggable cards
      for (const teacher of teachers) {
        for (const tb of (teacher.teacherBreaks || [])) {
          if (tb.schoolId !== school.id) continue;
          const bDay = tb.day || null;
          const bStart = timeToMin(tb.start), bEnd = timeToMin(tb.end);
          const days = bDay ? [bDay] : DAYS;
          for (const d of days) {
            for (const t of schoolSlotTimes) {
              if (schoolBreakTimes.has(t)) continue; // school break — skip, shown as row
              const tMin = timeToMin(t);
              if (tMin >= bStart && tMin < bEnd) {
                seededBreaks.push({ id: uid(), schoolId: school.id, day: d, time: t });
              }
            }
          }
        }
      }
    }
    // Deduplicate by schoolId+day+time
    const seen = new Set();
    const dedupedBreaks = seededBreaks.filter(b => {
      const k = `${b.schoolId}|${b.day}|${b.time}`;
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });
    setMasterBreaks(dedupedBreaks);
    setTimetable({ ...result, lessons: stampEnrolmentIds(result.lessons, enrolments) });
    const groupsSched = groupLessons.scheduled.length;
    let msg = `Timetable scheduled: ${result.lessons.length} lessons scheduled, ${result.unscheduled.length} unscheduled`;
    if (groupsSched > 0) msg += ` (incl. ${groupsSched} group${groupsSched !== 1 ? "s" : ""})`;
    setGenerating(false);
    notify(msg);
    setPage("timetable");
    } catch (genErr) {
      setGenerating(false);
      notify(`Generation error: ${genErr.message}`, "danger");
    }
  };

  const handleGenerateSchool = async (schoolId) => {
    const schoolName = schools.find(s => s.id === schoolId)?.name || "school";
    const schoolStudents = students.filter(s => s.status === "active" && s.schoolId === schoolId);
    if (schoolStudents.length === 0) { notify(`No active students at ${schoolName}`, "warning"); return; }

    // Keep lessons from other schools (drop old group lessons at this school — will re-schedule)
    const otherLessons = timetable ? timetable.lessons.filter(l => l.schoolId !== schoolId) : [];
    const otherUnscheduled = timetable ? timetable.unscheduled.filter(u => u.student.schoolId !== schoolId) : [];

    // AI note parsing for this school's students only
    let enrichedStudents = [...students];
    let enrichedSpecialists = specialists;
    const studentsWithNotes = schoolStudents.filter(s => s.notes && s.notes.trim());
    const specialistsWithNotes = specialists.filter(s => s.notes && s.notes.trim() && s.schoolId === schoolId);

    if (studentsWithNotes.length > 0 || specialistsWithNotes.length > 0) {
      setGenerating(true);
      try {
        enrichedSpecialists = await parseSpecialistNotes(specialists, specialistsWithNotes, recordUsage);
        enrichedStudents    = await parseStudentNotes(students, studentsWithNotes, enrichedSpecialists, schools, recordUsage);
      } catch (err) {
        console.error("Note parsing error:", err);
      }
      setGenerating(false);
    }

    // Schedule eligible groups at this school FIRST (equal priority)
    const eligibleSchoolGroups = groups.filter(g =>
      g.schoolId === schoolId && (g.studentIds || []).length >= g.minSize && g.status !== "scheduled"
    );
    const prevScheduledGroups = groups.filter(g => g.status === "scheduled" && g.schoolId === schoolId);
    const allGroupsToSchedule = [...eligibleSchoolGroups, ...prevScheduledGroups];
    const tempGroupsForSched = allGroupsToSchedule.map(g => ({ ...g, status: "ready" }));
    const groupLessons = tempGroupsForSched.length > 0
      ? scheduleReadyGroups(tempGroupsForSched, otherLessons, schools, students, teachers, enrichedSpecialists, teacherCoverage)
      : { scheduled: [], failed: [] };

    const result = generateMasterTimetable(schools, enrichedStudents, teachers, enrolments, enrichedSpecialists, {
      existingLessons: [...otherLessons, ...groupLessons.scheduled],
      targetSchoolId: schoolId,
      teacherCoverage
    });
    result.unscheduled = [...otherUnscheduled, ...result.unscheduled.filter(u => u.student.schoolId === schoolId), ...groupLessons.failed];

    // Promote pending students that got scheduled
    // Update group statuses
    const scheduledGroupIds = new Set(groupLessons.scheduled.map(l => l.groupId));
    const revertedGroupIds = prevScheduledGroups.filter(g => !scheduledGroupIds.has(g.id)).map(g => g.id);
    setGroups(prev => prev.map(g => {
      if (scheduledGroupIds.has(g.id)) return { ...g, status: "scheduled" };
      if (revertedGroupIds.includes(g.id)) return { ...g, status: "forming" };
      return g;
    }));

    compactTimetable(result, schools, students, teachers, enrolments, specialists, teacherCoverage);
    for (let i = result.lessons.length - 1; i >= 0; i--) {
      const l = result.lessons[i];
      const lTid = getCardTeacherId(l, teacherCoverage);
      const conflict = result.lessons.find((o, j) => {
        if (j >= i) return false;
        const oTid = getCardTeacherId(o, teacherCoverage);
        return lTid && oTid && oTid === lTid && o.day === l.day &&
          timeToMin(o.start) < timeToMin(l.end) && timeToMin(l.start) < timeToMin(o.end);
      });
      if (conflict) {
        const conflictTeacherName = teachers.find(t => t.id === lTid)?.name || "(unknown)";
        result.unscheduled.push({ student: students.find(s => s.id === l.studentId) || { id: l.studentId, name: l.studentName, schoolId: l.schoolId }, instrument: l.instrument, reason: `Double-booking: ${conflictTeacherName} on ${l.day} at ${l.start}` });
        result.lessons.splice(i, 1);
      }
    }
    setTimetable({ ...result, lessons: stampEnrolmentIds(result.lessons, enrolments) });
    const newCount = result.lessons.length - otherLessons.length;
    const newUnsched = result.unscheduled.filter(u => (u.student?.schoolId || u.schoolId) === schoolId).length;
    notify(`${schoolName}: ${newCount} lessons scheduled${newUnsched > 0 ? `, ${newUnsched} unscheduled` : ""}`);
  };

  const handleClearSchool = (schoolId) => {
    if (!timetable) return;
    const schoolName = schools.find(s => s.id === schoolId)?.name || "school";
    // Revert any scheduled groups at this school back to "forming"
    const clearedGroupIds = new Set(timetable.lessons.filter(l => l.schoolId === schoolId && l.isGroup).map(l => l.groupId));
    if (clearedGroupIds.size > 0) {
      setGroups(prev => prev.map(g => clearedGroupIds.has(g.id) ? { ...g, status: "forming" } : g));
    }
    const remaining = {
      lessons: timetable.lessons.filter(l => l.schoolId !== schoolId),
      unscheduled: timetable.unscheduled.filter(u => u.student.schoolId !== schoolId)
    };
    if (remaining.lessons.length === 0 && remaining.unscheduled.length === 0) {
      setTimetable(null);
    } else {
      setTimetable(remaining);
    }
  };

  // Remove a scheduled group lesson from the timetable (when reverting to forming)
  const handleRevertGroup = (groupId) => {
    if (!timetable) return;
    setTimetable(prev => ({
      ...prev,
      lessons: prev.lessons.filter(l => l.groupId !== groupId)
    }));
  };

  // Sync group changes to timetable lesson cards — keeps teacher, name, and student list
  // in sync when a scheduled group is edited in GroupsManager
  React.useEffect(() => {
    if (!timetable) return;
    // Spec 2 cluster 4c — functional-setter restructure to eliminate stale-closure
    // write-back. The .map runs inside the setter against prev.lessons (latest
    // state), so a regenerate that already wrote fresh bucket_id-stamped cards
    // can't be clobbered by a closure-captured snapshot.
    setTimetable(prev => {
      if (!prev) return prev;
      let needUpdate = false;
      const updatedLessons = prev.lessons.map(l => {
        if (!l.groupId) return l;
        const group = groups.find(g => g.id === l.groupId);
        if (!group) return l;
        const changes = {};
        // Cluster 12a: teacher-sync arm removed. Stamped teacherId/teacherName no longer
        // read post-cluster-12a; lane resolves at render time. Group name + student list
        // syncs below stay — those fields are still read at render.
        // Sync group name
        if (group.name && l.groupName !== group.name) {
          changes.groupName = group.name; changes.studentName = group.name;
        }
        // Sync student list
        const groupStudentIds = group.studentIds || [];
        if (JSON.stringify(l.studentIds || []) !== JSON.stringify(groupStudentIds)) {
          changes.studentIds = [...groupStudentIds];
          changes.studentNames = groupStudentIds.map(sid => students.find(s => s.id === sid)?.name || "?");
          if (groupStudentIds.length > 0 && l.studentId !== groupStudentIds[0]) changes.studentId = groupStudentIds[0];
        }
        if (Object.keys(changes).length === 0) return l;
        needUpdate = true;
        return { ...l, ...changes };
      });
      if (!needUpdate) return prev;
      return { ...prev, lessons: updatedLessons };
    });
  }, [groups]); // eslint-disable-line react-hooks/exhaustive-deps

  // Smart group scheduling: tries to fit a group into the master timetable
  // Can shuffle existing lessons within the same day (9:00-15:30 class time only)
  // but cannot change days or move lessons to before/after school
  const handleAddGroupToMaster = (groupId, manualDay = null, manualTime = null) => {
    if (!timetable) { notify("Generate a Master Timetable first", "warning"); return null; }
    const group = groups.find(g => g.id === groupId);
    if (!group) return null;
    const school = schools.find(s => s.id === group.schoolId);
    const teacher = teachers.find(t => t.id === group.teacherId);
    if (!school || !teacher) { notify("School or teacher not found", "warning"); return null; }

    const teacherAvail = teacher.availability.filter(a => a.schoolId === school.id);
    if (teacherAvail.length === 0) { return { success: false, reason: `${teacher.name} not available at ${school.name}` }; }

    const schoolLessons = timetable.lessons.filter(l => l.schoolId === school.id);
    const classSlots = school.slots.filter(s => s.type === "class");
    const beforeAfterTypes = ["before_school", "after_school"];

    // If manual placement requested
    if (manualDay && manualTime) {
      const slot = school.slots.find(s => s.start === manualTime);
      if (!slot) return { success: false, reason: "Invalid time slot" };
      // Spec 2 cluster 4c — lane lookup before stamping bucket_id.
      const bucketId = findLaneId(teacherCoverage, school.id, manualDay, teacher.id);
      if (!bucketId) {
        return { success: false, reason: `no covering lane for (${school.name}, ${manualDay}, ${teacher.name})` };
      }
      const lesson = {
        id: uid(), isGroup: true, groupId: group.id, groupName: group.name,
        studentId: group.studentIds[0], studentName: group.name,
        studentIds: [...group.studentIds],
        studentNames: group.studentIds.map(sid => students.find(s => s.id === sid)?.name || "?"),
        bucket_id: bucketId,
        schoolId: school.id, schoolName: school.name,
        day: manualDay, slotId: slot.id, slotName: slot.name,
        start: slot.start, end: slot.end,
        instrument: group.instrument || "Group",  duringSpecialist: false,
        enrolmentId: enrolmentIdFor(group.studentIds[0], group.instrument || "Group", enrolments, group.id)
      };
      setTimetable(prev => ({ ...prev, lessons: [...prev.lessons, lesson] }));
      setGroups(prev => prev.map(g => g.id === groupId ? { ...g, status: "scheduled" } : g));
      return { success: true };
    }

    // Build school/teacher break checker
    const schoolBreaks = (school.teacherBreaks || []).map(b => ({ start: timeToMin(b.start), end: timeToMin(b.end), day: b.day || "All" }));
    const tBreaks = (teacher.teacherBreaks || []).filter(b => b.schoolId === school.id);
    const isDuringBreak = (day, slotStart, slotEnd) => {
      const sMid = (timeToMin(slotStart) + timeToMin(slotEnd)) / 2;
      if (schoolBreaks.some(b => (b.day === "All" || b.day === day) && sMid >= b.start && sMid < b.end)) return true;
      return tBreaks.some(b => {
        const bDay = b.day || "All";
        if (bDay !== "All" && bDay !== day) return false;
        return sMid >= timeToMin(b.start) && sMid < timeToMin(b.end);
      });
    };

    // Spec 2 cluster 4c — track whether any day had a covering lane,
    // so the fallthrough error distinguishes "no slot" from "no lane".
    let anyLaneFound = false;

    // Try each day the teacher is available
    for (const day of school.days) {
      const dayAvail = teacherAvail.find(a => a.day === day);
      if (!dayAvail) continue;
      // Spec 2 cluster 4c — skip days without a covering lane.
      const bucketId = findLaneId(teacherCoverage, school.id, day, teacher.id);
      if (!bucketId) continue;
      anyLaneFound = true;
      const availStart = timeToMin(dayAvail.start);
      const availEnd = timeToMin(dayAvail.end);

      // Get all teacher lessons on this day at this school
      const teacherDayLessons = timetable.lessons.filter(l =>
        getCardTeacherId(l, teacherCoverage) === teacher.id && l.day === day
      );

      // Try each class-time slot (not before/after school)
      for (const slot of classSlots) {
        const slotStart = timeToMin(slot.start);
        const slotEnd = timeToMin(slot.end);
        if (slotStart < availStart || slotEnd > availEnd) continue;
        if (isDuringBreak(day, slot.start, slot.end)) continue;

        // Check if teacher is free at this slot
        const teacherBusy = teacherDayLessons.find(l => l.start === slot.start);
        if (teacherBusy) {
          // Try to shuffle this lesson to another class-time slot on the same day
          // Don't move before/after school lessons or group lessons
          const busySlotType = school.slots.find(s => s.id === teacherBusy.slotId);
          if (busySlotType && beforeAfterTypes.includes(busySlotType.type)) continue;
          if (teacherBusy.isGroup) continue;

          // Find an alternative class-time slot on the same day for the displaced lesson
          let canShuffle = false;
          for (const altSlot of classSlots) {
            if (altSlot.start === slot.start) continue;
            const altStart = timeToMin(altSlot.start);
            const altEnd = timeToMin(altSlot.end);
            if (altStart < availStart || altEnd > availEnd) continue;
            if (isDuringBreak(day, altSlot.start, altSlot.end)) continue;
            // Check no other lesson by this teacher at the alt time
            if (teacherDayLessons.some(l => l.start === altSlot.start && l.id !== teacherBusy.id)) continue;
            // Check no other lesson for the displaced student at the alt time
            if (timetable.lessons.some(l => l.studentId === teacherBusy.studentId && l.day === day && l.start === altSlot.start && l.id !== teacherBusy.id)) continue;

            canShuffle = true;
            // Do the shuffle: move existing lesson, place group
            const groupLesson = {
              id: uid(), isGroup: true, groupId: group.id, groupName: group.name,
              studentId: group.studentIds[0], studentName: group.name,
              studentIds: [...group.studentIds],
              studentNames: group.studentIds.map(sid => students.find(s => s.id === sid)?.name || "?"),
              bucket_id: bucketId,
              schoolId: school.id, schoolName: school.name,
              day, slotId: slot.id, slotName: slot.name,
              start: slot.start, end: slot.end,
              instrument: group.instrument || "Group",  duringSpecialist: false,
              enrolmentId: enrolmentIdFor(group.studentIds[0], group.instrument || "Group", enrolments, group.id)
            };
            setTimetable(prev => ({
              ...prev,
              lessons: [
                ...prev.lessons.map(l => l.id === teacherBusy.id ? { ...l, slotId: altSlot.id, slotName: altSlot.name, start: altSlot.start, end: altSlot.end } : l),
                groupLesson
              ]
            }));
            setGroups(prev => prev.map(g => g.id === groupId ? { ...g, status: "scheduled" } : g));
            return { success: true };
          }
          continue; // couldn't shuffle, try next slot
        }

        // Slot is free — place directly
        const groupLesson = {
          id: uid(), isGroup: true, groupId: group.id, groupName: group.name,
          studentId: group.studentIds[0], studentName: group.name,
          studentIds: [...group.studentIds],
          studentNames: group.studentIds.map(sid => students.find(s => s.id === sid)?.name || "?"),
          bucket_id: bucketId,
          schoolId: school.id, schoolName: school.name,
          day, slotId: slot.id, slotName: slot.name,
          start: slot.start, end: slot.end,
          instrument: group.instrument || "Group",  duringSpecialist: false,
          enrolmentId: enrolmentIdFor(group.studentIds[0], group.instrument || "Group", enrolments, group.id)
        };
        setTimetable(prev => ({ ...prev, lessons: [...prev.lessons, groupLesson] }));
        setGroups(prev => prev.map(g => g.id === groupId ? { ...g, status: "scheduled" } : g));
        return { success: true };
      }
    }

    return {
      success: false,
      reason: anyLaneFound
        ? "No available slot — all class-time slots are occupied"
        : `no covering lane for ${teacher.name} at ${school.name} on any day. Add staff first.`
    };
  };

  // Incremental scheduling: add pending students + ready groups without disturbing existing lessons
  const handleSchedulePending = (schoolIdOrStudentId = null, _schoolId, day, time, instrumentName) => {
    // When called from right-click with (studentId, schoolId, day, time, instrument) — place directly
    if (day && time) {
      const studentId = schoolIdOrStudentId;
      const student = students.find(s => s.id === studentId);
      if (!student) { notify("Student not found", "warning"); return; }
      const school = schools.find(s => s.id === student.schoolId);
      if (!school) { notify("School not found", "warning"); return; }
      const slot = school.slots.find(s => s.start === time);
      if (!slot) { notify("Invalid time slot", "warning"); return; }
      const studentInsts = instrumentsFromEnrolments(student.id, enrolments);
      const inst = instrumentName
        ? studentInsts.find(i => i.name === instrumentName) || studentInsts[0]
        : studentInsts[0];
      if (!inst) { notify("Student has no instruments", "warning"); return; }
      // Spec 2 cluster 10b Commit 2 — viewedLanes-aware destination + modal flow.
      const destLane = getDayLaneTeacher(teacherCoverage, teachers, school.id, day, null, null, viewedLanes);
      if (!destLane || !destLane.lane || !destLane.teacher) {
        notify(`No covering lane for ${school.name} on ${day}.`, "warning");
        return;
      }
      let currentTeacher = null;
      if (inst.teacherId) currentTeacher = teachers.find(t => t.id === inst.teacherId);
      if (!currentTeacher) currentTeacher = teachers.find(t =>
        t.instruments.some(ti => ti.name === inst.name) &&
        t.availability.some(a => a.schoolId === school.id && a.day === day)
      );
      const currentTid = currentTeacher?.id || "";
      let pendingEnrolmentMutation = null;
      let isReassign = false;
      if (currentTid && destLane.teacher.id !== currentTid) {
        const modalText = `Reassign ${student.name} from ${currentTeacher.name} to ${destLane.teacher.name}?\n\nThis updates ${student.name}'s enrolment to ${destLane.teacher.name} as well as placing this card.`;
        if (!window.confirm(modalText)) return;
        const enrolId = enrolmentIdFor(student.id, inst.name, enrolments);
        pendingEnrolmentMutation = (prev) => prev.map(e => e.id === enrolId ? { ...e, teacherId: destLane.teacher.id } : e);
        isReassign = true;
      } else if (!currentTid) {
        const modalText = `Assign ${student.name} to ${destLane.teacher.name}?\n\nThis sets ${student.name}'s enrolment to ${destLane.teacher.name} as well as placing this card.`;
        if (!window.confirm(modalText)) return;
        const enrolId = enrolmentIdFor(student.id, inst.name, enrolments);
        pendingEnrolmentMutation = (prev) => prev.map(e => e.id === enrolId ? { ...e, teacherId: destLane.teacher.id } : e);
        isReassign = true;
      }
      const lesson = {
        id: uid(),
        studentId: student.id, studentName: student.name,
        bucket_id: destLane.lane.id,
        schoolId: school.id, schoolName: school.name,
        day, slotId: slot.id, slotName: slot.name,
        start: slot.start, end: slot.end,
        instrument: inst.name,
        duringSpecialist: false,
        enrolmentId: enrolmentIdFor(student.id, inst.name, enrolments)
      };
      if (isReassign) {
        pendingPlaceUndoStack.current.push({
          seq: ++ttPageActionSeq.current,
          timetable: JSON.parse(JSON.stringify(timetable)),
          students: JSON.parse(JSON.stringify(students)),
          enrolments: JSON.parse(JSON.stringify(enrolments)),
          groups: JSON.parse(JSON.stringify(groups)),
        });
        pendingPlaceRedoStack.current = [];
        if (pendingPlaceUndoStack.current.length > 50) pendingPlaceUndoStack.current.shift();
        if (pendingEnrolmentMutation) setEnrolments(pendingEnrolmentMutation);
      }
      if (!timetable) {
        setTimetable({ lessons: [lesson], unscheduled: [] });
      } else {
        setTimetable(prev => ({ ...prev, lessons: [...prev.lessons, lesson] }));
      }
      // Keep student as pending — they are scheduled but still on the waiting list until explicitly activated
      return;
    }
    const schoolId = schoolIdOrStudentId;
    const existingLessons = timetable ? [...timetable.lessons] : [];
    const existingUnscheduled = timetable ? [...timetable.unscheduled] : [];

    let pendingToSchedule = students.filter(s => s.status === "pending" || s.status === "trial");
    if (schoolId) pendingToSchedule = pendingToSchedule.filter(s => s.schoolId === schoolId);

    if (pendingToSchedule.length === 0) {
      notify("No pending students to schedule", "warning");
      return;
    }

    const tempStudents = pendingToSchedule.map(s => ({ ...s, status: "active" }));
    const result = generateMasterTimetable(
      schools, tempStudents, teachers, enrolments, specialists,
      { existingLessons, targetSchoolId: schoolId || null, teacherCoverage }
    );
    const newLessons = result.lessons.filter(l => !existingLessons.some(el => el.id === l.id));
    const newUnscheduled = result.unscheduled;
    const scheduledStudentIds = new Set(newLessons.map(l => l.studentId));

    if (scheduledStudentIds.size > 0) {
      setStudents(prev => prev.map(s =>
        scheduledStudentIds.has(s.id) ? { ...s, status: "active" } : s
      ));
    }

    const mergedLessons = [...existingLessons, ...newLessons];
    const keptUnscheduled = schoolId
      ? existingUnscheduled.filter(u => u.student.schoolId !== schoolId)
      : [];
    const mergedResult = {
      lessons: mergedLessons,
      unscheduled: [...keptUnscheduled, ...newUnscheduled]
    };
    compactTimetable(mergedResult, schools, students, teachers, enrolments, specialists, teacherCoverage);
    setTimetable({ ...mergedResult, lessons: stampEnrolmentIds(mergedResult.lessons, enrolments) });

    const sched = newLessons.length;
    const unsched = newUnscheduled.length;
    if (sched > 0 && unsched > 0) {
      notify(`Scheduled ${sched} lesson${sched !== 1 ? "s" : ""}. Could not fit: ${unsched} student${unsched !== 1 ? "s" : ""}.`);
    } else if (sched > 0) {
      notify(`Scheduled ${sched} lesson${sched !== 1 ? "s" : ""} into existing timetable!`);
    } else {
      notify(`Could not fit any pending students.`, "warning");
    }
  };

  // Manual scheduling: place a pending/trial student at a specific day/time
  const handleManualSchedule = (studentId, day, time, target) => {
    const student = students.find(s => s.id === studentId);
    if (!student) { notify("Student not found", "warning"); return; }
    const school = schools.find(s => s.id === student.schoolId);
    if (!school) { notify("School not found", "warning"); return; }
    const slot = school.slots.find(s => s.start === time);
    if (!slot) { notify("Invalid time slot", "warning"); return; }

    const inst = instrumentsFromEnrolments(student.id, enrolments)[0];
    if (!inst) { notify("Student has no instruments", "warning"); return; }

    // Spec 2 cluster 10b Commit 2 — viewedLanes-aware destination resolution.
    // MTT branch (target === "master") gets the full Q1=α modal-or-stamp flow.
    // WTT branch (target === "weekly") gets Q2=β lane-only stamp, no modal.
    const monday = getCurrentWeekMonday();
    const weekKey = toLocalDateStr(monday);
    const destLane = target === "master"
      ? getDayLaneTeacher(teacherCoverage, teachers, school.id, day, null, null, viewedLanes)
      : getDayLaneTeacher(teacherCoverage, teachers, school.id, day, laneOverrides, weekKey, viewedLanes);
    if (!destLane || !destLane.lane || !destLane.teacher) {
      notify(`No covering lane for ${school.name} on ${day}.`, "warning");
      return;
    }

    let pendingEnrolmentMutation = null;
    let isReassign = false;
    if (target === "master") {
      let currentTeacher = null;
      if (inst.teacherId) currentTeacher = teachers.find(t => t.id === inst.teacherId);
      if (!currentTeacher) currentTeacher = teachers.find(t =>
        t.instruments.some(ti => ti.name === inst.name) &&
        t.availability.some(a => a.schoolId === school.id && a.day === day)
      );
      const currentTid = currentTeacher?.id || "";
      if (currentTid && destLane.teacher.id !== currentTid) {
        const modalText = `Reassign ${student.name} from ${currentTeacher.name} to ${destLane.teacher.name}?\n\nThis updates ${student.name}'s enrolment to ${destLane.teacher.name} as well as placing this card.`;
        if (!window.confirm(modalText)) return;
        const enrolId = enrolmentIdFor(student.id, inst.name, enrolments);
        pendingEnrolmentMutation = (prev) => prev.map(e => e.id === enrolId ? { ...e, teacherId: destLane.teacher.id } : e);
        isReassign = true;
      } else if (!currentTid) {
        const modalText = `Assign ${student.name} to ${destLane.teacher.name}?\n\nThis sets ${student.name}'s enrolment to ${destLane.teacher.name} as well as placing this card.`;
        if (!window.confirm(modalText)) return;
        const enrolId = enrolmentIdFor(student.id, inst.name, enrolments);
        pendingEnrolmentMutation = (prev) => prev.map(e => e.id === enrolId ? { ...e, teacherId: destLane.teacher.id } : e);
        isReassign = true;
      }
    }
    // (target === "weekly": no modal, no enrolment mutation — Q2=β.)

    const lesson = {
      id: uid(),
      studentId: student.id, studentName: student.name,
      bucket_id: destLane.lane.id,
      schoolId: school.id, schoolName: school.name,
      day, slotId: slot.id, slotName: slot.name,
      start: slot.start, end: slot.end,
      instrument: inst.name,
      duringSpecialist: false,
      enrolmentId: enrolmentIdFor(student.id, inst.name, enrolments)
    };

    if (target === "master") {
      if (isReassign) {
        pendingPlaceUndoStack.current.push({
          seq: ++ttPageActionSeq.current,
          timetable: JSON.parse(JSON.stringify(timetable)),
          students: JSON.parse(JSON.stringify(students)),
          enrolments: JSON.parse(JSON.stringify(enrolments)),
          groups: JSON.parse(JSON.stringify(groups)),
        });
        pendingPlaceRedoStack.current = [];
        if (pendingPlaceUndoStack.current.length > 50) pendingPlaceUndoStack.current.shift();
        if (pendingEnrolmentMutation) setEnrolments(pendingEnrolmentMutation);
      }
      if (!timetable) {
        setTimetable({ lessons: [lesson], unscheduled: [] });
      } else {
        setTimetable(prev => ({ ...prev, lessons: [...prev.lessons, lesson] }));
      }
    } else if (target === "weekly") {
      const storageKey = `${weekKey}|${student.schoolId}`;
      const dayDate = DAYS.map((d, di) => {
        const date = new Date(monday);
        date.setDate(monday.getDate() + di);
        return { day: d, date: toLocalDateStr(date) };
      });
      const weekDate = dayDate.find(wd => wd.day === day)?.date;

      setWeeklyTimetables(prev => {
        const entry = prev[storageKey] || { lessons: [], missed: [], notes: "", generatedAt: new Date().toISOString() };
        return {
          ...prev,
          [storageKey]: {
            ...entry,
            lessons: [...entry.lessons, { ...lesson, weekDate, adjusted: true, adjustReason: "Manually added" }]
          }
        };
      });
    }
  };

  const [showExportDialog, setShowExportDialog] = useState(null);

  // ── Voice recording ────────────────────────────────────────────
  const stopVoiceRecording = () => {
    if (speechRecognitionRef.current) {
      try { speechRecognitionRef.current.stop(); } catch(e) {}
      speechRecognitionRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
  };

  const startVoiceRecording = async (mode) => { // mode: 'note' | 'chat'
    // If already recording, stop instead (use refs — state is stale in hotkey handler)
    if (isRecordingRef.current || isVoiceChatRef.current) { stopVoiceRecording(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunksRef.current = [];
      voiceTranscriptRef.current = "";

      const mimeType = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "audio/mp4";
      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = e => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };

      recorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        // Wait briefly for SpeechRecognition to deliver its final result before reading transcript
        await new Promise(res => setTimeout(res, 350));
        const transcript = voiceTranscriptRef.current.trim();

        if (mode === "note") {
          let audioDataUrl = null;
          try {
            const blob = new Blob(audioChunksRef.current, { type: mimeType });
            audioDataUrl = await new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
          } catch(e) {}
          const note = { id: uid(), createdAt: new Date().toISOString(), transcript: transcript || "", audioDataUrl };
          setVoiceNotes(prev => [...prev, note]);
          notify(transcript ? "Voice note saved" : "Voice note saved — no transcript captured", transcript ? "success" : "warning");
        } else {
          // voice chat: put transcript in Claude input and send
          if (transcript) {
            setClaudeInput(transcript);
            setClaudePanelOpen(true);
            setTimeout(() => claudeSendRef.current?.(), 80);
          } else {
            notify("No speech detected — try speaking closer to the mic", "warning");
          }
        }
        isRecordingRef.current = false;
        isVoiceChatRef.current = false;
        setIsRecordingNote(false);
        setIsVoiceChat(false);
      };

      recorder.start();

      // Web Speech API for real-time transcription — runs concurrently with MediaRecorder
      try {
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (SR) {
          const recognition = new SR();
          recognition.continuous = true;
          recognition.interimResults = false;
          recognition.lang = "en-AU";
          recognition.onresult = e => {
            voiceTranscriptRef.current = Array.from(e.results).map(r => r[0].transcript).join(" ");
          };
          recognition.onerror = () => {};
          recognition.start();
          speechRecognitionRef.current = recognition;
        }
      } catch(e) {}

      if (mode === "note") { setIsRecordingNote(true); isRecordingRef.current = true; }
      else { setIsVoiceChat(true); isVoiceChatRef.current = true; }

    } catch(e) {
      notify("Could not access microphone — check system permissions", "warning");
      isRecordingRef.current = false;
      isVoiceChatRef.current = false;
      setIsRecordingNote(false);
      setIsVoiceChat(false);
    }
  };

  const sendVoiceNotesToClaude = (notes) => {
    if (!notes.length) return;
    let text;
    if (notes.length === 1) {
      const n = notes[0];
      const time = new Date(n.createdAt).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit", hour12: true });
      text = `Voice note (recorded ${time}):\n"${n.transcript || "[no transcript]"}"`;
    } else {
      const lines = notes.map(n => {
        const time = new Date(n.createdAt).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit", hour12: true });
        return `[${time}] "${n.transcript || "[no transcript]"}"`;
      });
      text = `Voice notes — end of day batch (${notes.length} notes):\n\n${lines.join("\n")}\n\nPlease parse these and suggest appropriate actions (todos, reminders, timetable changes, email drafts, etc). Describe what you plan to do and confirm before taking any actions.`;
    }
    setClaudeInput(text);
    setClaudePanelOpen(true);
    setTimeout(() => claudeSendRef.current?.(), 80);
    setVoiceNotesModalOpen(false);
  };

  // ── Global keyboard shortcuts ──────────────────────────────────────
  useEffect(() => {
    const handler = (e) => {
      // Escape: close any open modal/overlay
      if (e.key === "Escape") {
        if (showExportDialog) { setShowExportDialog(null); return; }
      }
      // Arrow keys: left/right = history navigation, up/down = scroll hovered list
      if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown") {
        const tag = document.activeElement?.tagName?.toLowerCase();
        if (tag === "input" || tag === "textarea" || tag === "select") return;
        if (e.key === "ArrowLeft" && historyCursor > 0) { e.preventDefault(); goBack(); }
        if (e.key === "ArrowRight" && historyCursor < pageHistory.length - 1) { e.preventDefault(); goForward(); }
        if ((e.key === "ArrowUp" || e.key === "ArrowDown") && hoveredScrollRef.current) {
          e.preventDefault();
          // If the email nav callback is set and the email list is hovered, navigate items
          if (emailNavRef.current?.navigate && hoveredScrollRef.current === emailListRef.current) {
            emailNavRef.current.navigate(e.key === "ArrowDown" ? 1 : -1);
          } else {
            hoveredScrollRef.current.scrollBy({ top: e.key === "ArrowDown" ? 60 : -60, behavior: "smooth" });
          }
        }
        return;
      }
      // Cmd+Z / Ctrl+Z: undo for timetable (lessons or breaks) or weekly
      if ((e.metaKey || e.ctrlKey) && e.key === "z" && !e.shiftKey) {
        if (page === "timetable" && ttPageUndoCount() > 0) {
          e.preventDefault(); undoTimetablePage();
        } else if (page === "weekly" && weeklyUndoStack.current.length > 0) {
          e.preventDefault(); undoWeekly();
        } else if (page === "dashboard" && todoUndoRef.current) {
          e.preventDefault(); todoUndoRef.current();
        }
        return;
      }
      // Cmd+Shift+Z / Ctrl+Y: redo
      if (((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "z") || ((e.ctrlKey) && e.key === "y")) {
        if (page === "timetable" && ttPageRedoCount() > 0) {
          e.preventDefault(); redoTimetablePage();
        } else if (page === "weekly" && weeklyRedoStack.current.length > 0) {
          e.preventDefault(); redoWeekly();
        }
        return;
      }
      // Cmd+Shift+D: toggle dark mode
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "d") {
        e.preventDefault();
        setDarkMode(prev => !prev);
        return;
      }
      // Cmd+. → quick-add To-Do (toggle modal)
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === ".") {
        e.preventDefault();
        setQuickAddTodoTrigger(prev => prev + 1);
        return;
      }
      // Cmd+/ → quick-add Reminder (toggle modal)
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === "/") {
        e.preventDefault();
        setQuickAddReminderTrigger(prev => prev + 1);
        return;
      }
      // Cmd+Shift+. → toggle voice note recording + modal (mirrors teacher app)
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === ".") {
        e.preventDefault();
        if (isRecordingRef.current || isVoiceChatRef.current) {
          stopVoiceRecording();
        } else {
          setVoiceNotesModalOpen(prev => {
            if (prev) return false;
            startVoiceRecording("note");
            return true;
          });
        }
        return;
      }
      // Cmd+Shift+/ → voice chat (transcribe and send to Claude)
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "/") {
        e.preventDefault();
        if (isRecordingRef.current || isVoiceChatRef.current) stopVoiceRecording();
        else startVoiceRecording("chat");
        return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [page, showExportDialog, historyCursor, pageHistory]);


  const handleExport = (callerWeeklyData = null, callerWeekLabel = "", initialType = null) => {
    if (!timetable && !callerWeeklyData && initialType !== "tally") { notify("No timetable to export", "warning"); return; }
    // Build list of all weeks that have a generated timetable, sorted chronologically
    const termBreaksForLabel = interruptions.filter(i => i.type === "term_break");
    const weekKeys = [...new Set(Object.keys(weeklyTimetables).map(k => k.split("|")[0]))].sort();
    const availableWeeks = weekKeys.map(wKey => {
      const allLessons = [], allMissed = [];
      for (const s of schools) {
        const wd = weeklyTimetables[`${wKey}|${s.id}`];
        if (wd) { allLessons.push(...wd.lessons); allMissed.push(...(wd.missed || [])); }
      }
      return allLessons.length > 0
        ? { weekKey: wKey, weekLabel: getTermWeekLabel(wKey, termBreaksForLabel), lessons: allLessons, missed: allMissed }
        : null;
    }).filter(Boolean);
    setShowExportDialog({ availableWeeks, initialType });
  };

  // ── Auth gates ───────────────────────────────────────────────
  if (authLoading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: colors.bg, fontFamily: "'DM Sans', sans-serif" }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 32, color: colors.accent, marginBottom: 12 }}>♪</div>
          <div style={{ color: colors.textLight, fontSize: 14 }}>Checking session…</div>
        </div>
      </div>
    );
  }
  if (!session) return <LoginScreen />;

  if (loading) {
    return (
      <ThemeProvider colors={colors} darkMode={darkMode} toggleDarkMode={toggleDarkMode}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: colors.bg, fontFamily: "'DM Sans', sans-serif" }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 32, color: colors.accent, marginBottom: 12 }}>♪</div>
            <div style={{ color: colors.textLight }}>Loading your timetable...</div>
          </div>
        </div>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider colors={colors} darkMode={darkMode} toggleDarkMode={toggleDarkMode}>
    <div style={{ display: "flex", height: "100vh", fontFamily: "'DM Sans', sans-serif", background: colors.bg, color: colors.text, overflow: "hidden" }}>
      {isDev && (
        <div style={{ position: "fixed", top: 0, left: 0, right: 0, zIndex: 99999, background: "#D97706", color: "#fff", textAlign: "center", fontSize: 12, fontWeight: 700, padding: "3px 0", letterSpacing: 0.5, fontFamily: "'DM Sans', sans-serif", pointerEvents: "none" }}>
          DEV MODE — Supabase writes disabled
        </div>
      )}
      {composeEmail && (
        <ComposeModal
          key={composeEmail._queueKey || composeEmail.to?.join(',') || 'compose'}
          initial={composeEmail}
          schools={schools}
          students={students}
          teachers={teachers}
          contacts={contacts}
          resources={resources}
          documents={documents}
          queueRemaining={composeQueue.length}
          onClose={() => {
            if (composeQueue.length > 0) {
              const [next, ...rest] = composeQueue;
              setComposeEmail(next);
              setComposeQueue(rest);
            } else {
              setComposeEmail(null);
            }
          }}
          onCancelAll={() => { setComposeEmail(null); setComposeQueue([]); }}
          notify={notify}
          onSoundPlay={() => playSound("email-send.mp3")}
          onSent={composeEmail?.onSent || null}
        />
      )}
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Serif+Display&display=swap" rel="stylesheet" />
      <style>{`
        @media print {
          /* Hide chrome: sidebar, notifications, buttons, modals, export dialogs */
          nav, button, [data-noprint], .no-print { display: none !important; }
          /* Fill the page */
          body, html { background: white !important; }
          /* Remove fixed/sticky positioning so content flows */
          * { position: static !important; box-shadow: none !important; }
          /* Main content area fills full width */
          [data-printarea] { width: 100% !important; max-width: 100% !important; overflow: visible !important; }
          /* Keep timetable grid readable */
          table { page-break-inside: auto; font-size: 11px; }
          tr { page-break-inside: avoid; }
          thead { display: table-header-group; }
          /* Lesson cards */
          [data-lessoncard] { break-inside: avoid; border: 1px solid #ccc !important; }
          /* Force background colours to print */
          * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
          /* Page margins */
          @page { margin: 15mm; }
        }
        * { outline: none !important; }
        ${darkMode ? `
          input:not([type='checkbox']):not([type='radio']):not([type='range']):not([type='color']):not([type='file']),
          select,
          textarea {
            background-color: #1E1C24 !important;
            color: #E8E3DF !important;
            border-color: #3D3942 !important;
            color-scheme: dark;
          }
        ` : ''}
      `}</style>

      {/* Sidebar */}
      <div className="no-print" ref={sidebarRefCb} style={{ width: 240, background: colors.sidebar, display: "flex", flexDirection: "column", flexShrink: 0 }}>
        <div style={{ padding: "12px 16px", borderBottom: "1px solid rgba(255,255,255,0.08)", display: "flex", alignItems: "center", justifyContent: "center", boxSizing: "border-box", height: HEADER_HEIGHT, flexShrink: 0, WebkitAppRegion: "drag" }}>
          <div style={{ background: colors.sidebarActive, borderRadius: 10, padding: "12px 16px", display: "flex", alignItems: "center", justifyContent: "center", width: "100%", boxSizing: "border-box" }}>
            <img src={"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAL4AAAA6CAYAAAAOVeNTAAATHUlEQVR4nO2deZRfRZXHP7eXpJOQFQiExUAyCQFkOwkRBhFxQBYHZhzCFhVmZMKBERxgxgHOyBCUddDhAIOsAyObDNuogIAKsglBUBCQVZLgBBKDbAmQtfs7f9xb/avfy/t12pCmpft9z+nTv1evllv1bt26davqFlSoUKFChf4B620CKvxpQVInT5iZepOWnkTF+P0cOaND32b2HBXj92ME0yceaDKzlRF2ItACnAE0AR0pTX/pGBX6KCRZ+svCpki6Q9JcSbMltTaK+1FHU28TUKHX0STpHEnfAIYD+wK3APOAnSSNAtoqSV+hTyAkeFP8PSKpXdIekl6VtLek6yTNkzRH0l9H/ObeprtChQ+EYOSW+P13khYGwz8XzL5UNVwY8SrGr/DRR8b4O0paIOn3klaqHu9FZxgVcfuMnl+hH0JSU/zfQNKvJHUUGP4qSd+T9JCk1yXNiPh9QupXk9v+izRZbQE2pmbW/AWwALgI+AbwG+BpYMcPm8CeREtvE1Ch1/EmMBe4FrfXLwW2AA4ETgIuASYAQyJ+n7DuVIzfzxAqjnAzpgHLgAeBm4FncMn+C2DTMGE+IekZoBnAzDpKM/6IoWL8/gcjVmlTgKQBwK5mNkvSAzhfNGcruyvNbEXvkNszqBi/nyBNZs2sPZ4HA38O7A0cDNyaMfryPClgkqyvSHuoGL9PIjM5JkZWYlpJmwAH4Mw+BWiNuBuYmSR16vDZaq36mhmzYvxeRiZljZg4riXJ2gx0ZBJ+K+BQYDowLov3FvAUcEciKWiom8RWWxYqrDUk9aMsfE0kbNqGkD03S/q0pCskzS/Y6Z+QdJqknULtSeVWJu4KPYPCdgGTNFXS30qaLmlihDcF4zbsAKrtt+nML8IHStpP0i2x8prwrqTbopz1i3n1VH0rVADqtgpMkG8Geydjzt9JOl5SS1GCl+RjKV48ryPpIEk/Uf3Wg/mSLpW0u6S2LH3apFYxfX+FanvOm3KG0Freh67aVoEpkp5VY3wt4rWUMX/OsJIGSTpE0n2FPObItxxvU0hXmmeFfoCMuZu7wwQRr0WrUT+6SN8pvSWNKzD9jyUdKWmapIvkOyPflbRzxG/NOmGzYr9M/N4v0ud7bZ6XdIqkccXy13ZHrvARgzKdOJ4HSRojabykLSV9XK6KjJYv8ORx/2jmzxivVdKNwaDLJJ0qaVAh7hfkqsrtkgYkZle9Hr9L5LO8wPAnSdo0i1dNWCs4Msk7UNJfSrow1ITZkl6T701/Xa4bvyjpR5LOkLS/pA3yfLrbATIpfXAw9QpJJ2b5tESnSPr/acHMn4/nFL65pPNVPy94NTpQzvBrPDpV6GMIBksMOFnSD7Xq/vPV4WlJMyWNz/JNTNbIPJmk/bryLcCSdE1KkzOnaurIMLk69IykIRE+Q9LLGS1LJV0mt9Hn6VPHrpi+v0P1k9WvaFW79uvyI3jXSvqOfBS4RG4SnCU/hpfjRUknSlovy7/TwpKVm5suT460CxUTzrLOkjHujIh/TtCU40lJh2Z5V9K9Qj1Us360STqvwEBPSDpO0jaShpWkbZE0QtIkSYfJJfXCLP0suQlxcF6eapPn5Klg1+hcknRqhJUya5Z+ROSfY4WkKyWNjbirtfdX6IfIpOc6kq7OGOgNSf+qkoUcdWH9iPDtJZ2l+lHgPklHKdOzszTbyY/vJUm9QZTRcMtIRvf+qk1gn5XPEXKrTurUFeNXcGRMPDQkdcKjknbN4jVcyJHq7Pt1klXSVpL+M5PkkvSSfLFouqR9JP2LfNIsuYly30jbnVXZZEI9vZLyFbqNTGqenzHmHaodnG7pSuoW8rLsr2hanCTpgkIHKMOxWbldMq3qR57i/pvKHl9hVeTMIl/gSa4yHpI0JsLzpf41XZAqjgDbyheOHpa0OGP41+QT4RapbsW1O8yf/3U7bYV+iIw5RqlmPpwtaVKErzVPATljZmHDJH1C0uHxt2WEl1p+KlRYK1Bt8ndEMP0SSdMirKXIqB+wrKIKtEqnkluT2opp1kb5FdYMfe4gSoGhPoMfrLgNP1rXBLTD2jtYEaeWLPJrT1I9PA/vBHwFmAi8L+lJ4H+Bh8ysI0tXocIHQ6bmDFTNBr5XhPW4M6RstDlI9fb+hPflq62jVe2jqbC2kDF+m6TfyPe3D/8w1AvVrC2T5C758snty4WOcFZK05M0VShHn1N1wJnfzJZKWgi8b2bvqOZPpidhocJ8CdgA91lzNnAl7rlgGDAZ+CawVcNcKlRYE6i2f2WmpMdVMAX2UJn5oZBHQ6qf0SDu1pL2+jBUrwr9CKrZ8LeQbzwbm4f3UJmJ8TcKlWa+pA2j07Wqtqe+NUtTHfvrJfRJ/TKzmLyAOzz9mw+x+HdxFeceM1tAeCLD/VJ2ACvTpNbMOiqrTu+gTzJ+IEnSi/ErbdZLHaJHCnOzZpOZLcJ9Ub4aZZmZqfDX0Ze8klX4E0OmfuytODjSw3p+UrH2kHR4T5dXYc1RthuxidoVjyqJm6wjHfDheNgKmlL5HWnRKKOr812Rpt5YJIpJa4uZLWvwPm/3Zhq0Z+RjQHtvqUSFdm5kGUtuCtt7o73XBKucFioyTSGu0vtsGO/I43aRvvtEdaPhUvkRf3U0lDo8LaOvrOyyfMvy6O4HTx05ufdLYTmNjRioLLxRWBlNXcVtFJ8G7VdCWzPU/HSWlZl+d8Ub+fs1oLVbdbZiImASsA3wS2B2FkfAUODTuE36Z8CKntRVs0aaAGyPT1RfKDTc4KCpA7gfWBLhVmSkYliDMpu6W6eyuGm9oKtOkK0prA98Evg9MIsYzSJOMzAV2ATf4jC/uzQVy29Up7I2SepaQZg0445mh1HzpLw4ngEGAAuBH/SUtC/SlYV12dbdyTgttR8dNujT47nztL58260kPZCFp0MRLSksS7du2LXb5G4y0u/R8lNIbRGWvxulcOeR5XVolHt5Cs9omhjvXpA0PE8Xv0dLWrfYgHIT44CMhuLRwfSXTJGtqj+321Qoo9su+bJ6bRW0P6dwMZLR1yLpl/F+2whrk2/F6FyFjngD07fIyli/hKZU5+J26la56XVooQ1SfVslnSv3NnGDpJ8HXffG813y7ditQWN+MizRl/hlYNAwUtLgaPuUrk2+yj4ko7XY1sPkJuOWElpzVyyJ9ubIt9NlI5Sv3L6J9+ppki4A/gA0h/52KC5ZX41NWEk/FX5lzMdwb7xvASOAq4AVuMQYDbyBm/s+huuLc4FBuOR7E7+GZihwJPAKtdFmUdC0p6TNI11r0DQtaJoPLImKdUg6AviroK1V0nLgUjO7M+J8Er+yfmGiUdIQ4Cbgv6jNc4YDN+C3hZxApl5JOgA4PMpA0vvAw8D1wJsqGdYL0mkxfpHyJGAf4Nb4JsvxDXbbRFsuivinxP+vB33tkfY4YKaZzZO0T7TfQGCFpKXAY8ClwHbA14DjzGxO1Pcfoy2W47ekzANujHqsoObF+eR0mYSk7YF7gcPMbF6ENQHHAFvH/ySZRwOnA/8ebX0lfr/WZ6N+i4ExwHs4f2wC/DOwFzDAzE7x7LVNhK8X9W6T9BDwbTN7L+pyCb5ifjDwdrT9UOA84ALgidRuZYw/Er8KpgU4xsz+TRJyFxZ7AnfhzAk1xtwIv2RgIrBDNMqyKPAdYHxU+Cj8MrENg4AFUdHrga8GYSPxjw21idSwePc+cIKZHSt3CzIO+Dx+jc14wnQo3wdzEHBypGsF9gAulzTTzK6IhpqEbx94PcrZJj7QXNwOL0nbRZ0mAP8BzAum3xP4FnAabr4E2Bm/aOHWrvTUDG34x/418E+Sbsd3eLbizHw3zkjJ4dQEYmjPOlNHtPvbkqbiDH4mcE+8mwxMA74bbb4TsDTKuAZnlJnAb/FOfiBwBPBIVk5yNT4AX5NYJ32XYPiBZrZE7nNoSzNbEUKxHRdmE+NbLsY7XytwdZS3Eu/w1wLX4bz0HC5klkW5U/Hb1q8Hvo13knHAqcAUSQfiKu5YvBMfaWZnh5R/Dxe0CfUjsepVnTslfU7uqGijCP+u/HzpyZLujbDkQeC0CD9N0p0Rlg9Pm8hVkc0pQK7avKzMN0wJTdMl/UzSbvK7WJNH4YuCrhmSnouwreUbxKaU5PdFSXNjeP2M/PB2WyHOHGVXW8qvvDxAfmTxzCzeCXLPZQOK5aT6q6YmDI7nQar37TM+2mVPubqTTKAHyv337Bt12SLC/1vSlYW23yJoa5X05Yg/vAFNu0n6bdBxgHwD39CSeMNUUx9y9S7RvbOktzK6kvr1dUk/Kny7EcFPfyZXd56UtHuhvEckHVIIu0bSRfH7LkmXldA5KL7XYfH8fbkrxrmSvhphAyL84zldZQtYK4ERZnYHPgwfGcz/OVzC5R96pVyP3AW4DDgHmChpx5CKbdEBBke65Bgpd8A0BB9dOt+V0NQBDDOz+/EJ7j/I/dlMC5qgprbtArxiZo+rdtQvnZH9ScTbAle5xgPXye90vVnST/HR7gdySbcLLs1uAc4HDohywdWBV4BZku6RdH984COjrGRJ2Aj4Ia46nIRLvtxgMBAfYa4AjpfPNY7HJeDv4n0aMZJJMUcy9Q6Jch4DHgya7pV7Tj5ONStYUk8/ATxsZotVmyO0yM8SLMry71x4y+jofJe+TzaqFQ/BJ5Nsit+CXy2U+KAF540kFNoifW46HQdcHfGTHt9mZktwI8tOEW8IPvoeCMyUNN3MllPPs4LGuzNT456BD/07AHeb2Vy5itB5a4Z8mNkZH/Lb8Q99LHAYbn/ukJQ3UEc8piG7o+RdGVLjnYnrcpsDj5rZ05L2oKZTLgBGShpoZssyJlwRkrAFVy/GAm/jzLIAZ8r1cXUu1W0GMFnSecAofMg+GLgodNu95BPPTfHhe3N8N+YbZnZLdOx3caYWrlIlnTlBuOpwOa5iXBXPF+OqWL6e0gQsD8ZojrZbEe8HmNlCYL+QbmPxTrMhrs4twNWZVP5CXD0FF3ZNZDeoJDWnmxaT3NbfHmmb4lum7Rp1G/IK31qEGVRSWqdJ9QWff4w1s4ckDUzlxLuNgMezfNYzswclfQG4QdI7uLpdV36ZxE+NCXA78CqwP3COavpeMnUNxvfBnIXr0k/jetcekra02k15aZ9Ko0ase6dVLSJpj4vhPfz5oOncCBM+kTNct10S75rMbGUw/Tr4nGOWmf0fPgr9Afiemd2Nm+sM+GI0/La4pDkbeAGft1wCHB3D+v6SvmxmT5nZHWb2fTM7L/Ick7Xvm2Z2g5n9j5ndW9IG7bjxYBHO/AcB18TzgLy98Q+4WUjgpcGkm+BzgLcl/YWkY8zsmaDpVjP7Dj7x3xj/ru343OImYIKko82s3cxWhLFgslyFHGmrbvHI5xVl3/MdvMOR8sMFxsh4V8c/1Dphnlcqoz37fT1whqTxZrYs+6ZfwoXytUHncnz+0mRmdwIzcEPFDvj8ojP/RpPbETGULA1p95KZPQUQDLR+SLMZuCpwep6B3LJwuqSDwxIwFLfy5PpkqvRgfJIztBCeY0TQNcTM3pV0IS49ZwWTpvRDzWxR9PbLgHvkx/1a8YvOXgeOjjzXiTzHSJpnZm9KOjfovg+fXP3KzC7O6nUzMAefiM8GjooR70WcyScDz+LqU530i3oVV50H4xP3dSLsRlwFSTcQDop6JZ39cvwj3453xoER/0ozWy7X16dL2h94CWeeycBr+EgyJeq9rpnNlvT3wLfkvn6eB9bFJ58/xSfZRYmf6E7tnez4qU43AYfI54BP4Pw1FfixmS2QtGG0+YiUDu+EI7I65gaNJKXPDdpuk/QwNYPJJOAoM3te7gVvFDA8OuxAM7sxRr9Toq0667CKrTkk3cbAffiMvIWaia0DvwB4vWicyUHcLGqjRwduHdkYl75LccvBVOAxM5tfkCKjcF3612b2irJFCdXMgZOiovfjlp3m+FseDbVDlPEAfvBE8snfZ4HNopznQuKmEWVz/DDIQ9Sk0RDgUzjTbIovLD1PrTM24epBh5k9EGXsjo8MzXgHuCcavuFCWKpj0LwjziSvxus2YHlI349FGz8KzI96jYl6DcPViMfN7LFUnnzythtuAWrF5yF3R8cYh1uJfo6b+zrkc7R9Ir/FwANmNidrp06rVPY9NgO2xVWM+dE+FjQPB/alZnZ81szui7yGA7sCz5ibU5vwzv0pfD7zbLSBRbwVwCPUDvhsh3f0VlxNvcvM3og6t+EWneeDj1pwXtwg0syK79lk2Yp52cepc5uhVb36NvrdVMynqzLKnleXpvC3Snlq4CRKDTyQpXzKyi22QRZeeoikq7zK8uyiXsX3Dc/nqrZg09W1QX9MO3Xp07MB3V3R17C+DfKyQlinJaw7tHbFG+l3aeUoWe7Pen3n0nH+u5BH2bJ3mjyV7a8ofVeMY/V7W0ppKqGj06JQrFNZntSku0WaIr15/VP80jK6g/igHUWpmtNYfE/93KysXnU0pXp0Uec8v9WeEejm92xEX3MxXT7KF8LKtijkPNudfFbLXxUq9Bv8P5yMG5b5h35SAAAAAElFTkSuQmCC"} alt="Matt Moras - Music Tuition" style={{ width: "100%", maxWidth: 180, height: "auto", display: "block", filter: darkMode ? "brightness(0.07) saturate(0.8) hue-rotate(250deg)" : undefined }} />
          </div>
        </div>
        <nav style={{ flex: 1, padding: "12px 8px", overflowY: "auto", overflowX: "hidden" }}>
          {[
            { id: "dashboard", icon: <House size={16} />, label: "Dashboard" },
            { id: "messages", icon: <MessageSquare size={16} />, label: "Messages" },
            { id: "calendar", icon: <Calendar size={16} />, label: "Calendar" },
            { id: "timetable", icon: <LayoutGrid size={16} />, label: "Master Timetable" },
            { id: "weekly", icon: <CalendarDays size={16} />, label: "Weekly Adjustments" },
            { id: "tally", icon: <ClipboardCheck size={16} />, label: "Master Tally" },
            { id: "students", icon: <GraduationCap size={16} />, label: "Students" },
            { id: "groups-bands", icon: <Piano size={16} />, label: "Groups & Bands" },
            { id: "pending", icon: <Clock size={16} />, label: "Waiting List" },
            { id: "specialists", icon: <Palette size={16} />, label: "Specialist Classes" },
            { id: "schools", icon: <Building2 size={16} />, label: "Schools" },
            { id: "teachers", icon: <Guitar size={16} />, label: "Staff" },
            { id: "contacts", icon: <BookUser size={16} />, label: "Contacts" },
            { id: "resources", icon: <Library size={16} />, label: "Documents & Resources" },
            { id: "invoicing", icon: <Receipt size={16} />, label: "Invoicing" },
            { id: "settings", icon: <Settings size={16} />, label: "Settings" },
          ].map(item => (
            <button
              key={item.id}
              onClick={() => {
                if (item.id === "groups-bands" && page === "groups-bands") {
                  setGroupsViewState(prev => ({ ...prev, resetSignal: ((prev.resetSignal || 0) + 1) }));
                } else {
                  setPage(item.id);
                }
              }}
              style={{
                display: "flex", alignItems: "center", gap: 10, width: "100%",
                height: 34, padding: "0 16px", border: "2px solid transparent", borderRadius: 8, cursor: "pointer",
                background: page === item.id ? colors.sidebarActive : "transparent",
                color: page === item.id ? colors.accent : "rgba(255,255,255,0.6)",
                fontSize: 13, fontFamily: "inherit", textAlign: "left", marginBottom: 2,
                fontWeight: 500, boxSizing: "border-box",
                transition: "all 0.15s"
              }}
              onMouseEnter={e => { if (page !== item.id) { e.currentTarget.style.background = colors.sidebarHover; e.currentTarget.style.color = colors.accent; } }}
              onMouseLeave={e => { if (page !== item.id) { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "rgba(255,255,255,0.6)"; } }}
            >
                <span style={{ width: 22, flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>{item.icon}</span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>{item.label}</span>
              {item.id === "dashboard" && dashBadges.alerts > 0 && (
                <span style={{ background: colors.danger, color: "#fff", fontSize: 11, fontWeight: 700, borderRadius: "50%", width: 20, height: 20, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  {dashBadges.alerts}
                </span>
              )}
              {item.id === "dashboard" && dashBadges.email > 0 && (
                <span style={{ background: colors.accent, color: "#fff", fontSize: 11, fontWeight: 700, borderRadius: "50%", width: 20, height: 20, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginLeft: dashBadges.alerts > 0 ? 4 : undefined }}>
                  {dashBadges.email}
                </span>
              )}
              {item.id === "timetable" && ttWarningCount > 0 && (
                <span style={{ marginLeft: "auto", background: colors.accent, color: "#fff", fontSize: 11, fontWeight: 700, borderRadius: "50%", width: 20, height: 20, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  {ttWarningCount}
                </span>
              )}
              {item.id === "weekly" && weeklyWarningCount > 0 && (
                <span style={{ marginLeft: "auto", background: colors.accent, color: "#fff", fontSize: 11, fontWeight: 700, borderRadius: "50%", width: 20, height: 20, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  {weeklyWarningCount}
                </span>
              )}
              {item.id === "messages" && (
                <>
                  {messageBadgeCount > 0 && (
                    <span style={{ background: colors.accent, color: "#fff", fontSize: 11, fontWeight: 700, borderRadius: "50%", width: 20, height: 20, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      {messageBadgeCount}
                    </span>
                  )}
                <span
                  title="Compose email"
                  onClick={e => { e.stopPropagation(); if (window._openComposeModal) window._openComposeModal({ to: [], from: "", subject: "", body: "", triggerId: "sidebar_compose", mergeCtx: null, attachments: null }); }}
                  style={{ marginLeft: "auto", marginRight: -3, display: "inline-flex", alignItems: "center", justifyContent: "center", width: 22, height: 22, borderRadius: 5, background: colors.sidebarActive, cursor: "pointer", flexShrink: 0, border: "1.5px solid rgba(255,255,255,0.18)" }}
                  onMouseEnter={e => { e.currentTarget.style.background = colors.accent; }}
                  onMouseLeave={e => { e.currentTarget.style.background = colors.sidebarActive; }}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={colors.white} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>
                </span>
                </>
              )}
            </button>
          ))}
        </nav>
        {/* ── Teacher Roster ────────────────────────────────
            Full staff roster in sort_order (persisted via teachers.sort_order).

            Online derivation requires BOTH:
              - presenceMap.has(t.id) — Realtime presence shows them online
              - effectiveLastSeen within last 90s — heartbeat is fresh
            Both required because Realtime presence can take 30-90s to
            detect an unclean disconnect (Cmd+Q without time for WebSocket
            leave frame). The freshness check kicks in when the heartbeat
            stops, so teachers stop showing as "online" within ~15s of the
            tick timer noticing.

            "Last seen" timestamp source priority:
              1. offlineAt[id] — captured by presence subscriber when a
                 teacher dropped out cleanly during THIS admin session
              2. liveLastSeen[id] — polled every 30s from teachers.last_seen
              3. t.lastSeen — initial load value (may be hours stale)
              4. "—" — never seen
        */}
        {teachers.length > 0 && (
          <div style={{ padding: "8px 12px", borderTop: "1px solid rgba(255,255,255,0.08)", flexShrink: 0 }}>
            {(() => {
              const presenceMap = new Map(teacherPresence.map(p => [p.teacherId, p]));
              const FRESHNESS_MS = 90 * 1000;
              const nowMs = Date.now();
              const formatLastSeen = (iso) => {
                if (!iso) return "—";
                const seen = new Date(iso);
                if (isNaN(seen.getTime())) return "—";
                const now = new Date();
                // Calendar-day diff via YYYY-MM-DD (DST-safe, unlike ms/86400000).
                const toYMD = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
                const daysAgo = Math.round((new Date(toYMD(now)).getTime() - new Date(toYMD(seen)).getTime()) / 86400000);
                const h = seen.getHours(); const m = seen.getMinutes();
                const t12 = `${h % 12 || 12}:${String(m).padStart(2, "0")}${h >= 12 ? "pm" : "am"}`;
                if (daysAgo <= 0) return t12;
                if (daysAgo === 1) return `Yesterday ${t12}`;
                if (daysAgo <= 7) return ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][seen.getDay()];
                return "over a week ago";
              };
              return teachers.map(t => {
                // Pick the freshest known timestamp for this teacher.
                const effectiveLastSeenIso = offlineAt[t.id] || liveLastSeen[t.id] || t.lastSeen;
                const lastSeenAgeMs = effectiveLastSeenIso
                  ? (nowMs - new Date(effectiveLastSeenIso).getTime())
                  : Infinity;
                const presenceEntry = presenceMap.get(t.id);
                // Primary online signal: presence is there and heartbeat fresh.
                const onlineViaPresence = !!presenceEntry && lastSeenAgeMs < FRESHNESS_MS;
                // Session 95 BUG 1 mitigation: if presence is absent but the
                // DB heartbeat (liveLastSeen) is very fresh AND we haven't
                // recorded an offlineAt stamp for this teacher this session,
                // treat them as online. Prevents the "Last seen HH:MM"
                // timestamp from climbing every minute during a presence
                // lag — teacher is really online, admin just hasn't received
                // the sync yet. We exclude teachers with offlineAt stamps so
                // a teacher who genuinely just quit doesn't flicker back to
                // online for 60s.
                const onlineViaHeartbeat = !presenceEntry
                  && !offlineAt[t.id]
                  && !!liveLastSeen[t.id]
                  && (nowMs - new Date(liveLastSeen[t.id]).getTime()) < FRESHNESS_MS;
                const isOnline = onlineViaPresence || onlineViaHeartbeat;
                const firstName = (t.name || "").split(" ")[0];
                if (isOnline) {
                  // If we have a presence entry, show the page label.
                  // If online via heartbeat only, show "…" as a subtle cue
                  // that presence is catching up (no page info available).
                  const pageText = presenceEntry?.page || "…";
                  const nameColour = presenceEntry?.color || t.color || "rgba(255,255,255,0.9)";
                  return (
                    <div key={t.id} style={{ fontSize: 11, color: nameColour, padding: "3px 0", display: "flex", alignItems: "center", gap: 6, lineHeight: 1.3 }}>
                      <span style={{ fontWeight: 600 }}>{firstName}</span>
                      <span style={{ opacity: 0.6, fontSize: 10 }}>{pageText}</span>
                    </div>
                  );
                }
                const lastSeenText = formatLastSeen(effectiveLastSeenIso);
                return (
                  <div key={t.id} style={{ fontSize: 11, color: "rgba(255,255,255,0.6)", padding: "3px 0", display: "flex", alignItems: "center", gap: 6, lineHeight: 1.3 }}>
                    <span style={{ fontWeight: 500 }}>{firstName}</span>
                    <span style={{ opacity: 0.55, fontSize: 10 }}>
                      {lastSeenText === "—" ? "—" : `Last seen ${lastSeenText}`}
                    </span>
                  </div>
                );
              });
            })()}
          </div>
        )}
        <div style={{ padding: "16px 12px", borderTop: "1px solid rgba(255,255,255,0.08)" }}>
          {/* ── Claude Panel ─────────────────────────────────── */}
          {(() => {
              const sendMessage = () => {
              const text = claudeInput.trim();
              const hasAttachment = !!claudeAttachment;
              if ((!text && !claudeAttachment) || claudeLoading) return;
              let userContent;
              if (claudeAttachment) {
                const filePart = claudeAttachment.kind === "image"
                  ? { type: "image", source: { type: "base64", media_type: claudeAttachment.mediaType, data: claudeAttachment.base64 } }
                  : { type: "document", source: { type: "base64", media_type: "application/pdf", data: claudeAttachment.base64 } };
                userContent = text ? [filePart, { type: "text", text }] : [filePart, { type: "text", text: "What can you tell me about this?" }];
              } else {
                userContent = text;
              }
              const displayText = text || (claudeAttachment ? `📎 ${claudeAttachment.filename}` : "");
              const userMsg = { role: "user", content: userContent, displayText };
              setClaudeMessages(prev => [...prev, userMsg]);
              setClaudeInput("");
              setClaudeAttachment(null);
              setClaudeLoading(true);
              const ctx = detectContextNeeds(text, claudeMessages, contextTriggers);
              const systemPrompt = buildClaudeSystemPrompt(page, ctx);
              // Determine effective model for this request
              const autoSonnet = hasAttachment || SONNET_AUTO_TRIGGERS.some(t => text.toLowerCase().includes(t));
              const effectiveModel = (claudeModel === "claude-sonnet-4-6" || autoSonnet)
                ? "claude-sonnet-4-6"
                : "claude-haiku-4-5-20251001";
              if (autoSonnet && claudeModel !== "claude-sonnet-4-6") setClaudeAutoSonnet(true);
              const history = claudeMessages.flatMap(m => {
                // If this message had tool calls, expand into the full API format:
                // assistant (text + tool_use blocks) → user (tool_result blocks)
                // This gives Claude full memory of what tools it called and what happened.
                if (m._apiHistory) {
                  return [
                    { role: "assistant", content: m._apiHistory.assistantContent },
                    { role: "user", content: m._apiHistory.toolResults.map(tr => ({
                      type: "tool_result",
                      tool_use_id: tr.id,
                      content: tr.result,
                    })) },
                  ];
                }
                return [{ role: m.role, content: m.content }];
              }).concat({ role: "user", content: userContent });
              let claudeRetryCount = 0;
              const retryCall = () => {
              let isFirstChunk = true;
              anthropicStreamChat(
                "https://api.anthropic.com/v1/messages",
                {
                  method: "POST", headers: { ...getAnthropicHeaders(), "anthropic-beta": "prompt-caching-2024-07-31" },
                  body: JSON.stringify({ model: effectiveModel, max_tokens: 2048, stream: true, system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }], tools: [{ type: "web_search_20250305", name: "web_search" }, ...ACTION_TOOLS], messages: history })
                },
                {
                  onChunk: (text) => {
                    if (isFirstChunk) {
                      isFirstChunk = false;
                      setClaudeLoading(false);
                      // Add the assistant message with the first chunk — dots disappear, text takes over
                      setClaudeMessages(prev => [...prev, { role: "assistant", content: text, streaming: true }]);
                    } else {
                      setClaudeMessages(prev => {
                        const last = prev[prev.length - 1];
                        if (!last || last.role !== "assistant") return prev;
                        return [...prev.slice(0, -1), { ...last, content: last.content + text }];
                      });
                    }
                  },
                  onEnd: (usage, toolCalls, textContent) => {
                    if (usage) recordUsage(claudeModel, (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) * 0.25 + (usage.cache_read_input_tokens || 0) * -0.9, usage.output_tokens || 0);
                    setApiStatus("ok");

                    if (toolCalls && toolCalls.length > 0) {
                      // ── Tool calls detected — execute them, then follow up ──────────
                      // Finalise any text that was already streamed (remove streaming flag)
                      if (!isFirstChunk) {
                        setClaudeMessages(prev => {
                          const last = prev[prev.length - 1];
                          if (!last || last.role !== "assistant") return prev;
                          return [...prev.slice(0, -1), { ...last, streaming: false }];
                        });
                      }
                      // Keep / restore the loading indicator while executing + follow-up
                      setClaudeLoading(true);

                      // Execute each tool and collect results
                      // Snapshot current state before any mutations so the user can undo
                      claudeActionSnapshotRef.current = {
                        weeklyTimetables:JSON.parse(JSON.stringify(weeklyTimetables)),
                        students:        JSON.parse(JSON.stringify(students)),
                        teachers:        JSON.parse(JSON.stringify(teachers)),
                      };
                      setHasClaudeUndo(true);
                      const toolResults = toolCalls.map(tc => ({
                        id: tc.id,
                        result: executeTool(tc.name, tc.input),
                      }));

                      // Build the assistant content block (text + tool_use) for history
                      const assistantContent = [];
                      if (textContent) assistantContent.push({ type: "text", text: textContent });
                      toolCalls.forEach(tc => assistantContent.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input }));

                      // Build the follow-up history: original history + assistant tool_use + tool_results
                      const followUpHistory = [
                        ...history,
                        { role: "assistant", content: assistantContent },
                        {
                          role: "user",
                          content: toolResults.map(tr => ({
                            type: "tool_result",
                            tool_use_id: tr.id,
                            content: tr.result,
                          })),
                        },
                      ];

                      // Stream Claude's confirmation reply — no action tools here,
                      // just a text confirmation. We don't want Claude re-calling tools.
                      let isFollowFirst = true;
                      anthropicStreamChat(
                        "https://api.anthropic.com/v1/messages",
                        {
                          method: "POST", headers: { ...getAnthropicHeaders(), "anthropic-beta": "prompt-caching-2024-07-31" },
                          body: JSON.stringify({ model: claudeModel, max_tokens: 1024, stream: true, system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }], messages: followUpHistory })
                        },
                        {
                          onChunk: (text) => {
                            if (isFollowFirst) {
                              isFollowFirst = false;
                              setClaudeLoading(false);
                              setClaudeMessages(prev => {
                                const last = prev[prev.length - 1];
                                // If Claude said text before the tool call, that's already the last
                                // assistant message. Append the confirmation to it rather than adding
                                // a new one — the API requires strictly alternating user/assistant turns.
                                if (last?.role === "assistant") {
                                  return [...prev.slice(0, -1), { ...last, content: last.content + "\n\n" + text, streaming: true }];
                                }
                                return [...prev, { role: "assistant", content: text, streaming: true }];
                              });
                            } else {
                              setClaudeMessages(prev => {
                                const last = prev[prev.length - 1];
                                if (!last || last.role !== "assistant") return prev;
                                return [...prev.slice(0, -1), { ...last, content: last.content + text }];
                              });
                            }
                          },
                          onEnd: (usage2) => {
                            if (usage2) recordUsage(claudeModel, (usage2.input_tokens || 0) + (usage2.cache_creation_input_tokens || 0) * 0.25 + (usage2.cache_read_input_tokens || 0) * -0.9, usage2.output_tokens || 0);
                            setClaudeAutoSonnet(false);
                            setApiStatus("ok");
                            setClaudeLoading(false);
                            playUISound("claude_response");
                            // Finalise message and attach _apiHistory so the next send can
                            // reconstruct the full tool_use + tool_result blocks for Claude.
                            // Without this, Claude has no memory of which tools it called.
                            setClaudeMessages(prev => {
                              const last = prev[prev.length - 1];
                              if (!last || last.role !== "assistant") return prev;
                              const content = last.content || "Done.";
                              return [...prev.slice(0, -1), {
                                role: "assistant", content,
                                _apiHistory: { assistantContent, toolResults: toolResults },
                              }];
                            });
                          },
                          onError: (message, isAuth) => {
                            setApiStatus(isAuth ? "error" : "ok");
                            setClaudeLoading(false);
                            // Finalise any existing assistant message rather than adding a second one
                            setClaudeMessages(prev => {
                              const last = prev[prev.length - 1];
                              if (last?.role === "assistant") {
                                return [...prev.slice(0, -1), { ...last, streaming: false }];
                              }
                              return prev;
                            });
                          },
                        }
                      );
                    } else {
                      // ── Normal text-only response ─────────────────────────────────
                      setClaudeAutoSonnet(false);
                      setClaudeLoading(false);
                      playUISound("claude_response");
                      // Remove streaming flag so message is treated as complete
                      setClaudeMessages(prev => {
                        const last = prev[prev.length - 1];
                        if (!last || last.role !== "assistant") return prev;
                        const content = last.content || "Sorry, I couldn't get a response.";
                        return [...prev.slice(0, -1), { role: "assistant", content }];
                      });
                    }
                  },
                  onError: (message, isAuth) => {
                    const msg = (message || "").toLowerCase();
                    const isRateLimit = !isAuth && (msg.includes("429") || msg.includes("rate") || msg.includes("too many"));
                    if (isRateLimit && claudeRetryCount < 2) {
                      const delay = claudeRetryCount === 0 ? 20000 : 45000;
                      claudeRetryCount++;
                      const secs = Math.round(delay / 1000);
                      setClaudeMessages(prev => {
                        const retryMsg = { role: "assistant", content: `Rate limit — retrying in ${secs}s…`, streaming: true };
                        const last = prev[prev.length - 1];
                        if (last?.role === "assistant") return [...prev.slice(0, -1), retryMsg];
                        return [...prev, retryMsg];
                      });
                      setClaudeLoading(true);
                      setTimeout(retryCall, delay);
                      return;
                    }
                    setClaudeAutoSonnet(false);
                    setApiStatus(isAuth ? "error" : "ok");
                    setClaudeLoading(false);
                    const errContent = isAuth
                      ? "Invalid API key — check Settings."
                      : isRateLimit
                        ? "Rate limit reached — try again in a minute."
                        : msg.includes("400") || msg.includes("bad request") || msg.includes("invalid_request")
                          ? "Request error (bad message format) — please try again."
                          : `Something went wrong — try again. (${message})`;
                    setClaudeMessages(prev => {
                      const last = prev[prev.length - 1];
                      if (last?.role === "assistant" && last.streaming) {
                        return [...prev.slice(0, -1), { role: "assistant", content: errContent }];
                      }
                      return [...prev, { role: "assistant", content: errContent }];
                    });
                  },
                }
              );
              }; // end retryCall
              retryCall();
            };
            claudeSendRef.current = sendMessage; // keep ref fresh every render for voice chat
            const canSend = (claudeInput.trim() || claudeAttachment) && !claudeLoading;
            return (
              <>
                {/* Hidden file input */}
                <input
                  ref={claudeFileInputRef}
                  type="file"
                  accept="image/*,application/pdf"
                  style={{ display: "none" }}
                  onChange={e => { const f = e.target.files?.[0]; if (f) readClaudeFile(f); e.target.value = ""; }}
                />
                <div style={{ marginBottom: 12 }}>
                  {/* Label + offline badge + undo button */}
                  <div style={{ display: "flex", alignItems: "center", marginBottom: 7, gap: 6 }}>
                    <span
                      title={!apiKey.trim() ? "No API key — add one in Settings" : ""}
                      onClick={!apiKey.trim() ? () => setPage("settings") : undefined}
                      style={{
                        fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase",
                        cursor: !apiKey.trim() ? "pointer" : "default",
                        color: !apiKey.trim() ? "transparent" : colors.accent,
                        WebkitTextStroke: !apiKey.trim() ? "1px rgba(255,255,255,0.25)" : "0",
                      }}
                    >Claude</span>
                    <div style={{ flex: 1 }} />
                    {/* Supabase sync status badge — right side of Claude row */}
                    {(() => {
                      const noSession = !sessionUserId;
                      const offline = supabaseOnline === false;
                      const synced = supabaseOnline === true && !noSession;
                      if (synced && !syncBadgeStartup) return null;
                      const label = noSession ? "NO SESSION" : offline ? "OFFLINE" : "SYNCED";
                      const color = noSession ? colors.danger : offline ? colors.warning : colors.success;
                      const title = noSession ? "Not logged in — saves to localStorage only, NOT to Supabase"
                        : offline ? "Supabase unreachable — using local cache. Will retry."
                        : "Supabase connected — data synced";
                      return (
                        <span title={title} style={{
                          fontSize: 8, fontWeight: 700, letterSpacing: "0.04em",
                          color, border: `1px solid ${color}50`, borderRadius: 3,
                          padding: "1px 5px", lineHeight: 1.3, background: `${color}1A`,
                          cursor: "default", flexShrink: 0,
                        }}>{label}</span>
                      );
                    })()}
                    {/* Undo last Claude Action */}
                    {hasClaudeUndo && (
                      <button
                        onClick={undoClaudeAction}
                        title="Undo last Claude action"
                        style={{
                          display: "inline-flex", alignItems: "center", gap: 4,
                          padding: "2px 7px", border: "1px solid rgba(255,255,255,0.18)",
                          borderRadius: 5, background: "rgba(255,255,255,0.07)",
                          color: "rgba(255,255,255,0.65)", fontSize: 11, cursor: "pointer",
                          fontFamily: "inherit", lineHeight: 1.4, flexShrink: 0,
                        }}
                        onMouseEnter={e => { e.currentTarget.style.borderColor = colors.accent; e.currentTarget.style.color = colors.accent; }}
                        onMouseLeave={e => { e.currentTarget.style.borderColor = "rgba(255,255,255,0.18)"; e.currentTarget.style.color = "rgba(255,255,255,0.65)"; }}
                      >
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7v6h6"/><path d="M3 13A9 9 0 1 0 5.17 6.5"/></svg>
                        Undo
                      </button>
                    )}
                  </div>
                  {/* Button row */}
                  <div style={{ display: "flex", gap: 6 }}>
                    {/* Mic — click to open notes modal, Cmd+Shift+. to record */}
                    <button
                      title={isRecordingNote ? "Stop recording" : isVoiceChat ? "Stop voice chat" : `Voice notes${(voiceNotes.length + sharedVoiceNotes.length) ? ` · ${voiceNotes.length + sharedVoiceNotes.length}` : ""} — Cmd+Shift+. to record`}
                      onClick={() => setVoiceNotesModalOpen(v => !v)}
                      style={{
                        flex: 1, height: 32, borderRadius: 7, cursor: "pointer",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        transition: "all 0.15s", position: "relative",
                        border: isRecordingNote ? "1px solid #f87171" : isVoiceChat ? `1px solid ${colors.accent}` : "1px solid rgba(255,255,255,0.12)",
                        background: isRecordingNote ? "rgba(248,113,113,0.18)" : isVoiceChat ? colors.accent + "22" : "rgba(255,255,255,0.05)",
                        color: isRecordingNote ? "#f87171" : isVoiceChat ? colors.accent : "rgba(255,255,255,0.7)",
                        animation: (isRecordingNote || isVoiceChat) ? "pulse 1.2s ease-in-out infinite" : "none",
                      }}
                      onMouseEnter={e => { if (!isRecordingNote && !isVoiceChat) { e.currentTarget.style.background = colors.sidebarActive; e.currentTarget.style.color = "rgba(255,255,255,1)"; }}}
                      onMouseLeave={e => { if (!isRecordingNote && !isVoiceChat) { e.currentTarget.style.background = "rgba(255,255,255,0.05)"; e.currentTarget.style.color = "rgba(255,255,255,0.7)"; }}}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="9" y="2" width="6" height="11" rx="3"/>
                        <path d="M5 10a7 7 0 0 0 14 0"/>
                        <line x1="12" y1="19" x2="12" y2="22"/>
                        <line x1="9" y1="22" x2="15" y2="22"/>
                      </svg>
                      {voiceNotes.length > 0 && !isRecordingNote && !isVoiceChat && (
                        <span style={{ position: "absolute", top: 3, right: 3, width: 13, height: 13, borderRadius: "50%", background: colors.accent, color: "#fff", fontSize: 8, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1 }}>
                          {(voiceNotes.length + sharedVoiceNotes.length) > 9 ? "9+" : (voiceNotes.length + sharedVoiceNotes.length)}
                        </span>
                      )}
                    </button>
                    {/* Browser panel button */}
                    <button
                      title="Open browser"
                      onClick={() => setBrowserPanelOpen(o => !o)}
                      style={{ flex: 1, height: 32, border: `1px solid ${browserPanelOpen ? colors.accent : "rgba(255,255,255,0.12)"}`, borderRadius: 7, background: browserPanelOpen ? colors.accent + "22" : "rgba(255,255,255,0.05)", color: browserPanelOpen ? colors.accent : "rgba(255,255,255,0.7)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.15s", position: "relative" }}
                      onMouseEnter={e => { if (!browserPanelOpen) { e.currentTarget.style.background = colors.sidebarActive; e.currentTarget.style.color = colors.white; } }}
                      onMouseLeave={e => { if (!browserPanelOpen) { e.currentTarget.style.background = "rgba(255,255,255,0.05)"; e.currentTarget.style.color = "rgba(255,255,255,0.7)"; } }}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a4 4 0 0 1-4-4V6"/>
                        <path d="M2 13.5V18a2 2 0 0 0 4 0V2"/>
                        <line x1="8" y1="7" x2="16" y2="7"/>
                        <line x1="8" y1="11" x2="14" y2="11"/>
                      </svg>
                      {browserPanelBadge > 0 && (
                        <span style={{ position: "absolute", top: 3, right: 3, width: 14, height: 14, borderRadius: "50%", background: colors.accent, color: "#fff", fontSize: 9, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1 }}>
                          {browserPanelBadge}
                        </span>
                      )}
                    </button>
                    {/* File / screenshot — click to browse, drag to drop */}
                    <button
                      title="Attach image or PDF"
                      onClick={() => claudeFileInputRef.current?.click()}
                      onDragEnter={e => { e.preventDefault(); setClaudeDragOver(true); }}
                      onDragOver={e => { e.preventDefault(); setClaudeDragOver(true); }}
                      onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setClaudeDragOver(false); }}
                      onDrop={e => {
                        e.preventDefault(); setClaudeDragOver(false);
                        // Check for email attachment drag first
                        if (window._pendingAttachmentDrag) {
                          // Guard against double-fire (two overlapping drop targets)
                          if (window._claudeAttachFetching) return;
                          window._claudeAttachFetching = true;

                          const { att, messageId } = window._pendingAttachmentDrag;
                          window._pendingAttachmentDrag = null;
                          if (window.electronAPI?.gmailFetchAttachment) {
                            const mimeType = att.mimeType || "application/octet-stream";
                            const kind = mimeType.startsWith("image/") ? "image" : "pdf";
                            if (kind !== "image" && mimeType !== "application/pdf") {
                              notify("Claude can read images and PDFs only.", "warning");
                              window._claudeAttachFetching = false;
                              return;
                            }
                            window.electronAPI.gmailFetchAttachment(messageId, att.attachmentId)
                              .then(r => {
                                setClaudeDragOver(false);
                                if (r.ok) {
                                  setClaudeAttachment({ filename: att.filename, base64: r.base64, mediaType: mimeType, kind });
                                  setClaudePanelOpen(true);
                                } else {
                                  const retryMatch = (r.error || "").match(/Retry after ([^\s]+)/);
                                  if (retryMatch) {
                                    const retryTime = new Date(retryMatch[1]).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" });
                                    notify(`Gmail rate limit — try again after ${retryTime}`, "warning", 8000);
                                  } else {
                                    notify("Could not load attachment: " + r.error, "danger");
                                  }
                                }
                              })
                              .catch(err => { console.error("[Claude drop] fetch error", err); setClaudeDragOver(false); })
                              .finally(() => { window._claudeAttachFetching = false; });
                          } else {
                            window._claudeAttachFetching = false;
                          }
                          return;
                        }
                        const f = e.dataTransfer.files?.[0]; if (f) readClaudeFile(f);
                      }}
                      style={{ flex: 1, height: 32, border: `1px solid ${claudeDragOver ? colors.accent : "rgba(255,255,255,0.12)"}`, borderRadius: 7, background: claudeDragOver ? colors.accent + "33" : "rgba(255,255,255,0.05)", color: claudeDragOver ? colors.accent : "rgba(255,255,255,0.7)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.15s" }}
                      onMouseEnter={e => { if (!claudeAttachment && !claudeDragOver) { e.currentTarget.style.background = colors.sidebarActive; e.currentTarget.style.color = colors.white; } }}
                      onMouseLeave={e => { if (!claudeAttachment && !claudeDragOver) { e.currentTarget.style.background = "rgba(255,255,255,0.05)"; e.currentTarget.style.color = "rgba(255,255,255,0.7)"; } }}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ pointerEvents: "none" }}>
                        <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66L9.41 17.41a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
                      </svg>
                    </button>
                    {/* Text — toggles the floating chat panel */}
                    <button
                      title="Type to Claude"
                      onClick={() => { setClaudePanelOpen(o => !o); setTimeout(() => claudeInputRef.current?.focus(), 50); }}
                      style={{ flex: 1, height: 32, border: `1px solid ${claudePanelOpen ? colors.accent : "rgba(255,255,255,0.12)"}`, borderRadius: 7, background: claudePanelOpen ? colors.accent + "22" : "rgba(255,255,255,0.05)", color: claudePanelOpen ? colors.accent : "rgba(255,255,255,0.7)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.15s" }}
                      onMouseEnter={e => { if (!claudePanelOpen) { e.currentTarget.style.background = colors.sidebarActive; e.currentTarget.style.color = colors.white; } }}
                      onMouseLeave={e => { if (!claudePanelOpen) { e.currentTarget.style.background = "rgba(255,255,255,0.05)"; e.currentTarget.style.color = "rgba(255,255,255,0.7)"; } }}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                      </svg>
                    </button>
                  </div>
                  {/* Token / budget bar */}
                  {(() => {
                    const monthKey = new Date().toISOString().slice(0, 7);
                    const monthSpend = (tokenUsage[monthKey]?.costUSD) || 0;
                    const pct = claudeBudget > 0 ? Math.min(1, monthSpend / claudeBudget) : 0;
                    const remaining = Math.max(0, claudeBudget - monthSpend);
                    const barColor = pct > 0.85 ? colors.danger : colors.accent;
                    const fmtCost = (c) => c < 0.005 ? "$0.00" : `$${c.toFixed(2)}`;
                    return (
                      <div style={{ marginTop: 8 }}>
                        {/* Bar */}
                        <div style={{ height: 3, borderRadius: 2, background: "rgba(255,255,255,0.1)", overflow: "hidden", marginBottom: 5 }}>
                          <div style={{ height: "100%", width: `${(1 - pct) * 100}%`, background: barColor, borderRadius: 2, transition: "width 0.4s ease, background 0.4s ease" }} />
                        </div>
                        {/* Labels */}
                        <div style={{ display: "flex", justifyContent: "space-between" }}>
                          <span
                            title={`Session: ${fmtCost(sessionTokens.costUSD)} · Month: ${fmtCost(monthSpend)} of $${claudeBudget.toFixed(2)} budget`}
                            style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", cursor: "default", letterSpacing: "0.02em" }}
                          >
                            {fmtCost(remaining)} left
                          </span>
                          <span style={{ fontSize: 10, color: "rgba(255,255,255,0.2)", cursor: "default", letterSpacing: "0.02em" }}>
                            {new Date().toLocaleString("default", { month: "short" })}
                          </span>
                        </div>
                      </div>
                    );
                  })()}
                </div>
                {/* ── End Claude Panel ───────────────────────── */}

                {/* ── Claude floating chat panel ─────────────── */}
                {claudePanelOpen && (
                  <div style={{ position: "fixed", left: claudePanelPos.x, top: claudePanelPos.y, width: claudePanelSize.w, height: claudePanelSize.h, background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, boxShadow: "0 8px 40px rgba(0,0,0,0.18)", display: "flex", flexDirection: "column", zIndex: 9990, overflow: "hidden", userSelect: claudePanelDragRef.current || claudePanelResizeRef.current ? "none" : "auto" }}>
                    {/* 8 resize handles */}
                    {[
                      { h: "n",  style: { top: 0, left: 8, right: 8, height: 5, cursor: "n-resize" } },
                      { h: "s",  style: { bottom: 0, left: 8, right: 8, height: 5, cursor: "s-resize" } },
                      { h: "w",  style: { left: 0, top: 8, bottom: 8, width: 5, cursor: "w-resize" } },
                      { h: "e",  style: { right: 0, top: 8, bottom: 8, width: 5, cursor: "e-resize" } },
                      { h: "nw", style: { top: 0, left: 0, width: 10, height: 10, cursor: "nw-resize" } },
                      { h: "ne", style: { top: 0, right: 0, width: 10, height: 10, cursor: "ne-resize" } },
                      { h: "sw", style: { bottom: 0, left: 0, width: 10, height: 10, cursor: "sw-resize" } },
                      { h: "se", style: { bottom: 0, right: 0, width: 10, height: 10, cursor: "se-resize" } },
                    ].map(({ h, style }) => (
                      <div key={h} style={{ position: "absolute", zIndex: 10, ...style }}
                        onMouseDown={e => {
                          e.preventDefault();
                          claudePanelResizeRef.current = { handle: h, startMouseX: e.clientX, startMouseY: e.clientY, startX: claudePanelPos.x, startY: claudePanelPos.y, startW: claudePanelSize.w, startH: claudePanelSize.h };
                        }}
                      />
                    ))}
                    {/* Header — drag target */}
                    <div
                      onMouseDown={e => {
                        e.preventDefault();
                        claudePanelDragRef.current = { startMouseX: e.clientX, startMouseY: e.clientY, startX: claudePanelPos.x, startY: claudePanelPos.y };
                      }}
                      style={{ padding: "12px 16px", background: colors.sidebar, display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0, position: "relative", cursor: "grab" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 11, fontWeight: 700, color: colors.accent, letterSpacing: "0.08em", textTransform: "uppercase" }}>Claude</span>
                        <span style={{ fontSize: 11, color: "rgba(255,255,255,0.35)" }}>· {page}</span>
                        {claudeMemory.length > 0 && (
                          <span title={`${claudeMemory.length} remembered fact${claudeMemory.length !== 1 ? "s" : ""}`} style={{ fontSize: 10, color: colors.accent, opacity: 0.7 }}>
                            ✦{claudeMemory.length}
                          </span>
                        )}
                        {/* Model toggle — lightbulb: dim=Haiku, bright=Sonnet manual, amber=Sonnet auto */}
                        {(() => {
                          const isSonnet = claudeModel === "claude-sonnet-4-6";
                          const isAuto = claudeAutoSonnet && !isSonnet;
                          const color = isSonnet ? colors.accent : isAuto ? "#F59E0B" : "rgba(255,255,255,0.25)";
                          const tip = isSonnet
                            ? "Sonnet (manual) — click to switch to Haiku"
                            : isAuto
                              ? "Auto-upgraded to Sonnet for this request — reverts to Haiku after"
                              : "Haiku — click to switch to Sonnet";
                          return (
                            <button
                              onClick={() => { const m = isSonnet ? "claude-haiku-4-5-20251001" : "claude-sonnet-4-6"; setClaudeModel(m); try { localStorage.setItem("mt-claude-model", m); } catch(e) {} }}
                              title={tip}
                              style={{ background: "none", border: "none", cursor: "pointer", padding: "0 2px", color, display: "inline-flex", alignItems: "center", transition: "color 0.2s" }}
                              onMouseEnter={e => e.currentTarget.style.opacity = "0.75"}
                              onMouseLeave={e => e.currentTarget.style.opacity = "1"}
                            >
                              <Lightbulb size={13} fill={isSonnet || isAuto ? "currentColor" : "none"} />
                            </button>
                          );
                        })()}
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        {/* Remember button */}
                        <button
                          onClick={() => { setClaudeRememberOpen(o => !o); setClaudeRememberInput(""); }}
                          title="Remember something"
                          style={{ background: "none", border: "none", cursor: "pointer", color: claudeRememberOpen ? colors.accent : "rgba(255,255,255,0.35)", fontSize: 11, fontFamily: "inherit", padding: "0 2px" }}
                          onMouseEnter={e => { if (!claudeRememberOpen) e.currentTarget.style.color = colors.white; }}
                          onMouseLeave={e => { if (!claudeRememberOpen) e.currentTarget.style.color = "rgba(255,255,255,0.35)"; }}
                        >remember</button>
                        {claudeMessages.length > 0 && (
                          <button onClick={() => { setClaudeMessages([]); setClaudeAttachment(null); }}
                            title="Clear conversation"
                            style={{ background: "none", border: "none", cursor: "pointer", color: "rgba(255,255,255,0.35)", fontSize: 11, fontFamily: "inherit", padding: "0 2px" }}
                            onMouseEnter={e => e.currentTarget.style.color = colors.white}
                            onMouseLeave={e => e.currentTarget.style.color = "rgba(255,255,255,0.35)"}
                          >clear</button>
                        )}
                        <button onClick={() => { setClaudePanelOpen(false); setClaudeRememberOpen(false); try { localStorage.setItem("mt-claude-panel-pos", JSON.stringify(claudePanelPos)); localStorage.setItem("mt-claude-panel-size", JSON.stringify(claudePanelSize)); } catch {} }}
                          style={{ background: "none", border: "none", cursor: "pointer", color: "rgba(255,255,255,0.4)", fontSize: 18, lineHeight: 1, padding: "0 2px", fontFamily: "inherit" }}
                          onMouseEnter={e => e.currentTarget.style.color = colors.white}
                          onMouseLeave={e => e.currentTarget.style.color = "rgba(255,255,255,0.4)"}
                        >×</button>
                      </div>
                      {/* Remember popover */}
                      {claudeRememberOpen && (
                        <div style={{ position: "absolute", top: "100%", left: 0, right: 0, background: colors.sidebar, borderTop: `1px solid rgba(255,255,255,0.08)`, padding: "10px 14px", zIndex: 1 }}>
                          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", marginBottom: 6 }}>
                            Add a fact for Claude to remember across all sessions:
                          </div>
                          <div style={{ display: "flex", gap: 6 }}>
                            <input
                              autoFocus
                              value={claudeRememberInput}
                              onChange={e => setClaudeRememberInput(e.target.value)}
                              onKeyDown={e => {
                                if (e.key === "Enter" && claudeRememberInput.trim()) {
                                  const updated = [...claudeMemory, claudeRememberInput.trim()];
                                  setClaudeMemory(updated);
                                  try { localStorage.setItem(STORAGE_KEYS.claudeMemory, JSON.stringify(updated)); } catch(err) {}
                                  setClaudeRememberInput("");
                                  setClaudeRememberOpen(false);
                                }
                                if (e.key === "Escape") setClaudeRememberOpen(false);
                              }}
                              placeholder="e.g. Jamie's mum prefers contact by text"
                              style={{ flex: 1, padding: "6px 10px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.15)", background: "rgba(255,255,255,0.08)", color: colors.white, fontSize: 12, fontFamily: "inherit", outline: "none" }}
                            />
                            <button
                              onClick={() => {
                                if (claudeRememberInput.trim()) {
                                  const updated = [...claudeMemory, claudeRememberInput.trim()];
                                  setClaudeMemory(updated);
                                  try { localStorage.setItem(STORAGE_KEYS.claudeMemory, JSON.stringify(updated)); } catch(err) {}
                                  setClaudeRememberInput("");
                                  setClaudeRememberOpen(false);
                                }
                              }}
                              style={{ padding: "6px 12px", borderRadius: 6, border: "none", background: colors.accent, color: colors.white, fontSize: 12, fontFamily: "inherit", cursor: "pointer", flexShrink: 0 }}
                            >Save</button>
                          </div>
                          {/* Existing memories */}
                          {claudeMemory.length > 0 && (
                            <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
                              {claudeMemory.map((m, i) => (
                                <div key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                  <span style={{ flex: 1, fontSize: 11, color: "rgba(255,255,255,0.6)", lineHeight: 1.4 }}>✦ {m}</span>
                                  <button
                                    onClick={() => {
                                      const updated = claudeMemory.filter((_, idx) => idx !== i);
                                      setClaudeMemory(updated);
                                      try { localStorage.setItem(STORAGE_KEYS.claudeMemory, JSON.stringify(updated)); } catch(err) {}
                                    }}
                                    style={{ background: "none", border: "none", cursor: "pointer", color: "rgba(255,255,255,0.3)", fontSize: 14, lineHeight: 1, padding: "0 2px", flexShrink: 0 }}
                                    onMouseEnter={e => e.currentTarget.style.color = colors.danger}
                                    onMouseLeave={e => e.currentTarget.style.color = "rgba(255,255,255,0.3)"}
                                  >×</button>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                    {/* Messages */}
                    <div style={{ flex: 1, overflowY: "auto", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
                      {claudeMessages.length === 0 && !claudeAttachment && (
                        <div style={{ margin: "auto", textAlign: "center", color: colors.textMuted, fontSize: 13, lineHeight: 1.6, padding: "0 12px" }}>
                          <div style={{ fontSize: 22, marginBottom: 8 }}>✦</div>
                          Ask me anything about your schedule, students, or timetable. You can also drop in an image or PDF.
                        </div>
                      )}
                      {claudeMessages.map((m, i) => (
                        <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: m.role === "user" ? "flex-end" : "flex-start" }}>
                          <div style={{ maxWidth: "85%", padding: "8px 12px", borderRadius: m.role === "user" ? "12px 12px 3px 12px" : "12px 12px 12px 3px", background: m.role === "user" ? colors.accent : colors.bg, color: m.role === "user" ? colors.white : colors.text, fontSize: 13, lineHeight: 1.55, border: m.role === "assistant" ? `1px solid ${colors.border}` : "none", whiteSpace: "pre-wrap" }}>
                            {typeof m.content === "string" && m.content.includes("__SCAN_REVIEW__")
                              ? <>
                                  {m.content.replace("__SCAN_REVIEW__", "").trimEnd()}
                                  <button
                                    onClick={() => { setPage("calendar"); setClaudePanelOpen(false); }}
                                    style={{ display: "block", marginTop: 10, padding: "6px 14px", background: colors.accent, color: colors.white, border: "none", borderRadius: 6, fontSize: 12, fontFamily: "inherit", cursor: "pointer", fontWeight: 600 }}
                                  >Review &amp; Import →</button>
                                </>
                              : (m.displayText || (typeof m.content === "string" ? m.content : ""))
                            }
                          </div>
                        </div>
                      ))}
                      {claudeLoading && (
                        <div style={{ display: "flex", alignItems: "flex-start" }}>
                          <div style={{ padding: "8px 14px", borderRadius: "12px 12px 12px 3px", background: colors.bg, border: `1px solid ${colors.border}`, fontSize: 18, letterSpacing: 3 }}>
                            <span style={{ animation: "mmm-flash 1s infinite" }}>···</span>
                          </div>
                        </div>
                      )}
                      <div ref={claudeMessagesEndRef} />
                    </div>
                    {/* Attachment preview */}
                    {claudeAttachment && (
                      <div style={{ padding: "8px 12px", borderTop: `1px solid ${colors.border}`, background: colors.accentLight, display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                        {claudeAttachment.kind === "image"
                          ? <img src={`data:${claudeAttachment.mediaType};base64,${claudeAttachment.base64}`} alt="attachment" style={{ width: 36, height: 36, objectFit: "cover", borderRadius: 5, flexShrink: 0, border: `1px solid ${colors.border}` }} />
                          : <div style={{ width: 36, height: 36, borderRadius: 5, background: colors.accent, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                            </div>
                        }
                        <span style={{ flex: 1, fontSize: 12, color: colors.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{claudeAttachment.filename}</span>
                        <button onClick={() => setClaudeAttachment(null)} style={{ background: "none", border: "none", cursor: "pointer", color: colors.textMuted, fontSize: 16, lineHeight: 1, padding: "0 2px", flexShrink: 0 }}
                          onMouseEnter={e => e.currentTarget.style.color = colors.danger}
                          onMouseLeave={e => e.currentTarget.style.color = colors.textMuted}
                        >×</button>
                      </div>
                    )}
                    {/* Input row */}
                    <div style={{ padding: "10px 12px", borderTop: `1px solid ${colors.border}`, display: "flex", gap: 8, flexShrink: 0, background: colors.white }}>
                      <textarea
                        ref={claudeInputRef}
                        value={claudeInput}
                        onChange={e => { if (!claudeLoading) setClaudeInput(e.target.value); }}
                        onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
                        onPaste={e => {
                          if (claudeLoading) return;
                          const items = e.clipboardData?.items;
                          if (!items) return;
                          for (const item of items) {
                            if (item.type.startsWith("image/")) {
                              e.preventDefault();
                              const file = item.getAsFile();
                              if (file) readClaudeFile(file);
                              return;
                            }
                          }
                        }}
                        placeholder={claudeLoading ? "Waiting for Claude…" : claudeAttachment ? "Add a message, or just send…" : "Ask Claude… (Enter to send, Shift+Enter for newline, paste images)"}
                        rows={2}
                        autoCorrect="off" spellCheck={false}
                        style={{ flex: 1, resize: "none", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, padding: "7px 10px", fontSize: 13, fontFamily: "inherit", outline: "none", lineHeight: 1.4, color: claudeLoading ? colors.textMuted : colors.text, background: claudeLoading ? colors.bg : colors.inputBg, cursor: claudeLoading ? "not-allowed" : "text" }}
                      />
                      <button
                        onClick={sendMessage}
                        disabled={!canSend}
                        style={{ width: 34, height: 34, alignSelf: "flex-end", border: "none", borderRadius: 8, background: canSend ? colors.accent : colors.border, color: colors.white, cursor: canSend ? "pointer" : "not-allowed", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, transition: "background 0.15s" }}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
                        </svg>
                      </button>
                    </div>
                  </div>
                )}
                {/* ── End Claude floating chat panel ─────────── */}
              </>
            );
          })()}
          {/* Clock */}
          <div style={{ textAlign: "center", marginBottom: 6, userSelect: "none" }}>
            <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 43, fontWeight: 700, color: "rgba(255,255,255,0.65)", letterSpacing: 2, lineHeight: 1 }}>
              {clockTime}
            </div>
          </div>
          {/* Day + term week */}
          {(() => {
            const now = melbourneNow();
            const dayName = now.toLocaleDateString("en-AU", { weekday: "long", timeZone: TIMEZONE });
            const todayStr = toLocalDateStr(now);
            const termBreaks = interruptions.filter(i => i.type === "term_break")
              .reduce((acc, i) => { if (!acc.find(x => x.date === i.date)) acc.push(i); return acc; }, [])
              .sort((a, b) => a.date.localeCompare(b.date));
            // After 6pm Friday, show next week's number so the weekend feels like "week ahead"
            const dow = now.getDay(); // 0=Sun,1=Mon,...5=Fri,6=Sat
            const hour = now.getHours();
            const rollToNextWeek = (dow === 5 && hour >= 18) || dow === 6 || dow === 0;
            const displayDate = rollToNextWeek ? (() => {
              const next = new Date(now);
              next.setDate(now.getDate() + (8 - (dow === 0 ? 7 : dow))); // next Monday
              return toLocalDateStr(next);
            })() : todayStr;
            const weekNum = computeTermWeekNum(displayDate, termBreaks);
            const holidayBreak = termBreaks.find(tb => displayDate >= tb.date && displayDate <= (tb.endDate || tb.date));
            const holidayWeekLabel = holidayBreak ? (() => {
              const breakStart = new Date(holidayBreak.date + "T00:00:00");
              const dow2 = breakStart.getDay();
              const firstMonday = new Date(breakStart);
              firstMonday.setDate(breakStart.getDate() + (dow2 === 1 ? 0 : dow2 === 0 ? 1 : 8 - dow2));
              const curMonday = _getMondayOf(new Date(displayDate + "T00:00:00"));
              const wkNum = Math.max(1, Math.round((curMonday - firstMonday) / (7 * 24 * 60 * 60 * 1000)) + 1);
              return `Holidays Week ${wkNum}`;
            })() : null;
            return (
              <div style={{ textAlign: "center", marginBottom: 10, userSelect: "none" }}>
                <span style={{ fontSize: 12, color: colors.accent, letterSpacing: "0.02em", opacity: 0.85 }}>
                  {dayName}{holidayWeekLabel ? ` · ${holidayWeekLabel}` : weekNum ? ` · Week ${weekNum}` : ""}
                </span>
              </div>
            );
          })()}
          {/* Version / update / toast button — toasts absorb into this button */}
          {(() => {
            const isToast    = !!notification;
            const toastColor = isToast ? TOAST_COLORS[notification.type] || TOAST_COLORS.success : null;
            const isUpdate   = !isToast && updateInfo && updateInfo.available;
            const bgColor    = isToast ? toastColor : isUpdate ? colors.accent : "transparent";
            const textColor  = isToast || isUpdate ? colors.white : colors.textLight;
            const borderColor = isToast ? toastColor : isUpdate ? colors.accent : "rgba(255,255,255,0.15)";
            return (
              <button
                onClick={() => {
                  if (isToast) return; // toasts are non-interactive
                  if (updateInfo && updateInfo.ready) {
                    if (window.electronAPI && window.electronAPI.installUpdate) {
                      window.electronAPI.installUpdate();
                    }
                  } else if (updateInfo && updateInfo.available) {
                    // already downloading, do nothing
                  } else {
                    if (window.electronAPI && window.electronAPI.checkForUpdates) {
                      window.electronAPI.checkForUpdates();
                    } else {
                      setNoUpdateFlash(true);
                      setTimeout(() => setNoUpdateFlash(false), 2500);
                    }
                  }
                }}
                style={{
                  width: "100%", padding: "7px",
                  background: bgColor,
                  color: textColor,
                  border: `1px solid ${borderColor}`,
                  borderRadius: 8, fontSize: 12,
                  cursor: isToast ? "default" : "pointer",
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                  transition: "background 0.25s, border-color 0.25s, color 0.15s",
                  fontFamily: "inherit", flexDirection: "column", overflow: "hidden"
                }}
                title={isToast ? "" : updateInfo && updateInfo.ready ? "Click to install and restart" : updateInfo && updateInfo.available ? "Downloading..." : "Check for updates"}
              >
                <span style={{ display: "flex", alignItems: "center", gap: 6, overflow: "hidden", maxWidth: "100%", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
                  {isToast
                    ? notification.msg
                    : updateInfo && updateInfo.ready
                      ? "⬆ Restart to update"
                      : updateInfo && updateInfo.available
                        ? "⬇ Downloading..."
                        : noUpdateFlash
                          ? "✓ No new updates"
                          : `v${APP_VERSION}`}
                </span>
                {updateProgress !== null && !isToast && (
                  <div style={{ width: "100%", height: 3, background: "rgba(255,255,255,0.2)", borderRadius: 2, marginTop: 4, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: updateProgress + "%", background: updateInfo && updateInfo.ready ? "#4ade80" : colors.white, borderRadius: 2, transition: "width 0.3s" }} />
                  </div>
                )}
              </button>
            );
          })()}
        </div>
      </div>

      {/* Main Content */}
      <div ref={mainScrollRef} data-printarea="true" style={{ flex: 1, overflow: "auto", position: "relative" }}
        onMouseEnter={e => { if (!hoveredScrollRef.current) hoveredScrollRef.current = e.currentTarget; }}
        onMouseLeave={e => { if (hoveredScrollRef.current === e.currentTarget) hoveredScrollRef.current = null; }}>
        {showExportDialog && (
          <ExportDialog
            lessons={timetable?.lessons || []}
            students={students}
            schools={schools}
            teachers={teachers}
            teacherCoverage={teacherCoverage}
            enrolments={enrolments}
            laneOverrides={laneOverrides}
            contacts={contacts}
            specialists={specialists}
            availableWeeks={showExportDialog.availableWeeks}
            initialType={showExportDialog.initialType}
            onClose={() => setShowExportDialog(null)}
            notify={notify}
            documents={documents}
            setDocuments={setDocuments}
          />
        )}

        <div style={{ padding: "28px 36px", maxWidth: 1200 }}>
          <div style={{ display: page === "dashboard" ? undefined : "none" }}>
          <Dashboard schools={schools} students={students} enrolments={enrolments} catchups={catchups} teachers={teachers} teacherCoverage={teacherCoverage} specialists={specialists} interruptions={interruptions} setInterruptions={setInterruptions} groups={groups} timetable={timetable} weeklyTimetables={weeklyTimetables} setWeeklyTimetables={setWeeklyTimetables} masterBreaks={masterBreaks} contacts={contacts} bands={bands} resources={resources} setResources={setResources} documents={documents} setDocuments={setDocuments} onNavigate={setPage} setStudentsViewState={setStudentsViewState} setNewStudentPrefill={setNewStudentPrefill} setAddParentPrefill={setAddParentPrefill} setNewContactPrefill={setNewContactPrefill} setSharedSchool={setSharedSchool} errorLog={errorLog} logError={logError} goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} onRestore={handleRestore} onBackup={handleBackup} notify={notify} recordUsage={recordUsage} hoveredScrollRef={hoveredScrollRef} emailNavRef={emailNavRef} emailListRef={emailListRef} filteredEmailsRef={filteredEmailsRef} todoUndoRef={todoUndoRef} autoSendQueue={autoSendQueue} setAutoSendQueue={setAutoSendQueue} autoSendTimerRef={autoSendTimerRef} autoSendActiveRef={autoSendActiveRef} setDashBadges={setDashBadges} onViewStudent={(studentId) => { setFocusStudentId(studentId); setFocusReturnPage("dashboard"); setPage("students"); }} onNewEmail={() => playSound("email-receive.mp3")} quickAddTodoTrigger={quickAddTodoTrigger} quickAddReminderTrigger={quickAddReminderTrigger} emailStyle={emailStyle} />
          </div>
          {page === "schools" && <SchoolsManager schools={schools} setSchools={setSchools} notify={notify} resetKey={resetKey} viewState={schoolsViewState} setViewState={setSchoolsViewState} goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}
          {page === "specialists" && <SpecialistManager specialists={specialists} setSpecialists={setSpecialists} schools={schools} notify={notify} resetKey={resetKey} viewState={specialistsViewState} setViewState={setSpecialistsViewState} goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}
          {page === "calendar" && <CalendarManager interruptions={interruptions} setInterruptions={setInterruptions} schools={schools} specialists={specialists} notify={notify} resetKey={resetKey} viewState={interruptionsViewState} setViewState={setInterruptionsViewState} goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}
          {page === "students" && <StudentsManager students={students} setStudents={setStudents} enrolments={enrolments} setEnrolments={setEnrolments} schools={schools} teachers={teachers} specialists={specialists} timetable={timetable} teacherCoverage={teacherCoverage} notify={notify} focusStudentId={focusStudentId} onClearFocus={() => setFocusStudentId(null)} returnPage={focusReturnPage} onReturn={() => { if (focusReturnPage) { setPage(focusReturnPage); setFocusReturnPage(null); } }} resetKey={resetKey} viewState={studentsViewState} setViewState={setStudentsViewState} newStudentPrefill={newStudentPrefill} onClearNewStudentPrefill={() => setNewStudentPrefill(null)} addParentPrefill={addParentPrefill} onClearAddParentPrefill={() => setAddParentPrefill(null)} goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} onAddMemory={onAddMemory} onArchiveStudent={(id) => {
              // Timetable cleanup only — student status is set by StudentsManager directly
              if (timetable) setTimetable(prev => ({ ...prev, lessons: (prev.lessons || []).filter(l => l.studentId !== id), unscheduled: (prev.unscheduled || []).filter(u => u.student?.id !== id) }));
              setWeeklyTimetables(prev => {
                const next = { ...prev };
                for (const key of Object.keys(next)) {
                  const entry = next[key];
                  if (!entry) continue;
                  next[key] = { ...entry, lessons: (entry.lessons || []).filter(l => l.studentId !== id) };
                }
                return next;
              });
            }} onDeleteStudent={(id) => {
              // Same timetable cleanup as archive — student record is fully removed
              if (timetable) setTimetable(prev => ({ ...prev, lessons: (prev.lessons || []).filter(l => l.studentId !== id), unscheduled: (prev.unscheduled || []).filter(u => u.student?.id !== id) }));
              setWeeklyTimetables(prev => {
                const next = { ...prev };
                for (const key of Object.keys(next)) {
                  const entry = next[key];
                  if (!entry) continue;
                  next[key] = { ...entry, lessons: (entry.lessons || []).filter(l => l.studentId !== id) };
                }
                return next;
              });
            }} onEndEnrolment={(enrolmentId) => {
              // Clear MTT + WTT cards stamped with this enrolmentId. Per Spec §17,
              // post-migration cards carry enrolmentId; the five WTT creation sites
              // deferred to Commit 4 may still produce enrolmentId:undefined cards,
              // which this filter won't clear — expected until Commit 4 stamps them.
              if (timetable) {
                setTimetable(prev => ({
                  ...prev,
                  lessons: (prev.lessons || []).filter(l => l.enrolmentId !== enrolmentId),
                  unscheduled: (prev.unscheduled || []).filter(u => u.enrolmentId !== enrolmentId),
                }));
              }
              setWeeklyTimetables(prev => {
                const next = { ...prev };
                for (const key of Object.keys(next)) {
                  const entry = next[key];
                  if (!entry) continue;
                  next[key] = {
                    ...entry,
                    lessons: (entry.lessons || []).filter(l => l.enrolmentId !== enrolmentId),
                    missed:  (entry.missed  || []).filter(m => m.enrolmentId !== enrolmentId),
                  };
                }
                return next;
              });
            }} />}
          {page === "teachers" && <TeachersManager teachers={teachers} setTeachers={setTeachers} schools={schools} notify={notify} resetKey={resetKey} viewState={teachersViewState} setViewState={setTeachersViewState} goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} onAddMemory={onAddMemory} />}
          {page === "pending" && <PendingManager students={students} setStudents={setStudents} schools={schools} timetable={timetable} interruptions={interruptions} weeklyTimetables={weeklyTimetables} setWeeklyTimetables={setWeeklyTimetables} enrolments={enrolments} onSchedulePending={handleSchedulePending} onViewStudent={(studentId) => { setFocusStudentId(studentId); setFocusReturnPage("pending"); setPage("students"); }} onManualSchedule={handleManualSchedule} notify={notify} goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}
          {page === "groups-bands" && (
            <div>
              <PageTitle
                pageColor={PAGE_COLORS.groups}
                navButtons={<NavButtons goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}
                action={groupsBandsTab === "groups"
                  ? <button onClick={() => setTriggerNewGroup(n => n + 1)} style={{ padding: "0 16px", height: 36, background: colors.accent, color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>+ New Group</button>
                  : <button onClick={() => setTriggerNewBand(n => n + 1)} style={{ padding: "0 16px", height: 36, background: colors.accent, color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>+ New Band</button>
                }>
                Groups &amp; Bands
              </PageTitle>
              {/* D&R-style toggle — below banner */}
              <div style={{ display: "flex", gap: 0, background: colors.bg, border: "2px solid " + colors.sidebarHover, borderRadius: 10, overflow: "hidden", alignSelf: "flex-start", marginBottom: 16 }}>
                {[{ id: "groups", label: "Groups" }, { id: "bands", label: "Bands" }].map(tab => (
                  <button key={tab.id} onClick={() => setGroupsBandsTab(tab.id)}
                    style={{ flex: 1, width: 120, padding: "8px 0", border: "none", fontSize: 13, fontFamily: "inherit", cursor: "pointer", fontWeight: 600, background: groupsBandsTab === tab.id ? colors.sidebarHover : "transparent", color: groupsBandsTab === tab.id ? colors.white : colors.textMuted, transition: "background 0.15s, color 0.15s" }}>
                    {tab.label}
                  </button>
                ))}
              </div>
              {groupsBandsTab === "groups" && <GroupsManager groups={groups} setGroups={setGroups} students={activeStudents} enrolments={enrolments} schools={schools} teachers={teachers} timetable={timetable} onRevertGroup={handleRevertGroup} onAddGroupToMaster={handleAddGroupToMaster} notify={notify} focusGroupId={focusGroupId} onClearFocusGroup={() => setFocusGroupId(null)} onReturn={() => { if (focusGroupReturnPage) { setPage(focusGroupReturnPage); setFocusGroupReturnPage(null); } }} onViewStudent={(studentId) => { setFocusStudentId(studentId); setFocusReturnPage("groups-bands"); setPage("students"); }} viewState={groupsViewState} setViewState={setGroupsViewState} goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} hideTitle={true} triggerNew={triggerNewGroup} />}
              {groupsBandsTab === "bands" && <BandsManager bands={bands} setBands={setBands} schools={schools} students={students} enrolments={enrolments} teachers={teachers} resources={resources} notify={notify} goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} hideTitle={true} triggerNew={triggerNewBand} onCompose={({ band, link }) => { const emails = [...new Set((band.members || []).map(m => students.find(s => s.id === m.studentId)).filter(Boolean).flatMap(s => (s.parents || []).filter(p => p.email).map(p => p.email)))]; setComposeEmail({ to: emails, subject: (band.name || "Band") + " \u2014 " + (link.label || link.category), body: "Hi,\n\nHere is a link for " + (band.name || "the band") + ":\n" + link.url }); }} />}
            </div>
          )}
          {page === "timetable" && <TimetableView mainScrollRef={mainScrollRef} timetable={timetable} schools={schools} students={activeStudents} allStudents={students} enrolments={enrolments} setEnrolments={setEnrolments} teachers={teachers} setTeachers={setTeachers} teacherCoverage={teacherCoverage} viewedLanes={viewedLanes} onSwitchLane={handleSwitchLane} onAddStaff={handleAddStaff} onRemoveStaff={handleRemoveStaff} specialists={specialists} pendingStudents={pendingStudents} masterBreaks={masterBreaks} setMasterBreaks={setMasterBreaks} bands={bands} viewState={ttViewState} setViewState={setTtViewState} sharedSchool={sharedSchool} setSharedSchool={setSharedSchool} sharedTimetableScroll={sharedTimetableScroll} setSharedTimetableScroll={setSharedTimetableScroll} onExport={handleExport} onPrint={() => printMasterTimetable(timetable, schools, students, teachers)} onGenerate={handleGenerateTimetable} onGenerateSchool={handleGenerateSchool} onClearSchool={handleClearSchool} contacts={contacts} onWarningsChange={(w, a) => { setTtConstraintWarnings(w); setTtAckedConstraints(a); }} initialConstraintWarnings={ttConstraintWarnings} initialAckedConstraints={ttAckedConstraints} onClear={() => { setTimetable(null); setGroups(prev => prev.map(g => g.status === "scheduled" ? { ...g, status: "forming" } : g)); }} onSchedulePending={handleSchedulePending} onMoveLesson={(lessonId, newDay, newTime) => {
            // Spec 2 cluster 10b Commit 2 — viewedLanes-aware destination + modal flow.
            // Q1=α MTT cross-teacher: modal confirms enrolment update; on confirm
            // push undo + setEnrolments/setGroups + commit. Same-teacher moves
            // stamp bucket_id with destination lane and skip the modal.
            const lesson = timetable?.lessons.find(l => l.id === lessonId);
            if (!lesson) return;
            const school = schools.find(s => s.id === lesson.schoolId);
            if (!school) return;
            const slot = school.slots.find(s => s.start === newTime);
            if (!slot) return;
            const destLane = getDayLaneTeacher(teacherCoverage, teachers, lesson.schoolId, newDay, null, null, viewedLanes);
            if (!destLane || !destLane.lane || !destLane.teacher) {
              notify(`No covering lane for ${school.name} on ${newDay}.`, "warning");
              return;
            }
            // Path B fallback — legacy cards without resolvable currentTid skip
            // the cross-teacher modal but still get destination bucket_id stamped.
            // Cluster 12a: stamped lesson.teacherId fallback removed; lane resolution only.
            const currentTid = getCardTeacherId(lesson, teacherCoverage) || "";
            const destBucketId = destLane.lane.id;
            let pendingEnrolmentMutation = null;
            let pendingGroupsMutation = null;
            let isReassign = false;
            if (currentTid && destLane.teacher.id !== currentTid) {
              const currentTeacherName = teachers.find(t => t.id === currentTid)?.name || "(unassigned)";
              const destTeacherName = destLane.teacher.name;
              let modalText;
              if (lesson.isGroup) {
                const groupName = lesson.groupName || lesson.studentName || "(group)";
                modalText = `Reassign ${groupName} from ${currentTeacherName} to ${destTeacherName}?\n\nThis updates the group's teacher as well as placing this card.`;
                pendingGroupsMutation = (prev) => prev.map(g => g.id === lesson.groupId ? { ...g, teacherId: destLane.teacher.id } : g);
              } else {
                const studentName = lesson.studentName || students.find(s => s.id === lesson.studentId)?.name || "(student)";
                modalText = `Reassign ${studentName} from ${currentTeacherName} to ${destTeacherName}?\n\nThis updates ${studentName}'s enrolment to ${destTeacherName} as well as placing this card.`;
                const enrolId = lesson.enrolmentId || enrolmentIdFor(lesson.studentId, lesson.instrument, enrolments, lesson.groupId);
                pendingEnrolmentMutation = (prev) => prev.map(e => e.id === enrolId ? { ...e, teacherId: destLane.teacher.id } : e);
              }
              if (!window.confirm(modalText)) return;
              isReassign = true;
            }
            if (isReassign) {
              pendingPlaceUndoStack.current.push({
                seq: ++ttPageActionSeq.current,
                timetable: JSON.parse(JSON.stringify(timetable)),
                students: JSON.parse(JSON.stringify(students)),
                enrolments: JSON.parse(JSON.stringify(enrolments)),
                groups: JSON.parse(JSON.stringify(groups)),
              });
              pendingPlaceRedoStack.current = [];
              if (pendingPlaceUndoStack.current.length > 50) pendingPlaceUndoStack.current.shift();
              if (pendingEnrolmentMutation) setEnrolments(pendingEnrolmentMutation);
              if (pendingGroupsMutation) setGroups(pendingGroupsMutation);
            }
            setTimetable(prev => {
              if (!prev) return prev;
              // Recalculate duringSpecialist for new position
              const student = students.find(s => s.id === lesson.studentId);
              const className = student?.className || "";
              let newDuringSpec = false;
              if (className && slot.type === "class") {
                for (const sp of specialists) {
                  if (sp.schoolId === lesson.schoolId && sp.className === className && sp.day === newDay) {
                    const spS = timeToMin(sp.start), spE = timeToMin(sp.end);
                    const slS = timeToMin(slot.start), slE = timeToMin(slot.end);
                    if (slS < spE && slE > spS) { newDuringSpec = sp.subject; break; }
                  }
                }
              }
              return { ...prev, lessons: prev.lessons.map(l => l.id === lessonId ? { ...l, day: newDay, start: slot.start, end: slot.end, slotId: slot.id, slotName: slot.name, duringSpecialist: newDuringSpec, bucket_id: destBucketId, _pinned: false } : l) };
            });
          }} onDeleteLesson={(lessonId) => {
            setTimetable(prev => {
              if (!prev) return prev;
              const lesson = prev.lessons.find(l => l.id === lessonId);
              if (!lesson) return prev;
              const student = students.find(s => s.id === lesson.studentId);
              const isPending = student && (student.status === "pending" || student.status === "trial");
              const newLessons = prev.lessons.filter(l => l.id !== lessonId);
              if (isPending) {
                // Pending student — just remove the lesson, they stay on waiting list
                return { ...prev, lessons: newLessons };
              } else {
                // Active student — add to unscheduled so they can be re-placed
                const instName = lesson.instrument || (student ? instrumentsFromEnrolments(student.id, enrolments)[0]?.name : "") || "";
                const alreadyUnscheduled = prev.unscheduled.some(u => u.student.id === lesson.studentId && (u.instrument || "") === instName);
                const newUnscheduled = alreadyUnscheduled ? prev.unscheduled : [
                  ...prev.unscheduled,
                  { student: student || { id: lesson.studentId, name: lesson.studentName, schoolId: lesson.schoolId, instruments: [] }, instrument: instName, reason: "Manually removed" }
                ];
                return { ...prev, lessons: newLessons, unscheduled: newUnscheduled };
              }
            });
          }} onReturnToPending={(lessonId) => {
            const lesson = timetable?.lessons.find(l => l.id === lessonId);
            setTimetable(prev => {
              if (!prev) return prev;
              return { ...prev, lessons: prev.lessons.filter(l => l.id !== lessonId) };
            });
            if (lesson?.studentId) {
              setStudents(prev => prev.map(s => s.id === lesson.studentId ? { ...s, status: "pending" } : s));
            }
          }} onViewStudent={(studentId) => {
            setFocusStudentId(studentId);
            setFocusReturnPage("timetable");
            setPage("students");
          }} onViewGroup={(groupId) => {
            setFocusGroupId(groupId);
            setFocusGroupReturnPage("timetable");
            setGroupsBandsTab("groups");
            setPage("groups-bands");
          }} onPlaceUnsched={(data, day, time) => {
            // Spec 2 cluster 10b Commit 2 — viewedLanes-aware destination + modal flow.
            // Push undo only on the reassign-confirmed branch (per spec rule).
            const parts = data.split(":");
            if (parts.length < 3) return;
            const studentId = parts[1];
            const instrumentName = parts.slice(2).join(":");
            const student = students.find(s => s.id === studentId);
            if (!student) return;
            const school = schools.find(s => s.id === student.schoolId);
            if (!school) return;
            const slot = school.slots.find(s => s.start === time);
            if (!slot) return;
            const studentInsts = instrumentsFromEnrolments(student.id, enrolments);
            const inst = studentInsts.find(i => i.name === instrumentName) || studentInsts[0];
            if (!inst) return;
            const destLane = getDayLaneTeacher(teacherCoverage, teachers, school.id, day, null, null, viewedLanes);
            if (!destLane || !destLane.lane || !destLane.teacher) {
              notify(`No covering lane for ${school.name} on ${day}.`, "warning");
              return;
            }
            let currentTeacher = null;
            if (inst.teacherId) currentTeacher = teachers.find(t => t.id === inst.teacherId);
            if (!currentTeacher) currentTeacher = teachers.find(t => t.instruments.some(ti => ti.name === inst.name) && t.availability.some(a => a.schoolId === school.id && a.day === day));
            const currentTid = currentTeacher?.id || "";
            // Modal-or-stamp branch (MTT, Q1=α). Push + enrolment mutation only on reassign confirm.
            let pendingEnrolmentMutation = null;
            let isReassign = false;
            if (currentTid && destLane.teacher.id !== currentTid) {
              const modalText = `Reassign ${student.name} from ${currentTeacher.name} to ${destLane.teacher.name}?\n\nThis updates ${student.name}'s enrolment to ${destLane.teacher.name} as well as placing this card.`;
              if (!window.confirm(modalText)) return;
              const enrolId = enrolmentIdFor(student.id, inst.name, enrolments);
              pendingEnrolmentMutation = (prev) => prev.map(e => e.id === enrolId ? { ...e, teacherId: destLane.teacher.id } : e);
              isReassign = true;
            } else if (!currentTid) {
              const modalText = `Assign ${student.name} to ${destLane.teacher.name}?\n\nThis sets ${student.name}'s enrolment to ${destLane.teacher.name} as well as placing this card.`;
              if (!window.confirm(modalText)) return;
              const enrolId = enrolmentIdFor(student.id, inst.name, enrolments);
              pendingEnrolmentMutation = (prev) => prev.map(e => e.id === enrolId ? { ...e, teacherId: destLane.teacher.id } : e);
              isReassign = true;
            }
            const lesson = {
              id: uid(), studentId: student.id, studentName: student.name,
              bucket_id: destLane.lane.id,
              schoolId: school.id, schoolName: school.name,
              day, slotId: slot.id, slotName: slot.name,
              start: slot.start, end: slot.end,
              instrument: inst.name, duringSpecialist: false,
              enrolmentId: enrolmentIdFor(student.id, inst.name, enrolments)
            };
            if (isReassign) {
              pendingPlaceUndoStack.current.push({
                seq: ++ttPageActionSeq.current,
                timetable: JSON.parse(JSON.stringify(timetable)),
                students: JSON.parse(JSON.stringify(students)),
                enrolments: JSON.parse(JSON.stringify(enrolments)),
                groups: JSON.parse(JSON.stringify(groups)),
              });
              pendingPlaceRedoStack.current = [];
              if (pendingPlaceUndoStack.current.length > 50) pendingPlaceUndoStack.current.shift();
              if (pendingEnrolmentMutation) setEnrolments(pendingEnrolmentMutation);
            }
            setTimetable(prev => ({
              ...prev,
              lessons: [...prev.lessons, lesson],
              unscheduled: prev.unscheduled.filter(u => !(u.student.id === studentId && (u.instrument || instrumentsFromEnrolments(u.student.id, enrolments)[0]?.name) === instrumentName))
            }));
          }} onPlacePending={(data, day, time) => {
            // Spec 2 cluster 10b Commit 2 — viewedLanes-aware destination + modal flow.
            // Pending placements still snapshot unconditionally (preserving pre-10b
            // undoable behaviour); snapshot shape now includes enrolments + groups so
            // cross-teacher reassigns from this path are reversible.
            const parts = data.split(":");
            if (parts.length < 3) return;
            const studentId = parts[1];
            const instrumentName = parts.slice(2).join(":");
            const student = students.find(s => s.id === studentId);
            if (!student) return;
            const school = schools.find(s => s.id === student.schoolId);
            if (!school) return;
            const slot = school.slots.find(s => s.start === time);
            if (!slot) return;
            const studentInsts = instrumentsFromEnrolments(student.id, enrolments);
            const inst = studentInsts.find(i => i.name === instrumentName) || studentInsts[0];
            if (!inst) return;
            const destLane = getDayLaneTeacher(teacherCoverage, teachers, school.id, day, null, null, viewedLanes);
            if (!destLane || !destLane.lane || !destLane.teacher) {
              notify(`No covering lane for ${school.name} on ${day}.`, "warning");
              return;
            }
            // Current teacher resolution mirrors the pre-10b chain.
            let currentTeacher = null;
            if (inst.teacherId) currentTeacher = teachers.find(t => t.id === inst.teacherId);
            if (!currentTeacher) currentTeacher = teachers.find(t => t.instruments.some(ti => ti.name === inst.name) && t.availability.some(a => a.schoolId === school.id && a.day === day));
            const currentTid = currentTeacher?.id || "";
            // Modal-or-stamp branch (MTT, Q1=α — enrolment update on cross-teacher).
            let pendingEnrolmentMutation = null;
            if (currentTid && destLane.teacher.id !== currentTid) {
              const modalText = `Reassign ${student.name} from ${currentTeacher.name} to ${destLane.teacher.name}?\n\nThis updates ${student.name}'s enrolment to ${destLane.teacher.name} as well as placing this card.`;
              if (!window.confirm(modalText)) return;
              const enrolId = enrolmentIdFor(student.id, inst.name, enrolments);
              pendingEnrolmentMutation = (prev) => prev.map(e => e.id === enrolId ? { ...e, teacherId: destLane.teacher.id } : e);
            } else if (!currentTid) {
              const modalText = `Assign ${student.name} to ${destLane.teacher.name}?\n\nThis sets ${student.name}'s enrolment to ${destLane.teacher.name} as well as placing this card.`;
              if (!window.confirm(modalText)) return;
              const enrolId = enrolmentIdFor(student.id, inst.name, enrolments);
              pendingEnrolmentMutation = (prev) => prev.map(e => e.id === enrolId ? { ...e, teacherId: destLane.teacher.id } : e);
            }
            const lesson = {
              id: uid(), studentId: student.id, studentName: student.name,
              bucket_id: destLane.lane.id,
              schoolId: school.id, schoolName: school.name,
              day, slotId: slot.id, slotName: slot.name,
              start: slot.start, end: slot.end,
              instrument: inst.name, duringSpecialist: false,
              enrolmentId: enrolmentIdFor(student.id, inst.name, enrolments)
            };
            // Snapshot all relevant state before mutating — order: push, then mutate.
            pendingPlaceUndoStack.current.push({
              seq: ++ttPageActionSeq.current,
              timetable: JSON.parse(JSON.stringify(timetable)),
              students: JSON.parse(JSON.stringify(students)),
              enrolments: JSON.parse(JSON.stringify(enrolments)),
              groups: JSON.parse(JSON.stringify(groups)),
            });
            pendingPlaceRedoStack.current = [];
            if (pendingPlaceUndoStack.current.length > 50) pendingPlaceUndoStack.current.shift();
            if (pendingEnrolmentMutation) setEnrolments(pendingEnrolmentMutation);
            setTimetableRaw(prev => ({
              ...(prev || { unscheduled: [] }),
              lessons: [...((prev || { lessons: [] }).lessons), lesson],
              unscheduled: (prev || { unscheduled: [] }).unscheduled,
            }));
            setStudents(prev => prev.map(s => s.id === studentId ? { ...s, status: "active" } : s));
          }} onUndo={undoTimetablePage} onRedo={redoTimetablePage} undoCount={ttPageUndoCount()} redoCount={ttPageRedoCount()} onDismissUnscheduled={(studentId, instrument) => {
              setTimetable(prev => ({
                ...prev,
                unscheduled: (prev.unscheduled || []).filter(u => !(u.student?.id === studentId && (u.instrument || (u.student?.id ? instrumentsFromEnrolments(u.student.id, enrolments)[0]?.name : undefined)) === instrument))
              }));
            }} goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} onAddMemory={onAddMemory} onSoundPlay={() => playUISound("drag_snap")} onLoadVersion={(schoolId, lessons) => {
            setTimetable(prev => {
              if (!prev) return prev;
              return {
                ...prev,
                lessons: [...prev.lessons.filter(l => l.schoolId !== schoolId), ...stampEnrolmentIds(lessons, enrolments)],
                unscheduled: (prev.unscheduled || []).filter(u => u.student.schoolId !== schoolId)
              };
            });
          }} />}
          {page === "weekly" && <WeeklyAdjustments mainScrollRef={mainScrollRef} timetable={timetable} schools={schools} students={students} setStudents={setStudents} enrolments={enrolments} setEnrolments={setEnrolments} teachers={teachers} setTeachers={setTeachers} teacherCoverage={teacherCoverage} laneOverrides={laneOverrides} catchups={catchups} setCatchups={setCatchups} onSetLaneOverride={handleSetLaneOverride} onClearLaneOverride={handleClearLaneOverride} viewedLanes={viewedLanes} onSwitchLane={handleSwitchLane} specialists={specialists} interruptions={interruptions} groups={groups} bands={bands} weeklyTimetables={weeklyTimetables} setWeeklyTimetables={setWeeklyTimetables} teacherActuals={teacherActuals} tallyEntries={tallyEntries} setTallyEntries={setTallyEntries} masterBreaks={masterBreaks} notify={notify} contacts={contacts} viewState={weeklyViewState} setViewState={setWeeklyViewState} sharedSchool={sharedSchool} setSharedSchool={setSharedSchool} sharedTimetableScroll={sharedTimetableScroll} setSharedTimetableScroll={setSharedTimetableScroll} onViewStudent={(studentId) => { setFocusStudentId(studentId); setFocusReturnPage("weekly"); setPage("students"); }} onViewGroup={(groupId) => { setFocusGroupId(groupId); setFocusGroupReturnPage("weekly"); setGroupsBandsTab("groups"); setPage("groups-bands"); }} logError={logError} onExport={handleExport} onUndo={undoWeekly} onRedo={redoWeekly} undoCount={weeklyUndoStack.current.length} redoCount={weeklyRedoStack.current.length} ackedConstraints={weeklyAckedConstraints} setAckedConstraints={setWeeklyAckedConstraints} onWarningsChange={(w) => setWeeklyConstraintWarnings(w)} goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} onAddMemory={onAddMemory} onSoundPlay={() => playUISound("drag_snap")} />}
          {page === "tally" && <TallyView timetable={timetable} schools={schools} students={students} enrolments={enrolments} setEnrolments={setEnrolments} teachers={teachers} interruptions={interruptions} weeklyTimetables={weeklyTimetables} setWeeklyTimetables={setWeeklyTimetables} catchups={catchups} groups={groups} notify={notify} onExport={handleExport} viewState={tallyViewState} setViewState={setTallyViewState} goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} onViewStudent={(studentId) => { setFocusStudentId(studentId); setFocusReturnPage("tally"); setPage("students"); }} />}
          {page === "contacts" && <ContactsManager contacts={contacts} setContacts={setContacts} schools={schools} students={students} enrolments={enrolments} setStudents={setStudents} teachers={teachers} specialists={specialists} notify={notify} resetKey={resetKey} newContactPrefill={newContactPrefill} onClearNewContactPrefill={() => setNewContactPrefill(null)} viewState={contactsViewState} setViewState={setContactsViewState} onViewStudent={(studentId) => { setFocusStudentId(studentId); setFocusReturnPage("contacts"); setPage("students"); }} goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}
          {page === "resources" && <DocumentsResourcesManager resources={resources} setResources={setResources} documents={documents} setDocuments={setDocuments} schools={schools} teachers={teachers} notify={notify} resetKey={resetKey} viewState={resourcesViewState} setViewState={setResourcesViewState} goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}
          <div style={{ display: page === "messages" ? "block" : "none", height: "100%" }}>
            <MessagesView
              teachers={teachers}
              notify={notify}
              soundSettings={soundSettings}
              messengerDisplayName={messengerDisplayName}
              messengerBubbleColour={messengerBubbleColour}
              onPlaySound={playSound}
              onUnreadCountChange={setMessageBadgeCount}
              isActive={page === "messages"}
              goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory}
            />
          </div>
          {page === "settings" && <SettingsManager
            apiKey={apiKey} setApiKey={setApiKey}
            schools={schools} students={students}
            enrolments={enrolments}
            teachers={teachers} specialists={specialists}
            interruptions={interruptions} setInterruptions={setInterruptions} groups={groups} timetable={timetable}
            weeklyTimetables={weeklyTimetables}
            contacts={contacts} bands={bands} masterBreaks={masterBreaks} resources={resources} documents={documents}
            onRestore={handleRestore} onBackup={handleBackup} notify={notify} resetKey={resetKey}
            updateInfo={updateInfo} noUpdateFlash={noUpdateFlash} setNoUpdateFlash={setNoUpdateFlash}
            updateProgress={updateProgress} APP_VERSION={APP_VERSION}
            viewState={settingsViewState} setViewState={setSettingsViewState}
            goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory}
            claudeBudget={claudeBudget} setClaudeBudget={setClaudeBudget} tokenUsage={tokenUsage}
            claudePersonalContext={claudePersonalContext} setClaudePersonalContext={setClaudePersonalContext}
                                  emailStyle={emailStyle} setEmailStyle={v => { setEmailStyle(v); try { localStorage.setItem("mt-email-style", v); } catch {} }}
            claudeMemory={claudeMemory} setClaudeMemory={setClaudeMemory}
            darkMode={darkMode} toggleDarkMode={toggleDarkMode}
            soundSettings={soundSettings} setSoundSettings={setSoundSettings}
            onPreviewSound={previewSound}
            contextTriggers={contextTriggers} setContextTriggers={setContextTriggers}
            messengerDisplayName={messengerDisplayName}
            setMessengerDisplayName={v => { setMessengerDisplayName(v); try { localStorage.setItem("mt-messenger-name", v); } catch {} supabase.from("app_settings").upsert({ key: "messenger_name", value: v }, { onConflict: "key" }).then(() => {}); }}
            messengerBubbleColour={messengerBubbleColour}
            setMessengerBubbleColour={v => { setMessengerBubbleColour(v); try { localStorage.setItem("mt-messenger-colour", v); } catch {} supabase.from("app_settings").upsert({ key: "messenger_colour", value: v }, { onConflict: "key" }).then(() => {}); }}
            orphanedLessons={orphanedLessons}
            onGoToOrphanStudent={(studentId) => { if (!studentId) return; setFocusStudentId(studentId); setFocusReturnPage("settings"); setPage("students"); }}
            onDeleteOrphanedLesson={(orphan) => {
              // Session 97.1: delete a single orphaned lesson from either the
              // master timetable or a specific weekly timetable, identified
              // by `where`. Sync effects will push the deletion to Supabase.
              if (!orphan || !orphan.lessonId) return;
              if (orphan.where === "master") {
                setTimetableRaw(prev => {
                  if (!prev || !prev.lessons) return prev;
                  return { ...prev, lessons: prev.lessons.filter(l => l.id !== orphan.lessonId) };
                });
              } else {
                setWeeklyTimetablesRaw(prev => {
                  const entry = prev[orphan.where];
                  if (!entry || !entry.lessons) return prev;
                  return { ...prev, [orphan.where]: { ...entry, lessons: entry.lessons.filter(l => l.id !== orphan.lessonId) } };
                });
              }
            }}
          />}
          {page === "invoicing" && <InvoicingManager
            students={students} enrolments={enrolments} schools={schools} groups={groups} timetable={timetable}
            weeklyTimetables={weeklyTimetables} catchups={catchups} interruptions={interruptions}
            notify={notify}
            goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory}
          />}
        </div>
      </div>
    </div>

      {/* ── Browser panel ─────────────────────────────────────────── */}
      {browserPanelOpen && (
        <BrowserPanel
          schools={schools}
          interruptions={interruptions} setInterruptions={setInterruptions}
          setContacts={setContacts}
          notify={notify}
          onSendToClaude={(text) => {
            setClaudeInput(text);
            setClaudePanelOpen(true);
            setTimeout(() => claudeInputRef.current?.focus(), 50);
          }}
          onSendToReminders={(text) => {
            const entry = { id: uid(), text: text.trim(), createdAt: new Date().toISOString() };
            try {
              const existing = JSON.parse(localStorage.getItem("mt-reminders") || "[]");
              localStorage.setItem("mt-reminders", JSON.stringify([entry, ...existing]));
              window.dispatchEvent(new CustomEvent("mt-reminders-updated"));
            } catch {}
            notify("Added to Reminders");
          }}
          onClose={() => setBrowserPanelOpen(false)}
          onBadgeClear={clearNewsletterBadge}
        />
      )}

      {/* ── Pulse animation for recording state ── */}
      <style>{`@keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.55; } } @keyframes waveBar { from { transform: scaleY(0.3); } to { transform: scaleY(1); } }`}</style>

      {/* ── Voice Notes Modal ──────────────────────────────────── */}
      {voiceNotesModalOpen && (
        <div style={{ position: "fixed", inset: 0, zIndex: 9990, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={() => { setVoiceNotesModalOpen(false); setClearVoiceNotesConfirm(false); setEditingNoteId(null); }}>
          <div style={{ background: colors.cardBg, borderRadius: 14, boxShadow: "0 8px 40px rgba(0,0,0,0.25)", width: 520, maxWidth: "92vw", maxHeight: "80vh", display: "flex", flexDirection: "column", overflow: "hidden" }}
            onClick={e => e.stopPropagation()}>

            {/* Header */}
            <div style={{ padding: "16px 20px 12px", borderBottom: `1px solid ${colors.border}`, display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={colors.accent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="2" width="6" height="11" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="9" y1="22" x2="15" y2="22"/>
                </svg>
                <span style={{ fontWeight: 700, fontSize: 15, color: colors.text }}>Voice Notes</span>
                {voiceNotes.length > 0 && <span style={{ fontSize: 12, color: colors.textMuted, background: colors.bg, borderRadius: 10, padding: "2px 8px" }}>{voiceNotes.length}</span>}
              </div>
              <button onClick={() => { setVoiceNotesModalOpen(false); setClearVoiceNotesConfirm(false); setEditingNoteId(null); }}
                style={{ background: "none", border: "none", cursor: "pointer", color: colors.textMuted, lineHeight: 1, padding: 4, borderRadius: 6, display: "flex", alignItems: "center" }}
                onMouseEnter={e => e.currentTarget.style.color = colors.text} onMouseLeave={e => e.currentTarget.style.color = colors.textMuted}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>

            {/* Notes list */}
            <div style={{ flex: 1, overflowY: "auto", padding: "12px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
              {voiceNotes.length === 0 && sharedVoiceNotes.length === 0 ? (
                <div style={{ textAlign: "center", padding: "40px 20px", color: colors.textMuted }}>
                  <div style={{ fontSize: 32, marginBottom: 10 }}>🎙️</div>
                  <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6, color: colors.text }}>No voice notes yet</div>
                  <div style={{ fontSize: 12 }}>Use <strong>Cmd+Shift+.</strong> to record a note</div>
                </div>
              ) : (() => {
                const localWithFlag  = voiceNotes.map(n => ({ ...n, _isLocal: true }));
                const sharedWithFlag = sharedVoiceNotes.map(n => ({ ...n, _isShared: true, createdAt: n.created_at }));
                const allNotes = [...localWithFlag, ...sharedWithFlag]
                  .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
                return allNotes.map(note => {
                  const time = new Date(note.createdAt).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit", hour12: true });
                  const date = new Date(note.createdAt).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" });
                  const isEditing = editingNoteId === note.id;
                  return (
                    <div key={note.id} style={{ background: colors.bg, border: `1px solid ${note._isShared ? (note.teacher_colour || colors.accent) : colors.border}`, borderRadius: 10, padding: "11px 14px" }}>
                      {note._isShared && (
                        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
                          <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: note.teacher_colour || "#888", flexShrink: 0 }} />
                          <span style={{ fontSize: 11, fontWeight: 700, color: note.teacher_colour || colors.textMuted }}>{note.teacher_name || "Teacher"}</span>
                          <span style={{ fontSize: 10, color: colors.textMuted, background: colors.cardBg, borderRadius: 8, padding: "1px 7px", marginLeft: 2 }}>Shared note</span>
                        </div>
                      )}
                      <div style={{ fontSize: 11, color: colors.textMuted, marginBottom: 7, display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontWeight: 600 }}>{time}</span>
                        <span>·</span>
                        <span>{date}</span>
                        {note.audioDataUrl && <span style={{ marginLeft: "auto", fontSize: 10, color: colors.accent, fontWeight: 600 }}>● Audio</span>}
                      </div>
                      {!note._isShared && isEditing ? (
                        <textarea autoFocus value={editingNoteText} onChange={e => setEditingNoteText(e.target.value)}
                          onBlur={() => { setVoiceNotes(prev => prev.map(n => n.id === note.id ? { ...n, transcript: editingNoteText } : n)); setEditingNoteId(null); }}
                          onKeyDown={e => {
                            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); setVoiceNotes(prev => prev.map(n => n.id === note.id ? { ...n, transcript: editingNoteText } : n)); setEditingNoteId(null); }
                            if (e.key === "Escape") setEditingNoteId(null);
                          }}
                          style={{ width: "100%", minHeight: 60, padding: "6px 8px", border: `1px solid ${colors.accent}`, borderRadius: 7, fontSize: 13, fontFamily: "inherit", resize: "vertical", color: colors.text, background: colors.cardBg, outline: "none", boxSizing: "border-box", lineHeight: 1.5 }} />
                      ) : (
                        <div onClick={() => { if (!note._isShared) { setEditingNoteId(note.id); setEditingNoteText(note.transcript || ""); } }} title={note._isShared ? undefined : "Click to edit"}
                          style={{ fontSize: 13, color: note.transcript ? colors.text : colors.textMuted, lineHeight: 1.55, cursor: note._isShared ? "default" : "text", minHeight: 24, fontStyle: note.transcript ? "normal" : "italic" }}>
                          {note.transcript || "No transcript — click to add text"}
                        </div>
                      )}
                      <div style={{ display: "flex", gap: 6, marginTop: 10, alignItems: "center" }}>
                        {note.audioDataUrl ? (
                          <button onClick={() => {
                            if (playingNoteId === note.id) return;
                            const a = new Audio(note.audioDataUrl);
                            setPlayingNoteId(note.id);
                            a.onended = () => setPlayingNoteId(null);
                            a.onerror = () => setPlayingNoteId(null);
                            a.play();
                          }} title={playingNoteId === note.id ? "Playing…" : "Play recording"}
                            style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 10px", border: `1px solid ${playingNoteId === note.id ? colors.accent : colors.border}`, borderRadius: 6, background: playingNoteId === note.id ? colors.accentLight : colors.cardBg, color: playingNoteId === note.id ? colors.accent : colors.textMuted, fontSize: 12, cursor: playingNoteId === note.id ? "default" : "pointer", fontFamily: "inherit", minWidth: 64 }}
                            onMouseEnter={e => { if (playingNoteId !== note.id) { e.currentTarget.style.borderColor = colors.accent; e.currentTarget.style.color = colors.accent; }}}
                            onMouseLeave={e => { if (playingNoteId !== note.id) { e.currentTarget.style.borderColor = colors.border; e.currentTarget.style.color = colors.textMuted; }}}>
                            {playingNoteId === note.id ? (
                              // Animated waveform bars
                              <span style={{ display: "inline-flex", alignItems: "center", gap: 2, height: 14 }}>
                                {[0,1,2,3,4].map(i => (
                                  <span key={i} style={{
                                    display: "inline-block", width: 3, borderRadius: 2,
                                    background: colors.accent,
                                    animation: `waveBar 0.8s ease-in-out ${i * 0.12}s infinite alternate`,
                                    height: [6,10,14,10,6][i],
                                  }} />
                                ))}
                              </span>
                            ) : (
                              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                            )}
                            {playingNoteId === note.id ? "Playing" : "Play"}
                          </button>
                        ) : (
                          <span style={{ fontSize: 11, color: colors.textMuted, fontStyle: "italic" }}>No audio (new session)</span>
                        )}
                        <div style={{ flex: 1 }} />
                        <button onClick={() => sendVoiceNotesToClaude([note])} title="Send to Claude"
                          style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "4px 10px", border: `1px solid ${colors.border}`, borderRadius: 6, background: colors.cardBg, color: colors.textMuted, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}
                          onMouseEnter={e => { e.currentTarget.style.borderColor = colors.sidebarActive; e.currentTarget.style.color = colors.sidebarActive; }}
                          onMouseLeave={e => { e.currentTarget.style.borderColor = colors.border; e.currentTarget.style.color = colors.textMuted; }}>
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> Send
                        </button>
                        <button
                          onClick={async () => {
                            if (note._isShared) {
                              await supabase.from("voice_notes").delete().eq("id", note.id);
                              setSharedVoiceNotes(prev => prev.filter(n => n.id !== note.id));
                            } else {
                              setVoiceNotes(prev => prev.filter(n => n.id !== note.id));
                            }
                          }}
                          title="Delete note"
                          style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 28, height: 28, border: `1px solid ${colors.border}`, borderRadius: 6, background: "none", color: colors.textMuted, cursor: "pointer" }}
                          onMouseEnter={e => { e.currentTarget.style.borderColor = colors.danger; e.currentTarget.style.color = colors.danger; e.currentTarget.style.background = colors.redLight; }}
                          onMouseLeave={e => { e.currentTarget.style.borderColor = colors.border; e.currentTarget.style.color = colors.textMuted; e.currentTarget.style.background = "none"; }}>
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
                        </button>
                      </div>
                    </div>
                  );
                });
              })()}
            </div>

            {/* Footer — always visible, matches teacher panel layout */}
            <div style={{ padding: "12px 16px", borderTop: `1px solid ${colors.border}`, display: "flex", gap: 8, alignItems: "center", flexShrink: 0, background: colors.bg }}>
              <button
                onClick={() => { if (isRecordingRef.current || isVoiceChatRef.current) stopVoiceRecording(); else startVoiceRecording("note"); }}
                style={{
                  flex: 1, padding: "8px 14px",
                  border: `1px solid ${(isRecordingNote || isVoiceChat) ? "#F87171" : colors.border}`,
                  borderRadius: 8,
                  background: (isRecordingNote || isVoiceChat) ? "rgba(248,113,113,0.18)" : colors.cardBg,
                  color: (isRecordingNote || isVoiceChat) ? "#F87171" : colors.text,
                  fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                  transition: "all 0.15s",
                  animation: (isRecordingNote || isVoiceChat) ? "pulse 1.2s ease-in-out infinite" : "none",
                }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill={(isRecordingNote || isVoiceChat) ? "#F87171" : "none"} stroke={(isRecordingNote || isVoiceChat) ? "#F87171" : "currentColor"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="2" width="6" height="11" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="9" y1="22" x2="15" y2="22"/>
                </svg>
                {(isRecordingNote || isVoiceChat) ? "Stop recording…" : "Record new note"}
              </button>
              {(voiceNotes.length > 0 || sharedVoiceNotes.length > 0) && !clearVoiceNotesConfirm && (
                <button onClick={() => setClearVoiceNotesConfirm(true)}
                  style={{ padding: "8px 14px", border: `1px solid ${colors.border}`, borderRadius: 8, background: "none", color: colors.textMuted, fontSize: 13, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = colors.danger; e.currentTarget.style.color = colors.danger; e.currentTarget.style.background = colors.redLight; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = colors.border; e.currentTarget.style.color = colors.textMuted; e.currentTarget.style.background = "none"; }}>
                  Clear all
                </button>
              )}
              {clearVoiceNotesConfirm && (
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <span style={{ fontSize: 12, color: colors.textMuted, whiteSpace: "nowrap" }}>Delete all?</span>
                  <button onClick={() => { setVoiceNotes([]); setClearVoiceNotesConfirm(false); }}
                    style={{ padding: "6px 12px", border: "none", borderRadius: 7, background: colors.danger, color: "#fff", fontSize: 12, cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}>Yes</button>
                  <button onClick={() => setClearVoiceNotesConfirm(false)}
                    style={{ padding: "6px 12px", border: `1px solid ${colors.border}`, borderRadius: 7, background: "none", fontSize: 12, cursor: "pointer", fontFamily: "inherit", color: colors.textMuted }}>Cancel</button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

  </ThemeProvider>
  );
}
