// ============================================================
// INTERRUPTIONSMANAGER — extracted from App.js
// ============================================================

import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { colors, DAYS } from "../constants";
import { uid, melbourneToday, toLocalDateStr, getTermWeekLabel } from "../utils/helpers";
import { anthropicFetch, getAnthropicHeaders } from "../utils/api";
import { Card, PageTitle, NavButtons, Btn, Input, Tag, EmptyState, PAGE_COLORS } from "../components/ui/SharedUI";

export function InterruptionsManager({ interruptions, setInterruptions, schools, specialists, notify, resetKey, viewState, setViewState, goBack, goForward, historyCursor, pageHistory, scanPreview, setScanPreview }) {
  const [form, setForm] = useState(null);
  const [editing, setEditing] = useState(null);
  const filterSchool = (viewState || {}).filterSchool || "";
  const setFilterSchool = (v) => setViewState(prev => ({ ...prev, filterSchool: v }));
  const filterType = (viewState || {}).filterType || "";
  const setFilterType = (v) => setViewState(prev => ({ ...prev, filterType: v }));
  const [fetching, setFetching] = useState(null);
  const [swimInstructions, setSwimInstructions] = useState("");
  const [swimSchoolId, setSwimSchoolId] = useState("");
  const [naplanInstructions, setNaplanInstructions] = useState("");
  const [naplanSchoolId, setNaplanSchoolId] = useState("");
  const [addExpanded, setAddExpanded] = useState(false);
  const [upcomingExpanded, setUpcomingExpanded] = useState(false);
  const [termDatesExpanded, setTermDatesExpanded] = useState(false);
  const [termDatePicker, setTermDatePicker] = useState(null); // { breakId, field: "date"|"endDate" }
  const [preview, setPreview] = useState(null);
  const [previewSelected, setPreviewSelected] = useState(new Set()); // Set of entry ids for interruption preview

  // Seed from sidebar scan results when navigating here from Claude panel
  useEffect(() => {
    if (scanPreview) {
      setPreview(scanPreview);
      setPreviewSelected(new Set());
      setScanPreview?.(null);
    }
  }, [scanPreview]);
  const swimRef = useRef(null);
  const naplanRef = useRef(null);
  const importRef = useRef(null);
  const [importMode, setImportMode] = useState(null); // null | "pdf" | "spreadsheet"
  const [importInstructions, setImportInstructions] = useState("");
  const [importSchoolId, setImportSchoolId] = useState("");
  const [importing, setImporting] = useState(false);
  const [overviewSchool, setOverviewSchool] = useState("");
  const [overviewType, setOverviewType] = useState("");

  useEffect(() => { setForm(null); setEditing(null); setFetching(null); setPreview(null); setImportMode(null); }, [resetKey]);

  const INTERRUPTION_TYPES = [
    { value: "public_holiday", label: "Public Holiday", color: "#C45454" },
    { value: "student_free", label: "Student Free / Curriculum Day", color: "#C47A6A" },
    { value: "excursion", label: "Excursion / Incursion", color: "#5B8BD4" },
    { value: "carnival", label: "Athletics / Swimming Carnival", color: "#4A9B6E" },
    { value: "swimming", label: "Swimming Program", color: "#3B9EC4" },
    { value: "concert", label: "Concert / Performance", color: "#D45BA8" },
    { value: "camp", label: "Camp", color: "#5BBDD4" },
    { value: "assembly", label: "Assembly / Special Event", color: "#C4A05B" },
    { value: "photos", label: "School Photos", color: "#9B8EC4" },
    { value: "other", label: "Other", color: "#8B8B8B" }
  ];

  const getTypeInfo = (type) => INTERRUPTION_TYPES.find(t => t.value === type) || INTERRUPTION_TYPES[INTERRUPTION_TYPES.length - 1];

  const today = melbourneToday();

  // ---- AUTO-PURGE PAST EVENTS & MIGRATE TIME DATA on mount ----
  useEffect(() => {
    let changed = false;
    let updated = [...interruptions];

    // Purge past events (but keep term_break and public_holiday — they're needed for week numbering)
    const before = updated.length;
    updated = updated.filter(i => {
      if (i.type === "term_break" || i.type === "public_holiday") return true;
      const endDate = i.endDate || i.date;
      return !endDate || endDate >= today;
    });
    if (updated.length !== before) changed = true;

    // Migrate: move times from notes into startTime/endTime fields
    updated = updated.map(i => {
      if (!i.startTime && i.notes) {
        const timeMatch = i.notes.match(/^(\d{1,2}:\d{2})\s*[\u2013\-–]\s*(\d{1,2}:\d{2})$/);
        if (timeMatch) {
          changed = true;
          return { ...i, startTime: timeMatch[1], endTime: timeMatch[2], notes: "" };
        }
      }
      return i;
    });

    if (changed) setInterruptions(updated);
  }, []);

  // ---- TERM DATE HELPERS ----
  // Get stored term breaks to determine what's "in term"
  const termBreaks = interruptions.filter(i => i.type === "term_break").sort((a, b) => a.date.localeCompare(b.date));

  const isWithinTerm = (dateStr) => {
    if (!dateStr || termBreaks.length === 0) return true; // no term data = show everything
    // A date is within term if it's NOT inside any term break period
    for (const tb of termBreaks) {
      if (dateStr >= tb.date && dateStr <= (tb.endDate || tb.date)) return false;
    }
    return true;
  };

  // Visible interruptions: exclude term_break entries, exclude public holidays outside terms, exclude past
  const visibleInterruptions = interruptions.filter(i => {
    if (i.type === "term_break") return false;
    if (i.type === "public_holiday" && !isWithinTerm(i.date)) return false;
    const endDate = i.endDate || i.date;
    if (endDate && endDate < today) return false;
    return true;
  });

  // ---- FETCH VIC TERM DATES & PUBLIC HOLIDAYS ----
  const fetchTermDatesAndHolidays = async () => {
    setFetching("terms");
    try {
      const currentYear = melbourneNow().getFullYear();
      const response = await anthropicFetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: getAnthropicHeaders(),
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 4000,
          tools: [{ type: "web_search_20250305", name: "web_search" }],
          messages: [{
            role: "user",
            content: `Search for the current Victorian (Australia) school term dates for ${currentYear} and ${currentYear + 1}, plus all Victorian public holidays for those years.

Return ONLY a JSON array of date entries with NO other text, NO markdown backticks. Each entry should have:
- date: "YYYY-MM-DD" format
- endDate: "YYYY-MM-DD" format (same as date for single-day events, or end date for term breaks)
- title: descriptive name
- type: one of "public_holiday" or "term_break"

Include:
- All 4 term start/end dates (as term_break entries for the gaps BETWEEN terms — i.e. school holiday periods)
- All Victorian public holidays including: New Year's Day, Australia Day, Labour Day, Good Friday, Saturday before Easter, Easter Sunday, Easter Monday, Anzac Day, King's Birthday, Friday before AFL Grand Final, Melbourne Cup Day (metro only), Christmas Day, Boxing Day
- Any other gazetted public holidays

For term breaks, create entries spanning the entire break period (e.g. the gap between Term 1 end and Term 2 start).

Return the JSON array only.`
          }]
        })
      });

      if (!response.ok) throw new Error(`API error: ${response.status}`);

      const data = await response.json();
      const textContent = data.content?.filter(c => c.type === "text").map(c => c.text).join("") || "";

      let cleaned = textContent.replace(/```json|```/g, "").trim();
      let entries;
      try {
        // Try to find JSON array in response
        const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
        entries = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(cleaned);
      } catch(e) {
        const lastObj = cleaned.lastIndexOf("}");
        if (lastObj > 0) {
          let recovered = cleaned.substring(0, lastObj + 1);
          if (!recovered.trim().endsWith("]")) recovered += "]";
          if (!recovered.trim().startsWith("[")) recovered = "[" + recovered;
          entries = JSON.parse(recovered);
        } else {
          throw new Error("Could not parse response");
        }
      }

      if (!Array.isArray(entries) || entries.length === 0) {
        notify("Could not find term dates. Try again later.", "warning");
        setFetching(null);
        return;
      }

      // Deduplicate against existing
      const existing = new Set(interruptions.map(i => `${i.date}|${i.title}`));
      const newEntries = entries
        .map(e => ({
          id: uid(),
          schoolId: "all",
          date: e.date || "",
          endDate: e.endDate || e.date || "",
          title: e.title || "",
          type: e.type || "public_holiday",
          affectsClasses: "all",
          startTime: "",
          endTime: "",
          notes: "",
          source: "auto-fetched"
        }))
        .filter(e => e.date && !existing.has(`${e.date}|${e.title}`))
        .filter(e => (e.endDate || e.date) >= today); // skip past dates

      if (newEntries.length === 0) {
        notify("Term dates and holidays are already up to date!", "success");
      } else {
        setInterruptions(prev => [...prev, ...newEntries]);
        const termCount = newEntries.filter(e => e.type === "term_break").length;
        const holCount = newEntries.filter(e => e.type === "public_holiday").length;
        notify(`Added ${termCount} term breaks and ${holCount} public holidays. Term breaks are stored but hidden from the list — public holidays only show if they fall within term time.`);
      }
    } catch (err) {
      console.error("Fetch error:", err);
      notify("Failed to fetch term dates: " + err.message, "danger");
    }
    setFetching(null);
  };

  // ---- SWIMMING TIMETABLE UPLOAD ----
  const handleImportUpload = async (e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;
    e.target.value = "";
    setImporting(true);
    try {
      let userGuidance = "";
      if (importInstructions.trim()) userGuidance = "\n\nSPECIFIC INSTRUCTIONS FROM THE USER:\n---\n" + importInstructions.trim() + "\n---";
      let msgContent;
      const currentYear = melbourneNow().getFullYear();
      const basePrompt = "This document contains school event or interruption data. Extract ALL events that could interrupt normal lesson timetables.\n\nFor each event return:\n- date: \"YYYY-MM-DD\" format (use " + currentYear + " if year not specified)\n- endDate: \"YYYY-MM-DD\" (same as date for single-day events)\n- title: descriptive event name\n- type: one of \"student_free\", \"excursion\", \"carnival\", \"swimming\", \"concert\", \"camp\", \"assembly\", \"photos\", \"other\"\n- affectsClasses: \"all\" if whole school, or specific classes (e.g. \"3A, 3B\")\n- startTime: start time HH:MM 24-hour if available, else empty\n- endTime: end time HH:MM 24-hour if available, else empty\n\nRespond ONLY with a JSON array, no other text, no markdown backticks." + userGuidance;
      if (importMode === "pdf") {
        const base64Data = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result.split(",")[1]); r.onerror = () => rej(new Error("Failed to read file")); r.readAsDataURL(files[0]); });
        msgContent = [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: base64Data } }, { type: "text", text: basePrompt }];
      } else {
        const XLSX = await getXLSX();
        const rawData = await new Promise((res, rej) => {
          const r = new FileReader();
          r.onload = (ev) => {
            try {
              const wb = XLSX.read(ev.target.result, { type: "binary" });
              const ws = wb.Sheets[wb.SheetNames[0]];
              res(XLSX.utils.sheet_to_json(ws, { defval: "" }));
            } catch(err2) { rej(err2); }
          };
          r.onerror = () => rej(new Error("Failed to read file"));
          r.readAsBinaryString(files[0]);
        });
        msgContent = [{ type: "text", text: "I have a spreadsheet with school event data. Here are the rows:\n\n" + JSON.stringify(rawData) + "\n\n" + basePrompt }];
      }
      const response = await anthropicFetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: getAnthropicHeaders(),
        body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 16000, messages: [{ role: "user", content: msgContent }] })
      });
      if (!response.ok) throw new Error("API error: " + response.status);
      const data = await response.json();
      const textContent = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("");
      const cleaned = textContent.replace(/```json|```/g, "").trim();
      const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
      const entries = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(cleaned);
      if (!Array.isArray(entries) || entries.length === 0) { notify("No events found in file.", "warning"); setImporting(false); return; }
      const targetSchool = importSchoolId || (schools.length === 1 ? schools[0].id : "all");
      setPreview({ entries: entries.map(e => ({ id: uid(), schoolId: targetSchool, date: e.date || "", endDate: e.endDate || e.date || "", title: e.title || "", type: e.type || "other", affectsClasses: e.affectsClasses || "all", startTime: e.startTime || "", endTime: e.endTime || "", notes: "", source: "import: " + files[0].name })), source: files[0].name });
      setImportMode(null);
    } catch(err) { notify("Import failed: " + err.message, "danger"); }
    setImporting(false);
  };

  const handleSwimUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = "";

    setFetching("swim");
    try {
      const base64Data = await new Promise((res, rej) => {
        const reader = new FileReader();
        reader.onload = () => res(reader.result.split(",")[1]);
        reader.onerror = () => rej(new Error("Failed to read file"));
        reader.readAsDataURL(file);
      });

      let userGuidance = "";
      if (swimInstructions.trim()) {
        userGuidance = `\n\nSPECIFIC INSTRUCTIONS FROM THE USER:\n---\n${swimInstructions.trim()}\n---`;
      }

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
              { type: "text", text: `This PDF contains a school swimming program timetable. It shows which classes go swimming on which days and times over a period (usually 1-2 weeks).

Extract ALL swimming session entries. Each entry represents a class going to swimming at a particular date and time.

For each entry return:
- date: "YYYY-MM-DD" format (use ${melbourneNow().getFullYear()} if year not specified)
- endDate: same as date for single sessions
- title: descriptive name, e.g. "Swimming - 3A" or "Swimming Program - Prep B"
- type: "swimming"
- affectsClasses: the class or classes attending that session (e.g. "3A", "Prep A, Prep B", "Year 5/6")
- start: start time in HH:MM 24-hour format if available
- end: end time in HH:MM 24-hour format if available

Rules:
- Extract EVERY session for EVERY class across ALL days of the program
- If times are in 12-hour format, convert to 24-hour
- Use the exact class names as shown in the document
- If a date range is given (e.g. "Week of March 10"), create individual entries for each day
- If you can't determine exact dates but know the week, estimate using Monday-Friday

Respond ONLY with a JSON array, no other text, no markdown backticks.${userGuidance}` }
            ]
          }]
        })
      });

      if (!response.ok) throw new Error(`API error: ${response.status}`);

      const data = await response.json();
      const textContent = data.content?.filter(c => c.type === "text").map(c => c.text).join("") || "";
      const cleaned = textContent.replace(/```json|```/g, "").trim();

      let entries;
      try { entries = JSON.parse(cleaned); }
      catch(e) {
        const lastObj = cleaned.lastIndexOf("}");
        if (lastObj > 0) {
          let recovered = cleaned.substring(0, lastObj + 1);
          if (!recovered.trim().endsWith("]")) recovered += "]";
          entries = JSON.parse(recovered);
          notify(`Response was truncated — recovered ${entries.length} entries.`, "warning");
        } else {
          throw new Error("Could not parse AI response");
        }
      }

      if (!Array.isArray(entries) || entries.length === 0) {
        notify("Could not extract swimming sessions. Try adding more specific instructions.", "warning");
        setFetching(null);
        return;
      }

      const targetSchool = swimSchoolId || (schools.length === 1 ? schools[0].id : "all");

      setPreview({
        entries: entries.map(e => ({
          id: uid(),
          schoolId: targetSchool,
          date: e.date || "",
          endDate: e.endDate || e.date || "",
          title: e.title || "Swimming Program",
          type: "swimming",
          affectsClasses: e.affectsClasses || "all",
          startTime: e.start || "",
          endTime: e.end || "",
          notes: "",
          source: "swimming: " + file.name
        })),
        source: "Swimming Timetable: " + file.name
      });
    } catch (err) {
      console.error("Swimming upload error:", err);
      notify("Failed to process swimming timetable: " + err.message, "danger");
    }
    setFetching(null);
  };


  // ---- NAPLAN UPLOAD ----
  const handleNaplanUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = "";
    setFetching("naplan");
    try {
      const base64Data = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result.split(",")[1]); r.onerror = () => rej(new Error("Failed to read file")); r.readAsDataURL(file); });
      let userGuidance = naplanInstructions.trim() ? "\n\nSPECIFIC INSTRUCTIONS FROM THE USER:\n---\n" + naplanInstructions.trim() + "\n---" : "";
      const response = await anthropicFetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: getAnthropicHeaders(),
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514", max_tokens: 16000,
          messages: [{ role: "user", content: [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64Data } },
            { type: "text", text: "This PDF contains a NAPLAN testing timetable. Extract ALL NAPLAN test sessions. For each session return:\n- date: \"YYYY-MM-DD\" (use " + melbourneNow().getFullYear() + " if year not specified)\n- endDate: same as date\n- title: descriptive name e.g. \"NAPLAN - Writing - Year 3\"\n- type: \"other\"\n- affectsClasses: year levels or classes affected (e.g. \"Year 3, Year 5\")\n- start/end: HH:MM 24hr if available\n\nRespond ONLY with a JSON array, no markdown backticks." + userGuidance }
          ]}]
        })
      });
      if (!response.ok) throw new Error("API error: " + response.status);
      const data = await response.json();
      const text = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("");
      const match = text.replace(/```json|```/g, "").trim().match(/\[[\s\S]*\]/);
      const entries = match ? JSON.parse(match[0]) : [];
      if (!Array.isArray(entries) || entries.length === 0) { notify("No NAPLAN sessions found in file.", "warning"); setFetching(null); return; }
      const targetSchool = naplanSchoolId || (schools.length === 1 ? schools[0].id : "all");
      setPreview({ entries: entries.map(e => ({ id: uid(), schoolId: targetSchool, date: e.date || "", endDate: e.endDate || e.date || "", title: e.title || "NAPLAN", type: e.type || "other", affectsClasses: e.affectsClasses || "all", startTime: e.start || "", endTime: e.end || "", notes: "", source: "naplan: " + file.name })), source: "NAPLAN Timetable: " + file.name });
    } catch(err) { notify("Failed to process NAPLAN timetable: " + err.message, "danger"); }
    setFetching(null);
  };

  // ---- Import preview helpers ----
  const confirmImport = (entriesToImport) => {
    if (!preview) return;
    const entries = entriesToImport || preview.entries;
    const existing = new Set(interruptions.map(i => `${i.date}|${i.title}`));
    const newEntries = entries.filter(e => e.date && e.title && !existing.has(`${e.date}|${e.title}`));
    const dupes = entries.length - newEntries.length;
    setInterruptions(prev => [...prev, ...newEntries]);
    notify(`Added ${newEntries.length} interruptions${dupes > 0 ? ` (${dupes} duplicates skipped)` : ""}`);
    setPreview(null);
    setPreviewSelected(new Set());
  };


    const updatePreviewEntry = (idx, key, val) => {
    setPreview(prev => { const entries = [...prev.entries]; entries[idx] = { ...entries[idx], [key]: val }; return { ...prev, entries }; });
  };

  const removePreviewEntry = (idx) => {
    setPreview(prev => ({ ...prev, entries: prev.entries.filter((_, i) => i !== idx) }));
  };

  const updateAllPreviewSchool = (schoolId) => {
    setPreview(prev => ({ ...prev, entries: prev.entries.map(e => ({ ...e, schoolId })) }));
  };

  // ---- MANUAL ENTRY ----
  const newEntry = () => {
    setForm({
      id: uid(), schoolId: "all", date: "", endDate: "", title: "",
      type: "other", affectsClasses: "all", startTime: "", endTime: "",
      daySchedules: [], notes: "", source: "manual"
    });
    setEditing("new");
  };

  const editEntry = (entry) => { setForm({ ...entry }); setEditing(entry.id); };

  const saveEntry = () => {
    if (!form.date && (!form.daySchedules || form.daySchedules.length === 0)) { notify("Date required", "warning"); return; }
    if (!form.title.trim()) { notify("Title required", "warning"); return; }

    const hasDaySchedules = form.daySchedules && form.daySchedules.length > 0;

    if (hasDaySchedules) {
      // Validate all rows have a date
      if (form.daySchedules.some(ds => !ds.date)) { notify("All schedule rows need a date", "warning"); return; }
      if (editing === "new") {
        // Create one interruption entry per day schedule row
        const entries = form.daySchedules.map(ds => ({
          ...form, id: uid(), date: ds.date, endDate: ds.date,
          startTime: ds.startTime || "", endTime: ds.endTime || "",
          daySchedules: undefined,
        }));
        setInterruptions(prev => [...prev, ...entries]);
        notify(`${entries.length} interruption${entries.length !== 1 ? "s" : ""} saved`);
      } else {
        // Editing existing — keep the first row as the original id, add extras
        const [first, ...rest] = form.daySchedules;
        const updated = { ...form, date: first.date, endDate: first.date, startTime: first.startTime || "", endTime: first.endTime || "", daySchedules: undefined };
        const extras = rest.map(ds => ({ ...form, id: uid(), date: ds.date, endDate: ds.date, startTime: ds.startTime || "", endTime: ds.endTime || "", daySchedules: undefined }));
        setInterruptions(prev => [...prev.map(i => i.id === form.id ? updated : i), ...extras]);
        notify(`Interruption updated${extras.length > 0 ? ` + ${extras.length} new` : ""}`);
      }
    } else {
      const entry = { ...form, endDate: form.endDate || form.date, daySchedules: undefined };
      if (editing === "new") { setInterruptions(prev => [...prev, entry]); }
      else { setInterruptions(prev => prev.map(i => i.id === entry.id ? entry : i)); }
      notify("Interruption saved!");
    }
    setForm(null); setEditing(null);
  };

  const deleteEntry = (id) => { setInterruptions(prev => prev.filter(i => i.id !== id)); notify("Removed"); };

  const clearAll = () => {
    // Keep term_break entries (they're hidden but needed for filtering)
    setInterruptions(prev => prev.filter(i => i.type === "term_break"));
    notify("All visible interruptions cleared (term date data retained)");
  };

  // ---- FILTERED & SORTED DATA ----
  const filtered = visibleInterruptions.filter(i => {
    if (filterSchool && i.schoolId !== filterSchool && i.schoolId !== "all") return false;
    if (filterType && i.type !== filterType) return false;
    return true;
  }).sort((a, b) => a.date.localeCompare(b.date));

  // Group by month
  const groupedByMonth = {};
  for (const item of filtered) {
    const monthKey = item.date ? item.date.substring(0, 7) : "unknown";
    const monthLabel = item.date ? new Date(item.date + "T00:00:00").toLocaleDateString("en-AU", { month: "long", year: "numeric" }) : "Unknown Date";
    if (!groupedByMonth[monthKey]) groupedByMonth[monthKey] = { label: monthLabel, items: [] };
    groupedByMonth[monthKey].items.push(item);
  }

  const hasTermData = termBreaks.length > 0;

  // ==== RENDER: IMPORT MODE ====
  if (importMode) {
    return (
      <div>
        <PageTitle subtitle={importMode === "pdf" ? "Upload a PDF with school events" : "Upload a spreadsheet with school events"}>Import Interruptions</PageTitle>
        <Card>
          <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
            <button onClick={() => setImportMode("pdf")} style={{ flex: 1, padding: "10px 14px", borderRadius: 8, fontSize: 14, fontFamily: "inherit", cursor: "pointer", border: "2px solid " + (importMode === "pdf" ? colors.accent : colors.border), background: importMode === "pdf" ? colors.accentLight : colors.white, color: importMode === "pdf" ? colors.accentDark : colors.text, fontWeight: 600 }}>📄 PDF Document</button>
            <button onClick={() => setImportMode("spreadsheet")} style={{ flex: 1, padding: "10px 14px", borderRadius: 8, fontSize: 14, fontFamily: "inherit", cursor: "pointer", border: "2px solid " + (importMode === "spreadsheet" ? colors.accent : colors.border), background: importMode === "spreadsheet" ? colors.accentLight : colors.white, color: importMode === "spreadsheet" ? colors.accentDark : colors.text, fontWeight: 600 }}>📁 Spreadsheet (CSV/XLSX)</button>
          </div>
          {schools.length > 1 && (
            <div style={{ marginBottom: 14 }}>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: colors.textLight, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>Default School <span style={{ fontWeight: 400, textTransform: "none" }}>(if not specified in file)</span></label>
              <select value={importSchoolId} onChange={e => setImportSchoolId(e.target.value)} style={{ padding: "8px 12px", border: "1px solid " + colors.inputBorder, borderRadius: 8, fontSize: 13, fontFamily: "inherit" }}>
                <option value="">Auto-detect / All schools</option>
                {schools.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          )}
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: colors.textLight, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>Import Instructions <span style={{ fontWeight: 400, textTransform: "none" }}>(optional)</span></label>
            <textarea value={importInstructions} onChange={e => setImportInstructions(e.target.value)} rows={5}
              placeholder={importMode === "pdf" ? "Examples:\n• Only extract events from the \"Term 2 Calendar\" section\n• \"PD Day\' means student free day\n• Ignore parent-teacher interview entries\n• All events are for the whole school unless a class is listed" : "Examples:\n• Column 'Event' is the title\n• 'SD' means student free day\n• Date format is DD/MM/YYYY\n• 'All' in the class column means whole school"}
              style={{ width: "100%", padding: "12px 14px", border: "1px solid " + colors.inputBorder, borderRadius: 8, fontSize: 14, fontFamily: "inherit", background: colors.inputBg, color: colors.text, resize: "vertical", boxSizing: "border-box", lineHeight: 1.6 }} />
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <input ref={importRef} type="file" accept={importMode === "pdf" ? ".pdf" : ".csv,.xlsx,.xls"} onChange={handleImportUpload} style={{ display: "none" }} />
            {importing ? <span style={{ fontSize: 13, color: colors.textMuted }}>⏳ Processing...</span> : <Btn onClick={() => importRef.current?.click()}>{importMode === "pdf" ? "📄 Select PDF File" : "📁 Select Spreadsheet"}</Btn>}
            <Btn variant="secondary" onClick={() => setImportMode(null)}>Cancel</Btn>
          </div>
        </Card>
      </div>
    );
  }

  // ==== RENDER: FETCHING ====
  if (fetching) {
    return (
      <div>
        <PageTitle>Interruptions</PageTitle>
        <Card style={{ background: "#FFF8F0", borderColor: colors.accent + "40" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ fontSize: 28 }}>⏳</div>
            <div>
              <div style={{ fontWeight: 600, fontSize: 15, color: colors.accent }}>
                {fetching === "terms" ? "Fetching Victorian term dates & public holidays..."
                  : fetching === "swim" ? "Processing swimming timetable..."
                  : fetching === "naplan" ? "Processing NAPLAN timetable..."
                  : "Scanning URL for events..."}
              </div>
              <div style={{ fontSize: 13, color: colors.textLight, marginTop: 4 }}>
                {fetching === "terms"
                  ? "Searching for the latest school calendar data. This may take 15–30 seconds."
                  : fetching === "swim"
                  ? "AI is reading the swimming program PDF and extracting each class session with dates and times."
                  : fetching === "naplan"
                  ? "AI is reading the NAPLAN timetable and extracting each session with dates, times, and affected classes."
                  : "AI is visiting the page, following the most recent link if it's an archive, and extracting event dates. This may take 20–40 seconds."}
              </div>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  // ==== RENDER: PREVIEW ====
  if (preview) {
    return (
      <div>
        <PageTitle subtitle={`Found ${preview.entries.length} upcoming events — review, assign to a school, and import`}>Review Scanned Events</PageTitle>

        {/* Assign all to school */}
        <Card style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <label style={{ fontSize: 13, fontWeight: 600, color: colors.textLight, whiteSpace: "nowrap" }}>Assign all to:</label>
            <select value={preview.entries[0]?.schoolId || "all"} onChange={e => updateAllPreviewSchool(e.target.value)}
              style={{ flex: 1, padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit" }}>
              <option value="all">All Schools</option>
              {schools.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 6 }}>
            Source: {preview.source}
          </div>
        </Card>

        <Card style={{ padding: 0, overflow: "hidden", marginBottom: 16 }}>
          <div style={{ maxHeight: 500, overflowY: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: colors.bg, borderBottom: `1px solid ${colors.border}`, position: "sticky", top: 0, zIndex: 1 }}>
                  <th style={{ padding: "10px 8px", background: colors.bg, width: 32 }}>
                    <input type="checkbox"
                      checked={previewSelected.size === preview.entries.length && preview.entries.length > 0}
                      onChange={() => {
                        if (previewSelected.size === preview.entries.length) setPreviewSelected(new Set());
                        else setPreviewSelected(new Set(preview.entries.map(e => e.id)));
                      }}
                      style={{ cursor: "pointer" }} />
                  </th>
                  {["Date", "End Date", "Title", "Type", "From", "To", "Affects", "School", ""].map((h, hi) => (
                    <th key={hi} style={{ padding: "10px 8px", textAlign: "left", fontSize: 11, fontWeight: 600, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.5, background: colors.bg }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.entries.map((entry, i) => (
                  <tr key={entry.id} style={{ borderBottom: `1px solid ${colors.borderLight}`, background: previewSelected.has(entry.id) ? colors.blueLight : "transparent" }}>
                    <td style={{ padding: "6px 8px", textAlign: "center" }}>
                      <input type="checkbox" checked={previewSelected.has(entry.id)}
                        onChange={() => setPreviewSelected(prev => { const n = new Set(prev); if (n.has(entry.id)) n.delete(entry.id); else n.add(entry.id); return n; })}
                        style={{ cursor: "pointer" }} />
                    </td>
                    <td style={{ padding: "6px 8px" }}>
                      <input type="date" value={entry.date} onChange={e => updatePreviewEntry(i, "date", e.target.value)}
                        style={{ padding: "4px 6px", border: `1px solid ${colors.inputBorder}`, borderRadius: 4, fontSize: 12, fontFamily: "inherit" }} />
                    </td>
                    <td style={{ padding: "6px 8px" }}>
                      <input type="date" value={entry.endDate} onChange={e => updatePreviewEntry(i, "endDate", e.target.value)}
                        style={{ padding: "4px 6px", border: `1px solid ${colors.inputBorder}`, borderRadius: 4, fontSize: 12, fontFamily: "inherit" }} />
                    </td>
                    <td style={{ padding: "6px 8px" }}>
                      <input value={entry.title} onChange={e => updatePreviewEntry(i, "title", e.target.value)}
                        style={{ width: "100%", padding: "4px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 4, fontSize: 13, fontFamily: "inherit" }} />
                    </td>
                    <td style={{ padding: "6px 8px" }}>
                      <select value={entry.type} onChange={e => updatePreviewEntry(i, "type", e.target.value)}
                        style={{ padding: "4px 6px", border: `1px solid ${colors.inputBorder}`, borderRadius: 4, fontSize: 12, fontFamily: "inherit" }}>
                        {INTERRUPTION_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                      </select>
                    </td>
                    <td style={{ padding: "6px 8px" }}>
                      <input type="time" value={entry.startTime || ""} onChange={e => updatePreviewEntry(i, "startTime", e.target.value)}
                        style={{ padding: "4px 6px", border: `1px solid ${colors.inputBorder}`, borderRadius: 4, fontSize: 12, fontFamily: "inherit" }} />
                    </td>
                    <td style={{ padding: "6px 8px" }}>
                      <input type="time" value={entry.endTime || ""} onChange={e => updatePreviewEntry(i, "endTime", e.target.value)}
                        style={{ padding: "4px 6px", border: `1px solid ${colors.inputBorder}`, borderRadius: 4, fontSize: 12, fontFamily: "inherit" }} />
                    </td>
                    <td style={{ padding: "6px 8px" }}>
                      <input value={entry.affectsClasses} onChange={e => updatePreviewEntry(i, "affectsClasses", e.target.value)}
                        style={{ width: 70, padding: "4px 6px", border: `1px solid ${colors.inputBorder}`, borderRadius: 4, fontSize: 12, fontFamily: "inherit" }} />
                    </td>
                    <td style={{ padding: "6px 8px" }}>
                      <select value={entry.schoolId} onChange={e => updatePreviewEntry(i, "schoolId", e.target.value)}
                        style={{ padding: "4px 6px", border: `1px solid ${colors.inputBorder}`, borderRadius: 4, fontSize: 12, fontFamily: "inherit" }}>
                        <option value="all">All Schools</option>
                        {schools.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </select>
                    </td>
                    <td style={{ padding: "6px 8px" }}>
                      <button onClick={() => removePreviewEntry(i)} style={{ border: "none", background: "none", color: colors.danger, cursor: "pointer", fontSize: 16 }}>×</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <Btn onClick={() => confirmImport()}>✓ Import All ({preview.entries.length})</Btn>
          <Btn variant="secondary" onClick={() => confirmImport(preview.entries.filter(e => previewSelected.has(e.id)))} disabled={previewSelected.size === 0}>
            Import Selected ({previewSelected.size})
          </Btn>
          <Btn variant="secondary" onClick={() => { setPreview(null); setPreviewSelected(new Set()); }}>Cancel</Btn>
        </div>
      </div>
    );
  }

  // ==== HELPERS: class list from specialists ====
  const getClassesForSchool = (schoolId) => {
    if (!schoolId || schoolId === "all") {
      return [...new Set(specialists.map(s => s.className))].sort();
    }
    return [...new Set(specialists.filter(s => s.schoolId === schoolId).map(s => s.className))].sort();
  };

  const toggleFormClass = (cls) => {
    if (!form) return;
    const current = form.affectsClasses === "all" ? [] : form.affectsClasses.split(",").map(c => c.trim()).filter(Boolean);
    const updated = current.includes(cls) ? current.filter(c => c !== cls) : [...current, cls];
    setForm(p => ({ ...p, affectsClasses: updated.length === 0 ? "all" : updated.join(", ") }));
  };

  // ==== RENDER: MANUAL FORM ====
  if (form) {
    const selectedClasses = form.affectsClasses === "all" ? [] : form.affectsClasses.split(",").map(c => c.trim()).filter(Boolean);
    const isAllClasses = form.affectsClasses === "all";
    const availableClasses = getClassesForSchool(form.schoolId);

    return (
      <div onKeyDown={e => { if (e.key === "Enter" && e.target.tagName !== "TEXTAREA" && e.target.tagName !== "SELECT" && e.target.tagName !== "BUTTON") { e.preventDefault(); saveEntry(); } }}>
        <PageTitle>{editing === "new" ? "Add Interruption" : "Edit Interruption"}</PageTitle>
        <Card>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 20px" }}>
            <Input label="Title" value={form.title} onChange={v => setForm(p => ({ ...p, title: v }))} placeholder="e.g. Athletics Carnival" />
            <Input label="Type" value={form.type} onChange={v => setForm(p => ({ ...p, type: v }))}
              options={INTERRUPTION_TYPES.map(t => ({ value: t.value, label: t.label }))} />
            <Input label="Date" value={form.date} onChange={v => setForm(p => ({ ...p, date: v }))} type="date" />
            <Input label="End Date (if multi-day)" value={form.endDate} onChange={v => setForm(p => ({ ...p, endDate: v }))} type="date" />
            <Input label="School" value={form.schoolId} onChange={v => setForm(p => ({ ...p, schoolId: v, affectsClasses: "all" }))}
              options={[{ value: "all", label: "All Schools" }, ...schools.map(s => ({ value: s.id, label: s.name }))]} />
          </div>

          {/* Per-day schedule — replaces single start/end time for multi-day events */}
          <div style={{ marginBottom: 4 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: colors.textLight, textTransform: "uppercase", letterSpacing: 0.5 }}>
                Times
              </label>
              <button onClick={() => {
                // Auto-populate one row per date in the range when first adding
                const days = [];
                if (form.date) {
                  const start = new Date(form.date + "T00:00:00");
                  const end = form.endDate ? new Date(form.endDate + "T00:00:00") : start;
                  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
                    const ds = toLocalDateStr(d);
                    if (!(form.daySchedules || []).some(s => s.date === ds))
                      days.push({ date: ds, startTime: form.startTime || "", endTime: form.endTime || "" });
                  }
                }
                if (days.length === 0) days.push({ date: form.date || "", startTime: form.startTime || "", endTime: form.endTime || "" });
                setForm(p => ({ ...p, daySchedules: [...(p.daySchedules || []), ...days] }));
              }}
                style={{ padding: "3px 10px", border: `1px solid ${colors.accent}`, borderRadius: 6, background: colors.accentLight, color: colors.accent, fontSize: 12, fontFamily: "inherit", fontWeight: 600, cursor: "pointer" }}>
                + Add day
              </button>
            </div>
            {(!form.daySchedules || form.daySchedules.length === 0) ? (
              /* Fall back to legacy single-time row */
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 20px" }}>
                <Input label="Start Time (optional)" value={form.startTime || ""} onChange={v => setForm(p => ({ ...p, startTime: v }))} type="time" />
                <Input label="End Time (optional)" value={form.endTime || ""} onChange={v => setForm(p => ({ ...p, endTime: v }))} type="time" />
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {(form.daySchedules || []).map((ds, idx) => (
                  <div key={idx} style={{ display: "flex", gap: 8, alignItems: "center", padding: "8px 12px", background: colors.bg, borderRadius: 8, border: `1px solid ${colors.borderLight}` }}>
                    <input type="date" value={ds.date} onChange={e => setForm(p => { const a = [...p.daySchedules]; a[idx] = { ...a[idx], date: e.target.value }; return { ...p, daySchedules: a }; })}
                      style={{ padding: "5px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit", flex: "1 1 130px" }} />
                    <input type="time" value={ds.startTime} onChange={e => setForm(p => { const a = [...p.daySchedules]; a[idx] = { ...a[idx], startTime: e.target.value }; return { ...p, daySchedules: a }; })}
                      style={{ padding: "5px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit", flex: "1 1 100px" }} />
                    <span style={{ color: colors.textMuted, fontSize: 13 }}>–</span>
                    <input type="time" value={ds.endTime} onChange={e => setForm(p => { const a = [...p.daySchedules]; a[idx] = { ...a[idx], endTime: e.target.value }; return { ...p, daySchedules: a }; })}
                      style={{ padding: "5px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit", flex: "1 1 100px" }} />
                    <button onClick={() => setForm(p => ({ ...p, daySchedules: p.daySchedules.filter((_, i) => i !== idx) }))}
                      style={{ border: "none", background: "none", color: colors.danger, cursor: "pointer", fontSize: 18, lineHeight: 1, padding: "0 2px", flexShrink: 0 }}>×</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Affected Classes multi-select */}
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: colors.textLight, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>
              Affected Classes
            </label>

            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 14, cursor: "pointer" }}>
                <input type="checkbox" checked={isAllClasses} onChange={() => setForm(p => ({ ...p, affectsClasses: isAllClasses ? "" : "all" }))}
                  style={{ accentColor: colors.accent, width: 16, height: 16 }} />
                <span style={{ fontWeight: isAllClasses ? 600 : 400, color: isAllClasses ? colors.accent : colors.text }}>Whole School</span>
              </label>
              {!isAllClasses && selectedClasses.length > 0 && (
                <span style={{ fontSize: 12, color: colors.textMuted }}>{selectedClasses.length} class{selectedClasses.length !== 1 ? "es" : ""} selected</span>
              )}
            </div>

            {!isAllClasses && (
              <>
                {availableClasses.length > 0 ? (
                  <div style={{
                    display: "flex", flexWrap: "wrap", gap: 6, padding: 12,
                    background: colors.bg, borderRadius: 8, border: `1px solid ${colors.borderLight}`,
                    maxHeight: 180, overflowY: "auto"
                  }}>
                    {availableClasses.map(cls => {
                      const isSel = selectedClasses.includes(cls);
                      return (
                        <button key={cls} onClick={() => toggleFormClass(cls)}
                          style={{
                            padding: "5px 14px", borderRadius: 6, fontSize: 13, fontFamily: "inherit",
                            cursor: "pointer", transition: "all 0.1s",
                            border: isSel ? `2px solid ${colors.accent}` : `1px solid ${colors.inputBorder}`,
                            background: isSel ? colors.accent + "15" : colors.white,
                            color: isSel ? colors.accent : colors.text,
                            fontWeight: isSel ? 600 : 400
                          }}>
                          {cls}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div style={{ fontSize: 13, color: colors.textMuted, fontStyle: "italic", padding: "8px 0" }}>
                    No classes found in specialist data{form.schoolId && form.schoolId !== "all" ? " for this school" : ""}. Type class names manually below.
                  </div>
                )}
                <input
                  value={form.affectsClasses === "all" ? "" : form.affectsClasses}
                  onChange={e => setForm(p => ({ ...p, affectsClasses: e.target.value || "all" }))}
                  placeholder="Or type manually, e.g. 3A, 3B, 4A"
                  style={{ marginTop: 8, width: "100%", padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" }}
                />
              </>
            )}
          </div>

          <Input label="Notes" value={form.notes} onChange={v => setForm(p => ({ ...p, notes: v }))} placeholder="Any details..." />
          <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
            <Btn onClick={saveEntry}>Save</Btn>
            <Btn variant="secondary" onClick={() => { setForm(null); setEditing(null); }}>Cancel</Btn>
          </div>
        </Card>
      </div>
    );
  }

  // ==== RENDER: MAIN VIEW ====
  return (
    <div>
      <PageTitle subtitle={(() => {
        const upcomingBreaks = termBreaks.filter(tb => tb.date > today).sort((a, b) => a.date.localeCompare(b.date));
        const termEnd = upcomingBreaks.length > 0 ? upcomingBreaks[0].date : (today.substring(0, 4) + "-12-20");
        const termCount = visibleInterruptions.filter(i => i.date <= termEnd).length;
        return termCount + " Upcoming this term" + (hasTermData ? "" : " · No term data yet");
      })()} pageColor={PAGE_COLORS.interruptions}
        navButtons={<NavButtons goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}
        action={null}>
        Interruptions
      </PageTitle>

      {/* ==== ADD INTERRUPTIONS COLLAPSIBLE BANNER ==== */}
      <div style={{ marginBottom: 16 }}>
        <div onClick={() => setAddExpanded(v => !v)}
          style={{ background: colors.accent, borderRadius: addExpanded ? "10px 10px 0 0" : 10, padding: "12px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", userSelect: "none" }}>
          <span style={{ color: colors.white, fontWeight: 700, fontSize: 14 }}>+ Add Interruptions</span>
          <span style={{ color: "rgba(255,255,255,0.7)", fontSize: 18, lineHeight: 1 }}>{addExpanded ? "▲" : "▼"}</span>
        </div>
        {addExpanded && (
          <div style={{ border: `1px solid ${colors.accent}`, borderTop: "none", borderRadius: "0 0 10px 10px", padding: 20, display: "flex", flexDirection: "column", gap: 16, background: colors.white }}>
            {/* Add / Import buttons */}
            <div style={{ display: "flex", gap: 8 }}>
              <Btn onClick={newEntry}>+ Add Manually</Btn>
              <Btn variant="secondary" onClick={() => setImportMode("spreadsheet")}>Import File</Btn>
            </div>

            {/* Term dates card */}
            <Card style={{ padding: "14px 20px", border: `1px solid #D8D0F8`, display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 0 }}
              onClick={!hasTermData ? fetchTermDatesAndHolidays : undefined}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span style={{ fontSize: 22 }}>📅</span>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14, color: colors.text }}>Victorian Term Dates & Public Holidays</div>
                  <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 2 }}>
                    {hasTermData ? `${termBreaks.length} term break periods stored · Public holidays within term time are shown below` : "Not yet fetched — click to search for current term dates and public holidays"}
                  </div>
                </div>
              </div>
              <Btn variant="secondary" onClick={(e) => { e.stopPropagation(); fetchTermDatesAndHolidays(); }} style={{ fontSize: 12 }}>
                {hasTermData ? "↻ Refresh" : "Fetch Now"}
              </Btn>
            </Card>


            {/* Upload/Scan Swimming Timetable */}
            <Card style={{ border: `1px solid #B0D8E8`, marginBottom: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
                <span style={{ fontSize: 22 }}>🏊</span>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14, color: colors.text }}>Upload/Scan Swimming Timetable</div>
                  <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 2 }}>Upload a PDF or scan a URL — AI will extract each class session with dates, times, and affected classes.</div>
                </div>
              </div>
              <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10 }}>
                <select value={swimSchoolId} onChange={e => setSwimSchoolId(e.target.value)}
                  style={{ padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", minWidth: 160 }}>
                  <option value="">Select school...</option>
                  {schools.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                <input ref={swimRef} type="file" accept=".pdf" onChange={handleSwimUpload} style={{ display: "none" }} />
                <Btn variant="secondary" onClick={() => swimRef.current?.click()} style={{ fontSize: 13 }}>📄 Upload PDF</Btn>
              </div>
              <textarea value={swimInstructions} onChange={e => setSwimInstructions(e.target.value)} rows={2}
                placeholder="Tips for the AI — e.g. 'Only extract Year 3-6 sessions', 'Dates start from March 10', 'Sessions are 45 minutes from listed start time'"
                style={{ width: "100%", padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", resize: "vertical", boxSizing: "border-box" }} />
            </Card>

            {/* Upload/Scan NAPLAN Timetable */}
            <Card style={{ border: `1px solid #D4B8E8`, marginBottom: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
                <span style={{ fontSize: 22 }}>📝</span>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14, color: colors.text }}>Upload/Scan NAPLAN Timetable</div>
                  <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 2 }}>Upload a PDF or scan a URL — AI will extract each NAPLAN test session with dates, times, and affected year levels.</div>
                </div>
              </div>
              <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10 }}>
                <select value={naplanSchoolId} onChange={e => setNaplanSchoolId(e.target.value)}
                  style={{ padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", minWidth: 160 }}>
                  <option value="">Select school...</option>
                  {schools.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                <input ref={naplanRef} type="file" accept=".pdf" onChange={handleNaplanUpload} style={{ display: "none" }} />
                <Btn variant="secondary" onClick={() => naplanRef.current?.click()} style={{ fontSize: 13 }}>📄 Upload PDF</Btn>
              </div>
              <textarea value={naplanInstructions} onChange={e => setNaplanInstructions(e.target.value)} rows={2}
                placeholder="Tips for the AI — e.g. 'Only extract Year 3 and Year 5 sessions', 'Sessions run for 45 minutes', 'Catch-up sessions on the following Friday'"
                style={{ width: "100%", padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", resize: "vertical", boxSizing: "border-box" }} />
            </Card>
          </div>
        )}
      </div>

      {/* ==== FULL-TERM OVERVIEW ==== */}
      {(() => {
        // Calculate term week number for a given date
        const getTermWeekNumber = (dateStr) => {
          if (termBreaks.length === 0) return null;
          const d = new Date(dateStr + "T00:00:00");
          const year = d.getFullYear();

          // Helper: find Monday of the week containing a date
          const getMondayOf = (dt) => {
            const m = new Date(dt);
            const dow = m.getDay(); // 0=Sun
            const off = dow === 0 ? -6 : 1 - dow;
            m.setDate(m.getDate() + off);
            m.setHours(0, 0, 0, 0);
            return m;
          };

          // Helper: get Term 1 start (always the weekday after Australia Day, Jan 26)
          const getTerm1Start = () => {
            // Check if we have an Australia Day public holiday stored
            const ausDayHoliday = interruptions.find(i =>
              i.type === "public_holiday" &&
              i.date && i.date.startsWith(year + "-01-2")
            );
            if (ausDayHoliday) {
              const d = new Date(ausDayHoliday.date + "T00:00:00");
              d.setDate(d.getDate() + 1);
              while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
              return d;
            }
            // Fallback: first Tuesday on or after Jan 27
            const start = new Date(year, 0, 27);
            while (start.getDay() !== 2) start.setDate(start.getDate() + 1);
            return start;
          };

          // Find the most recent break that ended before this date
          let termStartDay = null;
          let breakEndMonth = -1;
          for (const tb of termBreaks) {
            const tbEnd = new Date((tb.endDate || tb.date) + "T00:00:00");
            if (tbEnd < d) {
              termStartDay = new Date(tbEnd);
              termStartDay.setDate(termStartDay.getDate() + 1);
              breakEndMonth = tbEnd.getMonth(); // 0=Jan
            }
          }

          // If the most recent break ended in Dec or Jan, we're in Term 1
          // Use the reliable Australia Day anchor instead of the AI's break end date
          if (!termStartDay || breakEndMonth === 11 || breakEndMonth === 0) {
            termStartDay = getTerm1Start();
          }

          // Week 1 Monday = Monday of the week containing term start
          const week1Monday = getMondayOf(termStartDay);
          // Target Monday = Monday of the week containing d
          const targetMonday = getMondayOf(d);

          // Week number = difference in whole weeks + 1
          const diffMs = targetMonday.getTime() - week1Monday.getTime();
          const diffWeeks = Math.round(diffMs / (7 * 24 * 60 * 60 * 1000));
          return Math.max(1, diffWeeks + 1);
        };


        // Build full-term weeks from current week to end of current term
        const thisMonday = getCurrentWeekMonday();
        const upcomingBreaks = termBreaks.filter(tb => tb.date > today).sort((a, b) => a.date.localeCompare(b.date));
        const termEndDate = upcomingBreaks.length > 0
          ? new Date(upcomingBreaks[0].date + "T00:00:00")
          : new Date(today.substring(0, 4) + "-12-20T00:00:00");
        const msPerWeek = 7 * 24 * 60 * 60 * 1000;
        const weeksToEnd = Math.ceil((termEndDate - thisMonday) / msPerWeek);
        const numWeeks = Math.max(1, Math.min(weeksToEnd, 20));

        // After 6pm Friday of a week, that week is considered past — skip it
        const now = melbourneNow();
        const isFridayPast = (mondayDate) => {
          const fri = new Date(mondayDate);
          fri.setDate(mondayDate.getDate() + 4);
          fri.setHours(18, 0, 0, 0);
          return now > fri;
        };

        const weeks = [];
        let wIdx = 0;
        for (let w = 0; w < numWeeks; w++) {
          const weekStart = new Date(thisMonday);
          weekStart.setDate(thisMonday.getDate() + w * 7);
          if (isFridayPast(weekStart)) continue; // skip past weeks
          const days = [];
          for (let d = 0; d < 5; d++) {
            const date = new Date(weekStart);
            date.setDate(weekStart.getDate() + d);
            const dateStr = toLocalDateStr(date);
            days.push({ date, dateStr, dayName: ["Mon", "Tue", "Wed", "Thu", "Fri"][d], dayNum: date.getDate() });
          }
          const weekNum = getTermWeekNumber(days[0].dateStr);
          weeks.push({ days, weekNum, weekLabel: weekNum ? "Week " + weekNum : "Week " + (wIdx + 1) });
          wIdx++;
        }

        // Consolidate events for overview: group swimming by school+day
        const getOverviewEvents = (dateStr) => {
          const dayEvents = visibleInterruptions.filter(i => {
            if (overviewSchool && i.schoolId !== overviewSchool && i.schoolId !== "all") return false;
            if (overviewType && i.type !== overviewType) return false;
            const start = i.date;
            const end = i.endDate || i.date;
            return dateStr >= start && dateStr <= end;
          });

          // Group swimming entries by school
          const swimBySchool = {};
          const nonSwim = [];
          for (const ev of dayEvents) {
            if (ev.type === "swimming") {
              const key = ev.schoolId || "all";
              if (!swimBySchool[key]) swimBySchool[key] = ev;
            } else {
              // Prefix school-specific events with school acronym
              if (ev.schoolId && ev.schoolId !== "all") {
                const school = schools.find(s => s.id === ev.schoolId);
                if (school) {
                  const abbrev = school.name.split(" ").map(w => w[0]).join("").toUpperCase();
                  nonSwim.push({ ...ev, title: `${abbrev} - ${ev.title}` });
                } else {
                  nonSwim.push(ev);
                }
              } else {
                nonSwim.push(ev);
              }
            }
          }

          const consolidated = [...nonSwim];
          for (const [schoolId, ev] of Object.entries(swimBySchool)) {
            const school = schools.find(s => s.id === schoolId);
            const abbrev = school ? school.name.split(" ").map(w => w[0]).join("").toUpperCase() : "";
            consolidated.push({
              ...ev,
              title: school ? `${abbrev} - Swimming Program` : "Swimming Program",
              _consolidated: true
            });
          }
          return consolidated;
        };

        const isTermBreakDay = (dateStr) => {
          for (const tb of termBreaks) {
            if (dateStr >= tb.date && dateStr <= (tb.endDate || tb.date)) return true;
          }
          return false;
        };

        return (
          <Card style={{ marginBottom: 20, padding: 0, overflow: "hidden" }}>
            {/* Overview header with filters */}
            <div style={{ padding: "14px 20px", borderBottom: `1px solid ${colors.border}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ fontWeight: 700, fontSize: 15, color: colors.text }}>Term Overview</div>
              <div style={{ display: "flex", gap: 8 }}>
                <select value={overviewSchool} onChange={e => setOverviewSchool(e.target.value)}
                  style={{ padding: "5px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 12, fontFamily: "inherit" }}>
                  <option value="">All Schools</option>
                  {schools.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                <select value={overviewType} onChange={e => setOverviewType(e.target.value)}
                  style={{ padding: "5px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 12, fontFamily: "inherit" }}>
                  <option value="">All Types</option>
                  {INTERRUPTION_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </div>
            </div>

            {/* Week grid */}
            <div style={{ display: "grid", gridTemplateColumns: "80px repeat(5, 1fr)", fontSize: 12 }}>
              {/* Header row */}
              <div style={{ padding: "8px 12px", background: colors.sidebarActive, borderBottom: `1px solid ${colors.border}`, fontWeight: 600, color: colors.textMuted }} />
              {["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].map(d => (
                <div key={d} style={{ padding: "8px 6px", background: colors.sidebarActive, borderBottom: `1px solid ${colors.border}`, borderLeft: `1px solid ${colors.borderLight}`, fontWeight: 600, color: colors.white, textAlign: "center", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>{d}</div>
              ))}

              {/* Week rows */}
              {weeks.map((week, wi) => (
                <div key={wi} style={{ display: "contents" }}>
                  {/* Week label */}
                  <div style={{
                    padding: "8px 12px", borderBottom: wi < weeks.length - 1 ? `1px solid ${colors.border}` : "none",
                    display: "flex", alignItems: "flex-start", justifyContent: "center", flexDirection: "column",
                    background: wi % 2 === 0 ? colors.white : "#EEF1F7"
                  }}>
                    <div style={{ fontWeight: 700, fontSize: 13, color: colors.accent }}>{week.weekLabel}</div>
                    <div style={{ fontSize: 10, color: colors.textMuted, marginTop: 2 }}>
                      {week.days[0].date.toLocaleDateString("en-AU", { day: "numeric", month: "short" })}
                    </div>
                  </div>

                  {/* Day cells */}
                  {week.days.map((day, di) => {
                    const events = getOverviewEvents(day.dateStr);
                    const isBreak = isTermBreakDay(day.dateStr);
                    const isToday = day.dateStr === today;

                    return (
                      <div key={di} style={{
                        padding: "6px 6px", minHeight: 60,
                        borderLeft: `1px solid ${colors.borderLight}`,
                        borderBottom: wi < weeks.length - 1 ? `1px solid ${colors.border}` : "none",
                        background: isBreak ? "#F5F0FF" : isToday ? "#FFFFF0" : wi % 2 === 0 ? colors.white : "#EEF1F7",
                        position: "relative"
                      }}>
                        <div style={{
                          fontSize: 10, color: isToday ? colors.accent : colors.textMuted, fontWeight: isToday ? 700 : 400,
                          marginBottom: 3
                        }}>
                          {day.dayNum}{isToday && " ●"}
                        </div>
                        {isBreak ? (
                          <div style={{ fontSize: 10, color: colors.warning, fontStyle: "italic" }}>Holiday</div>
                        ) : (
                          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                            {events.map((ev, ei) => {
                              const typeInfo = getTypeInfo(ev.type);
                              const timeStr = ev.startTime && ev.endTime ? `${ev.startTime}–${ev.endTime}` : "";
                              return (
                                <div key={ei} style={{
                                  padding: "2px 5px", borderRadius: 4, fontSize: 10, lineHeight: 1.3,
                                  background: typeInfo.color + "18", color: typeInfo.color,
                                  fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"
                                }} title={ev.title + (timeStr ? ` (${timeStr})` : "") + (ev.affectsClasses && ev.affectsClasses !== "all" ? ` [${ev.affectsClasses}]` : "")}>
                                  {ev.title}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </Card>
        );
      })()}


      {/* ==== TERM DATES COLLAPSIBLE BANNER ==== */}
      {(() => {
        const year = melbourneNow().getFullYear();
        const getTerm1Start = (y) => { const s = new Date(y, 0, 27); while (s.getDay() !== 2) s.setDate(s.getDate() + 1); return s; };
        // Build interleaved list: [termPeriod, breakEntry, termPeriod, breakEntry, ...]
        const rows = [];
        for (const y of [year, year + 1]) {
          let termStart = getTerm1Start(y);
          const yearBreaks = termBreaks.filter(tb => new Date(tb.date + "T00:00:00").getFullYear() === y).sort((a,b) => a.date.localeCompare(b.date));
          let termNum = 1;
          for (const tb of yearBreaks) {
            const breakStartD = new Date(tb.date + "T00:00:00");
            const breakEndD = new Date((tb.endDate || tb.date) + "T00:00:00");
            if (breakStartD > termStart) {
              const termEnd = new Date(breakStartD); termEnd.setDate(termEnd.getDate() - 1);
              while (termEnd.getDay() === 0 || termEnd.getDay() === 6) termEnd.setDate(termEnd.getDate() - 1);
              rows.push({ type: "term", label: `${y} Term ${termNum}`, start: toLocalDateStr(termStart), end: toLocalDateStr(termEnd) });
              termNum++;
            }
            rows.push({ type: "break", tb });
            termStart = new Date(breakEndD); termStart.setDate(termStart.getDate() + 1);
            while (termStart.getDay() === 0 || termStart.getDay() === 6) termStart.setDate(termStart.getDate() + 1);
          }
          const yearEnd = new Date(y, 11, 18);
          while (yearEnd.getDay() === 0 || yearEnd.getDay() === 6) yearEnd.setDate(yearEnd.getDate() - 1);
          if (termStart <= yearEnd) rows.push({ type: "term", label: `${y} Term ${termNum}`, start: toLocalDateStr(termStart), end: toLocalDateStr(yearEnd) });
        }
        const visRows = rows.filter(r => {
          const refDate = r.type === "term" ? r.start : r.tb.date;
          return refDate && (refDate.startsWith(String(year)) || refDate.startsWith(String(year + 1)));
        });
        const fmtDate = (d) => { if (!d) return "—"; const [y, m, dy] = d.split("-"); return `${parseInt(dy)} ${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][parseInt(m)-1]} ${y}`; };
        const currentTerm = visRows.find(r => r.type === "term" && today >= r.start && today <= r.end);
        const subtitle = termBreaks.length === 0 ? "No term data — use 'Fetch Vic Term Dates' to load" : `${visRows.filter(r => r.type === "term" && r.start.startsWith(String(year))).length} terms for ${year}`;

        const updateBreakDate = (tbId, field, value) => {
          setInterruptions(prev => prev.map(i => i.id === tbId ? { ...i, [field]: value } : i));
          setTermDatePicker(null);
        };
        const deleteBreak = (tbId) => {
          if (window.confirm("Delete this holiday break entry? This will affect how term dates are calculated.")) {
            setInterruptions(prev => prev.filter(i => i.id !== tbId));
          }
        };

        const DateChip = ({ value, tbId, field }) => {
          const isOpen = termDatePicker?.breakId === tbId && termDatePicker?.field === field;
          return (
            <span style={{ position: "relative", display: "inline-block" }}>
              <span onClick={(e) => { e.stopPropagation(); setTermDatePicker(isOpen ? null : { breakId: tbId, field }); }}
                style={{ cursor: "pointer", color: colors.sidebarActive, fontWeight: 600, fontSize: 13, borderBottom: `1px dashed ${colors.sidebarActive}`, paddingBottom: 1 }}>
                {fmtDate(value)}
              </span>
              {isOpen && (
                <span style={{ position: "absolute", top: 24, left: 0, zIndex: 200, background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.13)", padding: 10 }}
                  onClick={e => e.stopPropagation()}>
                  <input type="date" defaultValue={value}
                    autoFocus
                    onChange={e => updateBreakDate(tbId, field, e.target.value)}
                    onBlur={() => setTermDatePicker(null)}
                    style={{ fontSize: 14, border: `1px solid ${colors.border}`, borderRadius: 6, padding: "4px 8px", outline: "none", fontFamily: "inherit" }} />
                </span>
              )}
            </span>
          );
        };

        return (
          <div style={{ marginBottom: 16 }}>
            <div onClick={() => setTermDatesExpanded(v => !v)}
              style={{ background: colors.sidebarActive, borderRadius: termDatesExpanded ? "10px 10px 0 0" : 10, padding: "12px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", userSelect: "none" }}>
              <div>
                <span style={{ color: colors.white, fontWeight: 700, fontSize: 14 }}>📅 Term Dates</span>
                <span style={{ color: "rgba(255,255,255,0.6)", fontSize: 12, marginLeft: 10 }}>{subtitle}</span>
              </div>
              <span style={{ color: "rgba(255,255,255,0.7)", fontSize: 18, lineHeight: 1 }}>{termDatesExpanded ? "▲" : "▼"}</span>
            </div>
            {termDatesExpanded && (
              <div style={{ border: `1px solid ${colors.sidebarActive}`, borderTop: "none", borderRadius: "0 0 10px 10px", padding: 20, background: colors.white }} onClick={() => setTermDatePicker(null)}>
                {termBreaks.length === 0 ? (
                  <div style={{ color: colors.textMuted, fontSize: 14, textAlign: "center", padding: "12px 0" }}>
                    No term break data. Use "Fetch Vic Term Dates &amp; Public Holidays" below to load.
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {visRows.map((r, i) => {
                      if (r.type === "term") {
                        const isCurrent = r.label === currentTerm?.label;
                        return (
                          <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 14px", borderRadius: 8, background: isCurrent ? colors.blueLight : colors.background, border: isCurrent ? `1.5px solid ${colors.sidebarActive}` : `1px solid ${colors.border}` }}>
                            <div style={{ minWidth: 110, fontWeight: 700, fontSize: 13, color: isCurrent ? colors.sidebarActive : colors.text }}>
                              {r.label}
                              {isCurrent && <span style={{ marginLeft: 6, fontSize: 10, background: colors.sidebarActive, color: colors.white, borderRadius: 4, padding: "1px 6px" }}>current</span>}
                            </div>
                            <div style={{ fontSize: 13, color: colors.textMuted, flex: 1 }}>
                              <span style={{ fontSize: 11 }}>Start: </span><span style={{ color: colors.text }}>{fmtDate(r.start)}</span>
                              <span style={{ margin: "0 10px", color: colors.border }}>·</span>
                              <span style={{ fontSize: 11 }}>End: </span><span style={{ color: colors.text }}>{fmtDate(r.end)}</span>
                            </div>
                          </div>
                        );
                      } else {
                        const tb = r.tb;
                        return (
                          <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 14px", borderRadius: 8, background: "#FFF8F0", border: "1px dashed #E8C88A", marginLeft: 20, marginRight: 20 }}>
                            <div style={{ fontSize: 11, fontWeight: 600, color: "#A07040", minWidth: 90, textTransform: "uppercase", letterSpacing: "0.04em" }}>🏖 Holidays</div>
                            <div style={{ fontSize: 13, flex: 1, display: "flex", alignItems: "center", gap: 6 }}>
                              <DateChip value={tb.date} tbId={tb.id} field="date" />
                              <span style={{ color: colors.textMuted }}>–</span>
                              <DateChip value={tb.endDate || tb.date} tbId={tb.id} field="endDate" />
                              {tb.title && <span style={{ color: colors.textMuted, fontSize: 12, marginLeft: 6 }}>({tb.title})</span>}
                            </div>
                            <button onClick={() => deleteBreak(tb.id)}
                              title="Delete this break entry"
                              style={{ background: "none", border: "none", cursor: "pointer", color: "#C45454", fontSize: 16, padding: "0 4px", lineHeight: 1, opacity: 0.7 }}>🗑</button>
                          </div>
                        );
                      }
                    })}
                    <div style={{ marginTop: 6, fontSize: 12, color: colors.textMuted }}>
                      Term dates are calculated from {termBreaks.length} holiday {termBreaks.length === 1 ? "break" : "breaks"}. Click any underlined date on a holidays row to edit it.
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })()}

      {/* ==== UPCOMING COLLAPSIBLE BANNER ==== */}
      <div style={{ marginBottom: 16 }}>
        <div onClick={() => setUpcomingExpanded(v => !v)}
          style={{ background: colors.sidebarActive, borderRadius: upcomingExpanded ? "10px 10px 0 0" : 10, padding: "12px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", userSelect: "none" }}>
          <span style={{ color: colors.white, fontWeight: 700, fontSize: 14 }}>
            Upcoming{filtered.length > 0 ? " (" + filtered.length + ")" : ""}
          </span>
          <span style={{ color: "rgba(255,255,255,0.7)", fontSize: 18, lineHeight: 1 }}>{upcomingExpanded ? "▲" : "▼"}</span>
        </div>
        {upcomingExpanded && (
          <div style={{ border: `1px solid ${colors.sidebarActive}`, borderTop: "none", borderRadius: "0 0 10px 10px", padding: 20, background: colors.white }}>
            {/* Filters */}
            {visibleInterruptions.length > 0 && (
              <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 16 }}>
                <select value={filterSchool} onChange={e => setFilterSchool(e.target.value)}
                  style={{ padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit" }}>
                  <option value="">All Schools</option>
                  {schools.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                <select value={filterType} onChange={e => setFilterType(e.target.value)}
                  style={{ padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit" }}>
                  <option value="">All Types</option>
                  {INTERRUPTION_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
                <div style={{ marginLeft: "auto", fontSize: 13, color: colors.textMuted }}>{filtered.length} shown</div>
                <Btn variant="danger" onClick={clearAll} style={{ fontSize: 12 }}>Clear All</Btn>
              </div>
            )}

            {/* List */}
            {filtered.length === 0 ? (
              <Card style={{ textAlign: "center", padding: "40px 20px", color: colors.textMuted }}>
                <div style={{ fontSize: 40, marginBottom: 12, opacity: 0.5 }}>🚧</div>
                <div style={{ fontSize: 16, fontWeight: 600, color: colors.textLight, marginBottom: 8 }}>
                  {visibleInterruptions.length === 0 ? "No upcoming interruptions" : "No interruptions match your filters"}
                </div>
                <div style={{ fontSize: 14, maxWidth: 480, margin: "0 auto" }}>
                  {visibleInterruptions.length === 0
                    ? "Scan a newsletter URL, fetch term dates, or add interruptions manually. Past events are automatically removed."
                    : "Try adjusting your school or type filter."}
                </div>
              </Card>
            ) : (
              Object.entries(groupedByMonth).sort(([a], [b]) => a.localeCompare(b)).map(([monthKey, { label, items }]) => (
                <div key={monthKey} style={{ marginBottom: 20 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: colors.textLight, marginBottom: 10, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {items.map(item => {
                    const typeInfo = getTypeInfo(item.type);
                    const school = item.schoolId === "all" ? null : schools.find(s => s.id === item.schoolId);
                    const dateStr = item.date ? new Date(item.date + "T00:00:00").toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" }) : "?";
                    const isMultiDay = item.endDate && item.endDate !== item.date;
                    const endDateStr = isMultiDay ? new Date(item.endDate + "T00:00:00").toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" }) : "";
                    return (
                      <div key={item.id} style={{
                        display: "flex", alignItems: "center", gap: 12, padding: "10px 14px",
                        background: colors.white, borderRadius: 10, border: `1px solid ${colors.border}`,
                        borderLeft: `4px solid ${typeInfo.color}`
                      }}>
                        <div style={{ minWidth: 110, fontSize: 13, fontWeight: 600, color: colors.text }}>
                          {dateStr}
                          {isMultiDay && <div style={{ fontSize: 11, fontWeight: 400, color: colors.textMuted }}>→ {endDateStr}</div>}
                        </div>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 14, fontWeight: 600, color: colors.text }}>{item.title}</div>
                          <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
                            <Tag color={typeInfo.color}>{typeInfo.label}</Tag>
                            {school && <Tag color="#666">{school.name}</Tag>}
                            {item.schoolId === "all" && <Tag color={colors.sidebarActive}>All Schools</Tag>}
                            {item.affectsClasses && item.affectsClasses !== "all" && (
                              <Tag color={colors.warning}>{item.affectsClasses}</Tag>
                            )}
                            {item.startTime && item.endTime && (
                              <Tag color="#3B9EC4">{item.startTime}–{item.endTime}</Tag>
                            )}
                          </div>
                        </div>
                        <div style={{ display: "flex", gap: 4 }}>
                          <button onClick={() => editEntry(item)} style={{ border: "none", background: "none", color: colors.textMuted, cursor: "pointer", fontSize: 13, padding: 4 }}>✏️</button>
                          <button onClick={() => deleteEntry(item.id)} style={{ border: "none", background: "none", color: colors.danger, cursor: "pointer", fontSize: 16, padding: 4 }}>×</button>
                        </div>
                      </div>
                    );
                  })}
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}


// ============================================================
// SCHOOLS MANAGER
// ============================================================
function SchoolsManager({ schools, setSchools, notify, resetKey, viewState, setViewState, goBack, goForward, historyCursor, pageHistory }) {
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(null);

  useEffect(() => { setEditing(null); setForm(null); }, [resetKey]);

  const newSchool = () => {
    const f = {
      id: uid(), name: "", acronym: "", days: [...DAYS],
      slots: defaultSlots(),
      specialistPolicy: "prefer-not",
      teacherBreaks: [],
      newsletterUrl: "",
      newsletterGuidance: "",
      senderEmail: "",
      timetableUploadUrl: "",
      notes: ""
    };
    setForm(f);
    setEditing("new");
  };

  const editSchool = (school) => {
    setForm({ ...school, slots: school.slots.map(s => ({ ...s })), days: [...school.days], teacherBreaks: (school.teacherBreaks || []).map(b => ({ ...b })) });
    setEditing(school.id);
  };

  const saveSchool = () => {
    if (!form.name.trim()) { notify("School name required", "warning"); return; }
    if (editing === "new") {
      setSchools(prev => [...prev, form]);
    } else {
      setSchools(prev => prev.map(s => s.id === form.id ? form : s));
    }
    setForm(null);
    setEditing(null);
    notify("School saved!");
  };

  const deleteSchool = (id) => {
    setSchools(prev => prev.filter(s => s.id !== id));
    notify("School removed");
  };

  const updateSlot = (idx, key, val) => {
    setForm(prev => {
      const slots = [...prev.slots];
      slots[idx] = { ...slots[idx], [key]: val };
      return { ...prev, slots };
    });
  };

  const addSlot = () => {
    setForm(prev => ({
      ...prev,
      slots: [...prev.slots, { id: uid(), name: "", start: "09:00", end: "09:30", type: "class" }]
    }));
  };

  const removeSlot = (idx) => {
    setForm(prev => ({ ...prev, slots: prev.slots.filter((_, i) => i !== idx) }));
  };

  const addTeacherBreak = () => {
    setForm(prev => ({ ...prev, teacherBreaks: [...(prev.teacherBreaks || []), { id: uid(), start: "11:00", end: "11:30" }] }));
  };
  const updateTeacherBreak = (idx, key, val) => {
    setForm(prev => {
      const breaks = [...(prev.teacherBreaks || [])];
      breaks[idx] = { ...breaks[idx], [key]: val };
      return { ...prev, teacherBreaks: breaks };
    });
  };
  const removeTeacherBreak = (idx) => {
    setForm(prev => ({ ...prev, teacherBreaks: (prev.teacherBreaks || []).filter((_, i) => i !== idx) }));
  };

  const toggleDay = (day) => {
    setForm(prev => ({
      ...prev,
      days: prev.days.includes(day) ? prev.days.filter(d => d !== day) : [...prev.days, day]
    }));
  };

  const [slotGen, setSlotGen] = useState(null);
  const [schoolOpen, setSchoolOpen] = useState({});

  const initSlotGenerator = () => {
    setSlotGen({
      blocks: [
        { start: "08:30", end: "11:00" },
        { start: "11:10", end: "13:40" },
        { start: "14:00", end: "15:30" }
      ],
      duration: 30,
      includeBeforeSchool: false,
      beforeSchoolStart: "08:00",
      includeAfterSchool: false,
      afterSchoolStart: "15:30"
    });
  };

  const generateSlots = () => {
    if (!slotGen) return;
    const slots = [];
    let slotNum = 1;

    if (slotGen.includeBeforeSchool) {
      slots.push({ id: uid(), name: "Before School", start: slotGen.beforeSchoolStart,
        end: `${String(Math.floor((timeToMin(slotGen.beforeSchoolStart) + slotGen.duration) / 60)).padStart(2, "0")}:${String((timeToMin(slotGen.beforeSchoolStart) + slotGen.duration) % 60).padStart(2, "0")}`,
        type: "before_school" });
    }

    for (const block of slotGen.blocks) {
      let current = timeToMin(block.start);
      const end = timeToMin(block.end);
      while (current + slotGen.duration <= end) {
        const startStr = `${String(Math.floor(current / 60)).padStart(2, "0")}:${String(current % 60).padStart(2, "0")}`;
        const endMin = current + slotGen.duration;
        const endStr = `${String(Math.floor(endMin / 60)).padStart(2, "0")}:${String(endMin % 60).padStart(2, "0")}`;
        slots.push({ id: uid(), name: `Slot ${slotNum}`, start: startStr, end: endStr, type: "class" });
        slotNum++;
        current = endMin;
      }
    }

    if (slotGen.includeAfterSchool) {
      slots.push({ id: uid(), name: "After School", start: slotGen.afterSchoolStart,
        end: `${String(Math.floor((timeToMin(slotGen.afterSchoolStart) + slotGen.duration) / 60)).padStart(2, "0")}:${String((timeToMin(slotGen.afterSchoolStart) + slotGen.duration) % 60).padStart(2, "0")}`,
        type: "after_school" });
    }

    setForm(prev => ({ ...prev, slots }));
    setSlotGen(null);
    notify(`Generated ${slots.length} slots`);
  };

  if (form) {
    return (
      <div onKeyDown={e => { if (e.key === "Enter" && e.target.tagName !== "TEXTAREA" && e.target.tagName !== "SELECT" && e.target.tagName !== "BUTTON") { e.preventDefault(); saveSchool(); } }}>
        <PageTitle subtitle="Configure school timetable structure" navButtons={<NavButtons goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}>{editing === "new" ? "Add School" : "Edit School"}</PageTitle>
        <Card>
          <Input label="School Name" value={form.name} onChange={v => setForm(p => ({ ...p, name: v }))} placeholder="e.g. Eastwood Primary" />

          <div style={{ marginBottom: 14 }}>
            <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: colors.textLight, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>Acronym</label>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <input
                value={form.acronym || ""}
                onChange={e => setForm(p => ({ ...p, acronym: e.target.value.toUpperCase() }))}
                placeholder={form.name ? form.name.split(" ").filter(w => w.length > 0).map(w => w[0].toUpperCase()).join("") : "e.g. EPS"}
                maxLength={8}
                style={{ width: 100, padding: "8px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", letterSpacing: 1, fontWeight: 600, textTransform: "uppercase" }}
              />
              <span style={{ fontSize: 12, color: colors.textMuted }}>
                Used on timetable exports and schedules. Leave blank to auto-derive from name initials.
              </span>
            </div>
          </div>

          <div style={{ marginBottom: 14 }}>
            <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: colors.textLight, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>Teaching Days</label>
            <div style={{ display: "flex", gap: 8 }}>
              {DAYS.map(d => (
                <button key={d} onClick={() => toggleDay(d)} style={{
                  padding: "6px 14px", borderRadius: 6, fontSize: 13, fontFamily: "inherit", cursor: "pointer",
                  border: `1px solid ${form.days.includes(d) ? colors.accent : colors.border}`,
                  background: form.days.includes(d) ? colors.accentLight : colors.white,
                  color: form.days.includes(d) ? colors.accentDark : colors.textLight, fontWeight: 500
                }}>
                  {d.slice(0, 3)}
                </button>
              ))}
            </div>
          </div>

          <Input label="Scheduling During Specialist Classes" value={form.specialistPolicy} onChange={v => setForm(p => ({ ...p, specialistPolicy: v }))}
            options={[
              { value: "yes", label: "Allow pulling students from specialist classes for music lessons" },
              { value: "prefer-not", label: "Allow if needed, but prefer to avoid" },
              { value: "no", label: "Never schedule during specialist classes" }
            ]} />
          <div style={{ fontSize: 12, color: colors.textMuted, marginTop: -8, marginBottom: 14, paddingLeft: 2 }}>
            💡 Specialist class times are managed separately in the "Specialist Classes" section — this setting controls whether the scheduler can pull students out of those classes.
          </div>

          <div style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: colors.textLight, textTransform: "uppercase", letterSpacing: 0.5 }}>Teacher Breaks</label>
              <Btn variant="secondary" onClick={addTeacherBreak} style={{ fontSize: 12 }}>+ Add Break</Btn>
            </div>
            <div style={{ fontSize: 12, color: colors.textMuted, marginBottom: 10, paddingLeft: 2 }}>
              ☕ Times when no teacher may have lessons at this school (e.g. staff meetings, yard duty). These override any individual teacher breaks set in the Teachers tab.
            </div>
            {(form.teacherBreaks || []).length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {(form.teacherBreaks || []).map((brk, i) => (
                  <div key={brk.id || i} style={{ display: "flex", gap: 10, alignItems: "center", padding: "8px 12px", background: colors.bg, borderRadius: 8, border: `1px solid ${colors.borderLight}` }}>
                    <input type="time" value={brk.start} onChange={e => updateTeacherBreak(i, "start", e.target.value)}
                      style={{ padding: "6px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit" }} />
                    <span style={{ color: colors.textMuted, fontSize: 13 }}>to</span>
                    <input type="time" value={brk.end} onChange={e => updateTeacherBreak(i, "end", e.target.value)}
                      style={{ padding: "6px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit" }} />
                    <button onClick={() => removeTeacherBreak(i)} style={{ border: "none", background: "none", color: colors.danger, cursor: "pointer", fontSize: 18, padding: 4 }}>×</button>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 13, color: colors.textMuted, fontStyle: "italic", padding: "8px 12px", background: colors.bg, borderRadius: 8, border: `1px dashed ${colors.border}` }}>
                No breaks defined — teachers can be scheduled in any slot. Individual breaks can also be set per-teacher in the Teachers tab.
              </div>
            )}
          </div>

          <div style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: colors.textLight, textTransform: "uppercase", letterSpacing: 0.5 }}>Time Slots / Periods</label>
              <div style={{ display: "flex", gap: 6 }}>
                <Btn variant="ghost" onClick={initSlotGenerator} style={{ fontSize: 12 }}>📅 Generate Slots</Btn>
                <Btn variant="secondary" onClick={addSlot} style={{ fontSize: 12 }}>+ Add Slot</Btn>
              </div>
            </div>

            {/* Slot Generator */}
            {slotGen && (
              <Card style={{ marginBottom: 14, padding: 16, background: colors.accentLight, borderColor: colors.accent + "40" }}>
                <div style={{ fontWeight: 600, fontSize: 14, color: colors.accentDark, marginBottom: 12 }}>📅 Slot Generator</div>
                <div style={{ fontSize: 12, color: colors.accentDark, marginBottom: 14 }}>
                  Define time blocks and a lesson duration. Slots will be generated continuously within each block, with gaps between blocks left for breaks.
                </div>

                <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12 }}>
                  <label style={{ fontSize: 12, fontWeight: 600, color: colors.textLight }}>Lesson duration:</label>
                  <select value={slotGen.duration} onChange={e => setSlotGen(prev => ({ ...prev, duration: parseInt(e.target.value) }))}
                    style={{ padding: "6px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit" }}>
                    {[20, 25, 30, 35, 40, 45, 50, 60].map(d => <option key={d} value={d}>{d} min</option>)}
                  </select>
                </div>

                <div style={{ marginBottom: 10 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                    <label style={{ fontSize: 11, fontWeight: 600, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>Time Blocks</label>
                    <Btn variant="ghost" onClick={() => setSlotGen(prev => ({ ...prev, blocks: [...prev.blocks, { start: "09:00", end: "12:00" }] }))} style={{ fontSize: 11 }}>+ Add Block</Btn>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {slotGen.blocks.map((block, i) => {
                      const slots = Math.floor((timeToMin(block.end) - timeToMin(block.start)) / slotGen.duration);
                      return (
                        <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", padding: "6px 10px", background: colors.white, borderRadius: 8, border: `1px solid ${colors.borderLight}` }}>
                          <input type="time" value={block.start} onChange={e => setSlotGen(prev => ({ ...prev, blocks: prev.blocks.map((b, idx) => idx === i ? { ...b, start: e.target.value } : b) }))}
                            style={{ padding: "6px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit" }} />
                          <span style={{ color: colors.textMuted, fontSize: 13 }}>to</span>
                          <input type="time" value={block.end} onChange={e => setSlotGen(prev => ({ ...prev, blocks: prev.blocks.map((b, idx) => idx === i ? { ...b, end: e.target.value } : b) }))}
                            style={{ padding: "6px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit" }} />
                          <span style={{ fontSize: 12, color: colors.textMuted, minWidth: 60 }}>→ {slots} slot{slots !== 1 ? "s" : ""}</span>
                          {slotGen.blocks.length > 1 && (
                            <button onClick={() => setSlotGen(prev => ({ ...prev, blocks: prev.blocks.filter((_, idx) => idx !== i) }))}
                              style={{ border: "none", background: "none", color: colors.danger, cursor: "pointer", fontSize: 18, padding: 2 }}>×</button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div style={{ display: "flex", gap: 16, marginBottom: 14 }}>
                  <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13, cursor: "pointer" }}>
                    <input type="checkbox" checked={slotGen.includeBeforeSchool} onChange={e => setSlotGen(prev => ({ ...prev, includeBeforeSchool: e.target.checked }))} />
                    Before school at
                    <input type="time" value={slotGen.beforeSchoolStart} onChange={e => setSlotGen(prev => ({ ...prev, beforeSchoolStart: e.target.value }))}
                      style={{ padding: "4px 6px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 12, fontFamily: "inherit", width: 90 }}
                      disabled={!slotGen.includeBeforeSchool} />
                  </label>
                  <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13, cursor: "pointer" }}>
                    <input type="checkbox" checked={slotGen.includeAfterSchool} onChange={e => setSlotGen(prev => ({ ...prev, includeAfterSchool: e.target.checked }))} />
                    After school at
                    <input type="time" value={slotGen.afterSchoolStart} onChange={e => setSlotGen(prev => ({ ...prev, afterSchoolStart: e.target.value }))}
                      style={{ padding: "4px 6px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 12, fontFamily: "inherit", width: 90 }}
                      disabled={!slotGen.includeAfterSchool} />
                  </label>
                </div>

                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <Btn onClick={generateSlots}>Generate {slotGen.blocks.reduce((sum, b) => sum + Math.floor((timeToMin(b.end) - timeToMin(b.start)) / slotGen.duration), 0) + (slotGen.includeBeforeSchool ? 1 : 0) + (slotGen.includeAfterSchool ? 1 : 0)} Slots</Btn>
                  <Btn variant="secondary" onClick={() => setSlotGen(null)}>Cancel</Btn>
                  <span style={{ fontSize: 12, color: colors.textMuted, marginLeft: 8 }}>⚠ This will replace all existing slots</span>
                </div>
              </Card>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {form.slots.map((slot, i) => (
                <div key={slot.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "8px 12px", background: colors.bg, borderRadius: 8, border: `1px solid ${colors.borderLight}` }}>
                  <input value={slot.name} onChange={e => updateSlot(i, "name", e.target.value)} placeholder="Period name"
                    style={{ flex: 1, padding: "6px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit" }} />
                  <input type="time" value={slot.start} onChange={e => updateSlot(i, "start", e.target.value)}
                    style={{ padding: "6px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit" }} />
                  <span style={{ color: colors.textMuted }}>—</span>
                  <input type="time" value={slot.end} onChange={e => updateSlot(i, "end", e.target.value)}
                    style={{ padding: "6px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit" }} />
                  <select value={slot.type} onChange={e => updateSlot(i, "type", e.target.value)}
                    style={{ padding: "6px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit", background: colors.white }}>
                    {SLOT_TYPES.map(t => <option key={t} value={t}>{SLOT_TYPE_LABELS[t]}</option>)}
                  </select>
                  <button onClick={() => removeSlot(i)} style={{ border: "none", background: "none", color: colors.danger, cursor: "pointer", fontSize: 18, padding: 4 }}>×</button>
                </div>
              ))}
            </div>
          </div>

          <Input label="Notes" value={form.notes} onChange={v => setForm(p => ({ ...p, notes: v }))} multiline placeholder="Any additional notes about this school..." />

          <Input label="Newsletter URL" value={form.newsletterUrl || ""} onChange={v => setForm(p => ({ ...p, newsletterUrl: v }))} placeholder="e.g. https://schoolname.vic.edu.au/newsletters" />
          <div style={{ fontSize: 12, color: colors.textMuted, marginTop: -8, marginBottom: 8, paddingLeft: 2 }}>
            📰 Link to the school's newsletter page. Used in the Interruptions tab to scan for upcoming events.
          </div>
          <Input label="Sender Email Address" value={form.senderEmail || ""} onChange={v => setForm(p => ({ ...p, senderEmail: v }))} placeholder="e.g. sps@mattmorasmusic.com" />
          <div style={{ fontSize: 12, color: colors.textMuted, marginTop: -8, marginBottom: 8, paddingLeft: 2 }}>
            ✉ Gmail "Send mail as" alias to use when emailing this school's contacts. Must be configured in your Gmail settings.
          </div>
          <Input label="Timetable Upload URL" value={form.timetableUploadUrl || ""} onChange={v => setForm(p => ({ ...p, timetableUploadUrl: v }))} placeholder="e.g. https://script.google.com/macros/s/…/exec" />
          <div style={{ fontSize: 12, color: colors.textMuted, marginTop: -8, marginBottom: 8, paddingLeft: 2 }}>
            📤 Endpoint to receive timetable uploads from the Export → Send → Upload to link option. Accepts a POST with JSON <code style={{ background: colors.bg, borderRadius: 3, padding: "1px 4px" }}>{`{filename, contentBase64, mimeType, schoolName}`}</code>. Works with Google Apps Script, Zapier, Make, etc.
          </div>
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: colors.text, marginBottom: 6 }}>AI Scanning Guidance</div>
            <textarea
              value={form.newsletterGuidance || ""}
              onChange={e => setForm(p => ({ ...p, newsletterGuidance: e.target.value }))}
              rows={3}
              placeholder={"e.g. \"Follow the link to the latest newsletter PDF\", \"Look for dates in the calendar section at the bottom\", \"Check both the newsletter and the events page linked at the top\", \"Term 2 dates are May-June 2026\"..."}
              style={{ width: "100%", padding: "10px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", resize: "vertical", boxSizing: "border-box" }}
            />
            <div style={{ fontSize: 11, color: colors.textMuted, marginTop: 4, paddingLeft: 2 }}>
              These instructions are automatically sent to the AI when scanning this school's newsletter from the Interruptions tab.
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
            <Btn onClick={saveSchool}>Save School</Btn>
            <Btn variant="secondary" onClick={() => { setForm(null); setEditing(null); }}>Cancel</Btn>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <PageTitle subtitle="Configure schools with their timetable structure" pageColor={PAGE_COLORS.schools}
        navButtons={<><Btn onClick={newSchool} style={{ height: 34, fontSize: 13, padding: "0 14px", background: "rgba(255,255,255,0.15)", color: colors.white, border: "1px solid rgba(255,255,255,0.3)", borderRadius: 6, fontWeight: 600 }}>+ Add School</Btn><NavButtons goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} /></>}>
        Schools
      </PageTitle>

      {schools.length === 0 ? (
        <EmptyState icon="🏫" title="No schools yet" subtitle="Add your first school to define its timetable periods, break times, and constraints." action="+ Add School" onAction={newSchool} />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {schools.map(school => {
            const isOpen = !!schoolOpen[school.id];
            return (
              <div key={school.id} style={{ borderRadius: 10, overflow: "hidden", border: `1px solid ${colors.borderLight}` }}>
                {/* Clickable banner */}
                <div
                  onClick={() => setSchoolOpen(prev => ({ ...prev, [school.id]: !prev[school.id] }))}
                  style={{ background: colors.sidebarActive, padding: "10px 14px", display: "flex", alignItems: "center", gap: 10, cursor: "pointer", userSelect: "none" }}>
                  <span style={{ fontSize: 16 }}>🏫</span>
                  <span style={{ fontWeight: 700, fontSize: 15, color: colors.white, flex: 1 }}>
                    {school.name}
                    {school.acronym && <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 600, color: "rgba(255,255,255,0.55)", letterSpacing: 0.5 }}>({school.acronym})</span>}
                  </span>
                  <span style={{ fontSize: 12, color: "rgba(255,255,255,0.55)", marginRight: 4 }}>{school.slots.length} slots · {school.days.length} days</span>
                  <button onClick={e => { e.stopPropagation(); editSchool(school); }} title="Edit school"
                    style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "3px 10px", borderRadius: 6, background: "rgba(255,255,255,0.12)", border: "1px solid rgba(255,255,255,0.25)", color: colors.white, cursor: "pointer", fontSize: 12, fontFamily: "inherit", fontWeight: 600 }}>
                    ✏️ Edit
                  </button>
                  <button onClick={e => { e.stopPropagation(); deleteSchool(school.id); }} title="Remove school"
                    style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 28, height: 28, borderRadius: 6, background: "rgba(255,255,255,0.12)", border: "1px solid rgba(255,255,255,0.25)", color: colors.white, cursor: "pointer", flexShrink: 0 }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
                  </button>
                  <span style={{ fontSize: 13, color: "rgba(255,255,255,0.6)", marginLeft: 2 }}>{isOpen ? "▲" : "▼"}</span>
                </div>
                {/* Collapsible info */}
                {isOpen && (
                  <div style={{ padding: "12px 14px", background: colors.white }}>
                    <div style={{ fontSize: 13, color: colors.textLight, marginBottom: 6 }}>
                      {school.days.map(d => d.slice(0, 3)).join(", ")} · {school.slots.length} time slots ·
                      Specialist scheduling: {school.specialistPolicy === "yes" ? "allowed" : school.specialistPolicy === "no" ? "not allowed" : "allowed, prefer to avoid"}
                    </div>
                    {(school.teacherBreaks || []).length > 0 && (
                      <div style={{ fontSize: 12, color: colors.textMuted, marginBottom: 6 }}>
                        ☕ Teacher breaks: {school.teacherBreaks.map(b => `${b.start}–${b.end}`).join(", ")}
                      </div>
                    )}
                    {school.newsletterUrl && (
                      <div style={{ fontSize: 12, color: colors.accent, marginBottom: 6 }}>
                        📰 Newsletter: {school.newsletterUrl}
                      </div>
                    )}
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 }}>
                      {school.slots.map(s => (
                        <Tag key={s.id} color={["recess", "lunch"].includes(s.type) ? colors.success : ["before_school", "after_school"].includes(s.type) ? "#8B7EC8" : "#666"}>
                          {s.name} ({toTimeLabel(s.start)}–{toTimeLabel(s.end)})
                        </Tag>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ============================================================
// STUDENTS MANAGER
// ============================================================
