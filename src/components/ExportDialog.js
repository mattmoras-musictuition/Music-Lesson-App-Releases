// ============================================================
// EXPORT DIALOG
// Modal for exporting timetable, teacher schedules, and tally
// data as PDF/XLSX/CSV. Includes Send menu with cascading
// recipient lists and an Attach queue for email.
// ============================================================

import React from "react";
import { DAYS, STORAGE_KEYS } from "../constants";
import { useTheme } from "../context/ThemeContext";
import { getParentEmails, openCompose, openGmailSequential, downloadFile, uid as makeId } from "../utils/helpers";
import { anthropicFetch } from "../utils/api";
import {
  generateExportHtml, generateTeacherSchedulesHtml,
  exportLessons, exportTeacherSchedules,
  electronPrintToPdf
} from "../data/exportHelpers";
// Session 96: upload exported timetables to the public resources bucket and
// register them as Documents so Matt can pick them up later when emailing.
import {
  BUCKET_DOCUMENTS, makeStoragePath, uploadToBucket,
} from "../utils/storageHelpers";
import { Btn } from "./ui/SharedUI";

export const ExportIcon = (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none" style={{display:"inline-block",verticalAlign:"middle",marginRight:4,flexShrink:0}}>
    <path d="M2 11.5 Q0.5 7 3.8 3.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none" opacity="0.5"/>
    <path d="M1.5 7 L12.5 2 L9 12 L6.5 8.5 Z" fill="currentColor"/>
    <path d="M6.5 8.5 L12.5 2" stroke="white" strokeWidth="0.75" strokeLinecap="round"/>
  </svg>
);

export function ExportDialog({ lessons, students, schools, teachers, teacherCoverage = [], contacts, specialists, availableWeeks, initialType, onClose, notify, documents, setDocuments }) {
  const { colors, darkMode } = useTheme();
  const [exportType, setExportType] = React.useState(initialType || "timetable");
  // Source is derived from sourceTab + selectedPastWeek
  const mostRecentWeek = (availableWeeks || []).slice(-1)[0] || null;
  const pastWeeks = (availableWeeks || []).slice(0, -1);
  const hasPastWeeks = pastWeeks.length > 0;
  const [sourceTab, setSourceTab] = React.useState(() =>
    mostRecentWeek ? "weekly" : "master"
  );
  const [selectedPastWeek, setSelectedPastWeek] = React.useState(
    () => pastWeeks.slice(-1)[0]?.weekKey || ""
  );
  const source = sourceTab === "master" ? "master"
    : sourceTab === "weekly" ? (mostRecentWeek?.weekKey || "master")
    : (selectedPastWeek || mostRecentWeek?.weekKey || "master");
  const [schoolId, setSchoolId] = React.useState("");
  const [teacherName, setTeacherName] = React.useState("");
  const [className, setClassName] = React.useState("");
  const [day, setDay] = React.useState(new Set());
  const [formats, setFormats] = React.useState(["pdf"]);
  const [exporting, setExporting] = React.useState(false);
  const [customFilename, setCustomFilename] = React.useState(null);
  const [sendMenu, setSendMenu] = React.useState(false);
  const [sendSubmenu, setSendSubmenu] = React.useState(null);
  const [showPreview, setShowPreview] = React.useState(false);
  const [previewHtml, setPreviewHtml] = React.useState(null);
  const [contactSearch, setContactSearch] = React.useState("");
  const [manualRecipients, setManualRecipients] = React.useState([]);
  const [attachQueue, setAttachQueue] = React.useState([]);
  const [attaching, setAttaching] = React.useState(false);
  const attachBtnRef = React.useRef(null);
  const saveBtnRef = React.useRef(null);
  const sendBtnRef = React.useRef(null);
  const sendMenuHideTimer = React.useRef(null);
  const [showPastDropdown, setShowPastDropdown] = React.useState(false);
  const pastDropdownRef = React.useRef(null);
  React.useEffect(() => {
    if (!showPastDropdown) return;
    const handler = (e) => { if (pastDropdownRef.current && !pastDropdownRef.current.contains(e.target)) setShowPastDropdown(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showPastDropdown]);

  const selectedWeek = source !== "master" ? (availableWeeks || []).find(w => w.weekKey === source) : null;
  const sourceLessons = selectedWeek ? selectedWeek.lessons : lessons;
  const sourceLabel = selectedWeek ? selectedWeek.weekLabel : "Master";

  const schoolIds = [...new Set(sourceLessons.map(l => l.schoolId))];
  const filteredSchools = schools.filter(s => schoolIds.includes(s.id));
  const scopedLessons = schoolId ? sourceLessons.filter(l => l.schoolId === schoolId) : sourceLessons;
  const teacherNames = [...new Set(scopedLessons.map(l => l.teacherName))].sort();
  const classNames = [...new Set(students.filter(s => scopedLessons.some(l => l.studentId === s.id) && s.className).map(s => s.className))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  const previewLessons = scopedLessons.filter(l => {
    if (teacherName && l.teacherName !== teacherName) return false;
    if (className) { const sids = new Set(students.filter(s => s.className === className).map(s => s.id)); if (!sids.has(l.studentId)) return false; }
    if (day.size > 0 && !day.has(l.day)) return false;
    return true;
  });

  const scheduleTeachers = [...new Set((schoolId ? sourceLessons.filter(l => l.schoolId === schoolId) : sourceLessons).map(l => l.teacherName))].sort();
  const scheduleTeachersFiltered = teacherName ? scheduleTeachers.filter(t => t === teacherName) : scheduleTeachers;

  const getPreviewLabel = () => {
    if (exportType === "teacher_schedules") return `${scheduleTeachersFiltered.length} teacher schedule${scheduleTeachersFiltered.length !== 1 ? "s" : ""}`;
    return `${previewLessons.length} lesson${previewLessons.length !== 1 ? "s" : ""}`;
  };
  const isReady = exportType === "teacher_schedules" ? scheduleTeachersFiltered.length > 0 : previewLessons.length > 0;

  const autoFilename = (() => {
    if (exportType === "teacher_schedules") {
      const schoolPart = schoolId ? ("-" + (schools.find(s => s.id === schoolId)?.name || "School")) : "";
      return `${sourceLabel}-Teacher-Schedules${schoolPart}`.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-");
    }
    const parts = [];
    if (schoolId) parts.push(filteredSchools.find(s => s.id === schoolId)?.name || "School");
    if (teacherName) parts.push(teacherName);
    if (className) parts.push(className);
    if (day.size > 0) parts.push([...day].join("-"));
    const filterLabel = parts.length > 0 ? parts.join("-") : "All";
    return `${sourceLabel}-${filterLabel}`.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-");
  })();

  React.useEffect(() => { setCustomFilename(null); }, [exportType, sourceTab, selectedPastWeek, schoolId, teacherName, className, day]);
  const activeFilename = (customFilename !== null ? customFilename : autoFilename).trim() || autoFilename;

  const toggleFormat = (f) => {
    setFormats(prev => prev.includes(f) ? (prev.length > 1 ? prev.filter(x => x !== f) : prev) : [...prev, f]);
  };

  const activeSchoolId = schoolId;
  const activeSchool = schools.find(s => s.id === activeSchoolId);
  const schoolContacts = (contacts || []).filter(c => !activeSchoolId || c.schoolId === activeSchoolId);
  const classTeacherContacts = schoolContacts.filter(c => c.role === "Classroom Teacher" && c.email && (!className || c.className === className));
  const adminContacts = schoolContacts.filter(c => c.email && c.role !== "Classroom Teacher" && c.role !== "Specialist Teacher");
  const allStaffObjects = teachers.filter(t => t.email);
  const parentStudentIds = [...new Set(previewLessons.map(l => l.studentId).filter(Boolean))];
  const parentStudents = students.filter(s => parentStudentIds.includes(s.id));
  const allParentEmails = [...new Set(parentStudents.flatMap(s => getParentEmails(s)).filter(Boolean))];

  const mergeCtxForSend = {
    school_name: activeSchool?.name || "",
    class_name: className || "",
    day: day || "",
    teacher_name: teacherName || "",
    week_label: sourceLabel,
  };

  const allSearchableContacts = React.useMemo(() => {
    const pool = [];
    students.forEach(st => {
      (st.parents || []).forEach(p => {
        if (!p.email) return;
        const relMap = { Mother: "mum", Father: "dad", Guardian: "guardian", Carer: "carer" };
        const rel = relMap[p.relationship] || "parent";
        const firstName = st.name ? st.name.split(" ")[0] : "";
        const label = firstName ? `${firstName}'s ${rel}` : rel;
        pool.push({ name: p.name || p.email, email: p.email, type: "parent", studentName: st.name, parentLabel: label });
      });
    });
    (contacts || []).forEach(c => {
      if (c.email) pool.push({ name: c.name || c.email, email: c.email, type: c.role || "contact", schoolName: (schools.find(s => s.id === c.schoolId) || {}).name });
    });
    (teachers || []).forEach(t => {
      if (t.email) pool.push({ name: t.name || t.email, email: t.email, type: "Staff" });
    });
    const seen = new Set();
    return pool.filter(c => { if (seen.has(c.email)) return false; seen.add(c.email); return true; });
  }, [students, contacts, schools, teachers]);

  const contactSearchResults = contactSearch.trim().length > 0
    ? allSearchableContacts.filter(c =>
        c.name.toLowerCase().includes(contactSearch.toLowerCase()) ||
        c.email.toLowerCase().includes(contactSearch.toLowerCase()) ||
        (c.studentName || "").toLowerCase().includes(contactSearch.toLowerCase())
      ).slice(0, 8)
    : [];

  const addManualRecipient = (c) => {
    if (!manualRecipients.some(r => r.email === c.email)) setManualRecipients(prev => [...prev, { name: c.name, email: c.email }]);
    setContactSearch("");
  };

  const getExportHtml = React.useCallback((singleDay) => {
    const dayFilter = singleDay || (day.size === 1 ? [...day][0] : null);
    if (exportType === "teacher_schedules") {
      return generateTeacherSchedulesHtml(sourceLessons, students, schools, teachers, { schoolId: schoolId || null, teacherName: teacherName || null, sourceLabel, teacherCoverage });
    }
    const parts = [];
    if (schoolId) parts.push(filteredSchools.find(s => s.id === schoolId)?.name || "School");
    if (teacherName) parts.push(teacherName);
    if (className) parts.push(className);
    if (dayFilter) parts.push(dayFilter);
    const filterLabel = parts.length > 0 ? parts.join(" — ") : "All";
    return generateExportHtml(sourceLessons, students, schools, teachers, {
      schoolId: schoolId || null, teacherName: teacherName || null,
      className: className || null, day: dayFilter,
      title: `${sourceLabel} Timetable — ${filterLabel}`,
      specialists: specialists || null,
      teacherCoverage,
    });
  }, [exportType, sourceLessons, students, schools, teachers, schoolId, teacherName, className, day, sourceLabel, filteredSchools, specialists]);

  // Session 96: helper — upload a base64 PDF to the private documents bucket
  // and register it as a Document so it appears in the Documents tab and
  // becomes attachable in emails via the template editor's auto-attach picker.
  // Non-fatal on failure: local save path still runs independently (caller
  // doesn't await success). setDocuments is optional — if the caller didn't
  // pass it through, we skip the Documents-tab registration.
  const uploadExportToDocuments = React.useCallback(async (pdfBase64, filename, label) => {
    if (!setDocuments || !pdfBase64) return;
    try {
      // Convert base64 → Blob for Supabase upload. The storage SDK accepts
      // Blob/File/ArrayBuffer; a Blob is simplest here since we already have
      // the data as base64 and don't need to touch the filesystem.
      const byteChars = atob(pdfBase64);
      const bytes = new Uint8Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
      const blob = new Blob([bytes], { type: "application/pdf" });
      const docId = makeId();
      const storagePath = makeStoragePath(docId, filename);
      const res = await uploadToBucket(BUCKET_DOCUMENTS, storagePath, blob);
      if (!res) return;
      const today = new Date().toISOString().slice(0, 10);
      const newDoc = {
        id: docId,
        label: label || filename.replace(/\.pdf$/, ""),
        type: "Timetable",
        teacherId: "", schoolId: "",
        expiryDate: "",
        url: "",
        notes: `Exported ${today}`,
        storage_path: storagePath,
        filename,
        size_bytes: blob.size,
        mime_type: "application/pdf",
      };
      setDocuments(prev => [newDoc, ...prev]);
    } catch (e) {
      console.warn("[export] Supabase upload failed:", e?.message || e);
    }
  }, [setDocuments]);

  const doExport = async (saveToFile) => {
    setExporting(true);
    const ttFolder = localStorage.getItem(STORAGE_KEYS.timetableFolder) || null;
    const daysToExport = day.size > 1 ? [...day] : [day.size === 1 ? [...day][0] : null];
    try {
      for (const exportDay of daysToExport) {
        const dayPart = exportDay ? `-${exportDay}` : "";
        const filenameBase = daysToExport.length > 1
          ? activeFilename.replace(/-Mon.*|-Tue.*|-Wed.*|-Thu.*|-Fri.*/i, "") + dayPart
          : activeFilename;
        for (const fmt of formats) {
          if (exportType === "timetable") {
            const parts = [];
            if (schoolId) parts.push(filteredSchools.find(s => s.id === schoolId)?.name || "School");
            if (teacherName) parts.push(teacherName);
            if (className) parts.push(className);
            if (exportDay) parts.push(exportDay);
            const filterLabel = parts.length > 0 ? parts.join(" — ") : "All";
            if (fmt === "pdf") {
              const html = getExportHtml(exportDay);
              if (html) {
                const pdfBase64 = await electronPrintToPdf(html);
                if (pdfBase64) {
                  if (ttFolder && window.electronAPI?.writeBackup) {
                    await window.electronAPI.writeBackup(filenameBase + ".pdf", "__base64__" + pdfBase64, ttFolder);
                  } else {
                    const blob = new Blob([Uint8Array.from(atob(pdfBase64), c => c.charCodeAt(0))], { type: "application/pdf" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a"); a.href = url; a.download = filenameBase + ".pdf";
                    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
                  }
                  // Session 96: upload to Supabase + register in Documents.
                  // Runs in parallel with local save — no await blocking.
                  // Session 97: use the user's filename (filenameBase) as the
                  // label so the Documents tab matches what they typed in the
                  // export dialog, instead of a derived "Master Timetable —
                  // SPS — Mon" auto-label.
                  uploadExportToDocuments(pdfBase64, filenameBase + ".pdf", filenameBase);
                } else {
                  if (ttFolder && window.electronAPI?.writeBackup) {
                    await window.electronAPI.writeBackup(filenameBase + ".html", html, ttFolder);
                  } else {
                    downloadFile(html, filenameBase + ".html", "text/html");
                  }
                  notify("PDF unavailable — saved as HTML (open and print to PDF)", "warning", 6000);
                }
              }
            } else {
              await exportLessons(sourceLessons, students, schools, teachers, {
                format: fmt, filenameBase, view: schoolId ? "school" : "all",
                schoolId: schoolId || null, teacherName: teacherName || null,
                className: className || null, day: exportDay || null,
                title: `${sourceLabel} Timetable — ${filterLabel}`,
                specialists: specialists || null,
                teacherCoverage,
              });
            }
          } else if (exportType === "teacher_schedules") {
            if (fmt === "pdf") {
              const html = getExportHtml();
              if (html) {
                const pdfBase64 = await electronPrintToPdf(html);
                if (pdfBase64) {
                  if (ttFolder && window.electronAPI?.writeBackup) {
                    await window.electronAPI.writeBackup(filenameBase + ".pdf", "__base64__" + pdfBase64, ttFolder);
                  } else {
                    const blob = new Blob([Uint8Array.from(atob(pdfBase64), c => c.charCodeAt(0))], { type: "application/pdf" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a"); a.href = url; a.download = filenameBase + ".pdf";
                    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
                  }
                  // Session 96: also register teacher-schedule PDFs in Documents.
                  uploadExportToDocuments(pdfBase64, filenameBase + ".pdf", filenameBase);
                } else {
                  await exportTeacherSchedules(sourceLessons, students, schools, teachers, { format: "pdf", schoolId: schoolId || null, teacherName: teacherName || null, sourceLabel, filenameBase, teacherCoverage });
                }
              }
            } else {
              await exportTeacherSchedules(sourceLessons, students, schools, teachers, { format: fmt, schoolId: schoolId || null, teacherName: teacherName || null, sourceLabel, filenameBase, teacherCoverage });
            }
          }
        }
      }
      notify(ttFolder ? `Saved to ${ttFolder.split("/").pop() || "timetable folder"}` : `Saved ${formats.join(", ").toUpperCase()}`);
      if (saveToFile) onClose();
    } catch (e) {
      notify("Export failed: " + e.message, "danger");
    }
    setExporting(false);
  };

  const buildAttachment = React.useCallback(async () => {
    if (exportType !== "timetable" && exportType !== "teacher_schedules") return null;
    const html = getExportHtml();
    if (!html) return null;
    const atts = [];
    const pdfBase64 = await electronPrintToPdf(html);
    if (pdfBase64) {
      atts.push({ filename: activeFilename + ".pdf", contentBase64: pdfBase64, mimeType: "application/pdf" });
    } else {
      const contentBase64 = btoa(unescape(encodeURIComponent(html)));
      atts.push({ filename: activeFilename + ".html", contentBase64, mimeType: "text/html" });
    }

    return atts;
  }, [exportType, getExportHtml, activeFilename]);

  const selectStyle = { padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", width: "100%", background: colors.inputBg, color: colors.text };
  const radioGroupStyle = { display: "flex", gap: 6, flexWrap: "wrap" };
  const labelStyle = { fontSize: 11, fontWeight: 600, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 };

  const RadioBtn = ({ value, current, onChange, children }) => (
    <button onClick={() => onChange(value)} style={{ padding: "6px 14px", borderRadius: 8, fontSize: 12, fontFamily: "inherit", cursor: "pointer", border: `1.5px solid ${current === value ? colors.sidebarActive : colors.border}`, background: current === value ? colors.blueLight : colors.cardBg, color: current === value ? (darkMode ? colors.blue600 : colors.sidebarHover) : colors.text, fontWeight: current === value ? 600 : 400 }}>{children}</button>
  );

  const CheckBtn = ({ value, children }) => {
    const active = formats.includes(value);
    return (
      <button onClick={() => toggleFormat(value)} style={{ padding: "6px 14px", borderRadius: 8, fontSize: 12, fontFamily: "inherit", cursor: "pointer", border: `1.5px solid ${active ? colors.sidebarActive : colors.border}`, background: active ? colors.blueLight : colors.cardBg, color: active ? (darkMode ? colors.blue600 : colors.sidebarHover) : colors.text, fontWeight: active ? 600 : 400, display: "flex", alignItems: "center", gap: 5 }}>
        <span style={{ fontSize: 10 }}>{active ? "✓" : "○"}</span>{children}
      </button>
    );
  };

  const TypeCard = ({ value, icon, title, desc }) => (
    <div onClick={() => { setExportType(value); setSchoolId(""); setTeacherName(""); setClassName(""); setDay(new Set()); }}
      style={{ flex: 1, padding: "12px 14px", borderRadius: 10, cursor: "pointer", border: `2px solid ${exportType === value ? colors.sidebarActive : colors.border}`, background: exportType === value ? colors.blueLight : colors.cardBg, transition: "all 0.15s" }}>
      <div style={{ fontSize: 18, marginBottom: 4 }}>{icon}</div>
      <div style={{ fontWeight: 700, fontSize: 13, color: exportType === value ? (darkMode ? colors.blue600 : colors.sidebarHover) : colors.text }}>{title}</div>
      <div style={{ fontSize: 11, color: colors.textMuted, marginTop: 2, lineHeight: 1.4 }}>{desc}</div>
    </div>
  );

  const SendMenu = () => {
    const menuStyle = { position: "absolute", bottom: "calc(100% + 6px)", right: 0, zIndex: 10010, background: colors.cardBg, border: `1px solid ${colors.border}`, borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.15)", minWidth: 180, padding: "4px 0", overflow: "visible" };
    const subMenuStyle = { position: "absolute", bottom: 0, right: "calc(100% + 4px)", zIndex: 10011, background: colors.cardBg, border: `1px solid ${colors.border}`, borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.15)", minWidth: 180, padding: "4px 0" };
    const btn = (color) => ({ display: "flex", alignItems: "center", justifyContent: "flex-start", width: "100%", padding: "8px 14px", background: "none", border: "none", fontSize: 13, cursor: "pointer", fontFamily: "inherit", color, fontWeight: 400 });
    const btnChev = (color) => ({ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", padding: "8px 14px", background: "none", border: "none", fontSize: 13, cursor: "pointer", fontFamily: "inherit", color, fontWeight: 600 });
    const hov = (e) => e.currentTarget.style.background = colors.bg;
    const unhov = (e) => e.currentTarget.style.background = "none";

    const sendTo = async (emailsArr, label) => {
      if (!emailsArr.length) { notify("No email addresses found for " + label, "danger"); return; }
      let atts;
      if (attachQueue.length > 0) { atts = attachQueue.flatMap(q => q.atts); } else { atts = await buildAttachment(); }
      openCompose(emailsArr, { triggerId: "timetable_send", mergeCtx: mergeCtxForSend, attachments: atts });
      setSendMenu(false); setSendSubmenu(null);
    };
    const sendSequential = async (emailsArr) => {
      let atts;
      if (attachQueue.length > 0) { atts = attachQueue.flatMap(q => q.atts); } else { atts = await buildAttachment(); }
      openGmailSequential(emailsArr, { triggerId: "timetable_send", mergeCtx: mergeCtxForSend, attachments: atts });
      setSendMenu(false); setSendSubmenu(null);
    };
    const uploadSchools = schools.filter(s => s.timetableUploadUrl && (exportType === "teacher_schedules" || !schoolId || s.id === schoolId));
    const uploadToLink = async (school) => {
      const uploadUrl = school.timetableUploadUrl;
      if (!uploadUrl) return;
      try {
        notify("Uploading to link…", "success", 8000);
        const atts = await buildAttachment();
        if (!atts || atts.length === 0) { notify("Nothing to upload", "danger"); return; }
        const att = atts[0];
        const payload = JSON.stringify({ filename: att.filename, contentBase64: att.contentBase64, mimeType: att.mimeType, schoolName: school.name });
        const res = await anthropicFetch(uploadUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: payload });
        if (res.ok) { notify(`✓ Uploaded to ${school.name}`, "success"); } else { notify(`Upload failed (${res.status})`, "danger"); }
      } catch(err) { notify("Upload error: " + err.message, "danger"); }
      setSendMenu(false); setSendSubmenu(null);
    };

    return (
      <div style={menuStyle} onClick={e => e.stopPropagation()}>
        {uploadSchools.length > 0 && (<>
          {uploadSchools.length === 1 ? (
            <button onClick={() => uploadToLink(uploadSchools[0])} style={btn(colors.sidebarActive)} onMouseEnter={hov} onMouseLeave={unhov}>📤 Upload to link</button>
          ) : (
            <div style={{ position: "relative" }}>
              <button onMouseEnter={e => { hov(e); setSendSubmenu("upload"); }} onMouseLeave={unhov} style={btnChev(colors.sidebarActive)}>📤 Upload to link<span style={{ fontSize: 10, opacity: 0.5 }}>▶</span></button>
              {sendSubmenu === "upload" && (
                <div style={subMenuStyle}>{uploadSchools.map(s => <button key={s.id} onClick={() => uploadToLink(s)} style={btn(colors.sidebarActive)} onMouseEnter={hov} onMouseLeave={unhov}>{s.name.replace(/Primary School/gi, "PS")}</button>)}</div>
              )}
            </div>
          )}
          <div style={{ height: 1, background: colors.borderLight, margin: "2px 0" }} />
        </>)}

        {allParentEmails.length > 0 && exportType !== "teacher_schedules" && (
          <div style={{ position: "relative" }}>
            <button onClick={() => sendTo(allParentEmails, "parents")} onMouseEnter={e => { hov(e); setSendSubmenu("parents"); }} onMouseLeave={unhov} style={btnChev(colors.sidebarActive)}>Parents<span style={{ fontSize: 10, opacity: 0.5 }}>▶</span></button>
            {sendSubmenu === "parents" && (
              <div style={subMenuStyle}>
                <button onClick={() => sendSequential(allParentEmails)} style={btn(colors.sidebarActive)} onMouseEnter={hov} onMouseLeave={unhov}>Individual (one each)</button>
                <div style={{ height: 1, background: colors.borderLight, margin: "2px 10px" }} />
                {parentStudents.slice(0, 12).map(s => {
                  const pEmails = getParentEmails(s);
                  const parents = (s.parents || []).filter(p => p.email);
                  if (pEmails.length === 0) return null;
                  if (parents.length <= 1) return <button key={s.id} onClick={() => sendTo(pEmails, s.name)} style={btn(colors.sidebarActive)} onMouseEnter={hov} onMouseLeave={unhov}>{parents[0]?.name || s.name}</button>;
                  return parents.map((p, pi) => <button key={`${s.id}-${pi}`} onClick={() => sendTo([p.email], s.name)} style={btn(colors.sidebarActive)} onMouseEnter={hov} onMouseLeave={unhov}>{p.name || p.email}</button>);
                })}
                {parentStudents.length > 12 && <div style={{ padding: "4px 14px", fontSize: 11, color: colors.textMuted }}>+{parentStudents.length - 12} more…</div>}
              </div>
            )}
          </div>
        )}

        {classTeacherContacts.length === 1 && (
          <button onClick={() => sendTo([classTeacherContacts[0].email], classTeacherContacts[0].name)} style={btn(colors.sidebarActive)} onMouseEnter={hov} onMouseLeave={unhov}>{classTeacherContacts[0].name.split(" ")[0]}</button>
        )}
        {classTeacherContacts.length > 1 && exportType !== "teacher_schedules" && (
          <div style={{ position: "relative" }}>
            <button onClick={() => sendTo(classTeacherContacts.map(c => c.email), "class teachers")} onMouseEnter={e => { hov(e); setSendSubmenu("classTeachers"); }} onMouseLeave={unhov} style={btnChev(colors.sidebarActive)}>Class Teachers<span style={{ fontSize: 10, opacity: 0.5 }}>▶</span></button>
            {sendSubmenu === "classTeachers" && (
              <div style={subMenuStyle}>{classTeacherContacts.map(c => <button key={c.id} onClick={() => sendTo([c.email], c.name)} style={btn(colors.sidebarActive)} onMouseEnter={hov} onMouseLeave={unhov}>{c.name.split(" ")[0]}{c.className ? ` (${c.className})` : ""}</button>)}</div>
            )}
          </div>
        )}

        {allStaffObjects.length === 1 && (
          <button onClick={() => sendTo([allStaffObjects[0].email], allStaffObjects[0].name)} style={{ ...btn(colors.text), gap: 8 }} onMouseEnter={e => { e.currentTarget.style.background = allStaffObjects[0].color ? allStaffObjects[0].color + "22" : colors.bg; }} onMouseLeave={e => { e.currentTarget.style.background = "none"; }}>
            {allStaffObjects[0].color && <span style={{ width: 8, height: 8, borderRadius: "50%", background: allStaffObjects[0].color, flexShrink: 0, display: "inline-block" }} />}
            {allStaffObjects[0].name.split(" ")[0]}
          </button>
        )}
        {allStaffObjects.length > 1 && (
          <div style={{ position: "relative" }}>
            <button onClick={() => sendTo(allStaffObjects.map(t => t.email), "staff")} onMouseEnter={e => { hov(e); setSendSubmenu("staff"); }} onMouseLeave={unhov} style={btnChev(colors.text)}>Staff ({allStaffObjects.length})<span style={{ fontSize: 10, opacity: 0.5 }}>▶</span></button>
            {sendSubmenu === "staff" && (
              <div style={subMenuStyle}>{allStaffObjects.map(t => <button key={t.id} onClick={() => sendTo([t.email], t.name)} style={{ ...btn(colors.text), gap: 8 }} onMouseEnter={e => { e.currentTarget.style.background = t.color ? t.color + "22" : colors.bg; }} onMouseLeave={e => { e.currentTarget.style.background = "none"; }}>{t.color && <span style={{ width: 8, height: 8, borderRadius: "50%", background: t.color, flexShrink: 0, display: "inline-block" }} />}{t.name.split(" ")[0]}</button>)}</div>
            )}
          </div>
        )}

        {adminContacts.length === 1 && exportType !== "teacher_schedules" && (
          <button onClick={() => sendTo([adminContacts[0].email], adminContacts[0].name)} style={btn(colors.textMuted)} onMouseEnter={hov} onMouseLeave={unhov}>{adminContacts[0].name.split(" ")[0]}</button>
        )}
        {adminContacts.length > 1 && exportType !== "teacher_schedules" && (
          <div style={{ position: "relative" }}>
            <button onClick={() => sendTo(adminContacts.map(c => c.email), "admin")} onMouseEnter={e => { hov(e); setSendSubmenu("admin"); }} onMouseLeave={unhov} style={btnChev(colors.textMuted)}>Admin<span style={{ fontSize: 10, opacity: 0.5 }}>▶</span></button>
            {sendSubmenu === "admin" && (
              <div style={subMenuStyle}>{adminContacts.map(c => <button key={c.id} onClick={() => sendTo([c.email], c.name)} style={btn(colors.textMuted)} onMouseEnter={hov} onMouseLeave={unhov}>{c.name.split(" ")[0]}{c.role ? ` — ${c.role}` : ""}</button>)}</div>
            )}
          </div>
        )}

        {(allParentEmails.length === 0 || exportType === "teacher_schedules") && (classTeacherContacts.length === 0 || exportType === "teacher_schedules") && allStaffObjects.length === 0 && (adminContacts.length === 0 || exportType === "teacher_schedules") && (
          <div style={{ padding: "10px 14px", fontSize: 12, color: colors.textMuted, fontStyle: "italic" }}>No contacts found for the current filters.</div>
        )}
      </div>
    );
  };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={() => { setSendMenu(false); setSendSubmenu(null); }}>
      {attachQueue.length > 0 && (() => {
        const anchorRect = (sendBtnRef.current || saveBtnRef.current)?.getBoundingClientRect();
        const modalRect = document.querySelector("[data-export-modal]")?.getBoundingClientRect();
        const left = modalRect ? modalRect.right + 12 : (anchorRect ? anchorRect.right + 10 : window.innerWidth);
        const bottom = anchorRect ? window.innerHeight - anchorRect.bottom : 20;
        return (
          <div onClick={e => e.stopPropagation()} style={{ position: "fixed", bottom, left, zIndex: 10025, background: colors.cardBg, border: `1px solid ${colors.border}`, borderRadius: 8, boxShadow: "0 -4px 20px rgba(0,0,0,0.18)", padding: 0, minWidth: 220 }}>
            {attachQueue.map((q, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", height: 34, padding: "0 12px", fontSize: 12 }}>
                <span style={{ color: colors.text, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 170 }}>📎 {q.label}</span>
                <button onClick={() => setAttachQueue(prev => prev.filter((_, j) => j !== i))} style={{ background: "none", border: "none", cursor: "pointer", color: colors.danger, fontSize: 15, lineHeight: 1, padding: "0 0 0 8px", flexShrink: 0 }}>×</button>
              </div>
            ))}
          </div>
        );
      })()}
      <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.45)" }} onClick={onClose} />
      <div data-export-modal style={{ position: "relative", background: colors.cardBg, borderRadius: 16, padding: "28px 32px", width: 560, maxHeight: "90vh", overflow: "auto", boxShadow: "0 24px 64px rgba(0,0,0,0.22)" }}
        onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 22 }}>
          <div style={{ fontWeight: 700, fontSize: 18, color: colors.text, display: "flex", alignItems: "center", gap: 4 }}>{ExportIcon}Export</div>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 22, cursor: "pointer", color: colors.textMuted, lineHeight: 1 }}>×</button>
        </div>

        <div style={{ marginBottom: 20 }}>
          <div style={labelStyle}>What to export</div>
          <div style={{ display: "flex", gap: 8 }}>
            <TypeCard value="timetable" icon="📅" title="Timetable" desc="Grid view by school, teacher or class" />
            <TypeCard value="teacher_schedules" icon="👩‍🏫" title="Teacher Schedules" desc="One page per teacher, all schools" />
          </div>
        </div>

        <div style={{ marginBottom: 16 }}>
          <div style={labelStyle}>Source</div>
          <div ref={pastDropdownRef} style={{ position: "relative", width: "fit-content" }}>
            <div style={{ display: "flex", gap: 0, background: colors.bg, border: `2px solid ${colors.sidebarActive}40`, borderRadius: 10, overflow: "hidden" }}>
              {[
                { id: "master", label: "Master", disabled: !lessons || lessons.length === 0 },
                { id: "weekly", label: "Weekly", disabled: !mostRecentWeek },
                { id: "past", disabled: !hasPastWeeks },
              ].map(tab => (
                <button key={tab.id}
                  onClick={() => {
                    if (tab.disabled) return;
                    setSourceTab(tab.id);
                    if (tab.id === "past") setShowPastDropdown(v => !v);
                    else setShowPastDropdown(false);
                  }}
                  style={{ width: 100, padding: "8px 0", border: "none", fontSize: 13, fontFamily: "inherit", cursor: tab.disabled ? "default" : "pointer", fontWeight: 600, background: sourceTab === tab.id ? colors.sidebarActive : "transparent", color: sourceTab === tab.id ? "#fff" : colors.textMuted, transition: "background 0.15s, color 0.15s", opacity: tab.disabled ? 0.4 : 1, textAlign: "center", whiteSpace: "nowrap" }}>
                  {tab.id === "past"
                    ? (sourceTab === "past" && selectedPastWeek ? (pastWeeks.find(w => w.weekKey === selectedPastWeek)?.weekLabel || "Past Weeks") : "Past Weeks")
                    : tab.label}
                </button>
              ))}
            </div>
            {showPastDropdown && hasPastWeeks && (
              <div style={{ position: "absolute", top: "calc(100% + 4px)", right: 0, zIndex: 200, background: colors.cardBg, border: `1px solid ${colors.border}`, borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.13)", minWidth: 160, overflow: "hidden" }}>
                {pastWeeks.slice().reverse().map(w => (
                  <button key={w.weekKey}
                    onClick={() => { setSelectedPastWeek(w.weekKey); setShowPastDropdown(false); }}
                    style={{ display: "block", width: "100%", padding: "9px 14px", background: selectedPastWeek === w.weekKey ? colors.blueLight : "none", border: "none", fontSize: 13, fontFamily: "inherit", cursor: "pointer", textAlign: "left", color: selectedPastWeek === w.weekKey ? colors.sidebarHover : colors.text, fontWeight: selectedPastWeek === w.weekKey ? 600 : 400 }}
                    onMouseEnter={e => { if (selectedPastWeek !== w.weekKey) e.currentTarget.style.background = colors.bg; }}
                    onMouseLeave={e => { e.currentTarget.style.background = selectedPastWeek === w.weekKey ? colors.blueLight : "none"; }}>
                    {w.weekLabel}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div style={{ marginBottom: 16 }}>
          <div style={labelStyle}>School</div>
          <select value={schoolId} onChange={e => { setSchoolId(e.target.value); setTeacherName(""); setClassName(""); }} style={selectStyle}>
            <option value="">All Schools</option>
            {filteredSchools.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>

        {exportType === "timetable" && (<>
          <div style={{ marginBottom: 16 }}>
            <div style={labelStyle}>Teacher</div>
            <select value={teacherName} onChange={e => setTeacherName(e.target.value)} style={selectStyle}>
              <option value="">All Teachers</option>
              {teacherNames.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div style={{ marginBottom: 16 }}>
            <div style={labelStyle}>Class</div>
            <select value={className} onChange={e => setClassName(e.target.value)} style={selectStyle}>
              <option value="">All Classes</option>
              {classNames.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div style={{ marginBottom: 16 }}>
            <div style={labelStyle}>Day{day.size > 1 ? " — multiple selected, individual files will be generated" : day.size === 1 ? " — portrait (phone-friendly)" : ""}</div>
            <div style={radioGroupStyle}>
              {DAYS.map(d => {
                const active = day.has(d);
                return (
                  <button key={d} onClick={() => setDay(prev => { const next = new Set(prev); active ? next.delete(d) : next.add(d); return next; })}
                    style={{ padding: "6px 14px", borderRadius: 8, fontSize: 12, fontFamily: "inherit", cursor: "pointer", border: `1.5px solid ${active ? colors.sidebarActive : colors.border}`, background: active ? colors.blueLight : colors.cardBg, color: active ? (darkMode ? colors.blue600 : colors.sidebarHover) : colors.text, fontWeight: active ? 600 : 400 }}>
                    {d.slice(0, 3)}
                  </button>
                );
              })}
            </div>
          </div>
        </>)}

        {exportType === "teacher_schedules" && scheduleTeachers.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div style={labelStyle}>Staff</div>
            <select value={teacherName} onChange={e => setTeacherName(e.target.value)} style={selectStyle}>
              <option value="">All Staff</option>
              {scheduleTeachers.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
        )}
        {exportType === "teacher_schedules" && scheduleTeachersFiltered.length > 0 && (
          <div style={{ marginBottom: 16, padding: "10px 14px", background: colors.blueLight, borderRadius: 8, fontSize: 12, color: colors.sidebarHover }}>
            Will export: {scheduleTeachersFiltered.join(", ")}
          </div>
        )}

        <div style={{ marginBottom: 22 }}>
          <div style={labelStyle}>Format <span style={{ fontSize: 10, fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>(select one or more)</span></div>
          <div style={radioGroupStyle}>
            <CheckBtn value="pdf">PDF (printable)</CheckBtn>
            <CheckBtn value="xlsx">Excel (.xlsx)</CheckBtn>
            {exportType !== "teacher_schedules" && <CheckBtn value="csv">CSV</CheckBtn>}
          </div>
          {formats.includes("pdf") && <div style={{ fontSize: 11, color: colors.textMuted, marginTop: 6 }}>PDF downloads as HTML — open and use File → Print → Save as PDF</div>}
          {formats.includes("xlsx") && <div style={{ fontSize: 11, color: colors.textMuted, marginTop: 4 }}>Excel opens in Numbers, Excel, or Google Sheets</div>}

        </div>

        <div style={{ marginBottom: 22 }}>
          <div style={labelStyle}>File name</div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input type="text" value={customFilename !== null ? customFilename : autoFilename}
              onChange={e => setCustomFilename(e.target.value)}
              style={{ flex: 1, padding: "8px 12px", border: `1.5px solid ${customFilename !== null ? colors.sidebarActive : colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", color: colors.text, outline: "none", boxSizing: "border-box" }}
              spellCheck={false} />
            {customFilename !== null && (
              <button onClick={() => setCustomFilename(null)} title="Reset" style={{ background: "none", border: "none", cursor: "pointer", fontSize: 16, color: colors.textMuted, padding: "0 2px", lineHeight: 1 }}>↺</button>
            )}
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: 16, borderTop: `1px solid ${colors.borderLight}`, gap: 8 }}>
          {(exportType === "timetable" || exportType === "teacher_schedules") ? (
            <div style={{ position: "relative", flexShrink: 0, width: 100 }}>
              <input value={contactSearch} onChange={e => setContactSearch(e.target.value)} placeholder="+ Add recipient…"
                style={{ width: "100%", height: 34, padding: "0 11px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 12, fontFamily: "inherit", boxSizing: "border-box", outline: "none" }} />
              {contactSearchResults.length > 0 && (
                <div style={{ position: "absolute", bottom: "calc(100% + 4px)", left: 0, right: 0, background: colors.cardBg, border: `1px solid ${colors.border}`, borderRadius: 8, boxShadow: "0 -4px 16px rgba(0,0,0,0.12)", zIndex: 100, overflow: "hidden" }}>
                  {contactSearchResults.map((c, i) => (
                    <button key={i} onClick={() => addManualRecipient(c)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", padding: "7px 12px", background: "none", border: "none", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}
                      onMouseEnter={e => e.currentTarget.style.background = colors.bg} onMouseLeave={e => e.currentTarget.style.background = "none"}>
                      <span style={{ fontWeight: 500, color: colors.text }}>{c.name.split(" ")[0]}</span>
                      <span style={{ fontSize: 11, color: colors.textMuted }}>{c.parentLabel || c.type}{c.studentName && !c.parentLabel ? ` · ${c.studentName.split(" ")[0]}` : ""}</span>
                    </button>
                  ))}
                </div>
              )}
              {manualRecipients.length > 0 && (
                <div style={{ position: "absolute", bottom: "calc(100% + 4px)", left: 0, right: 0, background: colors.cardBg, border: `1px solid ${colors.border}`, borderRadius: 8, boxShadow: "0 -4px 16px rgba(0,0,0,0.12)", zIndex: 99, padding: "8px 10px" }}>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8 }}>
                    {manualRecipients.map((r, i) => (
                      <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", background: colors.blueLight, border: `1px solid ${colors.sidebarActive}40`, borderRadius: 10, fontSize: 11, color: colors.sidebarHover, fontWeight: 500 }}>
                        {r.name.split(" ")[0]}
                        <button onClick={() => setManualRecipients(prev => prev.filter((_, j) => j !== i))} style={{ background: "none", border: "none", cursor: "pointer", color: colors.sidebarActive, fontSize: 13, lineHeight: 1, padding: 0 }}>×</button>
                      </span>
                    ))}
                  </div>
                  <button onClick={async () => {
                    let atts;
                    if (attachQueue.length > 0) { atts = attachQueue.flatMap(q => q.atts); } else { atts = await buildAttachment(); }
                    openCompose(manualRecipients.map(r => r.email), { triggerId: "timetable_send", mergeCtx: mergeCtxForSend, attachments: atts });
                    setManualRecipients([]);
                  }} style={{ width: "100%", padding: "5px 0", borderRadius: 6, border: `1px solid ${colors.sidebarActive}`, background: colors.sidebarActive, color: "#fff", fontSize: 12, cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}>
                    Send to {manualRecipients.length}
                  </button>
                </div>
              )}
            </div>
          ) : (
            <span style={{ fontSize: 13, color: colors.textMuted }}>{getPreviewLabel()}</span>
          )}

          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
            {(exportType === "timetable" || exportType === "teacher_schedules") && (
              <Btn variant="secondary" disabled={!isReady} onClick={() => { const html = getExportHtml(); if (html) { setPreviewHtml(html); setShowPreview(true); } }}>Preview</Btn>
            )}
            <div ref={saveBtnRef} style={{ display: "inline-flex" }}>
              <Btn variant="secondary" onClick={() => doExport(true)} disabled={exporting || !isReady}>{exporting ? "Saving…" : "Save"}</Btn>
            </div>

            {(exportType === "timetable" || exportType === "teacher_schedules") && (() => {
              const hasQueue = attachQueue.length > 0;
              return (
                <button ref={attachBtnRef} disabled={!isReady}
                  onClick={async () => {
                    if (attaching) return;
                    setAttaching(true);
                    try {
                      const atts = await buildAttachment();
                      if (atts && atts.length > 0) { setAttachQueue(prev => [...prev, { label: activeFilename, atts }]); notify(`"${activeFilename}" queued for Send`); }
                    } catch (e) { notify("Attach failed: " + e.message, "danger"); }
                    setAttaching(false);
                  }}
                  style={{ height: 34, padding: "0 16px", border: `2px solid ${hasQueue ? colors.sidebarActive : colors.border}`, borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: !isReady ? "not-allowed" : "pointer", fontFamily: "inherit", transition: "all 0.15s", opacity: !isReady ? 0.5 : 1, display: "inline-flex", alignItems: "center", gap: 6, boxSizing: "border-box", flexShrink: 0, marginTop: -2, background: hasQueue ? colors.blueLight : colors.tagBg, color: hasQueue ? colors.sidebarHover : colors.text, whiteSpace: "nowrap" }}>
                  Attach
                  <span style={{ background: hasQueue ? colors.sidebarActive : colors.border, color: hasQueue ? "#fff" : colors.textMuted, borderRadius: "50%", width: 18, height: 18, flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700 }}>
                    {attaching ? <span style={{ display: "inline-block", width: 10, height: 10, border: "2px solid rgba(0,0,0,0.15)", borderTopColor: colors.textMuted, borderRadius: "50%", animation: "spin 0.7s linear infinite" }} /> : attachQueue.length}
                  </span>
                </button>
              );
            })()}

            {(exportType === "timetable" || exportType === "teacher_schedules") && (
              <div style={{ position: "relative" }} ref={sendBtnRef}
                onMouseEnter={() => { if (sendMenuHideTimer.current) { clearTimeout(sendMenuHideTimer.current); sendMenuHideTimer.current = null; } }}
                onMouseLeave={() => { sendMenuHideTimer.current = setTimeout(() => { setSendMenu(false); setSendSubmenu(null); }, 300); }}>
                <Btn onClick={e => { e.stopPropagation(); setSendMenu(v => !v); setSendSubmenu(null); }} disabled={!isReady}>Send</Btn>
                {sendMenu && <SendMenu />}
              </div>
            )}
          </div>
        </div>

        {showPreview && previewHtml && (
          <div style={{ position: "fixed", inset: 0, zIndex: 10020, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => setShowPreview(false)}>
            <div style={{ background: colors.cardBg, borderRadius: 12, width: "85vw", maxWidth: 1100, height: "85vh", display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "0 24px 64px rgba(0,0,0,0.3)" }} onClick={e => e.stopPropagation()}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 20px", borderBottom: `1px solid ${colors.border}` }}>
                <span style={{ fontWeight: 600, fontSize: 14, color: colors.text }}>Preview</span>
                <button onClick={() => setShowPreview(false)} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: colors.textMuted, lineHeight: 1 }}>×</button>
              </div>
              <iframe srcDoc={previewHtml} style={{ flex: 1, border: "none", width: "100%" }} title="Timetable Preview" />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
