// ============================================================
// tallyPdfHtml.js
// HTML generator for the "Preview previous term" window in TallyView
// (Spec 4 cluster 8).
//
// Produces a self-contained HTML string with inline CSS, intended to be
// rendered in an Electron preview window opened via
// `window.electronAPI.openInvoicePreview`. The Electron preview window
// does not see the app's stylesheet, so all styling is inline.
//
// The HTML mirrors the on-screen tally's structure (header, summary
// chips, main grid, private-students panel) but is static — no React,
// no click handlers, no live tooltips. A "Print / Save as PDF" button
// at the top calls `window.print()`; the OS's native print dialog has
// a built-in "Save as PDF" destination so no separate save IPC is
// needed. The button is hidden under `@media print`.
//
// CSS sets `@page { size: A4 landscape; }` to bias the OS print
// dialog toward landscape orientation. The user can override in the
// dialog if they want.
// ============================================================

// Neutral palette matching the on-screen tally. Hardcoded because the
// preview window doesn't have access to the app's theme.
const COLORS = {
  success:        "#10B981",
  successBg:      "rgba(16, 185, 129, 0.12)",
  danger:         "#EF4444",
  dangerBg:       "rgba(239, 68, 68, 0.12)",
  accent:         "#F59E0B",
  accentBg:       "rgba(245, 158, 11, 0.18)",
  navy:           "#344565",
  navyBg:         "rgba(52, 69, 101, 0.07)",
  gray500:        "#6B7280",
  gray700:        "#374151",
  border:         "#E5E7EB",
  text:           "#1F2937",
  textMuted:      "#6B7280",
  cardBg:         "#FFFFFF",
  bg:             "#F9FAFB",
  headerBg:       "#1E293B",
  holidayBg:      "rgba(248,113,113,0.13)",
  holidayBlankBg: "rgba(248,113,113,0.08)",
  holidayHdrBg:   "#6B3030",
};

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ── Display-name helpers — match TallyView's conventions exactly ──

function buildPreferredDisplayName(name) {
  if (!name) return name || "";
  const match = name.match(/\(([^)]+)\)/);
  if (!match) return name;
  const prefFirst = match[1];
  const surname = name.replace(/^[^\s(]+\s*\([^)]+\)\s*/, "").trim();
  return surname ? `${prefFirst} ${surname}` : prefFirst;
}

function groupDisplayNameLive(lesson, groups, students) {
  if (!lesson?.isGroup) return null;
  const grp = (groups || []).find(g => g.id === lesson.groupId);
  const memberStudents = (grp?.studentIds || [])
    .map(sid => (students || []).find(s => s.id === sid))
    .filter(Boolean);
  if (memberStudents.length > 0) {
    return memberStudents.map(s => (s.name || "").split(" ")[0]).join(", ");
  }
  return lesson.groupName || "Group";
}

// ── Cell icon: HTML/CSS approximation of CellIcon ──
// Six states: blank, removed, completed, made-up, makeup-owed, no-catchup.
// Static HTML — no banking-catchup derivation (the preview is a snapshot).
function cellIconHTML(entry) {
  if (!entry) {
    return `<span style="display:inline-block;width:12px;height:12px;border-radius:50%;border:1.5px solid #C4C9D4;"></span>`;
  }
  if (entry.status === "removed") {
    return `<span style="font-size:13px;font-weight:700;color:#D1D5DB;">—</span>`;
  }
  if (entry.status === "completed") {
    return `<span style="display:inline-block;width:16px;height:16px;border-radius:50%;background:${COLORS.successBg};color:${COLORS.success};line-height:16px;text-align:center;font-weight:700;font-size:11px;">&#10003;</span>`;
  }
  if (entry.status === "missed") {
    if (entry.madeUp) {
      return `<span style="display:inline-block;width:16px;height:16px;border-radius:50%;background:${COLORS.navyBg};color:${COLORS.navy};line-height:16px;text-align:center;font-weight:700;font-size:11px;">&#8634;</span>`;
    }
    if (entry.makeupEligible) {
      return `<span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${COLORS.accent};"></span>`;
    }
    return `<span style="display:inline-block;width:16px;height:16px;border-radius:50%;background:${COLORS.dangerBg};color:${COLORS.danger};line-height:16px;text-align:center;font-weight:700;font-size:11px;">&#10005;</span>`;
  }
  return "";
}

// ── Single row render (used by both main grid and private panel) ──
function renderRowHTML({ lesson, termWeeks, entryMap, holidayCatchupsMap, students, groups, isPrivate }) {
  const liveStudent = lesson.isGroup ? null : (students || []).find(s => s.id === lesson.studentId);
  const displayName = lesson.isGroup
    ? (groupDisplayNameLive(lesson, groups, students) || "Group")
    : buildPreferredDisplayName(liveStudent?.name || lesson.studentName || "");
  const rowEntries = termWeeks.map(w => entryMap[`${lesson.lessonKey}|${w.weekKey}`] || null);
  const rowCompleted = rowEntries.filter(e => e?.status === "completed").length;
  const rowMissed    = rowEntries.filter(e => e?.status === "missed").length;
  const rowMakeup    = rowEntries.filter(e => e?.status === "missed" && e.makeupEligible && !e.madeUp).length;
  const rowMadeUp    = rowEntries.filter(e => e?.madeUp).length;

  const cellsHTML = termWeeks.map((w, wi) => {
    const entry = rowEntries[wi];
    const isHoliday = !!w.isHoliday;
    const cellKey = `${lesson.lessonKey}|${w.weekKey}`;
    // Main grid uses holidayCatchupsMap to render holiday catchups as
    // completed. Private panel does NOT (per Spec 4 C6 patch — private
    // cells are manual-only).
    const displayEntry = (!isPrivate && isHoliday)
      ? (holidayCatchupsMap?.[cellKey] || null)
      : entry;
    const holidayBlank = !isPrivate && isHoliday && !displayEntry;
    const bg = holidayBlank ? COLORS.holidayBlankBg
      : isHoliday ? COLORS.holidayBg
      : "transparent";
    return `<td style="padding:6px 2px;border-bottom:1px solid ${COLORS.border};text-align:center;background:${bg};">${
      holidayBlank ? "" : cellIconHTML(displayEntry)
    }</td>`;
  }).join("");

  const summaryParts = [
    `<span style="color:${COLORS.success};font-weight:600;">${rowCompleted}&#10003;</span>`,
    (rowMissed - rowMakeup - rowMadeUp) > 0
      ? `<span style="color:${COLORS.danger};font-weight:600;">${rowMissed - rowMakeup - rowMadeUp}&#10005;</span>`
      : "",
    rowMakeup > 0
      ? `<span style="color:${COLORS.accent};font-weight:600;">${rowMakeup}&#9679;</span>`
      : "",
    rowMadeUp > 0
      ? `<span style="color:${COLORS.navy};font-weight:600;">${rowMadeUp}&#8634;</span>`
      : "",
  ].filter(Boolean).join(" ");

  return `<tr>
    <td style="padding:8px 14px;border-bottom:1px solid ${COLORS.border};font-weight:500;font-size:13px;color:${COLORS.text};">${esc(displayName)}</td>
    <td style="padding:8px 8px;border-bottom:1px solid ${COLORS.border};text-align:center;font-size:12px;color:${COLORS.textMuted};border-right:1px solid ${COLORS.border};">
      ${esc(lesson.instrument || "")}${lesson.day ? `<div style="font-size:10px;color:${COLORS.textMuted};">${esc(lesson.day)}</div>` : ""}
    </td>
    ${cellsHTML}
    <td style="padding:8px 12px;border-bottom:1px solid ${COLORS.border};white-space:nowrap;border-left:1px solid ${COLORS.border};font-size:11px;">
      <div style="display:inline-flex;gap:6px;align-items:center;justify-content:center;">${summaryParts}</div>
    </td>
  </tr>`;
}

function renderHeaderRowHTML({ termWeeks, firstColLabel }) {
  const weekCols = termWeeks.map(w =>
    `<th style="padding:8px 4px;text-align:center;font-weight:600;font-size:11px;color:${w.isHoliday ? "rgba(255,200,200,0.85)" : "#FFFFFF"};background:${w.isHoliday ? COLORS.holidayHdrBg : COLORS.headerBg};min-width:30px;">${esc(w.label)}</th>`
  ).join("");
  return `<thead>
    <tr style="background:${COLORS.headerBg};">
      <th style="padding:10px 14px;text-align:left;font-weight:600;font-size:12px;color:#FFFFFF;">${esc(firstColLabel)}</th>
      <th style="padding:10px 8px;text-align:center;font-weight:600;font-size:11px;color:rgba(255,255,255,0.7);border-right:1px solid rgba(255,255,255,0.1);">Instrument</th>
      ${weekCols}
      <th style="padding:10px 12px;text-align:center;font-weight:600;font-size:11px;color:#FFFFFF;border-left:1px solid rgba(255,255,255,0.1);">Summary</th>
    </tr>
  </thead>`;
}

function renderGroupedRowsHTML({ groupedRows, termWeeks, entryMap, holidayCatchupsMap, schools, students, groups }) {
  return (groupedRows || []).map(([groupLabel, rows]) => {
    if (!rows || rows.length === 0) return "";
    const sid = rows[0]?.schoolId;
    const sc = (schools || []).find(s => s.id === sid);
    const groupBg = sc?.color || COLORS.navy;
    const headerRow = groupLabel
      ? `<tr><td colspan="${termWeeks.length + 3}" style="padding:6px 14px;font-size:11px;font-weight:700;color:#FFFFFF;background:${groupBg};letter-spacing:0.05em;text-transform:uppercase;">${esc(groupLabel)}</td></tr>`
      : "";
    const rowsHTML = rows
      .map(lesson => renderRowHTML({ lesson, termWeeks, entryMap, holidayCatchupsMap, students, groups, isPrivate: false }))
      .join("");
    return headerRow + rowsHTML;
  }).join("");
}

function renderSummaryChipsHTML(stats) {
  const chips = [
    { label: "Not Yet Marked",     value: stats.unmarked ?? 0,                                                    color: COLORS.gray500, bg: "#F3F4F6" },
    { label: "Completed",          value: stats.completed ?? 0,                                                   color: COLORS.success, bg: COLORS.successBg },
    { label: "Absent (no makeup)", value: Math.max(0, (stats.missed ?? 0) - (stats.makeupOwed ?? 0) - (stats.madeUp ?? 0)), color: COLORS.danger,  bg: COLORS.dangerBg },
    { label: "Makeup Owed",        value: stats.makeupOwed ?? 0,                                                  color: COLORS.accent,  bg: COLORS.accentBg },
    { label: "Made Up",            value: stats.madeUp ?? 0,                                                      color: COLORS.navy,    bg: COLORS.navyBg },
  ];
  return `<div style="display:flex;gap:10px;margin-bottom:20px;flex-wrap:wrap;">
    ${chips.map(s => `<div style="background:${s.bg};border:1px solid ${s.color}22;border-radius:10px;padding:10px 18px;flex:1 1 0;min-width:140px;display:flex;align-items:center;gap:10px;">
      <div style="font-size:26px;font-weight:800;color:${s.color};line-height:1;">${s.value}</div>
      <div style="font-size:13px;font-weight:600;color:${COLORS.gray700};">${esc(s.label)}</div>
    </div>`).join("")}
  </div>`;
}

function renderPrivatePanelHTML({ privateLessonRows, privateEntryMap, privateStats, termWeeks, students, groups }) {
  if (!privateLessonRows || privateLessonRows.length === 0) return "";
  const rowsHTML = privateLessonRows
    .map(lesson => renderRowHTML({ lesson, termWeeks, entryMap: privateEntryMap, holidayCatchupsMap: null, students, groups, isPrivate: true }))
    .join("");
  const ps = privateStats || {};
  const absent = Math.max(0, (ps.missed ?? 0) - (ps.makeupOwed ?? 0) - (ps.madeUp ?? 0));
  return `<div style="margin-top:36px;page-break-before:auto;">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;">
      <div style="font-weight:700;font-size:15px;color:${COLORS.text};">Private Students</div>
      <span style="font-size:11px;font-weight:700;color:${COLORS.accent};background:${COLORS.accentBg};border-radius:4px;padding:2px 8px;">Private</span>
      <div style="display:flex;gap:12px;font-size:12px;">
        <span style="color:${COLORS.success};">&#10003; ${ps.completed ?? 0}</span>
        ${absent > 0 ? `<span style="color:${COLORS.danger};">&#10005; ${absent}</span>` : ""}
        ${(ps.makeupOwed ?? 0) > 0 ? `<span style="color:${COLORS.accent};">&#9679; ${ps.makeupOwed} owed</span>` : ""}
        ${(ps.madeUp ?? 0) > 0 ? `<span style="color:${COLORS.navy};">&#8634; ${ps.madeUp}</span>` : ""}
      </div>
    </div>
    <table style="width:100%;border-collapse:separate;border-spacing:0;border:1px solid ${COLORS.border};border-radius:10px;overflow:hidden;">
      ${renderHeaderRowHTML({ termWeeks, firstColLabel: "Student" })}
      <tbody>${rowsHTML}</tbody>
    </table>
  </div>`;
}

/**
 * Build a self-contained HTML document for a tally preview window.
 *
 * @param {Object} params
 * @param {Array}  params.tallyRows
 * @param {Object} params.entryMap
 * @param {Array}  params.termWeeks
 * @param {Array}  params.groupedRows
 * @param {Object} params.stats
 * @param {Object} params.holidayCatchupsMap
 * @param {Array}  params.schools
 * @param {Array}  params.students
 * @param {Array}  params.groups
 * @param {Array}  params.privateLessonRows
 * @param {Object} params.privateEntryMap
 * @param {Object} params.privateStats
 * @param {Object} params.term — must carry `.label`.
 * @param {Function} [params.isFutureWeek] — ignored for past terms.
 * @returns {string}
 */
export function _genTallyHTML({
  // eslint-disable-next-line no-unused-vars
  tallyRows, entryMap, termWeeks, groupedRows, stats,
  holidayCatchupsMap, schools, students, groups,
  privateLessonRows, privateEntryMap, privateStats,
  term,
  // eslint-disable-next-line no-unused-vars
  isFutureWeek,
}) {
  const termLabel = term?.label || "";
  const docTitle  = `${termLabel} Tally`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>${esc(docTitle)}</title>
<style>
  @page { size: A4 landscape; margin: 1cm; }
  @media print { .no-print { display: none !important; } }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    font-size: 12px;
    color: ${COLORS.text};
    background: ${COLORS.cardBg};
    margin: 0;
    padding: 20px;
  }
  h1 { font-size: 20px; margin: 0; font-weight: 700; color: ${COLORS.text}; }
  .toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 18px; }
  .print-btn {
    padding: 8px 18px; background: ${COLORS.navy}; color: #FFFFFF;
    border: none; border-radius: 8px; font-size: 13px; cursor: pointer;
    font-family: inherit; font-weight: 600;
  }
  table.tally-grid {
    width: 100%; border-collapse: separate; border-spacing: 0;
    border: 1px solid ${COLORS.border}; border-radius: 10px; overflow: hidden;
  }
</style>
</head>
<body>
  <div class="toolbar">
    <h1>${esc(docTitle)}</h1>
    <button class="print-btn no-print" onclick="window.print()">Print / Save as PDF</button>
  </div>
  ${renderSummaryChipsHTML(stats || {})}
  <table class="tally-grid">
    ${renderHeaderRowHTML({ termWeeks, firstColLabel: "Student / Group" })}
    <tbody>${renderGroupedRowsHTML({ groupedRows, termWeeks, entryMap, holidayCatchupsMap, schools, students, groups })}</tbody>
  </table>
  ${renderPrivatePanelHTML({ privateLessonRows, privateEntryMap, privateStats, termWeeks, students, groups })}
</body>
</html>`;
}
