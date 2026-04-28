// ============================================================
// ResourcePicker.js — Shared resource picker modal
// Lets users search and select from the resources table.
// Used in band link forms in both admin and teacher apps.
// ============================================================

import React, { useState, useMemo } from "react";
import { X, Search, Link, Library } from "lucide-react";
import { useTheme } from "../context/ThemeContext";

export function ResourcePicker({ resources, onSelect, onClose }) {
  const { colors } = useTheme();
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return (resources || []).filter(r =>
      !r._isNew &&
      r.url &&
      ((r.label || "").toLowerCase().includes(q) ||
       (r.category || "").toLowerCase().includes(q))
    );
  }, [resources, search]);

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 10002, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: colors.cardBg, borderRadius: 14, width: 480, maxHeight: "70vh", display: "flex", flexDirection: "column", boxShadow: "0 24px 64px rgba(0,0,0,0.3)", overflow: "hidden" }}>

        {/* Header */}
        <div style={{ background: "#1E2230", padding: "14px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
          <span style={{ fontWeight: 700, fontSize: 14, color: "#fff", display: "inline-flex", alignItems: "center", gap: 8 }}>
            <Library size={14} /> Select Resource
          </span>
          <button onClick={onClose}
            style={{ background: "none", border: "none", cursor: "pointer", color: "rgba(255,255,255,0.7)", display: "inline-flex", alignItems: "center" }}>
            <X size={16} />
          </button>
        </div>

        {/* Search */}
        <div style={{ padding: "12px 16px", borderBottom: `1px solid ${colors.border}`, flexShrink: 0, position: "relative" }}>
          <Search size={14} style={{ position: "absolute", left: 28, top: "50%", transform: "translateY(-50%)", color: colors.textMuted, pointerEvents: "none" }} />
          <input autoFocus value={search} onChange={e => setSearch(e.target.value)} placeholder="Search resources…"
            style={{ width: "100%", padding: "8px 12px 8px 32px", border: `1px solid ${colors.inputBorder || colors.border}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box", background: colors.cardBg, color: colors.text, outline: "none" }} />
        </div>

        {/* List */}
        <div style={{ overflowY: "auto", flex: 1 }}>
          {filtered.length === 0 ? (
            <div style={{ padding: "32px 20px", textAlign: "center", color: colors.textMuted, fontSize: 13, fontStyle: "italic" }}>
              {search ? "No resources match your search." : "No resources available."}
            </div>
          ) : (
            filtered.map((item, i) => (
              <div key={item.id}
                onClick={() => onSelect(item)}
                style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderBottom: i < filtered.length - 1 ? `1px solid ${colors.border}20` : "none", cursor: "pointer", transition: "background 0.1s" }}
                onMouseEnter={e => e.currentTarget.style.background = colors.bg}
                onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, color: colors.text, marginBottom: 2 }}>{item.label || "Untitled"}</div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                    {item.category && (
                      <span style={{ padding: "1px 7px", borderRadius: 8, fontSize: 11, fontWeight: 600, background: colors.bg, color: colors.textMuted, border: `1px solid ${colors.border}` }}>{item.category}</span>
                    )}
                    {item.url && (
                      <span style={{ fontSize: 11, color: colors.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 220 }}>{item.url.replace(/^https?:\/\//, "")}</span>
                    )}
                  </div>
                </div>
                <Link size={14} style={{ color: colors.textMuted, flexShrink: 0 }} />
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
