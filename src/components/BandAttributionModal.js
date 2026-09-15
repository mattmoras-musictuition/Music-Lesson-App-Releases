// ============================================================
// BAND ATTRIBUTION MODAL
// Band Session Attribution cluster 3b.
//
// One row per member student of a band session. Each row chooses how
// that student's slot in the band is accounted for: their regular
// lesson, a catch-up settling a specific missed lesson, or a free extra.
//
// Presentational only. It receives already-derived rows and emits
// onChange / onSave / onCancel. It never touches Supabase, global state,
// or the pure helpers — every decision about what the data MEANS is made
// by the caller in WeeklyAdjustments.js, so this file can be read as
// pure layout.
//
// Styling follows the inline missed-lesson modal in WeeklyAdjustments.js:
// fixed backdrop, centred card, theme tokens from useTheme, backdrop
// click and Escape both cancel.
// ============================================================

import React, { useEffect } from "react";
import { useTheme } from "../context/ThemeContext";

const CONSUMPTION_OPTIONS = [
  { value: "", label: "Not set" },
  { value: "regular", label: "Regular lesson" },
  { value: "catchup", label: "Catch-up" },
  { value: "free", label: "Free extra" },
];

/**
 * @param {Object}   props
 * @param {string}   props.title        Band name.
 * @param {string}   props.subtitle     Day + start time.
 * @param {Array}    props.rows         One per student, already derived:
 *   { studentId, studentName, entries, consumption, enrolmentId,
 *     instrumentOptions: [{enrolmentId, label}], misses: [{key, label, miss}],
 *     settlesLabel, departed }
 * @param {Function} props.onChange     (studentId, patch) — patch carries any of
 *                                      { consumption, enrolmentId, missKey }.
 * @param {Function} props.onSave
 * @param {Function} props.onCancel
 * @param {boolean}  props.saving       Disables the footer while writes are in flight.
 */
export function BandAttributionModal({ title, subtitle, rows = [], onChange, onSave, onCancel, saving = false }) {
  const { colors } = useTheme();

  // Escape cancels, matching the backdrop click. Capture phase so a
  // focused <select> cannot swallow it.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); if (!saving) onCancel(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel, saving]);

  const selectStyle = (disabled) => ({
    padding: "6px 9px", borderRadius: 8, fontSize: 12.5, fontFamily: "inherit",
    border: `1.5px solid ${colors.inputBorder}`, background: colors.cardBg,
    color: disabled ? colors.textMuted : colors.text, outline: "none",
    cursor: disabled ? "not-allowed" : "pointer",
  });

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 1100, display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={() => { if (!saving) onCancel(); }}>
      <div style={{ background: colors.cardBg, borderRadius: 14, padding: 22, width: 460, boxShadow: "0 20px 60px rgba(0,0,0,0.22)", maxHeight: "90vh", overflowY: "auto" }}
        onClick={e => e.stopPropagation()}>

        <div style={{ fontWeight: 700, fontSize: 15, color: colors.text, marginBottom: 3 }}>{title}</div>
        <div style={{ fontSize: 12, color: colors.textMuted, marginBottom: 16 }}>{subtitle}</div>

        {rows.length === 0 && (
          <div style={{ fontSize: 12.5, color: colors.textMuted, fontStyle: "italic", marginBottom: 16 }}>
            No members with an active enrolment this week.
          </div>
        )}

        {rows.map(row => {
          const noMisses = !row.misses || row.misses.length === 0;
          return (
            <div key={row.studentId}
              style={{
                padding: "10px 0", borderTop: `1px solid ${colors.borderLight}`,
                opacity: row.departed ? 0.55 : 1,
              }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: colors.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {row.studentName}
                  </div>
                  {row.departed && (
                    <div style={{ fontSize: 11, color: colors.danger, marginTop: 2 }}>No longer in band</div>
                  )}
                  {!row.departed && row.consumption === "catchup" && (
                    <button
                      onClick={() => onChange(row.studentId, { cycleMiss: true })}
                      disabled={noMisses || (row.misses || []).length < 2}
                      title={(row.misses || []).length > 1 ? "Choose a different missed lesson" : undefined}
                      style={{
                        marginTop: 2, padding: 0, background: "none", border: "none", fontFamily: "inherit",
                        fontSize: 11, color: colors.sidebarActive, textAlign: "left",
                        cursor: (row.misses || []).length > 1 ? "pointer" : "default",
                        textDecoration: (row.misses || []).length > 1 ? "underline" : "none",
                      }}>
                      {row.settlesLabel ? `Settles ${row.settlesLabel}` : "No missed lesson selected"}
                    </button>
                  )}
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                  {row.departed ? (
                    <button onClick={() => onChange(row.studentId, { consumption: "" })}
                      style={{ padding: "6px 12px", borderRadius: 8, background: colors.tagBg, color: colors.gray700, fontWeight: 600, fontSize: 12, border: "none", cursor: "pointer", fontFamily: "inherit" }}>
                      Clear
                    </button>
                  ) : (
                    <>
                      {(row.instrumentOptions || []).length > 1 && (
                        <select
                          value={row.enrolmentId || ""}
                          onChange={e => onChange(row.studentId, { enrolmentId: e.target.value })}
                          title="Counts against"
                          style={selectStyle(false)}>
                          {row.instrumentOptions.map(o => (
                            <option key={o.enrolmentId} value={o.enrolmentId}>{o.label}</option>
                          ))}
                        </select>
                      )}
                      <select
                        value={row.consumption || ""}
                        onChange={e => onChange(row.studentId, { consumption: e.target.value })}
                        style={selectStyle(false)}>
                        {CONSUMPTION_OPTIONS.map(o => (
                          <option key={o.value} value={o.value} disabled={o.value === "catchup" && noMisses}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </>
                  )}
                </div>
              </div>
            </div>
          );
        })}

        <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
          <button onClick={() => { if (!saving) onCancel(); }} disabled={saving}
            style={{ flex: 1, padding: "9px 0", borderRadius: 8, background: colors.tagBg, color: colors.gray700, fontWeight: 600, fontSize: 13, border: "none", cursor: saving ? "not-allowed" : "pointer", fontFamily: "inherit" }}>
            Cancel
          </button>
          <button onClick={onSave} disabled={saving}
            style={{ flex: 1, padding: "9px 0", borderRadius: 8, fontWeight: 700, fontSize: 13, border: "none", fontFamily: "inherit",
              cursor: saving ? "not-allowed" : "pointer",
              background: saving ? colors.border : colors.sidebarActive, color: "#fff" }}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
