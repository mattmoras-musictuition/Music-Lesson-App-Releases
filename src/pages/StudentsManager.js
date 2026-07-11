// ============================================================
// STUDENTSMANAGER — extracted from App.js
// ============================================================

import React, { useState, useEffect, useRef, useMemo } from "react";
import { GraduationCap, StickyNote, AlertTriangle, Users, Trash2, Check, X, Plus, ClipboardList, ChevronUp, ChevronDown, Archive, RotateCcw, ChevronRight } from "lucide-react";
import { instruments_colors, ANTHROPIC_MODEL } from "../constants";
import { useTheme } from "../context/ThemeContext";
import { uid, getInstColor, getInitials, openCompose, getStudentMTTTeacher, buildStudentMTTTeacherIndex } from "../utils/helpers";
import { activeEnrolmentsFor } from "../utils/enrolmentsDB";
import { anthropicFetch, getAnthropicHeaders, getPapa, getXLSX } from "../utils/api";
import { parseStudentCSV } from "../data/parsers";
import { Card, PageTitle, NavButtons, Btn, Input, Tag, EmptyState, FileUpload, Checkbox, PAGE_COLORS } from "../components/ui/SharedUI";

export function StudentsManager({ students, setStudents, enrolments, setEnrolments, schools, teachers, specialists, timetable, teacherCoverage = [], notify, focusStudentId, onClearFocus, returnPage, onReturn, resetKey, viewState, setViewState, newStudentPrefill, onClearNewStudentPrefill, addParentPrefill, onClearAddParentPrefill, goBack, goForward, historyCursor, pageHistory, onAddMemory, onArchiveStudent, onDeleteStudent, onEndEnrolment, groupsView, groupsCount = 0, onAddGroup, focusGroupId, initialTabRequest, onClearTabRequest, waitingListSlot }) {
  const { colors } = useTheme();

  // Individuals | Groups segmented toggle — local to this page, not persisted.
  // Fresh visits land on Individuals; a group focus (focusGroupId) or an
  // explicit request (initialTabRequest) lands on Groups instead.
  const [studentTab, setStudentTab] = useState(() =>
    (focusGroupId || initialTabRequest === "groups") ? "groups" : "individuals"
  );
  useEffect(() => { if (focusStudentId) setStudentTab("individuals"); }, [focusStudentId]);
  useEffect(() => { if (focusGroupId) setStudentTab("groups"); }, [focusGroupId]);
  useEffect(() => {
    if (initialTabRequest) { setStudentTab(initialTabRequest); if (onClearTabRequest) onClearTabRequest(); }
  }, [initialTabRequest]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Enrolment helpers (Commit 2b) ────────────────────────────
  // activeEnrolmentsFor lifted to src/utils/enrolmentsDB.js — see import above.

  // All enrolments (active + ended) for a student.
  function allEnrolmentsFor(studentId, enrolments) {
    return (enrolments || []).filter(e => e.studentId === studentId);
  }

  // Primary enrolment for display/sort — first active by startDate.
  function primaryEnrolmentFor(studentId, enrolments) {
    const active = activeEnrolmentsFor(studentId, enrolments);
    if (active.length === 0) return null;
    return active.slice().sort((a, b) =>
      (a.startDate || "").localeCompare(b.startDate || "")
    )[0];
  }

  // Derive available instruments from what teachers can actually teach
  const availableInstruments = [...new Set(teachers.flatMap(t => t.instruments.map(i => i.name)))].sort();

  // Session 3 / C2 — pre-scheduling teacher reads derive teacher from the
  // student's current MTT placement (lane) rather than an enrolment stamp.
  const mttTeacherIdx = useMemo(
    () => buildStudentMTTTeacherIndex(timetable, teacherCoverage),
    [timetable, teacherCoverage]
  );
  // Lazy initialisers: if focusStudentId is set on mount, open edit form immediately
  // (avoids the useEffect flash where the list renders first then the form opens)
  const [editing, setEditing] = useState(() => {
    if (focusStudentId) { const s = students.find(st => st.id === focusStudentId); return s ? s.id : null; }
    return null;
  });
  const [form, setForm] = useState(() => {
    if (focusStudentId) {
      const s = students.find(st => st.id === focusStudentId);
      if (!s) return null;
      const { instruments, ...clean } = s;
      return clean;
    }
    return null;
  });
  const [formEnrolments, setFormEnrolments] = useState(() => {
    if (focusStudentId) return allEnrolmentsFor(focusStudentId, enrolments).map(e => ({ ...e }));
    return [];
  });
  const [isAddingEnrolment, setIsAddingEnrolment] = useState(false);
  const [newEnrolmentDraft, setNewEnrolmentDraft] = useState({ instrument: "", isGroup: false });
  const [endingEnrolment, setEndingEnrolment] = useState(null);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const filter = (viewState || {}).filter || { school: "", className: "", instrument: "", teacher: "", search: "" };
  const setFilter = (v) => setViewState(prev => ({ ...prev, filter: typeof v === "function" ? v(prev.filter || {}) : v }));
  const sortCol = (viewState || {}).sortCol || "name";
  const setSortCol = (v) => setViewState(prev => ({ ...prev, sortCol: v }));
  const sortDir = (viewState || {}).sortDir || "asc";
  const setSortDir = (v) => setViewState(prev => ({ ...prev, sortDir: typeof v === "function" ? v(prev.sortDir || "asc") : v }));
  const [importMode, setImportMode] = useState(null); // null | "pdf" | "spreadsheet"
  const [importInstructions, setImportInstructions] = useState("");
  const [importSchoolId, setImportSchoolId] = useState("");
  const [parsing, setParsing] = useState(false);
  const [importError, setImportError] = useState(null);
  const [preview, setPreview] = useState(null);
  const fileRef = useRef(null);
  const focusRowRef = useRef(null);
  const [expandedStudentNotes, setExpandedStudentNotes] = useState(new Set());
  const [studentNoteTooltip, setStudentNoteTooltip] = useState(null); // { text, x, y }
  const toggleStudentNote = (id) => setExpandedStudentNotes(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  // Merge prompt: shown when activating a pending student whose name matches an active student
  const [mergePrompt, setMergePrompt] = useState(null); // { pendingStudent, targetStudent, pendingForm }
  const [showArchived, setShowArchived] = useState(false);
  const [archiveDeleteConfirmId, setArchiveDeleteConfirmId] = useState(null); // row-level delete confirm in archived panel
  const [pickingStudentForParent, setPickingStudentForParent] = useState(false);
  const parentPrefillRef = useRef(null);
  const updateStudentNote = (id, val) => setStudents(prev => prev.map(s => s.id === id ? { ...s, notes: val } : s));
  // Context menu for student rows (right-click → Add to Claude memory)
  const [studentCtxMenu, setStudentCtxMenu] = useState(null); // { x, y, student }
  const studentCtxRef = useRef(null);
  useEffect(() => {
    if (!studentCtxMenu) return;
    const close = (e) => {
      if (studentCtxRef.current && studentCtxRef.current.contains(e.target)) return;
      setStudentCtxMenu(null);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [studentCtxMenu]);

  // Clear focusStudentId after it's been consumed on mount (handled via lazy useState above)
  // This also handles the case where focusStudentId changes while the component is already mounted
  useEffect(() => {
    if (focusStudentId) {
      const student = students.find(s => s.id === focusStudentId);
      if (student) {
        const { instruments, ...studentClean } = student;
        setForm(studentClean);
        setFormEnrolments(allEnrolmentsFor(student.id, enrolments).map(e => ({ ...e })));
        setEditing(student.id);
      }
      if (onClearFocus) onClearFocus();
    }
  }, [focusStudentId]);

  // Open new student form pre-filled from enquiry data
  useEffect(() => {
    if (newStudentPrefill) {
      const base = { id: uid(), name: "", schoolId: "", className: "", status: "pending", parents: [], notes: "", outsideClassOnly: false, outsideClassPreferred: false, availableBefore: false, availableAfter: false, avoidRecessLunch: false, avoidTimes: [], preferredTimes: [] };
      const merged = { ...base, ...newStudentPrefill };
      const { instruments, ...mergedClean } = merged;
      setForm(mergedClean);
      setEditing("new");

      // If the prefill carried an instrument hint (e.g. from an email enquiry),
      // seed one enrolment row so the user doesn't lose the hint.
      const prefillInstrument = newStudentPrefill.instrument || newStudentPrefill.instruments?.[0]?.name;
      if (prefillInstrument) {
        setFormEnrolments([{
          id: uid(),
          studentId: merged.id,
          instrument: prefillInstrument,
          isGroup: false,
          groupId: undefined,
          startDate: new Date().toISOString().split("T")[0],
          endDate: undefined,
        }]);
      } else {
        setFormEnrolments([]);
      }

      if (onClearNewStudentPrefill) onClearNewStudentPrefill();
    }
  }, [newStudentPrefill]);

  // Navigate to student picker to add a parent from email context menu
  useEffect(() => {
    if (addParentPrefill) {
      parentPrefillRef.current = addParentPrefill;
      setPickingStudentForParent(true);
      setEditing(null);
      setForm(null);
      setFormEnrolments([]);
      if (onClearAddParentPrefill) onClearAddParentPrefill();
    }
  }, [addParentPrefill]);

  // Reset enrolment-subsection UI state whenever the form opens for a different
  // student (or closes). Prevents stale add-row drafts, open end-confirmation
  // modals, or history-expanded state leaking across students.
  useEffect(() => {
    setIsAddingEnrolment(false);
    setNewEnrolmentDraft({ instrument: "", isGroup: false });
    setEndingEnrolment(null);
    setHistoryExpanded(form?.status === "archived");
  }, [form?.id]);

  const lastResetKey = useRef(resetKey);
  useEffect(() => {
    if (resetKey === lastResetKey.current) return; // skip strict-mode double-fire and initial mount
    lastResetKey.current = resetKey;
    setEditing(null); setForm(null); setFormEnrolments([]); setImportMode(null); setPreview(null);
  }, [resetKey]);

  // Migrate old constraint fields to new ones
  useEffect(() => {
    let changed = false;
    const migrated = students.map(s => {
      if (s.breakTimeOnly !== undefined || s.beforeAfterOnly !== undefined || s.availableBeforeAfter !== undefined) {
        changed = true;
        const { breakTimeOnly, beforeAfterOnly, availableBeforeAfter, ...rest } = s;
        return {
          ...rest,
          outsideClassOnly: rest.outsideClassOnly || breakTimeOnly || false,
          outsideClassPreferred: rest.outsideClassPreferred || false,
          availableBefore: rest.availableBefore || availableBeforeAfter || beforeAfterOnly || false,
          availableAfter: rest.availableAfter || availableBeforeAfter || beforeAfterOnly || false,
        };
      }
      // Ensure new fields exist
      if (s.availableBefore === undefined) {
        changed = true;
        return { ...s, outsideClassOnly: s.outsideClassOnly || false, outsideClassPreferred: s.outsideClassPreferred || false, availableBefore: false, availableAfter: false };
      }
      if (s.avoidRecessLunch === undefined) {
        changed = true;
        return { ...s, avoidRecessLunch: false };
      }
      // Migrate student-level isGroup to instrument-level isGroup
      if (s.isGroup !== undefined) {
        changed = true;
        const { isGroup, ...rest } = s;
        return { ...rest, instruments: (rest.instruments || []).map(i => ({ ...i, isGroup: i.isGroup !== undefined ? i.isGroup : isGroup })) };
      }
      // Ensure all instruments have isGroup field
      if (s.instruments?.some(i => i.isGroup === undefined)) {
        changed = true;
        return { ...s, instruments: (s.instruments || []).map(i => ({ ...i, isGroup: i.isGroup || false })) };
      }
      return s;
    });
    if (changed) setStudents(migrated);
  }, []);

  const activeStudents = students.filter(s => s.status === "active" || s.status === "pending" || s.status === "trial");
  const archivedStudents = students.filter(s => s.status === "archived");

  const newStudent = () => {
    setForm({
      id: uid(), name: "", schoolId: "", className: "",
      outsideClassOnly: false, outsideClassPreferred: false, availableBefore: false, availableAfter: false, avoidRecessLunch: false,
      avoidTimes: [], preferredTimes: [], status: "active", notes: "",
      parents: []
    });
    setFormEnrolments([]);
    setEditing("new");
  };

  const editStudent = (student) => {
    if (pickingStudentForParent && parentPrefillRef.current) {
      const prefill = parentPrefillRef.current;
      const { instruments, ...updatedForm } = student;
      if ((updatedForm.parents || []).length < 2) {
        updatedForm.parents = [...(updatedForm.parents || []), { id: uid(), name: prefill.name || "", email: prefill.email || "", phone: "", relationship: "", isPrimary: (updatedForm.parents || []).length === 0 }];
      }
      setForm(updatedForm);
      setFormEnrolments(allEnrolmentsFor(student.id, enrolments).map(e => ({ ...e })));
      setEditing(student.id);
      setPickingStudentForParent(false);
      parentPrefillRef.current = null;
      return;
    }
    const { instruments, ...studentClean } = student;
    setForm(studentClean);
    setFormEnrolments(allEnrolmentsFor(student.id, enrolments).map(e => ({ ...e })));
    setEditing(student.id);
  };

  const saveStudent = () => {
    if (!form.name.trim()) { notify("Student name required", "warning"); return; }
    // Activation merge check: if an existing pending/trial student is being set to active,
    // look for an active student with the same name and offer to merge instruments.
    if (editing !== "new" && form.status === "active") {
      const prev = students.find(s => s.id === form.id);
      if (prev && (prev.status === "pending" || prev.status === "trial")) {
        const normName = form.name.trim().toLowerCase();
        const match = students.find(s =>
          s.id !== form.id &&
          s.status === "active" &&
          s.name.trim().toLowerCase() === normName
        );
        if (match) {
          setMergePrompt({ pendingStudent: form, targetStudent: match });
          return; // hold — user must decide before saving
        }
      }
    }
    commitSaveStudent(form);
  };

  const commitSaveStudent = (f) => {
    const prevRecord = students.find(s => s.id === f.id);
    const isBecomingArchived = prevRecord && prevRecord.status !== "archived" && f.status === "archived";
    const record = f.status === "archived" && !f.archivedAt ? { ...f, archivedAt: new Date().toISOString() } : f;
    const todayISO = new Date().toISOString().split("T")[0];

    // Strip instruments off the student record — student rows never carry an
    // instruments field post-migration. Enrolments live in their own collection.
    const { instruments, ...cleanRecord } = record;

    // If the student is becoming archived, stamp today's endDate on every
    // still-active form-enrolment so history reflects the archive date.
    let effectiveFormEnrolments = formEnrolments;
    if (isBecomingArchived) {
      effectiveFormEnrolments = formEnrolments.map(e =>
        e.endDate ? e : { ...e, endDate: todayISO }
      );
    }

    // Find enrolments that are newly-ended by this save — they need a card
    // cascade. Ignore ones that were already ended before the form opened.
    const priorEnrolments = allEnrolmentsFor(cleanRecord.id, enrolments);
    const newlyEndedIds = effectiveFormEnrolments
      .filter(e => e.endDate && !priorEnrolments.find(p => p.id === e.id)?.endDate)
      .map(e => e.id);

    // Student writeback
    if (editing === "new") {
      setStudents(prev => [...prev, cleanRecord]);
    } else {
      setStudents(prev => prev.map(s => s.id === cleanRecord.id ? cleanRecord : s));
    }

    // Enrolment writeback: replace this student's enrolments with the form's version
    setEnrolments(prev => {
      const others = prev.filter(e => e.studentId !== cleanRecord.id);
      return [...others, ...effectiveFormEnrolments];
    });

    // Cascade: archive clears all of the student's cards in one shot (by
    // studentId, subsumes all enrolments). Otherwise each newly-ended
    // enrolment gets a per-enrolment card cascade.
    if (isBecomingArchived) {
      onArchiveStudent(cleanRecord.id);
    } else {
      for (const endedId of newlyEndedIds) {
        if (onEndEnrolment) onEndEnrolment(endedId);
      }
    }

    setForm(null); setEditing(null); setFormEnrolments([]);
    notify("Student saved!");
    if (onReturn) onReturn();
  };

  const handleMerge = () => {
    if (!mergePrompt) return;
    const { pendingStudent, targetStudent } = mergePrompt;

    // Pending's enrolments come from formEnrolments — the form is open, and
    // the user may have added/edited enrolments that aren't yet in the
    // enrolments prop. formEnrolments is the more-current source of truth.
    const pendingEnrolments = formEnrolments.filter(e => e.studentId === pendingStudent.id);

    // Target's already-active instruments — case-insensitive dedup.
    const targetActiveInstruments = new Set(
      activeEnrolmentsFor(targetStudent.id, enrolments).map(e => e.instrument.toLowerCase())
    );

    // Non-duplicate pending enrolments, reassigned to the target student.
    // Preserves id, startDate, teacherId, isGroup, groupId — only studentId changes.
    const transferred = pendingEnrolments
      .filter(e => !targetActiveInstruments.has(e.instrument.toLowerCase()))
      .map(e => ({ ...e, studentId: targetStudent.id }));

    // Drop ALL of pending's enrolments (dupes + transferred alike), then add
    // the transferred ones back with the new studentId. Clean state.
    setEnrolments(prev => [
      ...prev.filter(e => e.studentId !== pendingStudent.id),
      ...transferred,
    ]);
    setStudents(prev => prev.filter(s => s.id !== pendingStudent.id));

    setMergePrompt(null);
    setForm(null); setEditing(null); setFormEnrolments([]);
    notify(`Merged ${transferred.map(e => e.instrument).join(", ") || "0 new instruments"} into ${targetStudent.name}`);
    if (onReturn) onReturn();
  };

  const handleActivateWithoutMerge = () => {
    if (!mergePrompt) return;
    commitSaveStudent(mergePrompt.pendingStudent);
    setMergePrompt(null);
  };

  const deleteStudent = (id) => {
    setStudents(prev => prev.filter(s => s.id !== id));
    // Symmetric with onDeleteStudent's card cleanup — otherwise a permanent
    // delete would leave orphan enrolment rows keyed to a missing student.
    setEnrolments(prev => prev.filter(e => e.studentId !== id));
    if (onDeleteStudent) onDeleteStudent(id);
    notify("Student removed");
  };

  const archiveStudent = (id) => {
    const todayISO = new Date().toISOString().split("T")[0];
    setStudents(prev => prev.map(s => s.id === id ? { ...s, status: "archived", archivedAt: new Date().toISOString() } : s));
    // Mirror commitSaveStudent's archive path: stamp endDate on every active
    // enrolment. Without this, row-button archive leaves enrolments active
    // in the data model while cards are cleared — they'd still show as
    // active in the form's Enrolments section on a later re-open.
    setEnrolments(prev => prev.map(e =>
      e.studentId === id && !e.endDate ? { ...e, endDate: todayISO } : e
    ));
    onArchiveStudent(id); // timetable cleanup
    setForm(null); setEditing(null);
    notify("Student archived");
  };

  const restoreStudent = (id) => {
    // Restore to pending — timetable data was cleared on archive, so no slot will reappear
    setStudents(prev => prev.map(s => s.id === id ? { ...s, status: "pending", archivedAt: undefined } : s));
    notify("Student restored to pending");
  };

  const handleImport = (data, filename) => {
    const imported = parseStudentCSV(data, schools, teachers);
    if (imported.length === 0) { notify("No valid students found in file", "warning"); return; }
    const todayISO = new Date().toISOString().split("T")[0];

    // Build enrolment rows from each imported student's instruments[].
    // Each instrument becomes one enrolment keyed to the student's id.
    const importedEnrolments = imported.flatMap(s =>
      (s.instruments || []).map(inst => ({
        id: uid(),
        studentId: s.id,
        instrument: inst.name,
        isGroup: inst.isGroup || false,
        groupId: undefined,
        startDate: todayISO,
        endDate: undefined,
      }))
    );

    // Strip instruments from student records before persisting — student rows
    // don't carry instruments post-migration.
    const cleanStudents = imported.map(({ instruments, ...rest }) => rest);

    setStudents(prev => [...prev, ...cleanStudents]);
    setEnrolments(prev => [...prev, ...importedEnrolments]);
    notify(`Imported ${imported.length} students (${importedEnrolments.length} enrolments) from ${filename}`);
  };

  const openImport = (mode) => { setImportMode(mode); setImportError(null); };

  const handleFileUpload = async (e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;
    e.target.value = "";

    setParsing(true);
    setImportMode(null);
    try {
      let userGuidance = "";
      if (importInstructions.trim()) {
        userGuidance = `\n\nIMPORTANT — SPECIFIC INSTRUCTIONS FROM THE USER about this document. Follow these carefully, they override general assumptions:\n---\n${importInstructions.trim()}\n---`;
      }

      const schoolListStr = schools.map(s => {
        const initials = s.name.split(/\s+/).map(w => w[0]).join("").toUpperCase();
        return `"${s.name}" (abbreviation: "${initials}")`;
      }).join(", ");
      const instrumentListStr = availableInstruments.join(", ");
      const teacherListStr = teachers.map(t => t.name).join(", ");

      const prompt = `Extract student data from this document. Each student should have:
- name: student's full name
- school: the school value EXACTLY as it appears in the document (do NOT convert abbreviations — return the raw text e.g. "EBPS" not "East Bentleigh Primary School")
- class: class/grade name exactly as shown (e.g. "3A", "Prep B", "5/6C")
- instrument: instrument name (known instruments: ${instrumentListStr})
- teacher: the teacher value EXACTLY as it appears in the document (could be full name, first name only, or initials — return the raw text)
- notes: any other relevant info (optional)

For reference, known schools: ${schoolListStr}. Known teachers: ${teacherListStr}.

Rules:
- Extract ALL students from the document, one entry per student per instrument
- Return school and teacher values EXACTLY as they appear — do NOT try to expand abbreviations or match names
- Match instrument names to the known instruments listed above where possible
- Do NOT set level — it will be auto-assigned based on grade
- If teacher isn't specified, leave as empty string
- If the same student appears multiple times with different instruments, return each as a separate entry (they will be merged automatically)
- Ignore any headers, totals, or non-student rows

Respond ONLY with a JSON array, no other text, no markdown backticks.${userGuidance}`;

      // Helper: match school by name, abbreviation/initials, or partial match
      const matchSchool = (raw) => {
        if (!raw) return importSchoolId ? schools.find(s => s.id === importSchoolId) : null;
        const r = raw.trim();
        const rLower = r.toLowerCase();
        const rUpper = r.toUpperCase();
        // 1. Exact name match
        let match = schools.find(s => s.name.toLowerCase() === rLower);
        if (match) return match;
        // 2. Abbreviation/initials match (input is abbreviation of school name)
        match = schools.find(s => {
          const initials = s.name.split(/\s+/).map(w => w[0]).join("").toUpperCase();
          return initials === rUpper;
        });
        if (match) return match;
        // 3. Reverse initials match (school name is abbreviation of input)
        const inputInitials = r.split(/\s+/).map(w => w[0]).join("").toUpperCase();
        match = schools.find(s => s.name.toUpperCase() === inputInitials);
        if (match) return match;
        // 4. Initials without common words (skip "Primary", "School", "College" etc.)
        const skipWords = ["primary", "school", "college", "grammar", "academy", "the"];
        match = schools.find(s => {
          const significantWords = s.name.split(/\s+/).filter(w => !skipWords.includes(w.toLowerCase()));
          const sigInitials = significantWords.map(w => w[0]).join("").toUpperCase();
          return sigInitials === rUpper || s.name.split(/\s+/).map(w => w[0]).join("").toUpperCase() === rUpper;
        });
        if (match) return match;
        // 5. Partial/contains match
        match = schools.find(s => s.name.toLowerCase().includes(rLower) || rLower.includes(s.name.toLowerCase()));
        if (match) return match;
        // 6. First word match (e.g. "Solway" matches "Solway Primary School")
        match = schools.find(s => s.name.toLowerCase().startsWith(rLower) || rLower.startsWith(s.name.split(/\s+/)[0].toLowerCase()));
        if (match) return match;
        // Fallback to importSchoolId
        return importSchoolId ? schools.find(s => s.id === importSchoolId) : null;
      };

      // Helper: consolidate duplicate student names — merge instruments into one entry
      const consolidateStudents = (entries) => {
        const byKey = {};
        for (const e of entries) {
          // Key by name + school to handle same name at different schools
          const key = `${e.name.toLowerCase()}|${e.schoolId}`;
          if (byKey[key]) {
            // Merge instruments (avoid duplicates)
            for (const inst of e.instruments) {
              if (!byKey[key].instruments.some(i => i.name === inst.name)) {
                byKey[key].instruments.push(inst);
              }
            }
            // Keep preferred teacher if the existing entry doesn't have one
            // teacherId is per-instrument; merged via instruments array above
            // Merge notes
            if (e.notes && !byKey[key].notes.includes(e.notes)) {
              byKey[key].notes = [byKey[key].notes, e.notes].filter(Boolean).join("; ");
            }
          } else {
            byKey[key] = { ...e };
          }
        }
        return Object.values(byKey);
      };

      // Helper: convert AI entries to preview entries
      const toPreviewEntries = (entries) => {
        const mapped = entries.map(e => {
          const school = matchSchool(e.school);
          const className = (e.class || e.className || "").trim();
          const instruments = [{ name: e.instrument || "", isGroup: false }];
          if (e.instrument2) instruments.push({ name: e.instrument2, isGroup: false });
          return {
            id: uid(), name: (e.name || "").trim(),
            schoolId: school ? school.id : importSchoolId || "",
            className,
            instruments,
            // teacherId handled per-instrument
            outsideClassOnly: false, outsideClassPreferred: false, availableBefore: false, availableAfter: false,
            avoidTimes: [], preferredTimes: [],
            status: "active", notes: e.notes || ""
          };
        });
        return consolidateStudents(mapped);
      };

      // Helper: parse AI response JSON with truncation recovery
      const parseAIResponse = (textContent) => {
        const cleaned = textContent.replace(/```json|```/g, "").trim();
        try { return JSON.parse(cleaned); }
        catch(e) {
          const lastObj = cleaned.lastIndexOf("}");
          if (lastObj > 0) {
            let recovered = cleaned.substring(0, lastObj + 1);
            if (!recovered.trim().endsWith("]")) recovered += "]";
            return JSON.parse(recovered);
          }
          throw new Error("Could not parse AI response.\n\nRaw: " + cleaned.substring(0, 300));
        }
      };

      // Helper: read a single spreadsheet file
      const readSpreadsheet = (file) => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = async (ev) => {
          try {
            if (file.name.endsWith(".csv")) {
              const Papa = await getPapa();
              const result = Papa.parse(ev.target.result, { header: true, skipEmptyLines: true });
              resolve(result.data);
            } else {
              const XLSX = await getXLSX();
              const wb = XLSX.read(ev.target.result, { type: "array" });
              const ws = wb.Sheets[wb.SheetNames[0]];
              resolve(XLSX.utils.sheet_to_json(ws));
            }
          } catch (err) { reject(err); }
        };
        reader.onerror = () => reject(new Error("Failed to read " + file.name));
        if (file.name.endsWith(".csv")) reader.readAsText(file);
        else reader.readAsArrayBuffer(file);
      });

      const file = files[0]; // For PDF or single file references

      if (file.name.endsWith(".pdf")) {
        // PDF: single file only
        const base64Data = await new Promise((res, rej) => {
          const reader = new FileReader();
          reader.onload = () => res(reader.result.split(",")[1]);
          reader.onerror = () => rej(new Error("Failed to read file"));
          reader.readAsDataURL(file);
        });

        const response = await anthropicFetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: getAnthropicHeaders(),
          body: JSON.stringify({
            model: ANTHROPIC_MODEL,
            max_tokens: 16000,
            messages: [{
              role: "user",
              content: [
                { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64Data } },
                { type: "text", text: prompt }
              ]
            }]
          })
        });

        if (!response.ok) throw new Error(`API error: ${response.status}`);

        const data = await response.json();
        const textContent = data.content?.filter(c => c.type === "text").map(c => c.text).join("") || "";
        const entries = parseAIResponse(textContent);

        if (!Array.isArray(entries) || entries.length === 0) {
          notify("No students found. Try adding more specific instructions.", "warning");
          setParsing(false);
          return;
        }

        setPreview({ entries: toPreviewEntries(entries), filename: file.name });
      } else {
        // Spreadsheet(s): process all files and merge
        const allEntries = [];
        const filenames = [];

        for (const f of files) {
          const rawData = await readSpreadsheet(f);
          if (!rawData || rawData.length === 0) continue;
          filenames.push(f.name);

          // Always use AI for spreadsheets — handles any column names, abbreviations, etc.
          const response = await anthropicFetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: getAnthropicHeaders(),
            body: JSON.stringify({
              model: ANTHROPIC_MODEL,
              max_tokens: 16000,
              messages: [{
                role: "user",
                content: `I have a spreadsheet with student data. Here are the first 5 rows as a sample:\n\n${JSON.stringify(rawData.slice(0, 5), null, 2)}\n\nFull data (${rawData.length} rows):\n${JSON.stringify(rawData)}\n\n${prompt}`
              }]
            })
          });

          if (!response.ok) throw new Error(`API error for ${f.name}: ${response.status}`);

          const data = await response.json();
          const textContent = data.content?.filter(c => c.type === "text").map(c => c.text).join("") || "";
          const entries = parseAIResponse(textContent);
          allEntries.push(...toPreviewEntries(entries));
        }

        if (allEntries.length === 0) {
          notify("No valid students found in the selected file(s).", "warning");
          setParsing(false);
          return;
        }

        setPreview({
          entries: allEntries,
          filename: filenames.length === 1 ? filenames[0] : `${filenames.length} files (${filenames.join(", ")})`
        });
      }
    } catch (err) {
      console.error("Student import error:", err);
      setImportError({ filename: files.map(f => f.name).join(", "), message: err.message, details: err.stack || "" });
    }
    setParsing(false);
  };

  const confirmStudentImport = () => {
    if (!preview) return;
    const valid = preview.entries.filter(e => e.name && e.instruments[0]?.name);
    const todayISO = new Date().toISOString().split("T")[0];

    // Unwrap preview entries' instruments[] into enrolment rows.
    const newEnrolments = valid.flatMap(s =>
      (s.instruments || []).map(inst => ({
        id: uid(),
        studentId: s.id,
        instrument: inst.name,
        isGroup: inst.isGroup || false,
        groupId: undefined,
        startDate: todayISO,
        endDate: undefined,
      }))
    );

    // Strip instruments from student records before persisting.
    const cleanStudents = valid.map(({ instruments, ...rest }) => rest);

    setStudents(prev => [...prev, ...cleanStudents]);
    setEnrolments(prev => [...prev, ...newEnrolments]);
    notify(`Imported ${valid.length} students (${newEnrolments.length} enrolments) from ${preview.filename}`);
    setPreview(null);
  };

  const updatePreviewStudent = (idx, key, val) => {
    setPreview(prev => {
      const entries = [...prev.entries];
      entries[idx] = { ...entries[idx], [key]: val };
      return { ...prev, entries };
    });
  };

  const removePreviewStudent = (idx) => {
    setPreview(prev => ({ ...prev, entries: prev.entries.filter((_, i) => i !== idx) }));
  };

  // Session 3 / C2 — set of MTT-resolved teacher ids for a student's
  // non-group enrolments (via the bulk index). Empty when no enrolment has
  // an MTT placement yet.
  const getStudentMTTTeacherIds = (student, activeEnrols) => {
    const ids = new Set();
    for (const en of activeEnrols) {
      if (en.isGroup) continue;
      const key = `${student.id}:${(en.instrument || "").trim().toLowerCase()}`;
      const tid = mttTeacherIdx.get(key);
      if (tid) ids.add(tid);
    }
    return ids;
  };

  const filtered = activeStudents.filter(s => {
    if (filter.school && s.schoolId !== filter.school) return false;
    if (filter.className && s.className !== filter.className) return false;
    const active = activeEnrolmentsFor(s.id, enrolments);
    if (filter.instrument && !active.some(e => e.instrument === filter.instrument)) return false;
    if (filter.teacher) {
      const tids = getStudentMTTTeacherIds(s, active);
      if (filter.teacher === "_none_") {
        if (tids.size > 0) return false;
      } else {
        if (!tids.has(filter.teacher)) return false;
      }
    }
    if (filter.search && !s.name.toLowerCase().includes(filter.search.toLowerCase())) return false;
    if (filter.hasNote && !(s.notes && s.notes.trim())) return false;
    if (filter.hasWarning) {
      const isPrivate = s.schoolId === "__private__";
      const hasUnassignedTeacher = !isPrivate && active.some(e => {
        if (e.isGroup) return false;
        const key = `${s.id}:${(e.instrument || "").trim().toLowerCase()}`;
        return !mttTeacherIdx.has(key);
      });
      const hasMissingInstrument = active.length === 0;
      const hasMissingParent = !isPrivate && (!(s.parents || []).length || !(s.parents || []).some(p => p.email));
      const hasMissingClass = !isPrivate && !s.className;
      const hasMissingSchool = !isPrivate && !s.schoolId;
      const hasAnyWarning = hasUnassignedTeacher || hasMissingInstrument || hasMissingParent || hasMissingClass || hasMissingSchool;
      if (!hasAnyWarning) return false;
    }
    return true;
  });

  const handleSort = (col) => {
    if (sortCol === col) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortCol(col); setSortDir("asc"); }
  };

  const sortedFiltered = [...filtered].sort((a, b) => {
    const dir = sortDir === "asc" ? 1 : -1;
    switch (sortCol) {
      case "name": return dir * a.name.localeCompare(b.name);
      case "school": {
        const aSchool = schools.find(sc => sc.id === a.schoolId)?.name || "";
        const bSchool = schools.find(sc => sc.id === b.schoolId)?.name || "";
        return dir * aSchool.localeCompare(bSchool);
      }
      case "class": return dir * (a.className || "").localeCompare(b.className || "", undefined, { numeric: true });
      case "instrument": {
        const aInst = primaryEnrolmentFor(a.id, enrolments)?.instrument || "";
        const bInst = primaryEnrolmentFor(b.id, enrolments)?.instrument || "";
        return dir * aInst.localeCompare(bInst);
      }
      case "teacher": {
        // Session 3 / C2 — sort by MTT-derived teacher name of the primary
        // enrolment's instrument. Unassigned (no MTT placement) sorts last.
        const aPrim = primaryEnrolmentFor(a.id, enrolments);
        const bPrim = primaryEnrolmentFor(b.id, enrolments);
        const aTid = aPrim ? mttTeacherIdx.get(`${a.id}:${(aPrim.instrument || "").trim().toLowerCase()}`) : null;
        const bTid = bPrim ? mttTeacherIdx.get(`${b.id}:${(bPrim.instrument || "").trim().toLowerCase()}`) : null;
        const aT = aTid ? (teachers.find(t => t.id === aTid)?.name || "") : "zzz";
        const bT = bTid ? (teachers.find(t => t.id === bTid)?.name || "") : "zzz";
        return dir * aT.localeCompare(bT);
      }
      default: return 0;
    }
  });


  // ==== RENDER: IMPORT MODE ====

    if (importMode) {
    return (
      <div>
        <PageTitle subtitle={importMode === "pdf" ? "Upload a PDF with student data" : "Upload a spreadsheet with student data"}>Import Students</PageTitle>
        <Card>
          <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
            <button onClick={() => setImportMode("pdf")} style={{
              flex: 1, padding: "10px 14px", borderRadius: 8, fontSize: 14, fontFamily: "inherit", cursor: "pointer",
              border: `2px solid ${importMode === "pdf" ? colors.accent : colors.border}`,
              background: importMode === "pdf" ? colors.accentLight : colors.cardBg,
              color: importMode === "pdf" ? colors.accentDark : colors.text, fontWeight: 600
            }}><span style={{display:"inline-flex",alignItems:"center",gap:6}}><ClipboardList size={14}/>PDF Document</span></button>
            <button onClick={() => setImportMode("spreadsheet")} style={{
              flex: 1, padding: "10px 14px", borderRadius: 8, fontSize: 14, fontFamily: "inherit", cursor: "pointer",
              border: `2px solid ${importMode === "spreadsheet" ? colors.accent : colors.border}`,
              background: importMode === "spreadsheet" ? colors.accentLight : colors.cardBg,
              color: importMode === "spreadsheet" ? colors.accentDark : colors.text, fontWeight: 600
            }}><span style={{display:"inline-flex",alignItems:"center",gap:6}}><ClipboardList size={14}/>Spreadsheet (CSV/XLSX)</span></button>
          </div>

          {schools.length > 1 && (
            <div style={{ marginBottom: 14 }}>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: colors.textLight, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>
                Default School <span style={{ fontWeight: 400, textTransform: "none" }}>(if not specified in file)</span>
              </label>
              <select value={importSchoolId} onChange={e => setImportSchoolId(e.target.value)}
                style={{ padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit" }}>
                <option value="">Auto-detect from file</option>
                {schools.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          )}

          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: colors.textLight, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>
              Import Instructions <span style={{ fontWeight: 400, textTransform: "none" }}>(optional — helps AI understand your file)</span>
            </label>
            <textarea
              value={importInstructions}
              onChange={e => setImportInstructions(e.target.value)}
              rows={5}
              placeholder={importMode === "pdf"
                ? "Examples:\n• Only import students from the 'Current Enrolments' section\n• The instrument is listed under 'Program'\n• Ignore any students marked 'Withdrawn'\n• 'Gtr' means Guitar, 'Kbd' means Keyboard\n• All students on this page are from Moorabbin PS"
                : "Examples:\n• The 'Program' column is the instrument name\n• 'Gtr' means Guitar, 'Kbd' means Keyboard\n• Ignore rows where Status is 'Cancelled'\n• Class names are in the 'Home Group' column\n• Skill level is in the 'Year' column: Year 3-4 = Beginner, Year 5-6 = Intermediate"}
              style={{
                width: "100%", padding: "12px 14px",
                border: `1px solid ${colors.inputBorder}`, borderRadius: 8,
                fontSize: 14, fontFamily: "inherit", background: colors.inputBg,
                color: colors.text, resize: "vertical", boxSizing: "border-box",
                lineHeight: 1.6
              }}
            />
            <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 6 }}>
              Tell the AI which columns to use, what abbreviations mean, which rows to ignore, or anything else specific to your file.
              {importMode === "spreadsheet" && " AI will always interpret your spreadsheet — instructions help with tricky formats."}
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <input ref={fileRef} type="file" accept={importMode === "pdf" ? ".pdf" : ".csv,.xlsx,.xls"} multiple={importMode !== "pdf"} onChange={handleFileUpload} style={{ display: "none" }} />
            <Btn onClick={() => fileRef.current?.click()}>
              {importMode === "pdf" ? "📄 Select PDF File" : "📁 Select Spreadsheet(s)"}
            </Btn>
            <Btn variant="secondary" onClick={() => setImportMode(null)}>Cancel</Btn>
          </div>
        </Card>
      </div>
    );
  }

  // ==== RENDER: PARSING ====
  if (parsing) {
    return (
      <div>
        <PageTitle>Students</PageTitle>
        <Card style={{ background: colors.amberLight, borderColor: colors.accent + "40" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ fontSize: 28 }}>⏳</div>
            <div>
              <div style={{ fontWeight: 600, fontSize: 15, color: colors.accent }}>Processing student data...</div>
              <div style={{ fontSize: 13, color: colors.textLight, marginTop: 4 }}>
                AI is reading the document and extracting student records. This usually takes 10–20 seconds.
                {importInstructions.trim() && <span style={{ display: "block", marginTop: 4, color: colors.textMuted, fontStyle: "italic" }}>Using your instructions to guide extraction.</span>}
              </div>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  // ==== RENDER: IMPORT ERROR ====
  if (importError) {
    return (
      <div>
        <PageTitle subtitle="Something went wrong during import">Import Error</PageTitle>
        <Card style={{ background: colors.redLight, borderColor: "#FCC" }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
            <div style={{ flexShrink: 0, color: colors.danger, display: "flex", alignItems: "flex-start", paddingTop: 2 }}><AlertTriangle size={26} /></div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 15, color: colors.danger, marginBottom: 8 }}>
                Failed to import "{importError.filename}"
              </div>
              <div style={{ fontSize: 14, color: colors.text, lineHeight: 1.6, marginBottom: 12 }}>
                {importError.message}
              </div>
              {importError.details && (
                <div style={{ fontSize: 12, color: colors.textMuted, padding: "10px 14px", background: colors.cardBg, borderRadius: 8, border: "1px solid #F0E0E0", fontFamily: "monospace", whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 120, overflowY: "auto" }}>
                  {importError.details}
                </div>
              )}
            </div>
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
            <Btn onClick={() => { setImportError(null); openImport("pdf"); }}>Try PDF Again</Btn>
            <Btn variant="secondary" onClick={() => { setImportError(null); openImport("spreadsheet"); }}>Try Spreadsheet</Btn>
            <Btn variant="ghost" onClick={() => setImportError(null)}>Dismiss</Btn>
          </div>
        </Card>
      </div>
    );
  }

  // ==== RENDER: IMPORT PREVIEW ====
  if (preview) {
    return (
      <div>
        <PageTitle subtitle={`Found ${preview.entries.length} students from ${preview.filename} — review before importing`}>Review Import</PageTitle>

        <Card style={{ padding: 0, overflow: "hidden", marginBottom: 16 }}>
          <div style={{ maxHeight: 500, overflowY: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: colors.bg, borderBottom: `1px solid ${colors.border}`, position: "sticky", top: 0, zIndex: 1 }}>
                  {["Name", "School", "Class", "Instrument", ""].map((h, i) => (
                    <th key={i} style={{ padding: "10px 8px", textAlign: "left", fontSize: 11, fontWeight: 600, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.5, background: colors.bg }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.entries.map((entry, i) => (
                  <tr key={entry.id} style={{ borderBottom: `1px solid ${colors.borderLight}` }}>
                    <td style={{ padding: "6px 8px" }}>
                      <input value={entry.name} onChange={e => updatePreviewStudent(i, "name", e.target.value)}
                        style={{ width: "100%", padding: "4px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 4, fontSize: 13, fontFamily: "inherit" }} />
                    </td>
                    <td style={{ padding: "6px 8px" }}>
                      <select value={entry.schoolId} onChange={e => updatePreviewStudent(i, "schoolId", e.target.value)}
                        style={{ width: "100%", padding: "4px 6px", border: `1px solid ${colors.inputBorder}`, borderRadius: 4, fontSize: 12, fontFamily: "inherit" }}>
                        <option value="">Select...</option>
                        {schools.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </select>
                    </td>
                    <td style={{ padding: "6px 8px" }}>
                      <input value={entry.className} onChange={e => updatePreviewStudent(i, "className", e.target.value)}
                        style={{ width: 80, padding: "4px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 4, fontSize: 13, fontFamily: "inherit" }} />
                    </td>
                    <td style={{ padding: "6px 8px" }}>
                      <select value={entry.instruments[0]?.name || ""} onChange={e => {
                        const insts = [...entry.instruments]; insts[0] = { ...insts[0], name: e.target.value };
                        updatePreviewStudent(i, "instruments", insts);
                      }} style={{ width: "100%", padding: "4px 6px", border: `1px solid ${colors.inputBorder}`, borderRadius: 4, fontSize: 12, fontFamily: "inherit" }}>
                        <option value="">Select...</option>
                        {(() => {
                          const base = availableInstruments.length > 0 ? availableInstruments : [];
                          const current = entry.instruments[0]?.name;
                          if (current && !base.includes(current)) return [...base, current].sort();
                          return base;
                        })().map(n => <option key={n} value={n}>{n}</option>)}
                      </select>
                    </td>
                    <td style={{ padding: "6px 8px" }}>
                      <select value={entry.instruments[0]?.level || "Beginner"} onChange={e => {
                        const insts = [...entry.instruments]; insts[0] = { ...insts[0], level: e.target.value };
                        updatePreviewStudent(i, "instruments", insts);
                      }} style={{ padding: "4px 6px", border: `1px solid ${colors.inputBorder}`, borderRadius: 4, fontSize: 12, fontFamily: "inherit" }}>
                        
                      </select>
                    </td>
                    <td style={{ padding: "6px 8px" }}>
                      <button onClick={() => removePreviewStudent(i)}
                        style={{ border: "none", background: "none", color: colors.danger, cursor: "pointer", display: "inline-flex", alignItems: "center" }}><X size={14} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <div style={{ display: "flex", gap: 10 }}>
          <Btn onClick={confirmStudentImport}><span style={{display:"inline-flex",alignItems:"center",gap:5}}><Check size={13}/>Import {preview.entries.length} Students</span></Btn>
          <Btn variant="secondary" onClick={() => setPreview(null)}>Cancel</Btn>
        </div>
      </div>
    );
  }

  if (form) {
    return (
      <div onKeyDown={e => { if (e.key === "Enter" && e.target.tagName !== "TEXTAREA" && e.target.tagName !== "SELECT" && e.target.tagName !== "BUTTON") { e.preventDefault(); saveStudent(); } }}>
        <PageTitle navButtons={<NavButtons goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}>{editing === "new" ? "Add Student" : "Edit Student"}</PageTitle>
        <Card>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 20px" }}>
            <Input label="Student Name" value={form.name} onChange={v => setForm(p => ({ ...p, name: v }))} placeholder="Full name" />
            <Input label="School" value={form.schoolId} onChange={v => setForm(p => ({ ...p, schoolId: v, ...(v === "__private__" ? { className: "", status: "active" } : {}) }))}
              options={[...schools.map(s => ({ value: s.id, label: s.name })), { value: "__private__", label: "Private Student" }]} />
            <div style={{ marginBottom: 14 }}>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: colors.textLight, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>Class</label>
              <select
                value={form.className || ""}
                onChange={e => setForm(p => ({ ...p, className: e.target.value }))}
                disabled={!form.schoolId || form.schoolId === "__private__"}
                style={{ width: "100%", padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", background: (!form.schoolId || form.schoolId === "__private__") ? colors.bg : colors.cardBg, color: (!form.schoolId || form.schoolId === "__private__") ? colors.textMuted : colors.text, cursor: (!form.schoolId || form.schoolId === "__private__") ? "not-allowed" : "pointer" }}>
                <option value="">{form.schoolId === "__private__" ? "N/A — Private student" : form.schoolId ? "Select class..." : "Select a school first"}</option>
                {form.schoolId && form.schoolId !== "__private__" && [...new Set((specialists || []).filter(s => s.schoolId === form.schoolId).map(s => s.className).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map(c => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
            <div style={{ marginBottom: 14 }}>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: colors.textLight, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>Status</label>
              <select value={form.status} onChange={e => setForm(p => ({ ...p, status: e.target.value }))}
                disabled={form.schoolId === "__private__"}
                style={{ width: "100%", padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", background: form.schoolId === "__private__" ? colors.bg : colors.cardBg, color: form.schoolId === "__private__" ? colors.textMuted : colors.text, cursor: form.schoolId === "__private__" ? "not-allowed" : "pointer" }}>
                <option value="active">Active</option>
                {form.schoolId !== "__private__" && <option value="pending">Pending (Waiting List)</option>}
                {form.schoolId !== "__private__" && <option value="trial">Trial Lesson</option>}
                <option value="archived">Archived</option>
              </select>
            </div>
          </div>

          {form.schoolId !== "__private__" && (
          <div style={{ marginBottom: 14 }}>
            <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: colors.textLight, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>Scheduling Constraints</label>
            <Checkbox label="Outside of class time only" checked={form.outsideClassOnly} onChange={v => setForm(p => ({ ...p, outsideClassOnly: v, outsideClassPreferred: v ? false : p.outsideClassPreferred }))} />
            <Checkbox label="Outside of class time preferred" checked={form.outsideClassPreferred} onChange={v => setForm(p => ({ ...p, outsideClassPreferred: v, outsideClassOnly: v ? false : p.outsideClassOnly }))} />
            <Checkbox label="Available before school" checked={form.availableBefore} onChange={v => setForm(p => ({ ...p, availableBefore: v }))} />
            <Checkbox label="Available after school" checked={form.availableAfter} onChange={v => setForm(p => ({ ...p, availableAfter: v }))} />
            <Checkbox label="Avoid recess/lunch lessons" checked={form.avoidRecessLunch || false} onChange={v => setForm(p => ({ ...p, avoidRecessLunch: v }))} />
          </div>
          )}

          <Input label="Notes" value={form.notes} onChange={v => setForm(p => ({ ...p, notes: v }))} multiline placeholder="Any preferences, restrictions, or notes..." />

          {/* Teacher notes — read-only, shown in teacher's colour, not parsed by AI */}
          {(form.teacher_notes || []).length > 0 && (
            <div style={{ marginBottom: 14, marginTop: 4 }}>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: colors.textLight, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>Teacher Notes</label>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {(form.teacher_notes || []).map(n => (
                  <div key={n.id} style={{ padding: "8px 12px", borderRadius: 8, background: (n.teacherColor || "#94A3B8") + "14", border: `1px solid ${(n.teacherColor || "#94A3B8") + "40"}`, borderLeft: `3px solid ${n.teacherColor || "#94A3B8"}`, fontSize: 13, color: colors.text, lineHeight: 1.5 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: n.teacherColor || "#94A3B8", marginBottom: 3, display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ width: 7, height: 7, borderRadius: "50%", background: n.teacherColor || "#94A3B8", display: "inline-block" }} />
                      {n.teacherName || "Teacher"}
                      <span style={{ fontWeight: 400, color: colors.textMuted, fontSize: 10 }}>· {n.editedAt ? `edited ${new Date(n.editedAt).toLocaleDateString("en-AU", { day: "numeric", month: "short" })}` : n.addedAt ? new Date(n.addedAt).toLocaleDateString("en-AU", { day: "numeric", month: "short" }) : ""}</span>
                    </div>
                    {n.text}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Parent / Guardian contacts */}
          <div style={{ marginBottom: 14, marginTop: 4 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: colors.textLight, textTransform: "uppercase", letterSpacing: 0.5 }}>
                {form.schoolId === "__private__" ? "Contact Details" : "Parent / Guardian"}
              </label>
              {(form.parents || []).length < 2 && (
                <Btn variant="ghost" onClick={() => setForm(p => ({ ...p, parents: [...(p.parents || []), { id: uid(), name: "", email: "", phone: "", relationship: "", isPrimary: (p.parents || []).length === 0 }] }))} style={{ fontSize: 12 }}>
                  {form.schoolId === "__private__"
                    ? ((form.parents || []).length === 0 ? "+ Add Contact" : "+ Add Second Contact")
                    : ((form.parents || []).length === 0 ? "+ Add Parent" : "+ Add Second Parent")}
                </Btn>
              )}
            </div>
            {(form.parents || []).length === 0 ? (
              <div style={{ fontSize: 12, color: colors.textMuted, fontStyle: "italic", padding: "8px 0" }}>No parent details added</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {(form.parents || []).map((parent, pi) => (
                  <div key={parent.id || pi} style={{ padding: "12px 14px", background: colors.bg, borderRadius: 10, border: `1px solid ${colors.border}`, position: "relative" }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 10 }}>
                      {pi === 0 ? "Primary Contact" : "Second Contact"}
                    </div>
                    <button onClick={() => setForm(p => ({ ...p, parents: (p.parents || []).filter((_, i) => i !== pi) }))}
                      style={{ position: "absolute", top: 8, right: 10, border: "none", background: "none", color: colors.textMuted, cursor: "pointer", lineHeight: 1, display: "inline-flex", alignItems: "center" }}
                      title="Remove"><X size={14} /></button>
                    <div style={{ display: "flex", gap: 10, marginBottom: 8 }}>
                      <div style={{ flex: 1 }}>
                        <Input label="Name" value={parent.name} onChange={v => setForm(p => ({ ...p, parents: (p.parents || []).map((pr, i) => i === pi ? { ...pr, name: v } : pr) }))} placeholder={form.schoolId === "__private__" ? "Contact name (optional)" : "Parent or guardian name"} />
                      </div>
                      <div style={{ width: 140 }}>
                        <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: colors.textLight, marginBottom: 4 }}>Relationship</label>
                        <select value={parent.relationship || ""} onChange={e => setForm(p => ({ ...p, parents: (p.parents || []).map((pr, i) => i === pi ? { ...pr, relationship: e.target.value } : pr) }))}
                          style={{ width: "100%", padding: "8px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit" }}>
                          <option value="">Select…</option>
                          <option value="Mother">Mother</option>
                          <option value="Father">Father</option>
                          <option value="Guardian">Guardian</option>
                          <option value="Carer">Carer</option>
                          <option value="Other">Other</option>
                        </select>
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 10 }}>
                      <div style={{ flex: 1 }}>
                        <Input label="Email" value={parent.email} onChange={v => setForm(p => ({ ...p, parents: (p.parents || []).map((pr, i) => i === pi ? { ...pr, email: v } : pr) }))} placeholder="parent@example.com" />
                      </div>
                      <div style={{ flex: 1 }}>
                        <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: colors.textLight, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>Phone</label>
                        <div style={{ display: "flex", gap: 0, borderRadius: 8, overflow: "hidden", border: `1px solid ${colors.inputBorder}` }}>
                          <input value={parent.phone} onChange={e => setForm(p => ({ ...p, parents: (p.parents || []).map((pr, i) => i === pi ? { ...pr, phone: e.target.value } : pr) }))} placeholder="04xx xxx xxx"
                            style={{ flex: 1, padding: "8px 12px", border: "none", fontSize: 13, fontFamily: "inherit", color: colors.text, background: colors.cardBg, outline: "none" }} />
                          <button
                            onClick={() => setForm(p => ({ ...p, parents: (p.parents || []).map((pr, i) => i === pi ? { ...pr, sharePhone: !pr.sharePhone } : pr) }))}
                            title={parent.sharePhone ? "Phone shared with teachers — click to hide" : "Phone not shared with teachers — click to share"}
                            style={{ padding: "0 10px", border: "none", borderLeft: `1px solid ${colors.inputBorder}`, background: parent.sharePhone ? colors.sidebarActive : colors.cardBg, color: parent.sharePhone ? "#fff" : colors.textMuted, fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap", transition: "background 0.15s, color 0.15s" }}>
                            Share with staff
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Enrolments subsection (Commit 2b) */}
          {(() => {
            const isArchived = form.status === "archived";
            const activeFormEnrolments = formEnrolments.filter(e => !e.endDate);
            const endedFormEnrolments = formEnrolments
              .filter(e => e.endDate)
              .sort((a, b) => (b.endDate || "").localeCompare(a.endDate || ""));
            const existingActiveInstruments = new Set(activeFormEnrolments.map(e => e.instrument));
            const addableInstruments = availableInstruments.filter(i => !existingActiveInstruments.has(i));
            const formatDate = (iso) => iso ? new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "";

            return (
              <div style={{ marginBottom: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <label style={{ fontSize: 12, fontWeight: 600, color: colors.textLight, textTransform: "uppercase", letterSpacing: 0.5 }}>Enrolments</label>
                  {!isArchived && !isAddingEnrolment && (
                    <Btn variant="ghost" onClick={() => { setIsAddingEnrolment(true); setNewEnrolmentDraft({ instrument: "", isGroup: false }); }} style={{ fontSize: 12 }}>
                      + Add enrolment
                    </Btn>
                  )}
                </div>

                {activeFormEnrolments.length === 0 && !isAddingEnrolment && (
                  <div style={{ fontSize: 12, color: colors.textMuted, fontStyle: "italic", padding: "8px 0" }}>No enrolments</div>
                )}

                {activeFormEnrolments.map(e => (
                  e.isGroup ? (
                    // Group enrolment — read-only; editing lives in the Groups view
                    <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", marginBottom: 6, background: colors.bg, borderRadius: 8, border: `1px solid ${colors.border}` }}>
                      <Tag color={getInstColor(e.instrument, true)}>
                        <span style={{ display: "inline-flex", alignItems: "center", marginRight: 3 }}><Users size={10} /></span>{e.instrument}
                      </Tag>
                      <span style={{ fontSize: 12, color: colors.textMuted, fontStyle: "italic" }}>Group enrolment</span>
                      {!isArchived && (
                        <button
                          onClick={() => notify("Edit group enrolments via Students › Groups", "info")}
                          style={{ marginLeft: "auto", border: "none", background: "none", color: colors.textMuted, fontSize: 12, cursor: "pointer", textDecoration: "underline", fontFamily: "inherit" }}>
                          Edit via Groups
                        </button>
                      )}
                    </div>
                  ) : (
                    // Individual enrolment — editable unless form is for an archived student
                    <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", marginBottom: 6, background: colors.bg, borderRadius: 8, border: `1px solid ${colors.border}` }}>
                      <Tag color={getInstColor(e.instrument, false)}>{e.instrument}</Tag>
                      {isArchived ? (
                        <>
                          <span style={{ fontSize: 12, color: colors.text }}>
                            {getStudentMTTTeacher(form.id, e.instrument, timetable, students, teachers, enrolments, teacherCoverage)?.teacherName || "—"}
                          </span>
                          <span style={{ fontSize: 11, color: colors.textMuted, marginLeft: "auto" }}>{formatDate(e.startDate)}</span>
                        </>
                      ) : (
                        <>
                          <span style={{ fontSize: 11, color: colors.textMuted, marginLeft: "auto" }}>{formatDate(e.startDate)}</span>
                          <button onClick={() => setEndingEnrolment(e)}
                            style={{ padding: "4px 10px", border: `1px solid ${colors.border}`, borderRadius: 6, background: "none", color: colors.danger, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}
                            onMouseEnter={ev => { ev.currentTarget.style.background = colors.redLight; ev.currentTarget.style.borderColor = colors.danger; }}
                            onMouseLeave={ev => { ev.currentTarget.style.background = "none"; ev.currentTarget.style.borderColor = colors.border; }}>
                            End enrolment
                          </button>
                        </>
                      )}
                    </div>
                  )
                ))}

                {/* Inline add row */}
                {isAddingEnrolment && (
                  <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", marginBottom: 6, background: colors.accentLight, borderRadius: 8, border: `1px dashed ${colors.accent}` }}>
                    <select
                      value={newEnrolmentDraft.instrument}
                      onChange={ev => setNewEnrolmentDraft(d => ({ ...d, instrument: ev.target.value }))}
                      disabled={addableInstruments.length === 0}
                      style={{ padding: "5px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 12, fontFamily: "inherit", flex: 1 }}>
                      {addableInstruments.length === 0 && <option value="">All instruments already enrolled.</option>}
                      {addableInstruments.length > 0 && <option value="">Select instrument…</option>}
                      {addableInstruments.map(i => <option key={i} value={i}>{i}</option>)}
                    </select>
                    <label style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer", padding: "5px 10px", border: `1px solid ${newEnrolmentDraft.isGroup ? colors.accent : colors.inputBorder}`, borderRadius: 6, background: newEnrolmentDraft.isGroup ? colors.accentLight : "transparent", transition: "background 0.15s, border-color 0.15s", flexShrink: 0 }}
                      title="Mark as group enrolment (waiting for a group to form, or joining an existing group)">
                      <input type="checkbox" checked={!!newEnrolmentDraft.isGroup}
                        onChange={e => setNewEnrolmentDraft(d => ({ ...d, isGroup: e.target.checked }))}
                        style={{ margin: 0, cursor: "pointer" }} />
                      <Users size={12} color={newEnrolmentDraft.isGroup ? colors.accentDark : colors.textMuted} />
                      <span style={{ fontSize: 12, fontWeight: 600, color: newEnrolmentDraft.isGroup ? colors.accentDark : colors.textLight }}>Group</span>
                    </label>
                    <Btn
                      onClick={() => {
                        if (!newEnrolmentDraft.instrument) { notify("Pick an instrument", "warning"); return; }
                        setFormEnrolments(prev => [...prev, {
                          id: uid(),
                          studentId: form.id,
                          instrument: newEnrolmentDraft.instrument,
                          isGroup: newEnrolmentDraft.isGroup,
                          groupId: undefined,
                          startDate: new Date().toISOString().split("T")[0],
                          endDate: undefined,
                        }]);
                        setIsAddingEnrolment(false);
                        setNewEnrolmentDraft({ instrument: "", isGroup: false });
                      }}
                      disabled={addableInstruments.length === 0 || !newEnrolmentDraft.instrument}
                      style={{ fontSize: 12 }}>
                      Save
                    </Btn>
                    <Btn variant="secondary" onClick={() => { setIsAddingEnrolment(false); setNewEnrolmentDraft({ instrument: "", isGroup: false }); }} style={{ fontSize: 12 }}>Cancel</Btn>
                  </div>
                )}

                {/* History subsection (collapsible) */}
                {endedFormEnrolments.length > 0 && (
                  <div style={{ marginTop: 12 }}>
                    <button onClick={() => setHistoryExpanded(v => !v)}
                      style={{ display: "inline-flex", alignItems: "center", gap: 4, border: "none", background: "none", color: colors.textMuted, fontSize: 12, fontWeight: 600, cursor: "pointer", padding: 0, fontFamily: "inherit" }}>
                      <ChevronRight size={13} style={{ transform: historyExpanded ? "rotate(90deg)" : "none", transition: "transform 0.15s" }} />
                      History
                    </button>
                    {historyExpanded && (
                      <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
                        {endedFormEnrolments.map(e => {
                          const mttT = getStudentMTTTeacher(form.id, e.instrument, timetable, students, teachers, enrolments, teacherCoverage);
                          return (
                            <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 10px", background: colors.bg, borderRadius: 6, border: `1px solid ${colors.border}`, opacity: 0.8 }}>
                              <Tag color={getInstColor(e.instrument, e.isGroup)}>
                                {e.isGroup ? <span style={{ display: "inline-flex", alignItems: "center", marginRight: 3 }}><Users size={10} /></span> : null}{e.instrument}
                              </Tag>
                              <span style={{ fontSize: 12, color: colors.text }}>{mttT?.teacherName || "—"}</span>
                              <span style={{ fontSize: 11, color: colors.textMuted, marginLeft: "auto" }}>{formatDate(e.startDate)} – {formatDate(e.endDate)}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })()}

          <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
            <Btn onClick={saveStudent}>Save Student</Btn>
            <Btn variant="secondary" onClick={() => { setForm(null); setEditing(null); setFormEnrolments([]); if (onReturn) onReturn(); }}>Cancel</Btn>
          </div>
        </Card>

        {/* Merge prompt modal */}
        {mergePrompt && (
          <div style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center" }}
            onClick={() => setMergePrompt(null)}>
            <div style={{ background: colors.cardBg, borderRadius: 14, padding: 28, maxWidth: 460, width: "90%", boxShadow: "0 8px 32px rgba(0,0,0,0.18)" }}
              onClick={e => e.stopPropagation()}>
              <div style={{ fontWeight: 700, fontSize: 15, color: colors.sidebarActive, marginBottom: 10 }}>
                Merge into existing student?
              </div>
              <div style={{ fontSize: 13, color: colors.text, lineHeight: 1.65, marginBottom: 20 }}>
                <strong>{mergePrompt.targetStudent.name}</strong> already exists as an active student.
                <br /><br />
                Merge <strong>{formEnrolments.filter(e => e.studentId === mergePrompt.pendingStudent.id).map(e => e.instrument).filter(Boolean).join(", ")}</strong> into their profile and remove this duplicate record?
              </div>
              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                <Btn variant="secondary" onClick={handleActivateWithoutMerge}>Keep as Separate Student</Btn>
                <Btn onClick={handleMerge}><span style={{display:"inline-flex",alignItems:"center",gap:5}}><Check size={13}/>Merge Instruments</span></Btn>
              </div>
            </div>
          </div>
        )}

        {/* End-enrolment confirmation modal */}
        {endingEnrolment && (
          <div style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center" }}
            onClick={() => setEndingEnrolment(null)}>
            <div style={{ background: colors.cardBg, borderRadius: 14, padding: 28, maxWidth: 460, width: "90%", boxShadow: "0 8px 32px rgba(0,0,0,0.18)" }}
              onClick={ev => ev.stopPropagation()}>
              <div style={{ fontWeight: 700, fontSize: 15, color: colors.danger, marginBottom: 10 }}>
                End {endingEnrolment.instrument} enrolment?
              </div>
              <div style={{ fontSize: 13, color: colors.text, lineHeight: 1.65, marginBottom: 20 }}>
                This will end {form?.name || "this student"}'s {endingEnrolment.instrument} enrolment when you save. This is permanent — if {form?.name || "this student"} takes {endingEnrolment.instrument} again, it will be a new enrolment.
              </div>
              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                <Btn variant="secondary" onClick={() => setEndingEnrolment(null)}>Cancel</Btn>
                <button onClick={() => {
                  const todayISO = new Date().toISOString().split("T")[0];
                  setFormEnrolments(prev => prev.map(x => x.id === endingEnrolment.id ? { ...x, endDate: todayISO } : x));
                  setEndingEnrolment(null);
                }}
                  style={{ padding: "8px 16px", border: "none", borderRadius: 8, background: colors.danger, color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
                  End enrolment
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <PageTitle subtitle={
          studentTab === "groups"
            ? `${groupsCount} ${groupsCount === 1 ? "group" : "groups"}`
            : students.filter(s => s.status === "active").length + " active" +
              (students.filter(s => s.status === "pending").length > 0 ? " · " + students.filter(s => s.status === "pending").length + " pending" : "") +
              (students.filter(s => s.status === "trial").length > 0 ? " · " + students.filter(s => s.status === "trial").length + " trial" : "")
        }
        pageColor={PAGE_COLORS.students}
        action={<div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {studentTab === "individuals" && <div style={{ position: "relative", display: "inline-block" }}
            onMouseEnter={e => { const t = e.currentTarget.querySelector(".import-tooltip"); if (t) t.style.display = "block"; }}
            onMouseLeave={e => { const t = e.currentTarget.querySelector(".import-tooltip"); if (t) t.style.display = "none"; }}>
            <Btn variant="secondary" onClick={() => openImport("spreadsheet")}>Import</Btn>
            <div className="import-tooltip" style={{
              display: "none", position: "absolute", top: "calc(100% + 8px)", right: 0,
              width: 340, background: colors.cardBg, border: "1px solid " + colors.border,
              borderRadius: 10, boxShadow: "0 8px 24px rgba(0,0,0,0.12)", padding: "14px 16px",
              zIndex: 200, color: colors.text, fontSize: 12, lineHeight: 1.6,
            }}>
              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8, color: colors.sidebarActive }}><span style={{display:"inline-flex",alignItems:"center",gap:5}}><ClipboardList size={13}/>Spreadsheet Import Format</span></div>
              <div style={{ marginBottom: 8 }}>
                <span style={{ fontWeight: 600 }}>Required columns:</span><br/>
                <code style={{ background: colors.bg, borderRadius: 4, padding: "1px 5px", fontSize: 11 }}>name</code> &nbsp;
                <code style={{ background: colors.bg, borderRadius: 4, padding: "1px 5px", fontSize: 11 }}>school</code> &nbsp;
                <code style={{ background: colors.bg, borderRadius: 4, padding: "1px 5px", fontSize: 11 }}>class</code> &nbsp;
                <code style={{ background: colors.bg, borderRadius: 4, padding: "1px 5px", fontSize: 11 }}>instrument</code>
              </div>
              <div style={{ marginBottom: 8 }}>
                <span style={{ fontWeight: 600 }}>Optional columns:</span><br/>
                <code style={{ background: colors.bg, borderRadius: 4, padding: "1px 5px", fontSize: 11 }}>instrument2</code> &nbsp;
                <code style={{ background: colors.bg, borderRadius: 4, padding: "1px 5px", fontSize: 11 }}>teacher</code> &nbsp;
                <code style={{ background: colors.bg, borderRadius: 4, padding: "1px 5px", fontSize: 11 }}>status</code> <span style={{ color: colors.textMuted }}>(active/pending/trial)</span>
              </div>
              <div style={{ marginBottom: 8 }}>
                <span style={{ fontWeight: 600 }}>Constraint columns</span> <span style={{ color: colors.textMuted }}>(yes/no):</span><br/>
                <code style={{ background: colors.bg, borderRadius: 4, padding: "1px 5px", fontSize: 11 }}>outsideClassOnly</code> &nbsp;
                <code style={{ background: colors.bg, borderRadius: 4, padding: "1px 5px", fontSize: 11 }}>outsideClassPreferred</code> &nbsp;
                <code style={{ background: colors.bg, borderRadius: 4, padding: "1px 5px", fontSize: 11 }}>availableBefore</code> &nbsp;
                <code style={{ background: colors.bg, borderRadius: 4, padding: "1px 5px", fontSize: 11 }}>availableAfter</code>
              </div>
              <div>
                <code style={{ background: colors.bg, borderRadius: 4, padding: "1px 5px", fontSize: 11 }}>notes</code> <span style={{ color: colors.textMuted }}>— any scheduling notes</span>
              </div>
            </div>
          </div>}
          <Btn onClick={studentTab === "groups" ? onAddGroup : newStudent}><span style={{display:"inline-flex",alignItems:"center",gap:5}}><Plus size={13}/>Add</span></Btn>
        </div>}
        navButtons={<NavButtons goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}>
        Students
      </PageTitle>

      {/* Individuals | Groups | Waiting List segmented toggle — between header
          band and body. Three equal-width, centre-aligned segments. */}
      <div style={{ display: "flex", width: 390, border: "2px solid " + colors.sidebarActive, borderRadius: 10, overflow: "hidden", marginBottom: 16 }}>
        {[{ id: "individuals", label: "Individuals" }, { id: "groups", label: "Groups" }, { id: "pending", label: "Waiting List" }].map(t => (
          <button key={t.id} onClick={() => setStudentTab(t.id)}
            style={{ flex: 1, textAlign: "center", padding: "8px 0", border: "none", fontSize: 13, fontFamily: "inherit", cursor: "pointer", fontWeight: 600, background: studentTab === t.id ? colors.sidebarActive : "transparent", color: studentTab === t.id ? colors.accent : colors.textMuted, transition: "background 0.15s, color 0.15s" }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Waiting List tab renders the existing PendingManager (embedded) wired
          from App.js — its full controls/logic are reused, not duplicated. */}
      {studentTab === "pending" && waitingListSlot}
      {studentTab === "groups" && groupsView}
      {studentTab === "individuals" && (<>{/* ── Individuals side: existing Students table ── */}

      {/* ── Add-parent student picker banner ── */}
      {pickingStudentForParent && (
        <div style={{ margin: "0 0 12px 0", padding: "14px 18px", background: colors.accentLight, border: `1px solid ${colors.accent}`, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div>
            <span style={{ fontWeight: 700, fontSize: 13, color: colors.accentDark }}>Select the student to add this parent to:</span>
            {parentPrefillRef.current && (
              <span style={{ marginLeft: 10, fontSize: 12, color: colors.accentDark }}>
                {parentPrefillRef.current.name && <strong>{parentPrefillRef.current.name}</strong>}
                {parentPrefillRef.current.name && parentPrefillRef.current.email && " · "}
                {parentPrefillRef.current.email}
              </span>
            )}
          </div>
          <button onClick={() => { setPickingStudentForParent(false); parentPrefillRef.current = null; }}
            style={{ background: "none", border: "none", cursor: "pointer", color: colors.accentDark, lineHeight: 1, padding: 0, flexShrink: 0, display: "inline-flex", alignItems: "center" }}><X size={16} /></button>
        </div>
      )}
        <Card style={{ marginBottom: 10, padding: "10px 14px" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "nowrap" }}>
            <div style={{ flex: "1 1 140px", minWidth: 0, position: "relative" }}>
              <input value={filter.search} onChange={e => setFilter(p => ({ ...p, search: e.target.value }))} placeholder="Search name..."
                style={{ width: "100%", padding: "6px 28px 6px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 7, fontSize: 12, fontFamily: "inherit", boxSizing: "border-box" }} />
              {filter.search && (
                <button onClick={() => setFilter(p => ({ ...p, search: "" }))}
                  style={{ position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)", border: "none", background: "none", color: colors.textMuted, cursor: "pointer", lineHeight: 1, padding: 0, display: "inline-flex", alignItems: "center" }}><X size={13} /></button>
              )}
            </div>
            <select value={filter.school} onChange={e => setFilter(p => ({ ...p, school: e.target.value, className: "" }))}
              style={{ flex: "0 0 auto", padding: "6px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 7, fontSize: 12, fontFamily: "inherit" }}>
              <option value="">All Schools</option>
              {schools.map(s => <option key={s.id} value={s.id}>{s.name.split(" ").filter(w => /^[A-Z]/.test(w)).map(w => w[0]).join("") || s.name}</option>)}
              <option value="__private__">Private</option>
            </select>
            <select value={filter.className} onChange={e => setFilter(p => ({ ...p, className: e.target.value }))}
              style={{ flex: "0 0 auto", padding: "6px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 7, fontSize: 12, fontFamily: "inherit" }}>
              <option value="">All Classes</option>
              {[...new Set(activeStudents
                .filter(s => !filter.school || s.schoolId === filter.school)
                .map(s => s.className).filter(Boolean))]
                .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
                .map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <select value={filter.instrument} onChange={e => setFilter(p => ({ ...p, instrument: e.target.value }))}
              style={{ flex: "0 1 120px", minWidth: 0, padding: "6px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 7, fontSize: 12, fontFamily: "inherit" }}>
              <option value="">All Instruments</option>
              {(() => {
                const activeIds = new Set(activeStudents.map(s => s.id));
                return [...new Set([
                  ...(availableInstruments),
                  ...enrolments.filter(e => !e.endDate && activeIds.has(e.studentId)).map(e => e.instrument).filter(Boolean)
                ])].sort().map(i => <option key={i} value={i}>{i}</option>);
              })()}
            </select>
            <select value={filter.teacher} onChange={e => setFilter(p => ({ ...p, teacher: e.target.value }))}
              style={{ flex: "0 1 120px", minWidth: 0, padding: "6px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 7, fontSize: 12, fontFamily: "inherit" }}>
              <option value="">All Teachers</option>
              <option value="_none_">No teacher</option>
              {teachers.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <button onClick={() => setFilter(p => ({ ...p, hasNote: !p.hasNote }))}
              title="Show only students with a note"
              style={{ flex: "0 0 auto", padding: "6px 10px", border: `1px solid ${filter.hasNote ? colors.accent : colors.inputBorder}`, borderRadius: 7, fontSize: 12, fontFamily: "inherit", cursor: "pointer", background: filter.hasNote ? colors.accent : colors.cardBg, color: filter.hasNote ? colors.cardBg : colors.textMuted, fontWeight: filter.hasNote ? 700 : 400, whiteSpace: "nowrap" }}>
              <StickyNote size={12} style={{marginRight:4,display:"inline-flex",verticalAlign:"middle"}} />Has note
            </button>
            <button onClick={() => setFilter(p => ({ ...p, hasWarning: p.hasWarning ? "" : "any" }))}
              title="Show only students with missing data (teacher, instrument, parent, class, or school)"
              style={{ flex: "0 0 auto", padding: "6px 10px", border: `1px solid ${filter.hasWarning ? colors.danger : colors.inputBorder}`, borderRadius: 7, fontFamily: "inherit", cursor: "pointer", background: filter.hasWarning ? colors.redLight : colors.cardBg, color: filter.hasWarning ? colors.danger : colors.textMuted, fontWeight: filter.hasWarning ? 700 : 400, display: "inline-flex", alignItems: "center" }}>
              <AlertTriangle size={14} />
            </button>
          </div>
        </Card>

      {activeStudents.length === 0 ? (
        <EmptyState icon={<GraduationCap size={32} />} title="No students yet" subtitle="Add students manually or import from a spreadsheet (CSV or Excel)." action="+ Add Student" onAction={newStudent} />
      ) : (
        <>
          <div style={{ fontSize: 12, color: colors.textMuted, marginBottom: 6 }}>Showing {filtered.length} of {activeStudents.length} students</div>
          <div style={{ background: colors.cardBg, border: `1px solid ${colors.border}`, borderRadius: 12, overflow: "hidden", display: "flex", flexDirection: "column", maxHeight: "calc(100vh - 210px)" }}>
            <div style={{ overflowY: "auto", flex: 1 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
              <thead style={{ position: "sticky", top: 0, zIndex: 10 }}>
                <tr style={{ background: colors.sidebarHover, borderBottom: `1px solid ${colors.sidebarHover}` }}>
                  {[
                    { key: "name", label: "Name" },
                    { key: "school", label: "School" },
                    { key: "class", label: "Class" },
                    { key: "instrument", label: "Instrument(s)" },
                    { key: "teacher", label: "Teacher" },
                    { key: null, label: "Constraints" },
                    { key: null, label: "" }
                  ].map((col, ci) => (
                    <th key={ci}
                      onClick={col.key ? () => handleSort(col.key) : undefined}
                      style={{
                        padding: "10px 14px", textAlign: "left", fontSize: 11, fontWeight: 600,
                        color: sortCol === col.key ? colors.accent : "rgba(255,255,255,0.6)",
                        textTransform: "uppercase", letterSpacing: 0.5,
                        cursor: col.key ? "pointer" : "default",
                        userSelect: "none",
                        width: ci === 0 ? "18%" : ci === 1 ? "8%" : ci === 2 ? "7%" : ci === 3 ? "16%" : ci === 4 ? "20%" : ci === 5 ? "22%" : 72,
                      }}>
                      {col.label}{sortCol === col.key ? (sortDir === "asc" ? <ChevronUp size={10} style={{marginLeft:3,display:"inline-flex",verticalAlign:"middle"}} /> : <ChevronDown size={10} style={{marginLeft:3,display:"inline-flex",verticalAlign:"middle"}} />) : ""}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedFiltered.map(s => {
                  const school = schools.find(sc => sc.id === s.schoolId);
                  const active = activeEnrolmentsFor(s.id, enrolments);
                  const primary = primaryEnrolmentFor(s.id, enrolments);
                  const noteOpen = expandedStudentNotes.has(s.id);
                  const hasNote = !!(s.notes && s.notes.trim());
                  return (
                    <React.Fragment key={s.id}>
                    <tr ref={s.id === editing ? focusRowRef : null} style={{ borderBottom: noteOpen ? "none" : `1px solid ${colors.borderLight}`, cursor: "pointer", opacity: s.status !== "active" ? 0.6 : 1 }}
                      onClick={() => editStudent(s)}
                      onContextMenu={e => { e.preventDefault(); setStudentCtxMenu({ x: e.clientX, y: e.clientY, student: s }); }}
                      onMouseEnter={e => e.currentTarget.style.background = colors.bg}
                      onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                      <td style={{ padding: "10px 14px", fontWeight: 500 }}>{s.name}</td>
                      <td style={{ padding: "10px 14px", color: colors.textLight }}>{s.schoolId === "__private__" ? <span style={{ fontSize: 11, fontWeight: 700, color: colors.accent, background: colors.accentLight, borderRadius: 4, padding: "2px 6px" }}>Private</span> : school ? school.name.split(" ").filter(w => /^[A-Z]/.test(w) || w.length <= 3).map(w => w[0]).join("") || school.name.slice(0, 4).toUpperCase() : "—"}</td>
                      <td style={{ padding: "10px 14px", color: colors.textLight }}>{s.className || "—"}</td>
                      <td style={{ padding: "10px 14px" }}>
                        {active.map(e => (
                          <Tag key={e.id} color={getInstColor(e.instrument, e.isGroup)}>{e.isGroup ? <span style={{display:"inline-flex",alignItems:"center",marginRight:3}}><Users size={10}/></span> : ""}{e.instrument}</Tag>
                        ))}
                      </td>
                      <td style={{ padding: "10px 14px", color: colors.textLight, fontSize: 13 }}>
                        {(() => {
                          const indInsts = active.filter(e => !e.isGroup);
                          if (!indInsts.length) return <span style={{ color: colors.textMuted, fontStyle: "italic" }}>—</span>;
                          const isPrivate = s.schoolId === "__private__";
                          const parts = indInsts.map(e => {
                            const mttT = getStudentMTTTeacher(s.id, e.instrument, timetable, students, teachers, enrolments, teacherCoverage);
                            if (!mttT?.teacherName) return isPrivate
                              ? <span key={e.id} style={{ color: colors.textMuted, fontStyle: "italic" }}>—</span>
                              : <span key={e.id} style={{ color: colors.danger, fontStyle: "italic" }}>Unassigned</span>;
                            return <span key={e.id}>{mttT.teacherName}</span>;
                          });
                          return parts.reduce((acc, el, idx) => idx === 0 ? [el] : [...acc, <span key={"sep"+idx} style={{ color: colors.borderLight }}> / </span>, el], []);
                        })()}
                      </td>
                      <td style={{ padding: "10px 14px", fontSize: 12, color: colors.textMuted }}>
                        {s.outsideClassOnly && <Tag color={colors.accent}>Outside class only</Tag>}
                        {s.outsideClassPreferred && <Tag color="#F59E0B">Outside class pref.</Tag>}
                        {s.availableBefore && <Tag color={colors.sidebarActive}>Before school</Tag>}
                        {s.availableAfter && <Tag color={colors.sidebarActive}>After school</Tag>}
                        {active.some(e => e.isGroup) && <Tag color={instruments_colors.Group}>Group</Tag>}
                        {(() => {
                          const isPrivate = s.schoolId === "__private__";
                          const warns = [];
                          if (!active.length) warns.push("No instrument");
                          else if (!isPrivate) active.filter(e => !e.isGroup && !mttTeacherIdx.has(`${s.id}:${(e.instrument || "").trim().toLowerCase()}`)).forEach(e => warns.push(`No teacher (${e.instrument})`));
                          if (!isPrivate) {
                            if (!(s.parents || []).length) warns.push("No parent");
                            else if (!(s.parents || []).some(p => p.email)) warns.push("Parent missing email");
                            if (!s.className) warns.push("No class");
                            if (!s.schoolId) warns.push("No school");
                          }
                          return warns.map((w, wi) => (
                            <Tag key={wi} color={colors.danger}><span style={{display:"inline-flex",alignItems:"center",gap:3}}><AlertTriangle size={10}/>{w}</span></Tag>
                          ));
                        })()}
                      </td>
                      <td style={{ padding: "10px 8px", width: 82 }}>
                        <div style={{ display: "flex", gap: 4, alignItems: "center", justifyContent: "flex-end" }}>
                          <button data-expand-toggle="true"
                            onClick={(e) => { e.stopPropagation(); toggleStudentNote(s.id); }}
                            onMouseEnter={e => { e.stopPropagation(); setStudentNoteTooltip({ text: hasNote ? s.notes.slice(0, 80) : "Add note", x: e.clientX, y: e.clientY }); }}
                            onMouseLeave={() => setStudentNoteTooltip(null)}
                            title={hasNote ? s.notes.slice(0, 80) : "Add note"}
                            style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 30, height: 30, borderRadius: 6, background: noteOpen ? colors.sidebarActive : hasNote ? colors.accentLight : colors.cardBg, border: `1px solid ${noteOpen ? colors.sidebarActive : hasNote ? colors.accent : colors.border}`, color: noteOpen ? colors.cardBg : hasNote ? colors.accent : colors.textMuted, cursor: "pointer", flexShrink: 0 }}>
                            <StickyNote size={13} />
                          </button>
                          {(() => {
                            const primaryParent = (s.parents || []).find(p => p.isPrimary) || (s.parents || [])[0];
                            return primaryParent?.email ? (
                              <button onClick={e => { e.stopPropagation(); openCompose([primaryParent.email]); }}
                                title={"Email " + (primaryParent.name || "parent") + " (" + primaryParent.email + ")"}
                                style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 30, height: 30, borderRadius: 6, background: colors.sidebarActive, border: "none", color: "#fff", cursor: "pointer", flexShrink: 0 }}>
                                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>
                              </button>
                            ) : null;
                          })()}
                          <button onClick={(e) => { e.stopPropagation(); archiveStudent(s.id); }}
                            title="Archive student"
                            style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 30, height: 30, borderRadius: 6, background: colors.bg, border: `1px solid ${colors.border}`, color: colors.textMuted, cursor: "pointer", flexShrink: 0 }}
                            onMouseEnter={e => { e.currentTarget.style.borderColor = colors.accent; e.currentTarget.style.color = colors.accent; e.currentTarget.style.background = colors.accentLight; }}
                            onMouseLeave={e => { e.currentTarget.style.borderColor = colors.border; e.currentTarget.style.color = colors.textMuted; e.currentTarget.style.background = colors.bg; }}>
                            <Archive size={13} />
                          </button>
                        </div>
                      </td>
                    </tr>
                    {noteOpen && (
                      <tr style={{ borderBottom: `1px solid ${colors.borderLight}` }}>
                        <td data-expand-area="true" colSpan={7} style={{ padding: "0 14px 10px 14px" }}>
                          <div style={{ position: "relative" }}>
                            <textarea value={s.notes || ""} onChange={e => { e.stopPropagation(); updateStudentNote(s.id, e.target.value); }}
                              onClick={e => e.stopPropagation()}
                              placeholder="Notes…"
                              style={{ width: "100%", padding: "8px 32px 8px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 7, fontSize: 12, fontFamily: "inherit", resize: "vertical", minHeight: 60, color: colors.text, background: colors.cardBg, boxSizing: "border-box" }} />
                            {s.notes && s.notes.trim() && (
                              <button
                                onClick={e => { e.stopPropagation(); updateStudentNote(s.id, ""); }}
                                title="Clear note"
                                style={{ position: "absolute", top: 6, right: 6, background: "none", border: "none", cursor: "pointer", color: colors.textMuted, lineHeight: 1, padding: 2, borderRadius: 4, display: "inline-flex", alignItems: "center" }}
                                onMouseEnter={e => { e.currentTarget.style.color = colors.danger; e.currentTarget.style.background = colors.redLight; }}
                                onMouseLeave={e => { e.currentTarget.style.color = colors.textMuted; e.currentTarget.style.background = "none"; }}>
                                <X size={13} />
                              </button>
                            )}
                          </div>
                          {/* Teacher notes inline — read-only, coloured by teacher */}
                          {(s.teacher_notes || []).length > 0 && (
                            <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 5 }}>
                              {(s.teacher_notes || []).map(n => (
                                <div key={n.id} style={{ padding: "6px 10px", borderRadius: 7, background: (n.teacherColor || "#94A3B8") + "14", border: `1px solid ${(n.teacherColor || "#94A3B8") + "40"}`, borderLeft: `3px solid ${n.teacherColor || "#94A3B8"}`, fontSize: 12, color: colors.text, lineHeight: 1.5 }}>
                                  <span style={{ fontWeight: 600, color: n.teacherColor || "#94A3B8", marginRight: 6 }}>{n.teacherName || "Teacher"}:</span>
                                  {n.text}
                                  <span style={{ marginLeft: 8, fontSize: 10, color: colors.textMuted }}>{n.editedAt ? `edited ${new Date(n.editedAt).toLocaleDateString("en-AU", { day: "numeric", month: "short" })}` : n.addedAt ? new Date(n.addedAt).toLocaleDateString("en-AU", { day: "numeric", month: "short" }) : ""}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
            </div>
          </div>
        {/* ── Archived Students panel ── */}
        {archivedStudents.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <button
              onClick={() => setShowArchived(v => !v)}
              style={{ display: "flex", alignItems: "center", gap: 7, width: "100%", padding: "10px 14px", background: colors.cardBg, border: `1px solid ${colors.border}`, borderRadius: showArchived ? "10px 10px 0 0" : 10, cursor: "pointer", fontFamily: "inherit", color: colors.textMuted, fontSize: 13, fontWeight: 600 }}>
              <Archive size={14} />
              Archived Students ({archivedStudents.length})
              <ChevronRight size={13} style={{ marginLeft: "auto", transform: showArchived ? "rotate(90deg)" : "none", transition: "transform 0.15s" }} />
            </button>
            {showArchived && (
              <div style={{ background: colors.cardBg, border: `1px solid ${colors.border}`, borderTop: "none", borderRadius: "0 0 10px 10px", overflow: "hidden" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: colors.bg, borderBottom: `1px solid ${colors.border}` }}>
                      {["Name", "School", "Instruments", "Archived", ""].map((h, i) => (
                        <th key={i} style={{ padding: "8px 14px", textAlign: "left", fontSize: 11, fontWeight: 600, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {archivedStudents.sort((a, b) => a.name.localeCompare(b.name)).map(s => {
                      const school = schools.find(sc => sc.id === s.schoolId);
                      const isConfirmingDelete = archiveDeleteConfirmId === s.id;
                      return (
                        <tr key={s.id} style={{ borderBottom: `1px solid ${colors.borderLight}`, opacity: 0.75 }}>
                          <td style={{ padding: "9px 14px", fontWeight: 500, color: colors.text }}>{s.name}</td>
                          <td style={{ padding: "9px 14px", color: colors.textMuted, fontSize: 12 }}>
                            {s.schoolId === "__private__" ? <span style={{ fontSize: 11, fontWeight: 700, color: colors.accent }}>Private</span> : school ? school.name.split(" ").filter(w => /^[A-Z]/.test(w) || w.length <= 3).map(w => w[0]).join("") || school.name.slice(0, 4).toUpperCase() : "—"}
                          </td>
                          <td style={{ padding: "9px 14px" }}>
                            {allEnrolmentsFor(s.id, enrolments).map(e => (
                              <Tag key={e.id} color={getInstColor(e.instrument, e.isGroup)}>{e.instrument}</Tag>
                            ))}
                          </td>
                          <td style={{ padding: "9px 14px", color: colors.textMuted, fontSize: 12 }}>
                            {s.archivedAt ? new Date(s.archivedAt).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "—"}
                          </td>
                          <td style={{ padding: "9px 8px" }}>
                            <div style={{ display: "flex", gap: 6, alignItems: "center", justifyContent: "flex-end" }}>
                              {!isConfirmingDelete ? (
                                <>
                                  <button onClick={() => restoreStudent(s.id)} title="Restore to pending"
                                    style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "5px 10px", border: `1px solid ${colors.border}`, borderRadius: 6, background: colors.cardBg, color: colors.textMuted, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}
                                    onMouseEnter={e => { e.currentTarget.style.borderColor = colors.accent; e.currentTarget.style.color = colors.accent; e.currentTarget.style.background = colors.accentLight; }}
                                    onMouseLeave={e => { e.currentTarget.style.borderColor = colors.border; e.currentTarget.style.color = colors.textMuted; e.currentTarget.style.background = colors.cardBg; }}>
                                    <RotateCcw size={12} /> Restore
                                  </button>
                                  <button onClick={() => setArchiveDeleteConfirmId(s.id)} title="Delete permanently"
                                    style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 28, height: 28, borderRadius: 6, background: "none", border: `1px solid ${colors.border}`, color: colors.textMuted, cursor: "pointer", flexShrink: 0 }}
                                    onMouseEnter={e => { e.currentTarget.style.borderColor = colors.danger; e.currentTarget.style.color = colors.danger; e.currentTarget.style.background = colors.redLight; }}
                                    onMouseLeave={e => { e.currentTarget.style.borderColor = colors.border; e.currentTarget.style.color = colors.textMuted; e.currentTarget.style.background = "none"; }}>
                                    <Trash2 size={13} />
                                  </button>
                                </>
                              ) : (
                                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                  <span style={{ fontSize: 12, color: colors.textMuted }}>Delete permanently?</span>
                                  <button onClick={() => { deleteStudent(s.id); setArchiveDeleteConfirmId(null); }}
                                    style={{ padding: "4px 10px", border: "none", borderRadius: 6, background: colors.danger, color: "#fff", fontSize: 12, cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}>Delete</button>
                                  <button onClick={() => setArchiveDeleteConfirmId(null)}
                                    style={{ padding: "4px 10px", border: `1px solid ${colors.border}`, borderRadius: 6, background: "none", fontSize: 12, cursor: "pointer", fontFamily: "inherit", color: colors.textMuted }}>Cancel</button>
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {studentNoteTooltip && (
          <div style={{ position: "fixed", left: studentNoteTooltip.x + 12, top: studentNoteTooltip.y - 8, background: "#1B2432", color: "#fff", fontSize: 11, padding: "5px 9px", borderRadius: 6, zIndex: 9999, maxWidth: 220, pointerEvents: "none", whiteSpace: "pre-wrap", lineHeight: 1.4 }}>
            {studentNoteTooltip.text}
          </div>
        )}
        {studentCtxMenu && onAddMemory && (() => {
          const s = studentCtxMenu.student;
          const school = schools.find(sc => sc.id === s.schoolId);
          const instrs = allEnrolmentsFor(s.id, enrolments).map(e => {
            const mttT = getStudentMTTTeacher(s.id, e.instrument, timetable, students, teachers, enrolments, teacherCoverage);
            return `${e.instrument}${mttT?.teacherName ? ` with ${mttT.teacherName}` : ""}${e.endDate ? " (ended)" : ""}`;
          }).join(", ");
          const namePart = s.name;
          const schoolPart = school ? school.name : "";
          const classPart = s.className || "";
          const memText = [
            `Student: ${namePart}`,
            schoolPart && `school: ${schoolPart}`,
            classPart && `class: ${classPart}`,
            instrs && `instruments: ${instrs}`,
            s.notes && `note: ${s.notes.trim()}`,
          ].filter(Boolean).join(" — ");
          const menuY = studentCtxMenu.y + 160 > window.innerHeight ? studentCtxMenu.y - 44 : studentCtxMenu.y;
          return (
            <>
              <div onMouseDown={() => setStudentCtxMenu(null)} style={{ position: "fixed", inset: 0, zIndex: 9998 }} />
              <div ref={studentCtxRef}
                style={{ position: "fixed", left: studentCtxMenu.x, top: menuY, zIndex: 9999, background: colors.cardBg, border: `1px solid ${colors.border}`, borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.14)", minWidth: 180, overflow: "hidden", fontFamily: "inherit" }}>
                <button
                  onClick={() => { onAddMemory(memText); setStudentCtxMenu(null); }}
                  style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "9px 14px", background: "none", border: "none", fontSize: 13, cursor: "pointer", color: colors.text, fontFamily: "inherit" }}
                  onMouseEnter={e => e.currentTarget.style.background = colors.blueLight}
                  onMouseLeave={e => e.currentTarget.style.background = "none"}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a10 10 0 1 0 0 20A10 10 0 0 0 12 2z"/><path d="M12 8v4l3 3"/></svg>
                  Add to Claude memory
                </button>
              </div>
            </>
          );
        })()}
        
        </>
      )}
      </>)}


    </div>
  );
}

// ============================================================
// TEACHERS MANAGER
// ============================================================
