// ============================================================
// STUDENTSMANAGER — extracted from App.js
// ============================================================

import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { colors, INSTRUMENTS, instruments_colors } from "../constants";
import { uid, getInstColor, getInitials } from "../utils/helpers";
import { anthropicFetch, getAnthropicHeaders } from "../utils/api";
import { parseStudentCSV } from "../data/parsers";
import { Card, PageTitle, NavButtons, Btn, Input, Tag, EmptyState, FileUpload, Checkbox, PAGE_COLORS } from "../components/ui/SharedUI";

export function StudentsManager({ students, setStudents, schools, teachers, specialists, notify, focusStudentId, onClearFocus, returnPage, onReturn, resetKey, viewState, setViewState, newStudentPrefill, onClearNewStudentPrefill, goBack, goForward, historyCursor, pageHistory }) {
  // Derive available instruments from what teachers can actually teach
  const availableInstruments = [...new Set(teachers.flatMap(t => t.instruments.map(i => i.name)))].sort();
  // Lazy initialisers: if focusStudentId is set on mount, open edit form immediately
  // (avoids the useEffect flash where the list renders first then the form opens)
  const [editing, setEditing] = useState(() => {
    if (focusStudentId) { const s = students.find(st => st.id === focusStudentId); return s ? s.id : null; }
    return null;
  });
  const [form, setForm] = useState(() => {
    if (focusStudentId) { const s = students.find(st => st.id === focusStudentId); return s ? { ...s, instruments: s.instruments.map(i => ({ ...i })) } : null; }
    return null;
  });
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
  const updateStudentNote = (id, val) => setStudents(prev => prev.map(s => s.id === id ? { ...s, notes: val } : s));

  // Clear focusStudentId after it's been consumed on mount (handled via lazy useState above)
  // This also handles the case where focusStudentId changes while the component is already mounted
  useEffect(() => {
    if (focusStudentId) {
      const student = students.find(s => s.id === focusStudentId);
      if (student) {
        setForm({ ...student, instruments: student.instruments.map(i => ({ ...i })) });
        setEditing(student.id);
      }
      if (onClearFocus) onClearFocus();
    }
  }, [focusStudentId]);

  // Open new student form pre-filled from enquiry data
  useEffect(() => {
    if (newStudentPrefill) {
      const base = { id: uid(), name: "", instruments: [{ name: "", teacherId: "" }], schoolId: "", className: "", status: "pending", parents: [], notes: "", outsideClassOnly: false, outsideClassPreferred: false, availableBefore: false, availableAfter: false, avoidTimes: [], preferredTimes: [] };
      setForm({ ...base, ...newStudentPrefill });
      setEditing("new");
      if (onClearNewStudentPrefill) onClearNewStudentPrefill();
    }
  }, [newStudentPrefill]);

  const lastResetKey = useRef(resetKey);
  useEffect(() => {
    if (resetKey === lastResetKey.current) return; // skip strict-mode double-fire and initial mount
    lastResetKey.current = resetKey;
    setEditing(null); setForm(null); setImportMode(null); setPreview(null);
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
      // Migrate student-level isGroup to instrument-level isGroup
      if (s.isGroup !== undefined) {
        changed = true;
        const { isGroup, ...rest } = s;
        return { ...rest, instruments: (rest.instruments || []).map(i => ({ ...i, isGroup: i.isGroup !== undefined ? i.isGroup : isGroup })) };
      }
      // Ensure all instruments have isGroup field
      if (s.instruments?.some(i => i.isGroup === undefined)) {
        changed = true;
        return { ...s, instruments: s.instruments.map(i => ({ ...i, isGroup: i.isGroup || false })) };
      }
      return s;
    });
    if (changed) setStudents(migrated);
  }, []);

  const activeStudents = students.filter(s => s.status === "active" || s.status === "pending" || s.status === "trial");

  const newStudent = () => {
    setForm({
      id: uid(), name: "", schoolId: "", className: "",
      instruments: [{ name: "", isGroup: false }],
      outsideClassOnly: false, outsideClassPreferred: false, availableBefore: false, availableAfter: false,
      avoidTimes: [], preferredTimes: [], status: "active", notes: "",
      parents: []
    });
    setEditing("new");
  };

  const editStudent = (student) => {
    setForm({ ...student, instruments: student.instruments.map(i => ({ ...i })) });
    setEditing(student.id);
  };

  const saveStudent = () => {
    if (!form.name.trim()) { notify("Student name required", "warning"); return; }
    if (!form.instruments[0]?.name) { notify("At least one instrument required", "warning"); return; }
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
    if (editing === "new") {
      setStudents(prev => [...prev, f]);
    } else {
      setStudents(prev => prev.map(s => s.id === f.id ? f : s));
    }
    setForm(null); setEditing(null);
    notify("Student saved!");
    if (onReturn) onReturn();
  };

  const handleMerge = () => {
    if (!mergePrompt) return;
    const { pendingStudent, targetStudent } = mergePrompt;
    // Append instruments from the pending record that aren't already on the target
    const existingInstNames = new Set((targetStudent.instruments || []).map(i => i.name.trim().toLowerCase()));
    const newInsts = (pendingStudent.instruments || []).filter(i => !existingInstNames.has(i.name.trim().toLowerCase()));
    const merged = {
      ...targetStudent,
      instruments: [...(targetStudent.instruments || []), ...newInsts],
    };
    setStudents(prev => prev
      .filter(s => s.id !== pendingStudent.id)   // remove temp pending record
      .map(s => s.id === targetStudent.id ? merged : s)
    );
    setMergePrompt(null);
    setForm(null); setEditing(null);
    notify(`Merged ${pendingStudent.instruments.map(i => i.name).join(", ")} into ${targetStudent.name}`);
    if (onReturn) onReturn();
  };

  const handleActivateWithoutMerge = () => {
    if (!mergePrompt) return;
    commitSaveStudent(mergePrompt.pendingStudent);
    setMergePrompt(null);
  };

  const deleteStudent = (id) => {
    setStudents(prev => prev.filter(s => s.id !== id));
    notify("Student removed");
  };

  const handleImport = (data, filename) => {
    const imported = parseStudentCSV(data, schools, teachers);
    if (imported.length === 0) { notify("No valid students found in file", "warning"); return; }
    setStudents(prev => [...prev, ...imported]);
    notify(`Imported ${imported.length} students from ${filename}`);
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
      const instrumentListStr = (availableInstruments.length > 0 ? availableInstruments : INSTRUMENTS).join(", ");
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

      // Helper: match teacher by full name, first name, last name, or initials
      const matchTeacher = (raw) => {
        if (!raw) return null;
        const r = raw.trim();
        const rLower = r.toLowerCase();
        // 1. Exact full name match
        let match = teachers.find(t => t.name.toLowerCase() === rLower);
        if (match) return match;
        // 2. First name match
        match = teachers.find(t => t.name.split(/\s+/)[0].toLowerCase() === rLower);
        if (match) return match;
        // 3. Last name match
        match = teachers.find(t => {
          const parts = t.name.split(/\s+/);
          return parts.length > 1 && parts[parts.length - 1].toLowerCase() === rLower;
        });
        if (match) return match;
        // 4. Initials match (e.g. "JS" matches "John Smith", "J.S." matches too)
        const rClean = r.replace(/[.\s]/g, "").toUpperCase();
        if (rClean.length >= 2 && rClean.length <= 4) {
          match = teachers.find(t => {
            const initials = t.name.split(/\s+/).map(w => w[0]).join("").toUpperCase();
            return initials === rClean;
          });
          if (match) return match;
        }
        // 5. Partial/contains match (e.g. "John S" or "J Smith")
        match = teachers.find(t => t.name.toLowerCase().includes(rLower) || rLower.includes(t.name.toLowerCase()));
        if (match) return match;
        // 6. First name starts-with (e.g. "Jo" matches "John Smith")
        match = teachers.find(t => t.name.split(/\s+/)[0].toLowerCase().startsWith(rLower));
        if (match) return match;
        return null;
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
          const matched = matchTeacher(e.teacher);
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
              const Papa = window.Papa;
              const result = window.window.Papa.parse(ev.target.result, { header: true, skipEmptyLines: true });
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
            model: "claude-sonnet-4-20250514",
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
              model: "claude-sonnet-4-20250514",
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
    setStudents(prev => [...prev, ...valid]);
    notify(`Imported ${valid.length} students from ${preview.filename}`);
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

  const filtered = activeStudents.filter(s => {
    if (filter.school && s.schoolId !== filter.school) return false;
    if (filter.className && s.className !== filter.className) return false;
    if (filter.instrument && !s.instruments.some(i => i.name === filter.instrument)) return false;
    if (filter.teacher) {
      if (filter.teacher === "_none_") {
        if (s.instruments.some(i => i.teacherId)) return false;
      } else {
        if (!s.instruments.some(i => i.teacherId === filter.teacher)) return false;
      }
    }
    if (filter.search && !s.name.toLowerCase().includes(filter.search.toLowerCase())) return false;
    if (filter.hasNote && !(s.notes && s.notes.trim())) return false;
    if (filter.hasWarning) {
      const hasUnassignedTeacher = (s.instruments || []).some(i => !i.isGroup && !i.teacherId);
      const hasMissingInstrument = !(s.instruments || []).length;
      const hasMissingParent = !(s.parents || []).length || !(s.parents || []).some(p => p.email);
      const hasMissingClass = !s.className;
      const hasMissingSchool = !s.schoolId;
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
        const aInst = a.instruments[0]?.name || "";
        const bInst = b.instruments[0]?.name || "";
        return dir * aInst.localeCompare(bInst);
      }
      case "teacher": {
        const aTid = a.instruments && a.instruments[0] && a.instruments[0].teacherId;
        const bTid = b.instruments && b.instruments[0] && b.instruments[0].teacherId;
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
              background: importMode === "pdf" ? colors.accentLight : colors.white,
              color: importMode === "pdf" ? colors.accentDark : colors.text, fontWeight: 600
            }}>📄 PDF Document</button>
            <button onClick={() => setImportMode("spreadsheet")} style={{
              flex: 1, padding: "10px 14px", borderRadius: 8, fontSize: 14, fontFamily: "inherit", cursor: "pointer",
              border: `2px solid ${importMode === "spreadsheet" ? colors.accent : colors.border}`,
              background: importMode === "spreadsheet" ? colors.accentLight : colors.white,
              color: importMode === "spreadsheet" ? colors.accentDark : colors.text, fontWeight: 600
            }}>📁 Spreadsheet (CSV/XLSX)</button>
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
        <Card style={{ background: "#FFF8F0", borderColor: colors.accent + "40" }}>
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
        <Card style={{ background: "#FEF6F6", borderColor: "#FCC" }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
            <div style={{ fontSize: 28, flexShrink: 0 }}>⚠️</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 15, color: colors.danger, marginBottom: 8 }}>
                Failed to import "{importError.filename}"
              </div>
              <div style={{ fontSize: 14, color: colors.text, lineHeight: 1.6, marginBottom: 12 }}>
                {importError.message}
              </div>
              {importError.details && (
                <div style={{ fontSize: 12, color: colors.textMuted, padding: "10px 14px", background: "#FFF", borderRadius: 8, border: "1px solid #F0E0E0", fontFamily: "monospace", whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 120, overflowY: "auto" }}>
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
                  {["Name", "School", "Class", "Instrument", "Teacher", ""].map((h, i) => (
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
                          const base = availableInstruments.length > 0 ? availableInstruments : INSTRUMENTS;
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
                      <select value={entry.instruments && entry.instruments[0] && entry.instruments[0].teacherId || ""} onChange={e => {
                        const insts = entry.instruments ? [...entry.instruments] : [{ name: "" }];
                        if (insts.length > 0) insts[0] = { ...insts[0], teacherId: e.target.value };
                        updatePreviewStudent(i, "instruments", insts);
                      }}
                        style={{ width: "100%", padding: "4px 6px", border: `1px solid ${colors.inputBorder}`, borderRadius: 4, fontSize: 12, fontFamily: "inherit" }}>
                        <option value="">Auto</option>
                        {teachers.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                      </select>
                    </td>
                    <td style={{ padding: "6px 8px" }}>
                      <button onClick={() => removePreviewStudent(i)}
                        style={{ border: "none", background: "none", color: colors.danger, cursor: "pointer", fontSize: 16 }}>×</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <div style={{ display: "flex", gap: 10 }}>
          <Btn onClick={confirmStudentImport}>✓ Import {preview.entries.length} Students</Btn>
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
            <Input label="School" value={form.schoolId} onChange={v => setForm(p => ({ ...p, schoolId: v }))}
              options={schools.map(s => ({ value: s.id, label: s.name }))} />
            <div style={{ marginBottom: 14 }}>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: colors.textLight, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>Class</label>
              <select
                value={form.className || ""}
                onChange={e => setForm(p => ({ ...p, className: e.target.value }))}
                disabled={!form.schoolId}
                style={{ width: "100%", padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", background: !form.schoolId ? colors.bg : colors.white, color: !form.schoolId ? colors.textMuted : colors.text, cursor: !form.schoolId ? "not-allowed" : "pointer" }}>
                <option value="">{form.schoolId ? "Select class..." : "Select a school first"}</option>
                {form.schoolId && [...new Set((specialists || []).filter(s => s.schoolId === form.schoolId).map(s => s.className).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map(c => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
            <Input label="Status" value={form.status} onChange={v => setForm(p => ({ ...p, status: v }))}
              options={[{ value: "active", label: "Active" }, { value: "pending", label: "Pending (Waiting List)" }, { value: "trial", label: "Trial Lesson" }]} />
          </div>

          <div style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: colors.textLight, textTransform: "uppercase", letterSpacing: 0.5 }}>Instruments</label>
              {form.instruments.length < 2 && (
                <Btn variant="ghost" onClick={() => setForm(p => ({ ...p, instruments: [...p.instruments, { name: "", isGroup: false }] }))} style={{ fontSize: 12 }}>
                  + Second Instrument
                </Btn>
              )}
            </div>
            {form.instruments.map((inst, i) => (
              <React.Fragment key={i}>
                <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 4 }}>
                  <div style={{ flex: 1 }}>
                    <Input value={inst.name} onChange={v => {
                      const insts = [...form.instruments]; insts[i] = { ...insts[i], name: v };
                      setForm(p => ({ ...p, instruments: insts }));
                    }} options={(() => {
                      const base = availableInstruments.length > 0 ? availableInstruments : INSTRUMENTS;
                      if (inst.name && !base.includes(inst.name)) return [...base, inst.name].sort();
                      return base;
                    })()} style={{ marginBottom: 0 }} />
                  </div>
                  <label style={{ display: "flex", gap: 4, alignItems: "center", fontSize: 12, color: inst.isGroup ? instruments_colors.Group : colors.textMuted, cursor: "pointer", whiteSpace: "nowrap" }}>
                    <input type="checkbox" checked={inst.isGroup || false} onChange={e => {
                      const insts = [...form.instruments]; insts[i] = { ...insts[i], isGroup: e.target.checked };
                      setForm(p => ({ ...p, instruments: insts }));
                    }} style={{ accentColor: instruments_colors.Group, width: 14, height: 14 }} />
                    Group
                  </label>
                  {i > 0 && (
                    <button onClick={() => setForm(p => ({ ...p, instruments: p.instruments.filter((_, idx) => idx !== i) }))}
                      style={{ border: "none", background: "none", color: colors.danger, cursor: "pointer", fontSize: 18 }}>×</button>
                  )}
                  {i > 0 && !inst.isGroup && <span style={{ fontSize: 11, color: colors.textMuted, whiteSpace: "nowrap" }}>↑ 2nd: specialist/break/before-after only</span>}
                </div>
                <div style={{ marginBottom: 8 }}>
                  <select value={inst.teacherId || ""} onChange={e => {
                      const insts = [...form.instruments]; insts[i] = { ...insts[i], teacherId: e.target.value };
                      setForm(p => ({ ...p, instruments: insts }));
                    }}
                    style={{ padding: "5px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 12, fontFamily: "inherit", color: inst.teacherId ? colors.text : colors.textMuted }}>
                    <option value="">Unassigned</option>
                    {teachers.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </div>
              </React.Fragment>
            ))}
          </div>

          <div style={{ marginBottom: 14 }}>
            <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: colors.textLight, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>Scheduling Constraints</label>
            <Checkbox label="Outside of class time only" checked={form.outsideClassOnly} onChange={v => setForm(p => ({ ...p, outsideClassOnly: v, outsideClassPreferred: v ? false : p.outsideClassPreferred }))} />
            <Checkbox label="Outside of class time preferred" checked={form.outsideClassPreferred} onChange={v => setForm(p => ({ ...p, outsideClassPreferred: v, outsideClassOnly: v ? false : p.outsideClassOnly }))} />
            <Checkbox label="Available before school" checked={form.availableBefore} onChange={v => setForm(p => ({ ...p, availableBefore: v }))} />
            <Checkbox label="Available after school" checked={form.availableAfter} onChange={v => setForm(p => ({ ...p, availableAfter: v }))} />
          </div>

          <Input label="Notes" value={form.notes} onChange={v => setForm(p => ({ ...p, notes: v }))} multiline placeholder="Any preferences, restrictions, or notes..." />

          {/* Parent / Guardian contacts */}
          <div style={{ marginBottom: 14, marginTop: 4 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: colors.textLight, textTransform: "uppercase", letterSpacing: 0.5 }}>
                Parent / Guardian
              </label>
              {(form.parents || []).length < 2 && (
                <Btn variant="ghost" onClick={() => setForm(p => ({ ...p, parents: [...(p.parents || []), { id: uid(), name: "", email: "", phone: "", relationship: "", isPrimary: (p.parents || []).length === 0 }] }))} style={{ fontSize: 12 }}>
                  {(form.parents || []).length === 0 ? "+ Add Parent" : "+ Add Second Parent"}
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
                      style={{ position: "absolute", top: 8, right: 10, border: "none", background: "none", color: colors.textMuted, cursor: "pointer", fontSize: 16, lineHeight: 1 }}
                      title="Remove">×</button>
                    <div style={{ display: "flex", gap: 10, marginBottom: 8 }}>
                      <div style={{ flex: 1 }}>
                        <Input label="Name" value={parent.name} onChange={v => setForm(p => ({ ...p, parents: (p.parents || []).map((pr, i) => i === pi ? { ...pr, name: v } : pr) }))} placeholder="Parent or guardian name" />
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
                        <Input label="Phone" value={parent.phone} onChange={v => setForm(p => ({ ...p, parents: (p.parents || []).map((pr, i) => i === pi ? { ...pr, phone: v } : pr) }))} placeholder="04xx xxx xxx" />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
            <Btn onClick={saveStudent}>Save Student</Btn>
            <Btn variant="secondary" onClick={() => { setForm(null); setEditing(null); if (onReturn) onReturn(); }}>Cancel</Btn>
          </div>
        </Card>

        {/* Merge prompt modal */}
        {mergePrompt && (
          <div style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center" }}
            onClick={() => setMergePrompt(null)}>
            <div style={{ background: colors.white, borderRadius: 14, padding: 28, maxWidth: 460, width: "90%", boxShadow: "0 8px 32px rgba(0,0,0,0.18)" }}
              onClick={e => e.stopPropagation()}>
              <div style={{ fontWeight: 700, fontSize: 15, color: colors.sidebarActive, marginBottom: 10 }}>
                Merge into existing student?
              </div>
              <div style={{ fontSize: 13, color: colors.text, lineHeight: 1.65, marginBottom: 20 }}>
                <strong>{mergePrompt.targetStudent.name}</strong> already exists as an active student.
                <br /><br />
                Merge <strong>{mergePrompt.pendingStudent.instruments.map(i => i.name).filter(Boolean).join(", ")}</strong> into their profile and remove this duplicate record?
                <br /><br />
                <span style={{ color: colors.textMuted, fontSize: 12 }}>
                  Tally entries and lesson cards stay separate — they already reference each student individually.
                </span>
              </div>
              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                <Btn variant="secondary" onClick={handleActivateWithoutMerge}>Keep as Separate Student</Btn>
                <Btn onClick={handleMerge}>&#10003; Merge Instruments</Btn>
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
          students.filter(s => s.status === "active").length + " active" +
          (students.filter(s => s.status === "pending").length > 0 ? " · " + students.filter(s => s.status === "pending").length + " pending" : "") +
          (students.filter(s => s.status === "trial").length > 0 ? " · " + students.filter(s => s.status === "trial").length + " trial" : "")
        }
        pageColor={PAGE_COLORS.students}
        action={<div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div style={{ position: "relative", display: "inline-block" }}
            onMouseEnter={e => { const t = e.currentTarget.querySelector(".import-tooltip"); if (t) t.style.display = "block"; }}
            onMouseLeave={e => { const t = e.currentTarget.querySelector(".import-tooltip"); if (t) t.style.display = "none"; }}>
            <Btn variant="secondary" onClick={() => openImport("spreadsheet")}>Import</Btn>
            <div className="import-tooltip" style={{
              display: "none", position: "absolute", top: "calc(100% + 8px)", right: 0,
              width: 340, background: colors.white, border: "1px solid " + colors.border,
              borderRadius: 10, boxShadow: "0 8px 24px rgba(0,0,0,0.12)", padding: "14px 16px",
              zIndex: 200, color: colors.text, fontSize: 12, lineHeight: 1.6,
            }}>
              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8, color: colors.sidebarActive }}>📋 Spreadsheet Import Format</div>
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
          </div>
          <Btn onClick={newStudent}>+ Add</Btn>
        </div>}
        navButtons={<NavButtons goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}>
        Students
      </PageTitle>

      {activeStudents.length > 0 && (
        <Card style={{ marginBottom: 10, padding: "10px 14px" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "nowrap" }}>
            <div style={{ flex: "1 1 140px", minWidth: 0, position: "relative" }}>
              <input value={filter.search} onChange={e => setFilter(p => ({ ...p, search: e.target.value }))} placeholder="Search name..."
                style={{ width: "100%", padding: "6px 28px 6px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 7, fontSize: 12, fontFamily: "inherit", boxSizing: "border-box" }} />
              {filter.search && (
                <button onClick={() => setFilter(p => ({ ...p, search: "" }))}
                  style={{ position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)", border: "none", background: "none", color: colors.textMuted, cursor: "pointer", fontSize: 15, lineHeight: 1, padding: 0 }}>×</button>
              )}
            </div>
            <select value={filter.school} onChange={e => setFilter(p => ({ ...p, school: e.target.value, className: "" }))}
              style={{ flex: "0 0 auto", padding: "6px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 7, fontSize: 12, fontFamily: "inherit" }}>
              <option value="">All Schools</option>
              {schools.map(s => <option key={s.id} value={s.id}>{s.name.split(" ").filter(w => /^[A-Z]/.test(w)).map(w => w[0]).join("") || s.name}</option>)}
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
              {[...new Set([
                ...(availableInstruments.length > 0 ? availableInstruments : INSTRUMENTS),
                ...activeStudents.flatMap(s => s.instruments.map(i => i.name)).filter(Boolean)
              ])].sort().map(i => <option key={i} value={i}>{i}</option>)}
            </select>
            <select value={filter.teacher} onChange={e => setFilter(p => ({ ...p, teacher: e.target.value }))}
              style={{ flex: "0 1 120px", minWidth: 0, padding: "6px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 7, fontSize: 12, fontFamily: "inherit" }}>
              <option value="">All Teachers</option>
              <option value="_none_">No teacher</option>
              {teachers.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <button onClick={() => setFilter(p => ({ ...p, hasNote: !p.hasNote }))}
              title="Show only students with a note"
              style={{ flex: "0 0 auto", padding: "6px 10px", border: `1px solid ${filter.hasNote ? colors.accent : colors.inputBorder}`, borderRadius: 7, fontSize: 12, fontFamily: "inherit", cursor: "pointer", background: filter.hasNote ? colors.accent : colors.white, color: filter.hasNote ? colors.white : colors.textMuted, fontWeight: filter.hasNote ? 700 : 400, whiteSpace: "nowrap" }}>
              📝 Has note
            </button>
            <button onClick={() => setFilter(p => ({ ...p, hasWarning: p.hasWarning ? "" : "any" }))}
              title="Show only students with missing data (teacher, instrument, parent, class, or school)"
              style={{ flex: "0 0 auto", padding: "6px 10px", border: `1px solid ${filter.hasWarning ? colors.danger : colors.inputBorder}`, borderRadius: 7, fontSize: 14, fontFamily: "inherit", cursor: "pointer", background: filter.hasWarning ? "#FEF2F2" : colors.white, color: filter.hasWarning ? colors.danger : colors.textMuted, fontWeight: filter.hasWarning ? 700 : 400, lineHeight: 1 }}>
              ⚠
            </button>
          </div>
        </Card>
      )}

      {activeStudents.length === 0 ? (
        <EmptyState icon="👨‍🎓" title="No students yet" subtitle="Add students manually or import from a spreadsheet (CSV or Excel)." action="+ Add Student" onAction={newStudent} />
      ) : (
        <>
          <div style={{ fontSize: 12, color: colors.textMuted, marginBottom: 6 }}>Showing {filtered.length} of {activeStudents.length} students</div>
          <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, overflow: "hidden", display: "flex", flexDirection: "column", maxHeight: "calc(100vh - 210px)" }}>
            <div style={{ overflowY: "auto", flex: 1 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
              <thead style={{ position: "sticky", top: 0, zIndex: 10 }}>
                <tr style={{ background: colors.sidebarActive, borderBottom: `1px solid ${colors.border}` }}>
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
                      {col.label}{sortCol === col.key ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedFiltered.map(s => {
                  const school = schools.find(sc => sc.id === s.schoolId);
                  const prefTeacher = s.instruments && s.instruments[0] && s.instruments[0].teacherId ? teachers.find(t => t.id === s.instruments[0].teacherId) : null;
                  const noteOpen = expandedStudentNotes.has(s.id);
                  const hasNote = !!(s.notes && s.notes.trim());
                  return (
                    <React.Fragment key={s.id}>
                    <tr ref={s.id === editing ? focusRowRef : null} style={{ borderBottom: noteOpen ? "none" : `1px solid ${colors.borderLight}`, cursor: "pointer", opacity: s.status !== "active" ? 0.6 : 1 }}
                      onClick={() => editStudent(s)}
                      onMouseEnter={e => e.currentTarget.style.background = colors.bg}
                      onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                      <td style={{ padding: "10px 14px", fontWeight: 500 }}>{s.name}</td>
                      <td style={{ padding: "10px 14px", color: colors.textLight }}>{school ? school.name.split(" ").filter(w => /^[A-Z]/.test(w) || w.length <= 3).map(w => w[0]).join("") || school.name.slice(0, 4).toUpperCase() : "—"}</td>
                      <td style={{ padding: "10px 14px", color: colors.textLight }}>{s.className || "—"}</td>
                      <td style={{ padding: "10px 14px" }}>
                        {s.instruments.map((inst, i) => (
                          <Tag key={i} color={getInstColor(inst.name, inst.isGroup)}>{inst.isGroup ? "👥 " : ""}{inst.name}</Tag>
                        ))}
                      </td>
                      <td style={{ padding: "10px 14px", color: colors.textLight, fontSize: 13 }}>
                        {(() => {
                          const indInsts = (s.instruments || []).filter(i => !i.isGroup);
                          if (!indInsts.length) return <span style={{ color: colors.textMuted, fontStyle: "italic" }}>—</span>;
                          const parts = indInsts.map(i => {
                            if (!i.teacherId) return <span key={i.name} style={{ color: colors.danger, fontStyle: "italic" }}>Unassigned</span>;
                            const t = teachers.find(t => t.id === i.teacherId);
                            return <span key={i.name}>{t ? t.name : "—"}</span>;
                          });
                          return parts.reduce((acc, el, idx) => idx === 0 ? [el] : [...acc, <span key={"sep"+idx} style={{ color: colors.borderLight }}> / </span>, el], []);
                        })()}
                      </td>
                      <td style={{ padding: "10px 14px", fontSize: 12, color: colors.textMuted }}>
                        {s.outsideClassOnly && <Tag color={colors.warning}>Outside class only</Tag>}
                        {s.outsideClassPreferred && <Tag color="#F59E0B">Outside class pref.</Tag>}
                        {s.availableBefore && <Tag color={colors.info || "#3B82F6"}>Before school</Tag>}
                        {s.availableAfter && <Tag color={colors.info || "#3B82F6"}>After school</Tag>}
                        {s.instruments.some(i => i.isGroup) && <Tag color={instruments_colors.Group}>Group</Tag>}
                        {(() => {
                          const warns = [];
                          if (!(s.instruments || []).length) warns.push("No instrument");
                          else (s.instruments || []).filter(i => !i.isGroup && !i.teacherId).forEach(i => warns.push(`No teacher (${i.name})`));
                          if (!(s.parents || []).length) warns.push("No parent");
                          else if (!(s.parents || []).some(p => p.email)) warns.push("Parent missing email");
                          if (!s.className) warns.push("No class");
                          if (!s.schoolId) warns.push("No school");
                          return warns.map((w, wi) => (
                            <Tag key={wi} color={colors.danger}>⚠ {w}</Tag>
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
                            style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 30, height: 30, borderRadius: 6, background: noteOpen ? colors.sidebarActive : hasNote ? colors.accentLight : colors.white, border: `1px solid ${noteOpen ? colors.sidebarActive : hasNote ? colors.accent : colors.border}`, color: noteOpen ? colors.white : hasNote ? colors.accent : colors.textMuted, cursor: "pointer", flexShrink: 0, fontSize: 14 }}>
                            📝
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
                          <button onClick={(e) => { e.stopPropagation(); deleteStudent(s.id); }}
                            title="Remove student"
                            style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 30, height: 30, borderRadius: 6, background: "#FEF2F2", border: "1px solid #FECACA", color: "#DC2626", cursor: "pointer", flexShrink: 0 }}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
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
                              style={{ width: "100%", padding: "8px 32px 8px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 7, fontSize: 12, fontFamily: "inherit", resize: "vertical", minHeight: 60, color: colors.text, background: colors.white, boxSizing: "border-box" }} />
                            {s.notes && s.notes.trim() && (
                              <button
                                onClick={e => { e.stopPropagation(); updateStudentNote(s.id, ""); }}
                                title="Clear note"
                                style={{ position: "absolute", top: 6, right: 6, background: "none", border: "none", cursor: "pointer", fontSize: 14, color: colors.textMuted, lineHeight: 1, padding: 2, borderRadius: 4 }}
                                onMouseEnter={e => { e.currentTarget.style.color = colors.danger; e.currentTarget.style.background = "#FEF2F2"; }}
                                onMouseLeave={e => { e.currentTarget.style.color = colors.textMuted; e.currentTarget.style.background = "none"; }}>
                                ✕
                              </button>
                            )}
                          </div>
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
        {studentNoteTooltip && (
          <div style={{ position: "fixed", left: studentNoteTooltip.x + 12, top: studentNoteTooltip.y - 8, background: "#1B2432", color: "#fff", fontSize: 11, padding: "5px 9px", borderRadius: 6, zIndex: 9999, maxWidth: 220, pointerEvents: "none", whiteSpace: "pre-wrap", lineHeight: 1.4 }}>
            {studentNoteTooltip.text}
          </div>
        )}
        </>
      )}


    </div>
  );
}

// ============================================================
// TEACHERS MANAGER
// ============================================================
