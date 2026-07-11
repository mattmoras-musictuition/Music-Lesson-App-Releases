// ============================================================
// SpecialistManager.js
// ============================================================

import React, { useState, useEffect, useRef } from "react";
import { Building2, Palette, ChevronUp, ChevronDown, StickyNote, Pencil, X, Trash2, RefreshCw, ClipboardList, FileText } from "lucide-react";
import { DAYS, SLOT_TYPES, SLOT_TYPE_LABELS, HEADER_HEIGHT, ANTHROPIC_MODEL } from "../constants";
import { useTheme } from "../context/ThemeContext";
import { uid, timeToMin, toTimeLabel, to12h, melbourneNow, toLocalDateStr, getCurrentWeekMonday, getTermWeekLabel } from "../utils/helpers";
import { defaultSlots } from "../utils/backup";
import { anthropicFetch, getAnthropicHeaders, getXLSX } from "../utils/api";
import { Card, PageTitle, NavButtons, Btn, Input, Tag, EmptyState, FileUpload, PAGE_COLORS } from "../components/ui/SharedUI";

export function SpecialistManager({ specialists, setSpecialists, schools, notify, resetKey, viewState, setViewState, goBack, goForward, historyCursor, pageHistory }) {
  const { colors } = useTheme();
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(null);
  const filterSchool = (viewState || {}).filterSchool || "";
  const setFilterSchool = (v) => setViewState(prev => ({ ...prev, filterSchool: v }));
  const filterClass = (viewState || {}).filterClass || "";
  const setFilterClass = (v) => setViewState(prev => ({ ...prev, filterClass: v }));
  const filterDay = (viewState || {}).filterDay || "";
  const setFilterDay = (v) => setViewState(prev => ({ ...prev, filterDay: v }));
  const filterSubject = (viewState || {}).filterSubject || "";
  const setFilterSubject = (v) => setViewState(prev => ({ ...prev, filterSubject: v }));
  const [importMode, setImportMode] = useState(null);
  const [importInstructions, setImportInstructions] = useState("");
  const [importSchoolId, setImportSchoolId] = useState("");
  const [parsing, setParsing] = useState(false);
  const [preview, setPreview] = useState(null);
  const [importError, setImportError] = useState(null);
  const [updateSchoolId, setUpdateSchoolId] = useState(null); // schoolId being updated
  const [schoolBannerOpen, setSchoolBannerOpen] = useState({}); // schoolId -> bool
  const [calendarStripOpen, setCalendarStripOpen] = useState(false); // hidden by default
  const [schoolBannerMode, setSchoolBannerMode] = useState({}); // schoolId -> "all"|"day"|"class"
  const filterBarRef = React.useRef(null);
  const [filterBarHeight, setFilterBarHeight] = useState(0);
  const [updateInstructions, setUpdateInstructions] = useState("");
  const [updateUrl, setUpdateUrl] = useState(""); // optional URL to fetch
  const [diffPreview, setDiffPreview] = useState(null); // { schoolId, added, removed, changed, schoolName }
  const [diffAccepted, setDiffAccepted] = useState({}); // changeKey -> true/false
  const fileRef = useRef(null);
  const updateFileRef = useRef(null);

  useEffect(() => { setEditing(null); setForm(null); setImportMode(null); setPreview(null); setUpdateSchoolId(null); setUpdateUrl(""); setDiffPreview(null); }, [resetKey]);
  useEffect(() => {
    const el = filterBarRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setFilterBarHeight(el.offsetHeight));
    ro.observe(el);
    setFilterBarHeight(el.offsetHeight);
    return () => ro.disconnect();
  }, []);

  const SPECIALIST_SUBJECTS = [
    "Art", "Music", "PE/Sport", "LOTE", "Science", "Library",
    "Digital Tech", "Drama", "Dance", "STEM", "Wellbeing", "Other"
  ];

  const normalizeSubject = (raw) => {
    if (!raw) return raw;
    const r = raw.trim().toLowerCase();
    // Strip dots for matching (P.E. -> pe, P.E./Sport -> pe/sport)
    const rNoDots = r.replace(/\./g, "");
    // LOTE variants
    if (r === "lote" || r === "language" || r === "languages" || r === "lote/language" ||
        r === "lote / language" || r === "lote/languages" || r === "lote / languages" ||
        r === "foreign language" || r === "second language" || r === "japanese" ||
        r === "italian" || r === "french" || r === "mandarin" || r === "chinese" ||
        r === "indonesian" || r === "german" || r === "spanish" || r === "auslan" ||
        r.startsWith("lote")) return "LOTE";
    // PE/Sport variants — check both with and without dots
    if (r === "pe" || rNoDots === "pe" || r === "sport" || r === "sports" ||
        r === "pe/sport" || rNoDots === "pe/sport" || r === "pe / sport" || rNoDots === "pe / sport" ||
        r === "pe/sports" || rNoDots === "pe/sports" || r === "pe / sports" ||
        r === "physical education" || r === "phys ed" ||
        r === "phys. ed" || r === "phys. ed." || r === "physical ed" || r === "gym" ||
        r === "gymnastics" || r === "fitness" || r === "health & pe" || r === "health and pe" ||
        r === "hpe" || r === "sport/pe" || r === "sport / pe" ||
        r.startsWith("pe ") || rNoDots.startsWith("pe ") || r.startsWith("pe/") || rNoDots.startsWith("pe/") ||
        r.startsWith("pe -") || rNoDots.startsWith("pe -") || rNoDots.startsWith("pe-") ||
        r.startsWith("sport") || r.startsWith("physical e")) return "PE/Sport";
    // Match existing subjects case-insensitively
    const match = SPECIALIST_SUBJECTS.find(s => s.toLowerCase() === r);
    if (match) return match;
    return raw.trim();
  };

  // Migrate existing entries to normalized subjects
  useEffect(() => {
    let changed = false;
    const migrated = specialists.map(s => {
      const norm = normalizeSubject(s.subject);
      if (norm !== s.subject) { changed = true; return { ...s, subject: norm }; }
      return s;
    });
    if (changed) setSpecialists(migrated);
  }, []);

  // Migrate: split comma-separated classNames into individual entries
  useEffect(() => {
    const grouped = specialists.filter(s => s.className && s.className.includes(","));
    if (grouped.length === 0) return;
    const expanded = [];
    const removeIds = new Set();
    for (const s of grouped) {
      removeIds.add(s.id);
      const classes = s.className.split(",").map(c => c.trim()).filter(Boolean);
      for (const cn of classes) {
        expanded.push({ ...s, id: uid(), className: cn });
      }
    }
    setSpecialists(prev => [...prev.filter(s => !removeIds.has(s.id)), ...expanded]);
  }, []);

  const openImport = (mode) => {
    setImportMode(mode);
    setImportInstructions("");
    setImportSchoolId(filterSchool || (schools.length === 1 ? schools[0].id : ""));
    setImportError(null);
  };

  const clearAllEntries = () => {
    if (specialists.length === 0) { notify("Nothing to clear", "warning"); return; }
    setSpecialists([]);
    notify("All specialist entries cleared");
  };

  // ---- FILE UPLOAD HANDLER ----
  const handleFileUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = "";
    const isPdf = file.name.toLowerCase().endsWith(".pdf");
    if (importMode === "pdf" && !isPdf) { notify("Please select a PDF file", "warning"); return; }

    // Check file size (warn if >10MB)
    if (file.size > 10 * 1024 * 1024) {
      notify("File is very large (" + (file.size / 1024 / 1024).toFixed(1) + "MB). This may take longer or fail.", "warning");
    }

    setParsing(true);
    setImportMode(null);
    setImportError(null);

    try {
      if (isPdf) {
        await handlePdfImport(file);
      } else {
        await handleSpreadsheetImport(file);
      }
    } catch (err) {
      console.error("Import error:", err);
      const errorMsg = err.message || "Unknown error";
      setImportError({ message: errorMsg, filename: file.name, details: String(err) });
      notify("Import failed — see error details below.", "danger");
    }
    setParsing(false);
  };

  // ---- PDF IMPORT ----
  const handlePdfImport = async (file) => {
    const base64Data = await new Promise((res, rej) => {
      const reader = new FileReader();
      reader.onload = () => res(reader.result.split(",")[1]);
      reader.onerror = () => rej(new Error("Failed to read the PDF file from disk."));
      reader.readAsDataURL(file);
    });

    let userGuidance = "";
    if (importInstructions.trim()) {
      userGuidance = `\n\nIMPORTANT — SPECIFIC INSTRUCTIONS FROM THE USER about this document. Follow these carefully, they override general assumptions:\n---\n${importInstructions.trim()}\n---`;
    }

    let response;
    try {
      response = await anthropicFetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: getAnthropicHeaders(),
        body: JSON.stringify({
          model: ANTHROPIC_MODEL,
          max_tokens: 16000,
          messages: [{
            role: "user",
            content: [
              { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64Data } },
              { type: "text", text: `This PDF contains a specialist class timetable for a primary/elementary school.\nExtract ALL specialist class entries from this document.\n\nFor each entry I need:\n- class: The class/grade name (e.g. "Prep A", "1B", "3/4C", "Year 5")\n- day: The day of the week (Monday, Tuesday, Wednesday, Thursday, or Friday)\n- start: Start time in HH:MM 24-hour format (e.g. "09:00", "14:30")\n- end: End time in HH:MM 24-hour format\n- subject: The specialist subject (e.g. "Art", "PE/Sport", "LOTE", "Music", "Science", "Library", "Digital Tech", "Drama", "Dance", "STEM")\n\nRespond ONLY with a JSON array, no other text, no markdown backticks. Example:\n[{"class":"3A","day":"Monday","start":"09:00","end":"09:50","subject":"Art"}]\n\nRules:\n- Extract EVERY entry you can find\n- If times are in 12-hour format, convert to 24-hour\n- Use exact class names from the document\n- If you can't determine exact times, estimate based on typical school day (9am-3:30pm)\n- Include ALL classes and ALL specialist subjects shown\n- Use compact JSON with no extra whitespace to fit everything${userGuidance}` }
            ]
          }]
        })
      });
    } catch (fetchErr) {
      throw new Error("Network error connecting to AI service. Check your internet connection and try again.");
    }

    if (!response.ok) {
      let errBody = "";
      try { errBody = await response.text(); } catch(e) {}
      throw new Error(`AI service returned error ${response.status}: ${errBody.substring(0, 200)}`);
    }

    const data = await response.json();

    // Check for API-level errors
    if (data.error) {
      throw new Error(`AI error: ${data.error.message || JSON.stringify(data.error)}`);
    }

    const textContent = data.content?.map(c => c.type === "text" ? c.text : "").join("") || "";

    if (!textContent.trim()) {
      throw new Error("AI returned an empty response. The PDF may be image-based or unreadable. Try a clearer PDF or use a spreadsheet instead.");
    }

    const cleaned = textContent.replace(/```json|```/g, "").trim();

    let entries;
    try {
      entries = JSON.parse(cleaned);
    } catch (parseErr) {
      // Try to recover truncated JSON — the response may have been cut off mid-array
      let recovered = cleaned;
      // Remove any trailing incomplete object
      const lastCompleteObj = recovered.lastIndexOf("}");
      if (lastCompleteObj > 0) {
        recovered = recovered.substring(0, lastCompleteObj + 1);
        // Close the array if needed
        if (!recovered.trim().endsWith("]")) {
          recovered = recovered.trim() + "]";
        }
        try {
          entries = JSON.parse(recovered);
          notify(`Response was truncated — recovered ${entries.length} entries. Some may be missing from the end.`, "warning");
        } catch(e) {
          throw new Error("AI response was cut off and couldn't be recovered. Try adding instructions to limit extraction (e.g. 'only extract Prep–Year 2 classes') and import in batches.\n\nRaw response preview: " + cleaned.substring(0, 300));
        }
      } else {
        throw new Error("AI response wasn't valid JSON.\n\nRaw response preview: " + cleaned.substring(0, 300));
      }
    }

    if (!Array.isArray(entries) || entries.length === 0) {
      throw new Error("AI could not find any specialist entries in this document. Try adding more specific instructions about what to look for.");
    }

    setPreview({
      entries: entries.map(e => ({ id: uid(), schoolId: importSchoolId, className: e.class || "", day: e.day || "", start: e.start || "", end: e.end || "", subject: normalizeSubject(e.subject || ""), notes: "" })),
      schoolId: importSchoolId,
      filename: file.name
    });
  };
  const handleSpreadsheetImport = async (file) => {
    const rawData = await new Promise((resolve) => {
      if (file.name.endsWith(".csv")) {
        window.Papa.parse(file, { header: true, skipEmptyLines: true, complete: (r) => resolve(r.data) });
      } else {
        const reader = new FileReader();
        reader.onload = async (ev) => {
          try {
          const XLSX = await getXLSX();
          const wb = XLSX.read(ev.target.result, { type: "binary" });
            const ws = wb.Sheets[wb.SheetNames[0]];
            resolve(XLSX.utils.sheet_to_json(ws, { defval: "" }));
          } catch(e) { resolve([]); }
        };
        reader.readAsBinaryString(file);
      }
    });

    if (rawData.length === 0) { notify("No data found in file", "warning"); return; }

    // If user provided instructions, use AI to interpret
    if (importInstructions.trim()) {
      let response;
      try {
        response = await anthropicFetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: getAnthropicHeaders(),
          body: JSON.stringify({
            model: ANTHROPIC_MODEL,
            max_tokens: 16000,
            messages: [{
              role: "user",
              content: `I have a spreadsheet with specialist class timetable data. Here are the first 5 rows as a sample:\n\n${JSON.stringify(rawData.slice(0, 5), null, 2)}\n\nFull data (${rawData.length} rows):\n${JSON.stringify(rawData)}\n\nIMPORTANT — SPECIFIC INSTRUCTIONS FROM THE USER. Follow these carefully:\n---\n${importInstructions.trim()}\n---\n\nExtract specialist class entries. For each return:\n- class: class/grade name\n- day: Day of week (Monday-Friday)\n- start: Start time HH:MM 24-hour\n- end: End time HH:MM 24-hour\n- subject: specialist subject name\n\nRespond ONLY with a JSON array, no other text, no markdown backticks.`
            }]
          })
        });
      } catch (fetchErr) {
        throw new Error("Network error connecting to AI service. The spreadsheet was read successfully — try again without instructions to use direct column mapping instead.");
      }

      if (!response.ok) {
        let errBody = ""; try { errBody = await response.text(); } catch(e) {}
        throw new Error(`AI service returned error ${response.status}: ${errBody.substring(0, 200)}`);
      }

      const data = await response.json();
      if (data.error) {
        throw new Error(`AI error: ${data.error.message || JSON.stringify(data.error)}`);
      }
      const textContent = data.content?.map(c => c.type === "text" ? c.text : "").join("") || "";
      const cleaned = textContent.replace(/```json|```/g, "").trim();
      try {
        const entries = JSON.parse(cleaned);
        if (Array.isArray(entries) && entries.length > 0) {
          setPreview({
            entries: entries.map(e => ({ id: uid(), schoolId: importSchoolId, className: e.class || "", day: e.day || "", start: e.start || "", end: e.end || "", subject: normalizeSubject(e.subject || ""), notes: "" })),
            schoolId: importSchoolId,
            filename: file.name
          });
          return;
        }
      } catch(e) { /* fall through to direct mapping */ }
      notify("AI couldn't extract entries with those instructions. Falling back to direct mapping.", "warning");
    }

    // Direct column-mapping fallback
    const imported = [];
    for (const row of rawData) {
      const className = row.class || row.Class || row.className || row.grade || row.Grade || "";
      const day = row.day || row.Day || "";
      const start = row.start || row.start_time || row.Start || "";
      const end = row.end || row.end_time || row.End || "";
      const subject = row.subject || row.Subject || row.specialist || row.Specialist || "";
      if (!className || !day || !subject) continue;
      imported.push({ id: uid(), schoolId: importSchoolId || (schools.length === 1 ? schools[0].id : ""), className: className.trim(), day: day.trim(), start: start.trim() || "09:00", end: end.trim() || "09:30", subject: normalizeSubject(subject.trim()), notes: row.notes || row.Notes || "" });
    }

    if (imported.length === 0) { notify("No valid entries found. Try adding instructions to help interpret the data.", "warning"); return; }
    setPreview({ entries: imported, schoolId: importSchoolId, filename: file.name });
  };

  // ---- PREVIEW HELPERS ----
  const confirmImport = () => {
    if (!preview) return;
    const valid = preview.entries.filter(e => e.schoolId && e.className && e.day && e.subject);
    if (valid.length === 0) { notify("No valid entries. Make sure a school is selected.", "warning"); return; }
    setSpecialists(prev => [...prev, ...valid]);
    notify(`Imported ${valid.length} specialist entries from ${preview.filename}`);
    setPreview(null);
  };

  // ---- UPDATE (DIFF) FLOW ----
  const handleUpdateFileUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (updateFileRef.current) updateFileRef.current.value = "";
    const schoolId = updateSchoolId;
    const school = schools.find(s => s.id === schoolId);
    const existingEntries = specialists.filter(s => s.schoolId === schoolId);
    const isPdf = file.name.toLowerCase().endsWith(".pdf");
    setParsing(true);
    setImportError(null);
    try {
      let parsedEntries = [];
      const toBase64 = f => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result.split(",")[1]); r.onerror = rej; r.readAsDataURL(f); });
      const existingDesc = existingEntries.map(e => e.className + " " + e.day + " " + e.start + "-" + e.end + " " + e.subject).join("; ");
      const updatePrompt = "This is an UPDATED specialist class timetable for " + (school ? school.name : "a school") + ". The existing timetable has these entries: " + existingDesc + ". This update likely has only a few changes from the existing timetable. Focus on identifying what is NEW, what has been REMOVED, and what has CHANGED (different time/day/subject for the same class). Extract ALL entries from this document as before." + (updateInstructions ? " Additional instructions: " + updateInstructions : "") + " For each entry return: class, day, start (HH:MM 24h), end (HH:MM 24h), subject. Respond ONLY with a JSON array, no other text, no markdown backticks.";
      if (isPdf) {
        const base64 = await toBase64(file);
        const resp = await anthropicFetch("https://api.anthropic.com/v1/messages", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 4000,
            messages: [{ role: "user", content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } }, { type: "text", text: updatePrompt }] }] })
        });
        const data = await resp.json();
        const text = (data.content || []).map(c => c.type === "text" ? c.text : "").join("");
        parsedEntries = JSON.parse(text.replace(/```json|```/g, "").trim());
      } else {
        const SheetJS = window.XLSX;
        const ab = await file.arrayBuffer();
        const wb = SheetJS.read(ab); const ws = wb.Sheets[wb.SheetNames[0]];
        const rawData = SheetJS.utils.sheet_to_json(ws);
        const resp = await anthropicFetch("https://api.anthropic.com/v1/messages", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 4000,
            messages: [{ role: "user", content: updatePrompt + " Data: " + JSON.stringify(rawData) }] })
        });
        const data = await resp.json();
        const text = (data.content || []).map(c => c.type === "text" ? c.text : "").join("");
        parsedEntries = JSON.parse(text.replace(/```json|```/g, "").trim());
      }
      if (!Array.isArray(parsedEntries)) throw new Error("Expected JSON array");
      const newEntries = parsedEntries.map(e => ({
        id: uid(), schoolId, className: (e.class || "").trim(),
        day: (e.day || "").trim(), start: (e.start || "").trim(),
        end: (e.end || "").trim(), subject: normalizeSubject((e.subject || "").trim()), notes: ""
      })).filter(e => e.className && e.day && e.subject);

      // Build diff: compare new vs existing
      const key = e => e.className + "|" + e.day + "|" + e.start + "|" + e.end + "|" + e.subject;
      const existKeys = new Set(existingEntries.map(key));
      const newKeys = new Set(newEntries.map(key));
      const added = newEntries.filter(e => !existKeys.has(key(e)));
      const removed = existingEntries.filter(e => !newKeys.has(key(e)));
      // Detect changes: same class+day but different time or subject
      const changed = [];
      for (const ne of newEntries) {
        const sameSlot = existingEntries.find(ex => ex.className === ne.className && ex.day === ne.day && (ex.start !== ne.start || ex.end !== ne.end || ex.subject !== ne.subject) && !newKeys.has(key(ex)));
        if (sameSlot) changed.push({ "old": sameSlot, "new": ne });
      }
      // Remove changed items from added/removed
      const changedOldKeys = new Set(changed.map(c => key(c.old)));
      const changedNewKeys = new Set(changed.map(c => key(c["new"])));
      const addedFinal = added.filter(e => !changedNewKeys.has(key(e)));
      const removedFinal = removed.filter(e => !changedOldKeys.has(key(e)));

      if (addedFinal.length === 0 && removedFinal.length === 0 && changed.length === 0) {
        notify("No changes detected — timetable appears identical to existing data.");
        setUpdateSchoolId(null);
        setParsing(false);
        return;
      }
      const initialAccepted = {};
      addedFinal.forEach((_, i) => { initialAccepted["add_" + i] = true; });
      removedFinal.forEach((_, i) => { initialAccepted["rem_" + i] = true; });
      changed.forEach((_, i) => { initialAccepted["chg_" + i] = true; });
      setDiffAccepted(initialAccepted);
      setDiffPreview({ schoolId, schoolName: school?.name || "", added: addedFinal, removed: removedFinal, changed });
      setUpdateSchoolId(null);
    } catch(err) {
      setImportError("Could not parse update file: " + err.message);
    }
    setParsing(false);
  };

  const handleUpdateUrl = async () => {
    const url = updateUrl.trim();
    if (!url) return;
    const schoolId = updateSchoolId;
    const school = schools.find(s => s.id === schoolId);
    const existingEntries = specialists.filter(s => s.schoolId === schoolId);
    setParsing(true);
    setImportError(null);
    try {
      const existingDesc = existingEntries.map(e => e.className + " " + e.day + " " + e.start + "-" + e.end + " " + e.subject).join("; ");
      const urlPrompt = "This is an UPDATED specialist class timetable for " + (school ? school.name : "a school") + ". The existing timetable has these entries: " + existingDesc + ". Please fetch the URL I provide and extract ALL specialist class entries from it." + (updateInstructions ? " Additional instructions: " + updateInstructions : "") + " For each entry return: class, day, start (HH:MM 24h), end (HH:MM 24h), subject. Respond ONLY with a JSON array, no other text, no markdown backticks. URL: " + url;
      const resp = await anthropicFetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL, max_tokens: 4000,
          tools: [{ type: "web_search_20250305", name: "web_search" }],
          messages: [{ role: "user", content: urlPrompt }]
        })
      });
      const data = await resp.json();
      const text = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("");
      const cleaned = text.replace(/```json|```/g, "").trim();
      const arrMatch = cleaned.match(/\[[\s\S]*\]/);
      if (!arrMatch) throw new Error("No JSON array found in response");
      const parsedEntries = JSON.parse(arrMatch[0]);
      if (!Array.isArray(parsedEntries)) throw new Error("Expected JSON array");
      const newEntries = parsedEntries.map(e => ({
        id: uid(), schoolId, className: (e.class || "").trim(),
        day: (e.day || "").trim(), start: (e.start || "").trim(),
        end: (e.end || "").trim(), subject: normalizeSubject((e.subject || "").trim()), notes: ""
      })).filter(e => e.className && e.day && e.subject);
      const eKey = e => e.className + "|" + e.day + "|" + e.start + "|" + e.end + "|" + e.subject;
      const existKeys = new Set(existingEntries.map(eKey));
      const newKeys = new Set(newEntries.map(eKey));
      const added = newEntries.filter(e => !existKeys.has(eKey(e)));
      const removed = existingEntries.filter(e => !newKeys.has(eKey(e)));
      const changed = [];
      for (const ne of newEntries) {
        const sameSlot = existingEntries.find(ex => ex.className === ne.className && ex.day === ne.day && (ex.start !== ne.start || ex.end !== ne.end || ex.subject !== ne.subject) && !newKeys.has(eKey(ex)));
        if (sameSlot) changed.push({ "old": sameSlot, "new": ne });
      }
      const changedOldKeys = new Set(changed.map(c => eKey(c["old"])));
      const changedNewKeys = new Set(changed.map(c => eKey(c["new"])));
      const addedFinal = added.filter(e => !changedNewKeys.has(eKey(e)));
      const removedFinal = removed.filter(e => !changedOldKeys.has(eKey(e)));
      if (addedFinal.length === 0 && removedFinal.length === 0 && changed.length === 0) {
        notify("No changes detected — timetable appears identical to existing data.");
        setUpdateSchoolId(null); setParsing(false); return;
      }
      const initialAccepted = {};
      addedFinal.forEach((_, i) => { initialAccepted["add_" + i] = true; });
      removedFinal.forEach((_, i) => { initialAccepted["rem_" + i] = true; });
      changed.forEach((_, i) => { initialAccepted["chg_" + i] = true; });
      setDiffAccepted(initialAccepted);
      setDiffPreview({ schoolId, schoolName: school ? school.name : "", added: addedFinal, removed: removedFinal, changed });
      setUpdateSchoolId(null);
      setUpdateUrl("");
    } catch(err) {
      setImportError("Could not fetch or parse URL: " + err.message);
      notify("URL fetch failed: " + err.message, "danger");
    }
    setParsing(false);
  };

  const applyDiff = () => {
    if (!diffPreview) return;
    const { schoolId, added, removed, changed } = diffPreview;
    let updated = [...specialists];
    // Apply accepted removals
    const toRemove = new Set();
    removed.forEach((e, i) => { if (diffAccepted["rem_" + i]) toRemove.add(e.id); });
    changed.forEach((c, i) => { if (diffAccepted["chg_" + i]) toRemove.add(c["old"].id); });
    updated = updated.filter(e => !toRemove.has(e.id));
    // Apply accepted additions and changes
    added.forEach((e, i) => { if (diffAccepted["add_" + i]) updated.push(e); });
    changed.forEach((c, i) => { if (diffAccepted["chg_" + i]) updated.push(c["new"]); });
    setSpecialists(updated);
    const totalChanges = Object.values(diffAccepted).filter(Boolean).length;
    notify("Applied " + totalChanges + " change" + (totalChanges !== 1 ? "s" : "") + " to " + diffPreview.schoolName);
    setDiffPreview(null);
    setDiffAccepted({});
    setUpdateInstructions("");
  };

    const updatePreviewEntry = (idx, key, val) => {
    setPreview(prev => { const entries = [...prev.entries]; entries[idx] = { ...entries[idx], [key]: val }; return { ...prev, entries }; });
  };

  const removePreviewEntry = (idx) => {
    setPreview(prev => ({ ...prev, entries: prev.entries.filter((_, i) => i !== idx) }));
  };

  const updateAllPreviewSchool = (schoolId) => {
    setPreview(prev => ({ ...prev, schoolId, entries: prev.entries.map(e => ({ ...e, schoolId })) }));
  };

  // ---- MANUAL ENTRY ----
  const newEntry = () => {
    setForm({
      schoolId: "", className: "", subject: "", customSubject: "", notes: "",
      timeSlots: [{ id: uid(), day: "Monday", start: "09:00", end: "09:30" }]
    });
    setEditing("new");
  };
  const editEntry = (entry) => {
    const isCustom = entry.subject && !SPECIALIST_SUBJECTS.includes(entry.subject);
    setForm({
      ...entry,
      subject: isCustom ? "Other" : entry.subject,
      customSubject: isCustom ? entry.subject : "",
      timeSlots: [{ id: entry.id, day: entry.day, start: entry.start, end: entry.end }]
    });
    setEditing(entry.id);
  };

  const addTimeSlot = () => {
    setForm(p => {
      const last = p.timeSlots[p.timeSlots.length - 1];
      return { ...p, timeSlots: [...p.timeSlots, { id: uid(), day: last?.day || "Monday", start: last?.start || "09:00", end: last?.end || "09:30" }] };
    });
  };
  const updateTimeSlot = (idx, key, val) => {
    setForm(p => {
      const ts = [...p.timeSlots];
      ts[idx] = { ...ts[idx], [key]: val };
      return { ...p, timeSlots: ts };
    });
  };
  const removeTimeSlot = (idx) => {
    setForm(p => ({ ...p, timeSlots: p.timeSlots.filter((_, i) => i !== idx) }));
  };
  const duplicateTimeSlot = (idx) => {
    setForm(p => {
      const ts = [...p.timeSlots];
      ts.splice(idx + 1, 0, { ...ts[idx], id: uid() });
      return { ...p, timeSlots: ts };
    });
  };

  const saveEntry = () => {
    if (!form.schoolId) { notify("Select a school", "warning"); return; }
    if (!form.className.trim()) { notify("Class name required", "warning"); return; }
    if (!form.subject) { notify("Select a subject", "warning"); return; }
    if (form.subject === "Other" && !form.customSubject?.trim()) { notify("Enter a custom subject name", "warning"); return; }
    if (!form.timeSlots || form.timeSlots.length === 0) { notify("Add at least one day/time", "warning"); return; }
    // Resolve subject: use custom name for "Other", otherwise normalize
    const subject = form.subject === "Other" ? form.customSubject.trim() : normalizeSubject(form.subject);

    if (editing === "new") {
      // Split comma-separated class names into individual entries (one per class per time slot)
      const classNames = form.className.split(",").map(c => c.trim()).filter(Boolean);
      const newEntries = [];
      for (const cn of classNames) {
        for (const ts of form.timeSlots) {
          newEntries.push({
            id: uid(), schoolId: form.schoolId, className: cn,
            day: ts.day, start: ts.start, end: ts.end,
            subject, notes: form.notes || ""
          });
        }
      }
      setSpecialists(prev => [...prev, ...newEntries]);
      notify(`Added ${newEntries.length} specialist ${newEntries.length === 1 ? "entry" : "entries"}${classNames.length > 1 ? ` across ${classNames.length} classes` : ""}`);
    } else {
      // Editing existing — if className now has commas, expand into multiple entries
      const classNames = form.className.split(",").map(c => c.trim()).filter(Boolean);
      const ts = form.timeSlots[0];
      if (classNames.length === 1) {
        const normalized = {
          id: form.id, schoolId: form.schoolId, className: classNames[0],
          day: ts.day, start: ts.start, end: ts.end,
          subject, notes: form.notes || ""
        };
        setSpecialists(prev => prev.map(s => s.id === normalized.id ? normalized : s));
      } else {
        // Replace the original with multiple individual entries
        const newEntries = classNames.map(cn => ({
          id: uid(), schoolId: form.schoolId, className: cn,
          day: ts.day, start: ts.start, end: ts.end,
          subject, notes: form.notes || ""
        }));
        setSpecialists(prev => [...prev.filter(s => s.id !== form.id), ...newEntries]);
      }
      notify("Entry updated");
    }
    // Reset form for another entry
    setForm({
      schoolId: form.schoolId, className: form.className, subject: "", customSubject: "", notes: "",
      timeSlots: [{ id: uid(), day: form.timeSlots[0]?.day || "Monday", start: form.timeSlots[0]?.start || "09:00", end: form.timeSlots[0]?.end || "09:30" }]
    });
    setEditing("new");
  };

  const deleteEntry = (id) => { setSpecialists(prev => prev.filter(s => s.id !== id)); notify("Entry removed"); };

  const clearSchoolEntries = (schoolId) => {
    const count = specialists.filter(s => s.schoolId === schoolId).length;
    setSpecialists(prev => prev.filter(s => s.schoolId !== schoolId));
    notify(`Cleared ${count} entries`);
  };

  // ---- DATA ----
  const filtered = specialists.filter(s => {
    if (filterSchool && s.schoolId !== filterSchool) return false;
    if (filterClass && s.className !== filterClass) return false;
    if (filterDay && s.day !== filterDay) return false;
    if (filterSubject && s.subject !== filterSubject) return false;
    return true;
  });

  const dayOrder = { Monday: 0, Tuesday: 1, Wednesday: 2, Thursday: 3, Friday: 4 };

  // ==== RENDER: IMPORT PANEL ====
  if (diffPreview) {
    const { schoolName, added, removed, changed } = diffPreview;
    const changeCount = added.length + removed.length + changed.length;
    return (
      <div>
        <PageTitle subtitle={`${changeCount} change${changeCount !== 1 ? "s" : ""} detected for ${schoolName} — review and accept or reject each`}>
          Review Specialist Timetable Update
        </PageTitle>
        <Card style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <Btn onClick={applyDiff}>✓ Apply Accepted Changes</Btn>
            <Btn variant="secondary" onClick={() => { setDiffPreview(null); setDiffAccepted({}); }}>Cancel</Btn>
            <span style={{ fontSize: 12, color: colors.textMuted, marginLeft: 8 }}>
              {Object.values(diffAccepted).filter(Boolean).length} of {changeCount} changes accepted
            </span>
          </div>
        </Card>

        {added.length > 0 && (
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#16A34A", marginBottom: 8 }}>➕ Added ({added.length})</div>
            {added.map((e, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 14px", marginBottom: 6, background: diffAccepted["add_" + i] ? "#F0FDF4" : colors.bg, border: `1px solid ${diffAccepted["add_" + i] ? "#86EFAC" : colors.border}`, borderRadius: 8, fontSize: 13 }}>
                <input type="checkbox" checked={!!diffAccepted["add_" + i]} onChange={ev => setDiffAccepted(p => ({ ...p, ["add_" + i]: ev.target.checked }))} style={{ width: 16, height: 16, cursor: "pointer" }} />
                <Tag color={colors.accent}>{e.className}</Tag>
                <span style={{ fontWeight: 600 }}>{e.day}</span>
                <span style={{ color: colors.textLight }}>{e.start}–{e.end}</span>
                <Tag color={colors.sidebarActive}>{e.subject}</Tag>
              </div>
            ))}
          </div>
        )}

        {removed.length > 0 && (
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: colors.danger, marginBottom: 8 }}>➖ Removed ({removed.length})</div>
            {removed.map((e, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 14px", marginBottom: 6, background: diffAccepted["rem_" + i] ? "#FEF2F2" : colors.bg, border: `1px solid ${diffAccepted["rem_" + i] ? "#FCA5A5" : colors.border}`, borderRadius: 8, fontSize: 13 }}>
                <input type="checkbox" checked={!!diffAccepted["rem_" + i]} onChange={ev => setDiffAccepted(p => ({ ...p, ["rem_" + i]: ev.target.checked }))} style={{ width: 16, height: 16, cursor: "pointer" }} />
                <Tag color={colors.accent}>{e.className}</Tag>
                <span style={{ fontWeight: 600 }}>{e.day}</span>
                <span style={{ color: colors.textLight }}>{e.start}–{e.end}</span>
                <Tag color={colors.sidebarActive}>{e.subject}</Tag>
                <span style={{ fontSize: 11, color: colors.textMuted, fontStyle: "italic", marginLeft: 4 }}>will be deleted</span>
              </div>
            ))}
          </div>
        )}

        {changed.length > 0 && (
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: colors.accent, marginBottom: 8 }}><span style={{display:"inline-flex",alignItems:"center",gap:6}}><Pencil size={13}/>Changed ({changed.length})</span></div>
            {changed.map((c, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 14px", marginBottom: 6, background: diffAccepted["chg_" + i] ? "rgba(52,69,101,0.07)" : colors.bg, border: `1px solid ${diffAccepted["chg_" + i] ? "rgba(52,69,101,0.25)" : colors.border}`, borderRadius: 8, fontSize: 13, flexWrap: "wrap" }}>
                <input type="checkbox" checked={!!diffAccepted["chg_" + i]} onChange={ev => setDiffAccepted(p => ({ ...p, ["chg_" + i]: ev.target.checked }))} style={{ width: 16, height: 16, cursor: "pointer" }} />
                <Tag color={colors.accent}>{c["old"].className}</Tag>
                <span style={{ color: colors.textMuted, textDecoration: "line-through", fontSize: 12 }}>{c["old"].day} {c["old"].start}–{c["old"].end} {c["old"].subject}</span>
                <span style={{ color: colors.textMuted }}>→</span>
                <span style={{ fontWeight: 600 }}>{c["new"].day} {c["new"].start}–{c["new"].end}</span>
                <Tag color={colors.sidebarActive}>{c["new"].subject}</Tag>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (updateSchoolId) {
    const school = schools.find(s => s.id === updateSchoolId);
    return (
      <div>
        <PageTitle subtitle={`Upload an updated specialist timetable for ${school?.name || "this school"} — the AI will compare it to existing data and show you what changed`}>
          Update Specialist Timetable
        </PageTitle>
        {parsing ? (
          <Card style={{ textAlign: "center", padding: 40 }}>
            <div style={{ marginBottom: 12, display:"flex",justifyContent:"center" }}><RefreshCw size={32} /></div>
            <div style={{ fontSize: 16, fontWeight: 600, color: colors.text, marginBottom: 8 }}>Analysing changes...</div>
            <div style={{ fontSize: 13, color: colors.textMuted }}>Comparing new timetable to existing data</div>
          </Card>
        ) : (
          <Card>
            {importError && <div style={{ marginBottom: 12, padding: "10px 14px", background: colors.redLight, border: "1px solid #FCA5A5", borderRadius: 8, fontSize: 13, color: colors.danger }}>{importError}</div>}
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: colors.textLight, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>Optional instructions</label>
              <textarea value={updateInstructions} onChange={e => setUpdateInstructions(e.target.value)}
                placeholder="Any hints for the AI about what changed, class name format, time format, etc..."
                style={{ width: "100%", padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", minHeight: 80, resize: "vertical", boxSizing: "border-box" }} />
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: colors.textLight, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>Link (URL)</label>
              <div style={{ display: "flex", gap: 8 }}>
                <input value={updateUrl} onChange={e => setUpdateUrl(e.target.value)}
                  placeholder="https://... paste a link to the updated timetable"
                  style={{ flex: 1, padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit" }} />
                <Btn onClick={handleUpdateUrl} disabled={!updateUrl.trim()} style={{ opacity: updateUrl.trim() ? 1 : 0.4, whiteSpace: "nowrap" }}>🔗 Fetch Link</Btn>
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
              <div style={{ flex: 1, height: 1, background: colors.border }} />
              <span style={{ fontSize: 12, color: colors.textMuted }}>or upload a file</span>
              <div style={{ flex: 1, height: 1, background: colors.border }} />
            </div>
            <input ref={updateFileRef} type="file" accept=".pdf,.csv,.xlsx,.xls" onChange={handleUpdateFileUpload} style={{ display: "none" }} />
            <div style={{ display: "flex", gap: 10 }}>
              <Btn onClick={() => updateFileRef.current && updateFileRef.current.click()}><span style={{display:"inline-flex",alignItems:"center",gap:5}}><FileText size={13}/>Upload PDF / Spreadsheet</span></Btn>
              <Btn variant="secondary" onClick={() => { setUpdateSchoolId(null); setUpdateInstructions(""); setUpdateUrl(""); setImportError(null); }}>Cancel</Btn>
            </div>
          </Card>
        )}
      </div>
    );
  }

    if (importMode) {
    return (
      <div>
        <PageTitle subtitle={importMode === "pdf" ? "Upload a PDF and guide the AI on what to extract" : "Upload a spreadsheet and guide the AI on how to read it"}>
          Import Specialist Timetable
        </PageTitle>
        <Card>
          <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
            <button onClick={() => setImportMode("pdf")} style={{
              flex: 1, padding: "10px 14px", borderRadius: 8, fontSize: 14, fontFamily: "inherit", cursor: "pointer",
              border: "2px solid " + (importMode === "pdf" ? colors.accent : colors.border),
              background: importMode === "pdf" ? colors.accentLight : colors.cardBg,
              color: importMode === "pdf" ? colors.accentDark : colors.text, fontWeight: 600
            }}><span style={{display:"inline-flex",alignItems:"center",gap:6}}><FileText size={14}/>PDF Document</span></button>
            <button onClick={() => setImportMode("spreadsheet")} style={{
              flex: 1, padding: "10px 14px", borderRadius: 8, fontSize: 14, fontFamily: "inherit", cursor: "pointer",
              border: "2px solid " + (importMode === "spreadsheet" ? colors.accent : colors.border),
              background: importMode === "spreadsheet" ? colors.accentLight : colors.cardBg,
              color: importMode === "spreadsheet" ? colors.accentDark : colors.text, fontWeight: 600
            }}><span style={{display:"inline-flex",alignItems:"center",gap:6}}><ClipboardList size={14}/>Spreadsheet (CSV/XLSX)</span></button>
          </div>
          <Input label="School" value={importSchoolId} onChange={setImportSchoolId}
            options={schools.map(s => ({ value: s.id, label: s.name }))} />

          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: colors.textLight, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>
              Import Instructions <span style={{ fontWeight: 400, textTransform: "none" }}>(optional but recommended)</span>
            </label>
            <textarea
              value={importInstructions}
              onChange={e => setImportInstructions(e.target.value)}
              rows={6}
              placeholder={importMode === "pdf"
                ? "Examples of things you can tell the AI:\n\n• Class names look like \"Prep A\", \"1/2B\", \"3/4C\"\n• Ignore \"Assembly\" and \"Recess\" — only extract specialist subjects\n• The times shown are session times, each session is 50 min\n• \"LOTE\" means Languages / LOTE\n• Only extract entries for Prep–Year 2 classes\n• The PDF has two tables — one per campus, only use the first"
                : "Examples of things you can tell the AI:\n\n• The \"Period\" column maps to times: P1=9:00-9:30, P2=9:30-10:00\n• Column \"Spec\" is the subject name\n• Ignore rows where subject is \"Library\"\n• Class names are in the \"Grade\" column, not \"Class\"\n• Times are in 12-hour format (e.g. 2:30pm)"}
              style={{
                width: "100%", padding: "12px 14px",
                border: `1px solid ${colors.inputBorder}`, borderRadius: 8,
                fontSize: 14, fontFamily: "inherit", background: colors.inputBg,
                color: colors.text, resize: "vertical", boxSizing: "border-box",
                lineHeight: 1.6
              }}
            />
            <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 6 }}>
              Tell the AI what class names look like, which subjects to include or ignore, how to interpret times, or anything else specific to this document.
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <input ref={fileRef} type="file" accept={importMode === "pdf" ? ".pdf" : ".csv,.xlsx,.xls"} onChange={handleFileUpload} style={{ display: "none" }} />
            <Btn onClick={() => fileRef.current?.click()}>
              {importMode === "pdf" ? <span style={{display:"inline-flex",alignItems:"center",gap:5}}><FileText size={13}/>Select PDF File</span> : <span style={{display:"inline-flex",alignItems:"center",gap:5}}><ClipboardList size={13}/>Select Spreadsheet</span>}
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
        <PageTitle>Specialist Timetables</PageTitle>
        <Card style={{ background: colors.amberLight, borderColor: colors.accent + "40" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ fontSize: 28 }}>⏳</div>
            <div>
              <div style={{ fontWeight: 600, fontSize: 15, color: colors.accent }}>Processing your file...</div>
              <div style={{ fontSize: 13, color: colors.textLight, marginTop: 4 }}>
                AI is reading the document and extracting specialist class data. This usually takes 10–20 seconds.
                {importInstructions.trim() && <span style={{ display: "block", marginTop: 4, color: colors.textMuted, fontStyle: "italic" }}>Using your instructions to guide extraction.</span>}
              </div>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  // ==== RENDER: ERROR ====
  if (importError) {
    return (
      <div>
        <PageTitle subtitle="Something went wrong during import">Import Error</PageTitle>
        <Card style={{ background: colors.redLight, borderColor: "#FCC" }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
            <div style={{ fontSize: 28, flexShrink: 0 }}>⚠️</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 15, color: colors.danger, marginBottom: 8 }}>
                Failed to import "{importError.filename}"
              </div>
              <div style={{ fontSize: 14, color: colors.text, lineHeight: 1.6, marginBottom: 12 }}>
                {importError.message}
              </div>
              <div style={{ fontSize: 12, color: colors.textMuted, padding: "10px 14px", background: colors.cardBg, borderRadius: 8, border: "1px solid #F0E0E0", fontFamily: "monospace", whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 120, overflowY: "auto" }}>
                {importError.details}
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
            <Btn onClick={() => { setImportError(null); openImport("pdf"); }}>Try PDF Again</Btn>
            <Btn variant="secondary" onClick={() => { setImportError(null); openImport("spreadsheet"); }}>Try Spreadsheet</Btn>
            <Btn variant="ghost" onClick={() => setImportError(null)}>Dismiss</Btn>
          </div>
        </Card>

        <Card style={{ marginTop: 16, background: colors.accentLight, borderColor: colors.accent + "40" }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: colors.accentDark, marginBottom: 6 }}>💡 Troubleshooting Tips</div>
          <div style={{ fontSize: 12, color: colors.accentDark, lineHeight: 1.8 }}>
            • <strong>Network error:</strong> Check your internet connection and try again
            <br />• <strong>Empty response:</strong> The PDF might be image-based (scanned). Try a text-based PDF or use a spreadsheet
            <br />• <strong>Unexpected format:</strong> Add more specific instructions about class names, time formats, and layout
            <br />• <strong>File too large:</strong> Try a smaller PDF or convert the relevant page to a spreadsheet
          </div>
        </Card>
      </div>
    );
  }

  // ==== RENDER: PREVIEW ====
  if (preview) {
    return (
      <div>
        <PageTitle subtitle={`Extracted ${preview.entries.length} entries from ${preview.filename} — review and edit before importing`}>Review Import</PageTitle>

        <Card style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <label style={{ fontSize: 13, fontWeight: 600, color: colors.textLight, whiteSpace: "nowrap" }}>Assign all to school:</label>
            <select value={preview.schoolId} onChange={e => updateAllPreviewSchool(e.target.value)}
              style={{ flex: 1, padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit" }}>
              <option value="">Select school...</option>
              {schools.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          {!preview.schoolId && <div style={{ fontSize: 12, color: colors.danger, marginTop: 8 }}>⚠ Please select a school before importing</div>}
        </Card>

        <Card style={{ padding: 0, overflow: "hidden", marginBottom: 16 }}>
          <div style={{ maxHeight: 500, overflowY: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: colors.bg, borderBottom: `1px solid ${colors.border}`, position: "sticky", top: 0, zIndex: 1 }}>
                  {["Class", "Day", "Start", "End", "Subject", ""].map(h => (
                    <th key={h} style={{ padding: "10px 12px", textAlign: "left", fontSize: 11, fontWeight: 600, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.5, background: colors.bg }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.entries.map((entry, i) => (
                  <tr key={entry.id} style={{ borderBottom: `1px solid ${colors.borderLight}` }}>
                    <td style={{ padding: "6px 12px" }}>
                      <input value={entry.className} onChange={e => updatePreviewEntry(i, "className", e.target.value)}
                        style={{ width: "100%", padding: "4px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 4, fontSize: 13, fontFamily: "inherit" }} />
                    </td>
                    <td style={{ padding: "6px 12px" }}>
                      <select value={entry.day} onChange={e => updatePreviewEntry(i, "day", e.target.value)}
                        style={{ padding: "4px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 4, fontSize: 13, fontFamily: "inherit" }}>
                        {DAYS.map(d => <option key={d} value={d}>{d}</option>)}
                      </select>
                    </td>
                    <td style={{ padding: "6px 12px" }}>
                      <input type="time" value={entry.start} onChange={e => updatePreviewEntry(i, "start", e.target.value)}
                        style={{ padding: "4px 6px", border: `1px solid ${colors.inputBorder}`, borderRadius: 4, fontSize: 13, fontFamily: "inherit" }} />
                    </td>
                    <td style={{ padding: "6px 12px" }}>
                      <input type="time" value={entry.end} onChange={e => updatePreviewEntry(i, "end", e.target.value)}
                        style={{ padding: "4px 6px", border: `1px solid ${colors.inputBorder}`, borderRadius: 4, fontSize: 13, fontFamily: "inherit" }} />
                    </td>
                    <td style={{ padding: "6px 12px" }}>
                      <input value={entry.subject} onChange={e => updatePreviewEntry(i, "subject", e.target.value)}
                        style={{ width: "100%", padding: "4px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 4, fontSize: 13, fontFamily: "inherit" }} />
                    </td>
                    <td style={{ padding: "6px 12px" }}>
                      <button onClick={() => removePreviewEntry(i)} style={{ border: "none", background: "none", color: colors.danger, cursor: "pointer", display: "inline-flex", alignItems: "center" }}><X size={14} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <div style={{ display: "flex", gap: 10 }}>
          <Btn onClick={confirmImport} disabled={!preview.schoolId}>✓ Import {preview.entries.length} Entries</Btn>
          <Btn variant="secondary" onClick={() => setPreview(null)}>Cancel</Btn>
        </div>
      </div>
    );
  }

  // ==== RENDER: MANUAL FORM ====
  if (form) {
    const isNew = editing === "new";
    return (
      <div onKeyDown={e => { if (e.key === "Enter" && e.target.tagName !== "TEXTAREA" && e.target.tagName !== "SELECT" && e.target.tagName !== "BUTTON") { e.preventDefault(); saveEntry(); } }}>
        <PageTitle subtitle={isNew ? "Add a subject to one or more day/time slots at once." : "Edit this specialist entry."}>{isNew ? "Add Specialist Entry" : "Edit Specialist Entry"}</PageTitle>
        <Card>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 20px" }}>
            <Input label="School" value={form.schoolId} onChange={v => setForm(p => ({ ...p, schoolId: v }))} options={schools.map(s => ({ value: s.id, label: s.name }))} />
            <Input label="Class / Grade" value={form.className} onChange={v => setForm(p => ({ ...p, className: v }))} placeholder="e.g. 3A, Prep B, Year 5" />
            <Input label="Subject" value={SPECIALIST_SUBJECTS.includes(form.subject) || !form.subject ? form.subject : "Other"} onChange={v => setForm(p => ({ ...p, subject: v, customSubject: v === "Other" ? (p.customSubject || "") : "" }))} options={SPECIALIST_SUBJECTS} />
            {(form.subject === "Other" || (!SPECIALIST_SUBJECTS.includes(form.subject) && form.subject)) && (
              <Input label="Custom Subject Name" value={form.customSubject || (form.subject !== "Other" ? form.subject : "")} onChange={v => setForm(p => ({ ...p, customSubject: v }))} placeholder="e.g. Spelling, Handwriting, Coding" />
            )}
          </div>

          <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: colors.textLight, marginTop: 16, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>Day & Time Slots</label>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {form.timeSlots.map((ts, i) => (
              <div key={ts.id} style={{ display: "flex", gap: 10, alignItems: "center", padding: "8px 12px", background: colors.bg, borderRadius: 8, border: `1px solid ${colors.borderLight}` }}>
                <select value={ts.day} onChange={e => updateTimeSlot(i, "day", e.target.value)}
                  style={{ padding: "6px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit", minWidth: 110 }}>
                  {DAYS.map(d => <option key={d} value={d}>{d}</option>)}
                </select>
                <input type="time" value={ts.start} onChange={e => updateTimeSlot(i, "start", e.target.value)}
                  style={{ padding: "6px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit" }} />
                <span style={{ color: colors.textMuted, fontSize: 13 }}>to</span>
                <input type="time" value={ts.end} onChange={e => updateTimeSlot(i, "end", e.target.value)}
                  style={{ padding: "6px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit" }} />
                {isNew && (
                  <>
                    <button onClick={() => duplicateTimeSlot(i)} title="Duplicate" style={{ border: "none", background: "none", cursor: "pointer", fontSize: 14, color: colors.textMuted, padding: "2px 4px" }}>⧉</button>
                    {form.timeSlots.length > 1 && (
                      <button onClick={() => removeTimeSlot(i)} title="Remove" style={{ border: "none", background: "none", cursor: "pointer", color: colors.danger, padding: "2px 4px", display: "inline-flex", alignItems: "center" }}><X size={14} /></button>
                    )}
                  </>
                )}
              </div>
            ))}
            {isNew && (
              <button onClick={addTimeSlot} style={{ alignSelf: "flex-start", padding: "6px 14px", background: "none", border: `1px dashed ${colors.border}`, borderRadius: 8, fontSize: 13, color: colors.accent, cursor: "pointer", fontFamily: "inherit" }}>
                + Add another day/time
              </button>
            )}
          </div>

          <Input label="Notes (optional)" value={form.notes} onChange={v => setForm(p => ({ ...p, notes: v }))} placeholder="e.g. alternating weeks only" />
          <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
            <Btn onClick={saveEntry}>{isNew ? (form.timeSlots.length > 1 ? `Save ${form.timeSlots.length} Entries & Add More` : "Save & Add Another") : "Save"}</Btn>
            <Btn variant="secondary" onClick={() => { setForm(null); setEditing(null); }}>Done</Btn>
          </div>
        </Card>
      </div>
    );
  }

  // ==== RENDER: MAIN LIST ====

  // Subject colour palette for the calendar strip
  const SUBJECT_COLORS = {
    "Art": "#F59E0B", "Music": "#C47A6A", "PE/Sport": "#4A9B6E", "LOTE": "#344565",
    "Science": "#5BBDD4", "Library": "#B07CD4", "Digital Tech": "#D48B5B",
    "Drama": "#F97316", "Dance": "#D45B5B", "STEM": "#8cc183", "Wellbeing": "#6B9FD4",
  };
  const subjectColor = (s) => SUBJECT_COLORS[s] || colors.accent;

  // Extract year level from class name: "5A" -> "5", "3/4A" -> "3/4", "Prep A" -> "Prep"
  const yearLevel = (className) => {
    if (!className) return className;
    // Strip trailing letter suffix (and any space before it), but only if something numeric/meaningful remains
    // e.g. "5A" -> "5", "3/4B" -> "3/4", "Prep A" -> "Prep", "Year 5A" -> "Year 5"
    const stripped = className.replace(/\s+[A-Za-z]$/, "").replace(/[A-Za-z]$/, "").trim();
    return stripped || className;
  };

  // Merge entries with same school+day+start+end+subject into one, combining year levels
  const mergeStripEntries = (entries) => {
    const groups = {};
    for (const e of entries) {
      const key = `${e.schoolId}|${e.day}|${e.start}|${e.end}|${e.subject}`;
      if (!groups[key]) groups[key] = { ...e, _classes: [e.className] };
      else groups[key]._classes.push(e.className);
    }
    return Object.values(groups).map(g => {
      if (g._classes.length === 1) return { ...g, displayClass: g.className };
      // Map to year levels, deduplicate, then sort
      const seen = new Set();
      const levels = [];
      for (const cn of g._classes) {
        const lv = yearLevel(cn);
        if (!seen.has(lv)) { seen.add(lv); levels.push(lv); }
      }
      levels.sort((a, b) => {
        const na = parseInt(a), nb = parseInt(b);
        if (!isNaN(na) && !isNaN(nb)) return na - nb;
        return a.localeCompare(b);
      });
      return { ...g, displayClass: levels.join("/") };
    });
  };

  // Build per-day data from filtered entries (grouped by school within each day)
  const STRIP_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
  const stripByDay = STRIP_DAYS.map(day => {
    const raw = filtered
      .filter(e => e.day === day)
      .sort((a, b) => a.start.localeCompare(b.start));
    const merged = mergeStripEntries(raw).sort((a, b) => a.start.localeCompare(b.start));
    // Group by school for display
    const bySchool = {};
    for (const e of merged) {
      const sName = (schools.find(s => s.id === e.schoolId) || {}).name || "Unknown";
      if (!bySchool[sName]) bySchool[sName] = [];
      bySchool[sName].push(e);
    }
    return { day, entries: merged, bySchool };
  });

  // Build per-school data for the collapsible banners (always use filtered)
  const bannerSchools = (() => {
    const map = {};
    for (const e of filtered) {
      const school = schools.find(s => s.id === e.schoolId);
      const id = e.schoolId;
      const name = school ? school.name : "Unknown School";
      if (!map[id]) map[id] = { id, name, entries: [] };
      map[id].entries.push(e);
    }
    // Sort schools by name
    return Object.values(map).sort((a, b) => a.name.localeCompare(b.name));
  })();

  const toggleBanner = (id) => setSchoolBannerOpen(prev => ({ ...prev, [id]: !prev[id] }));
  const setBannerMode = (id, mode, e) => {
    e.stopPropagation();
    setSchoolBannerMode(prev => ({ ...prev, [id]: mode }));
    setSchoolBannerOpen(prev => ({ ...prev, [id]: true }));
  };

  return (
    <div>
      <PageTitle pageColor={PAGE_COLORS.specialists}
        navButtons={<NavButtons goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}
        action={<div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {filterSchool && (
            <Btn variant="secondary" onClick={() => { setUpdateSchoolId(filterSchool); setImportError(null); }} style={{ fontSize: 12 }}><span style={{display:"inline-flex",alignItems:"center",gap:5}}><RefreshCw size={12}/>Update</span></Btn>
          )}
          <div style={{ position: "relative", display: "inline-block" }}
            onMouseEnter={e => { const t = e.currentTarget.querySelector(".spec-import-tooltip"); if (t) t.style.display = "block"; }}
            onMouseLeave={e => { const t = e.currentTarget.querySelector(".spec-import-tooltip"); if (t) t.style.display = "none"; }}>
            <Btn variant="secondary" onClick={() => openImport("spreadsheet")}>Import</Btn>
            <div className="spec-import-tooltip" style={{
              display: "none", position: "absolute", top: "calc(100% + 8px)", right: 0,
              width: 360, background: colors.cardBg, border: "1px solid " + colors.border,
              borderRadius: 10, boxShadow: "0 8px 24px rgba(0,0,0,0.12)", padding: "14px 16px",
              zIndex: 200, color: colors.text, fontSize: 12, lineHeight: 1.6,
            }}>
              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8, color: colors.sidebarActive }}><span style={{display:"inline-flex",alignItems:"center",gap:5}}><ClipboardList size={13}/>Spreadsheet Import Format</span></div>
              <div style={{ marginBottom: 8 }}>
                <span style={{ fontWeight: 600 }}>Required columns:</span><br/>
                <code style={{ background: colors.bg, borderRadius: 4, padding: "1px 5px", fontSize: 11 }}>class</code> &nbsp;
                <code style={{ background: colors.bg, borderRadius: 4, padding: "1px 5px", fontSize: 11 }}>day</code> &nbsp;
                <code style={{ background: colors.bg, borderRadius: 4, padding: "1px 5px", fontSize: 11 }}>start</code> &nbsp;
                <code style={{ background: colors.bg, borderRadius: 4, padding: "1px 5px", fontSize: 11 }}>end</code> &nbsp;
                <code style={{ background: colors.bg, borderRadius: 4, padding: "1px 5px", fontSize: 11 }}>subject</code>
              </div>
              <div style={{ marginBottom: 8 }}>
                <span style={{ fontWeight: 600 }}>Optional columns:</span><br/>
                <code style={{ background: colors.bg, borderRadius: 4, padding: "1px 5px", fontSize: 11 }}>school</code> <span style={{ color: colors.textMuted }}>(school name, matched automatically)</span><br/>
                <code style={{ background: colors.bg, borderRadius: 4, padding: "1px 5px", fontSize: 11 }}>notes</code> <span style={{ color: colors.textMuted }}>(any scheduling notes)</span>
              </div>
              <div style={{ marginBottom: 8 }}>
                <span style={{ fontWeight: 600 }}>Times:</span> 24-hour format preferred <span style={{ color: colors.textMuted }}>(e.g. 09:00, 14:30)</span><br/>
                <span style={{ color: colors.textMuted }}>Add instructions to explain 12-hour, period names, or other formats.</span>
              </div>
              <div style={{ marginBottom: 6 }}>
                <span style={{ fontWeight: 600 }}>Subjects recognised:</span><br/>
                <span style={{ color: colors.textMuted }}>Art, Music, PE/Sport, LOTE, Science, Library, Digital Tech, Drama, Dance, STEM, Wellbeing — or any custom name.</span>
              </div>
              <div style={{ borderTop: "1px solid " + colors.border, paddingTop: 8, marginTop: 4, color: colors.textMuted }}>
                <span style={{display:"inline-flex",alignItems:"center",gap:4}}><FileText size={12}/>PDF import also available — click Import to switch modes.</span>
              </div>
            </div>
          </div>
          <Btn onClick={newEntry}>+ Add</Btn>
        </div>}>
        Specialist Timetables
      </PageTitle>

      {schools.length === 0 ? (
        <EmptyState icon={<Building2 size={32} />} title="Add schools first" subtitle="Set up at least one school before adding specialist timetables." />
      ) : specialists.length === 0 ? (
        <EmptyState icon={<Palette size={32} />} title="No specialist timetables yet" subtitle="Import from a PDF or spreadsheet (with optional instructions), or add entries manually." action="+ Add Entry" onAction={newEntry} />
      ) : (
        <>
          {/* ── FILTER BAR ── */}
          <div ref={filterBarRef} style={{ position: "sticky", top: HEADER_HEIGHT, zIndex: 10, marginBottom: 16 }}>
            <Card style={{ padding: 14 }}>
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <select value={filterSchool} onChange={e => { setFilterSchool(e.target.value); setFilterClass(""); }}
                  style={{ padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit" }}>
                  <option value="">All Schools</option>
                  {schools.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                <select value={filterClass} onChange={e => setFilterClass(e.target.value)}
                  style={{ padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit" }}>
                  <option value="">All Classes</option>
                  {[...new Set(specialists
                    .filter(s => !filterSchool || s.schoolId === filterSchool)
                    .map(s => s.className).filter(Boolean))]
                    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
                    .map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                <select value={filterDay} onChange={e => setFilterDay(e.target.value)}
                  style={{ padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit" }}>
                  <option value="">All Days</option>
                  {DAYS.map(d => <option key={d} value={d}>{d}</option>)}
                </select>
                <select value={filterSubject} onChange={e => setFilterSubject(e.target.value)}
                  style={{ padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit" }}>
                  <option value="">All Subjects</option>
                  {[...new Set(specialists.map(s => s.subject).filter(Boolean))].sort().map(s => <option key={s} value={s}>{s}</option>)}
                </select>
                {filterSchool && (
                  <Btn variant="danger" onClick={() => clearSchoolEntries(filterSchool)} style={{ fontSize: 12 }}>Clear This School</Btn>
                )}
                <Btn variant="danger" onClick={clearAllEntries} style={{ fontSize: 12 }}>Clear All</Btn>
              </div>
              {(filterSchool || filterClass || filterDay || filterSubject) && (
                <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 8 }}>
                  Showing {filtered.length} of {specialists.length} entries
                  <button onClick={() => { setFilterSchool(""); setFilterClass(""); setFilterDay(""); setFilterSubject(""); }}
                    style={{ border: "none", background: "none", color: colors.accent, cursor: "pointer", fontSize: 12, marginLeft: 8, textDecoration: "underline" }}>Clear filters</button>
                </div>
              )}
            </Card>
          </div>

          {/* ── CALENDAR STRIP ── */}
          <div style={{ marginBottom: 20, borderRadius: 10, overflow: "hidden", border: `2px solid ${colors.sidebarHover}` }}>
            <div onClick={() => setCalendarStripOpen(v => !v)}
              style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", background: colors.sidebarHover, color: "#fff", cursor: "pointer", userSelect: "none" }}>
              <span style={{ fontWeight: 700, fontSize: 14, flex: 1 }}>Week Overview</span>
              <span style={{ fontSize: 11, color: "rgba(255,255,255,0.6)", marginRight: 4 }}>{specialists.length} {specialists.length === 1 ? "entry" : "entries"}</span>
              {calendarStripOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </div>
            {calendarStripOpen && (
          <Card style={{ marginBottom: 0, padding: 0, overflow: "hidden", borderRadius: 0, border: "none" }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)" }}>
              {stripByDay.map(({ day, bySchool }, di) => {
                const allEntries = Object.values(bySchool).flat();
                return (
                  <div key={day} style={{
                    borderRight: di < 4 ? `1px solid ${colors.borderLight}` : "none",
                    display: "flex", flexDirection: "column",
                  }}>
                    {/* Day header */}
                    <div style={{
                      padding: "8px 10px", textAlign: "center", fontWeight: 700, fontSize: 12,
                      letterSpacing: 0.8, textTransform: "uppercase",
                      background: allEntries.length > 0 ? colors.sidebarHover : `${colors.sidebarHover}88`,
                      color: allEntries.length > 0 ? "#fff" : "rgba(255,255,255,0.55)",
                      borderBottom: `1px solid ${colors.borderLight}`,
                    }}>
                      {day.slice(0, 3)}
                    </div>
                    {/* Entries */}
                    <div style={{ flex: 1, padding: allEntries.length > 0 ? "8px 6px" : "12px 8px", minHeight: 60 }}>
                      {allEntries.length === 0 ? (
                        <div style={{ fontSize: 11, color: colors.textMuted, textAlign: "center", paddingTop: 4, fontStyle: "italic" }}>—</div>
                      ) : (
                        Object.entries(bySchool).map(([schoolName, entries]) => (
                          <div key={schoolName} style={{ marginBottom: Object.keys(bySchool).length > 1 ? 8 : 0 }}>
                            {Object.keys(bySchool).length > 1 && (
                              <div style={{ fontSize: 9, fontWeight: 700, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>{schoolName}</div>
                            )}
                            {entries.map(e => (
                              <div key={e.id} style={{
                                display: "flex", alignItems: "center", gap: 4,
                                padding: "3px 6px", marginBottom: 3, borderRadius: 5,
                                background: subjectColor(e.subject) + "18",
                                border: `1px solid ${subjectColor(e.subject)}40`,
                              }}>
                                <span style={{ fontSize: 10, color: colors.textMuted, whiteSpace: "nowrap", flexShrink: 0 }}>
                                  {e.start}–{e.end}
                                </span>
                                <span style={{ fontSize: 10, fontWeight: 600, color: colors.accent, whiteSpace: "nowrap", flexShrink: 0 }}>
                                  {e.displayClass || e.className}
                                </span>
                                <span style={{ fontSize: 11, fontWeight: 600, color: subjectColor(e.subject), overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                  {e.subject}
                                </span>
                              </div>
                            ))}
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
            )}
          </div>

          {/* ── SCHOOL BANNERS ── */}
          {bannerSchools.map(({ id, name, entries }) => {
            const isOpen = !!schoolBannerOpen[id];
            const mode = schoolBannerMode[id] || "all";
            const bannerSchool = schools.find(s => s.id === id);
            const bannerColor = bannerSchool?.color || colors.sidebarHover;

            // Build display entries based on mode
            const displayContent = (() => {
              if (mode === "day") {
                // Group by day, chronological within each day
                return STRIP_DAYS.map(day => {
                  const dayEntries = entries.filter(e => e.day === day).sort((a, b) => a.start.localeCompare(b.start));
                  if (dayEntries.length === 0) return null;
                  return (
                    <div key={day} style={{ marginBottom: 14 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: colors.sidebarHover, textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 6, paddingBottom: 4, borderBottom: `1px solid ${colors.sidebarHover}40` }}>{day}</div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        {dayEntries.map(e => (
                          <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: colors.bg, borderRadius: 7, border: `1px solid ${colors.borderLight}`, fontSize: 13 }}>
                            <span style={{ fontSize: 11, color: colors.textMuted, minWidth: 80, whiteSpace: "nowrap" }}>{to12h(e.start)}–{to12h(e.end)}</span>
                            <Tag color={subjectColor(e.subject)}>{e.subject}</Tag>
                            <Tag color={colors.accent}>{e.className}</Tag>
                            {e.notes && <span title={e.notes} style={{ fontSize: 11, color: colors.textMuted, cursor: "help", display: "inline-flex", alignItems: "center" }}><StickyNote size={11} /></span>}
                            <div style={{ flex: 1 }} />
                            <button onClick={() => editEntry(e)} style={{ border: "none", background: "none", color: colors.textMuted, cursor: "pointer", padding: "2px 4px", display: "inline-flex", alignItems: "center" }}><Pencil size={12} /></button>
                            <button onClick={() => deleteEntry(e.id)} style={{ border: "none", background: "none", color: colors.danger, cursor: "pointer", padding: "2px 4px", display: "inline-flex", alignItems: "center" }}><X size={13} /></button>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                }).filter(Boolean);
              } else if (mode === "class") {
                // Group by class name, alphabetically
                const byClass = {};
                for (const e of entries) {
                  if (!byClass[e.className]) byClass[e.className] = [];
                  byClass[e.className].push(e);
                }
                return Object.entries(byClass)
                  .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
                  .map(([className, clsEntries]) => {
                    const sorted = [...clsEntries].sort((a, b) => (dayOrder[a.day] || 0) - (dayOrder[b.day] || 0) || a.start.localeCompare(b.start));
                    return (
                      <div key={className} style={{ marginBottom: 14 }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: colors.accent, textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 6, paddingBottom: 4, borderBottom: `1px solid ${colors.borderLight}` }}>Class {className}</div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                          {sorted.map(e => (
                            <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: colors.bg, borderRadius: 7, border: `1px solid ${colors.borderLight}`, fontSize: 13 }}>
                              <span style={{ fontSize: 11, fontWeight: 600, color: colors.text, minWidth: 28 }}>{e.day.slice(0, 3)}</span>
                              <span style={{ fontSize: 11, color: colors.textMuted, minWidth: 80, whiteSpace: "nowrap" }}>{to12h(e.start)}–{to12h(e.end)}</span>
                              <Tag color={subjectColor(e.subject)}>{e.subject}</Tag>
                              {e.notes && <span title={e.notes} style={{ fontSize: 11, color: colors.textMuted, cursor: "help", display: "inline-flex", alignItems: "center" }}><StickyNote size={11} /></span>}
                              <div style={{ flex: 1 }} />
                              <button onClick={() => editEntry(e)} style={{ border: "none", background: "none", color: colors.textMuted, cursor: "pointer", padding: "2px 4px", display: "inline-flex", alignItems: "center" }}><Pencil size={12} /></button>
                              <button onClick={() => deleteEntry(e.id)} style={{ border: "none", background: "none", color: colors.danger, cursor: "pointer", padding: "2px 4px", display: "inline-flex", alignItems: "center" }}><X size={13} /></button>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  });
              } else {
                // "all" — flat list sorted by day then time
                const sorted = [...entries].sort((a, b) => (dayOrder[a.day] || 0) - (dayOrder[b.day] || 0) || a.start.localeCompare(b.start));
                return (
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {sorted.map(e => (
                      <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: colors.bg, borderRadius: 7, border: `1px solid ${colors.borderLight}`, fontSize: 13 }}>
                        <span style={{ fontSize: 11, fontWeight: 600, color: colors.text, minWidth: 28 }}>{e.day.slice(0, 3)}</span>
                        <span style={{ fontSize: 11, color: colors.textMuted, minWidth: 80, whiteSpace: "nowrap" }}>{to12h(e.start)}–{to12h(e.end)}</span>
                        <Tag color={subjectColor(e.subject)}>{e.subject}</Tag>
                        <Tag color={colors.accent}>{e.className}</Tag>
                        {e.notes && <span title={e.notes} style={{ fontSize: 11, color: colors.textMuted, cursor: "help", display: "inline-flex", alignItems: "center" }}><StickyNote size={11} /></span>}
                        <div style={{ flex: 1 }} />
                        <button onClick={() => editEntry(e)} style={{ border: "none", background: "none", color: colors.textMuted, cursor: "pointer", padding: "2px 4px", display: "inline-flex", alignItems: "center" }}><Pencil size={12} /></button>
                        <button onClick={() => deleteEntry(e.id)} style={{ border: "none", background: "none", color: colors.danger, cursor: "pointer", padding: "2px 4px", display: "inline-flex", alignItems: "center" }}><X size={13} /></button>
                      </div>
                    ))}
                  </div>
                );
              }
            })();

            return (
              <div key={id} style={{ marginBottom: 8, borderRadius: 10, overflow: "hidden", border: `2px solid ${bannerColor}` }}>
                {/* Banner header — click to toggle */}
                <div
                  onClick={() => toggleBanner(id)}
                  style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", background: bannerColor, color: "#fff", cursor: "pointer", userSelect: "none" }}>
                  <span style={{ display: "inline-flex", alignItems: "center" }}><Building2 size={15} /></span>
                  <span style={{ fontWeight: 700, fontSize: 15, flex: 1 }}>{name}</span>
                  <span style={{ fontSize: 11, color: "rgba(255,255,255,0.6)", marginRight: 8 }}>{entries.length} {entries.length === 1 ? "entry" : "entries"}</span>
                  {/* Day / Class mode buttons */}
                  <button
                    onClick={e => setBannerMode(id, "day", e)}
                    style={{ padding: "3px 10px", borderRadius: 6, fontSize: 11, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", border: `1px solid ${mode === "day" && isOpen ? "#fff" : "rgba(255,255,255,0.35)"}`, background: mode === "day" && isOpen ? "rgba(255,255,255,0.22)" : "transparent", color: "#fff" }}>
                    Day
                  </button>
                  <button
                    onClick={e => setBannerMode(id, "class", e)}
                    style={{ padding: "3px 10px", borderRadius: 6, fontSize: 11, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", border: `1px solid ${mode === "class" && isOpen ? "#fff" : "rgba(255,255,255,0.35)"}`, background: mode === "class" && isOpen ? "rgba(255,255,255,0.22)" : "transparent", color: "#fff" }}>
                    Class
                  </button>
                  <span style={{ display: "inline-flex", alignItems: "center", marginLeft: 4 }}>{isOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</span>
                </div>
                {/* Collapsible content */}
                {isOpen && (
                  <div style={{ padding: "14px 16px", background: colors.cardBg }}>
                    {displayContent}
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}

      <Card style={{ marginTop: 20, background: colors.accentLight, borderColor: colors.accent + "40" }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: colors.accentDark, marginBottom: 6, display:"flex", alignItems:"center", gap:6 }}><ClipboardList size={13}/>Import Tips</div>
        <div style={{ fontSize: 12, color: colors.accentDark, lineHeight: 1.8 }}>
          Both PDF and spreadsheet imports let you add <strong>instructions</strong> to guide the AI. Use them to specify:
          <br />• What class names look like (e.g. "Prep A", "1/2B", "3/4C")
          <br />• Which subjects to extract or ignore (e.g. "ignore Assembly and Library")
          <br />• How to interpret times (e.g. "P1 = 9:00–9:50, P2 = 9:50–10:40")
          <br />• Any other specifics about the document layout
          <br /><br /><strong>Spreadsheet columns:</strong> class, day, start, end, subject (optional: school, notes). Skip instructions if columns already match.
        </div>
      </Card>
    </div>
  );
}


