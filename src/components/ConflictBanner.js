// ============================================================
// CONFLICT BANNER
// Displays timetable conflicts, unassigned and unscheduled
// students after timetable generation.
// ============================================================

import React from "react";
import { useTheme } from "../context/ThemeContext";

export function ConflictBanner({ constraintWarnings, ackedConstraints, lessons, students, unscheduled, onAckAll, allClearLabel = "No conflicts or unscheduled lessons" }) {
  const { colors, darkMode } = useTheme();
  const [expanded, setExpanded] = React.useState(false);

  const unacked = Object.entries(constraintWarnings).filter(([id]) =>
    !ackedConstraints.has(id) && lessons.some(l => l.id === id)
  );
  const unschedItems = (unscheduled || []);
  const unassignedItems = unschedItems.filter(u => u.reason === "Unassigned");
  const cantFitItems = unschedItems.filter(u => u.reason !== "Unassigned");
  const allClear = unacked.length === 0 && unschedItems.length === 0;

  // Theme-aware colour sets
  const green = {
    border: darkMode ? "#4a7a42" : "#8cc183",
    bg:     darkMode ? "#1A2A1A" : "#F3F9F1",
    text:   darkMode ? "#7ec97a" : "#4a7a42",
  };
  const red = {
    border:   colors.danger,
    bg:       darkMode ? "#2A1818" : "#FEF6F6",
    divider:  darkMode ? "#3D2020" : "#FEE2E2",
    text:     colors.danger,
    nameText: colors.gray700,
    subText:  colors.gray500,
  };

  if (allClear) {
    return (
      <div style={{ marginBottom: 16, borderRadius: 10, border: `1.5px solid ${green.border}`, background: green.bg, padding: "10px 16px", display: "flex", alignItems: "center", gap: 8 }}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={green.text} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
          <polyline points="20 6 9 17 4 12"/>
        </svg>
        <span style={{ fontWeight: 600, fontSize: 13, color: green.text }}>{allClearLabel}</span>
      </div>
    );
  }

  const conflictItems = unacked.map(([id, warnings]) => {
    const lesson = lessons.find(l => l.id === id);
    const name = lesson ? (lesson.isGroup && lesson.studentNames ? lesson.studentNames.join(", ") : (lesson.studentName || "Unknown")) : "Unknown";
    const time = lesson ? `${lesson.day} ${lesson.start}` : "";
    return { id, name, time, warnings };
  });

  return (
    <div style={{ marginBottom: 16, borderRadius: 10, overflow: "hidden", border: `1.5px solid ${red.border}`, boxShadow: "0 2px 8px rgba(196,84,84,0.10)" }}>
      <div onClick={() => setExpanded(e => !e)}
        style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", cursor: "pointer", background: red.bg, userSelect: "none" }}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={red.text} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
          <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
        </svg>
        <span style={{ fontWeight: 700, fontSize: 13, color: red.text, flex: 1 }}>
          {[
            unacked.length > 0 && `${unacked.length} conflict${unacked.length !== 1 ? "s" : ""}`,
            unassignedItems.length > 0 && `${unassignedItems.length} unassigned`,
            cantFitItems.length > 0 && `${cantFitItems.length} unscheduled`,
          ].filter(Boolean).join(" · ")}
        </span>
        {unacked.length > 0 && (
          <span style={{ fontSize: 11, color: red.text, fontWeight: 500, marginRight: 6, opacity: 0.75 }}>Click a card and press ✓ to resolve</span>
        )}
        {onAckAll && unacked.length > 0 && (
          <button onClick={e => { e.stopPropagation(); onAckAll(); }}
            style={{ fontSize: 11, fontWeight: 600, color: red.text, background: "rgba(196,84,84,0.08)", border: `1px solid ${red.border}`, borderRadius: 6, padding: "3px 10px", cursor: "pointer", fontFamily: "inherit", marginRight: 6 }}>
            Acknowledge all
          </button>
        )}
        <span style={{ fontSize: 11, color: red.text, fontWeight: 600 }}>{expanded ? "▲" : "▼"}</span>
      </div>

      {expanded && (
        <div style={{ background: red.bg, borderTop: `1px solid ${red.border}` }}>
          {conflictItems.length > 0 && (
            <>
              {(unassignedItems.length > 0 || cantFitItems.length > 0) && (
                <div style={{ padding: "5px 16px 3px", fontSize: 10, fontWeight: 700, color: red.text, textTransform: "uppercase", letterSpacing: 0.5, opacity: 0.7 }}>Conflicts</div>
              )}
              {conflictItems.map((item, i) => (
                <div key={item.id} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "8px 16px", borderBottom: (i < conflictItems.length - 1 || unassignedItems.length > 0 || cantFitItems.length > 0) ? `1px solid ${red.divider}` : "none" }}>
                  <div style={{ fontSize: 11, minWidth: 120, color: red.nameText, fontWeight: 600, paddingTop: 1 }}>
                    {item.name}
                    {item.time && <div style={{ fontWeight: 400, color: red.subText }}>{item.time}</div>}
                  </div>
                  <div style={{ flex: 1 }}>
                    {item.warnings.map((w, wi) => (
                      <div key={wi} style={{ fontSize: 11, color: red.text, lineHeight: 1.5 }}>• {w}</div>
                    ))}
                  </div>
                </div>
              ))}
            </>
          )}
          {unassignedItems.length > 0 && (
            <>
              <div style={{ padding: "5px 16px 3px", fontSize: 10, fontWeight: 700, color: red.text, textTransform: "uppercase", letterSpacing: 0.5, opacity: 0.7 }}>No Teacher Assigned</div>
              {unassignedItems.map((u, i) => (
                <div key={(u.student?.id || i) + (u.instrument || "")} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "8px 16px", borderBottom: (i < unassignedItems.length - 1 || cantFitItems.length > 0) ? `1px solid ${red.divider}` : "none" }}>
                  <div style={{ fontSize: 11, minWidth: 120, color: red.nameText, fontWeight: 600, paddingTop: 1 }}>
                    {u.student?.name || "Unknown"}
                    {u.instrument && <div style={{ fontWeight: 400, color: red.subText }}>{u.instrument}</div>}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 11, color: red.text, lineHeight: 1.5 }}>• Assign a teacher in student details</div>
                  </div>
                </div>
              ))}
            </>
          )}
          {cantFitItems.length > 0 && (
            <>
              <div style={{ padding: "5px 16px 3px", fontSize: 10, fontWeight: 700, color: red.text, textTransform: "uppercase", letterSpacing: 0.5, opacity: 0.7 }}>Could Not Schedule</div>
              {cantFitItems.map((u, i) => (
                <div key={(u.student?.id || i) + (u.instrument || "")} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "8px 16px", borderBottom: i < cantFitItems.length - 1 ? `1px solid ${red.divider}` : "none" }}>
                  <div style={{ fontSize: 11, minWidth: 120, color: red.nameText, fontWeight: 600, paddingTop: 1 }}>
                    {u.student?.name || "Unknown"}
                    {u.instrument && <div style={{ fontWeight: 400, color: red.subText }}>{u.instrument}</div>}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 11, color: red.text, lineHeight: 1.5 }}>• {u.reason || "No available slot found"}</div>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
