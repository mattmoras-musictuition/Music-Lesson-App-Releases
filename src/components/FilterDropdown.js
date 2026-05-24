// ============================================================
// FilterDropdown.js — multi-select filter dropdown
//
// A button + checkbox popover. `options` is [{value, label}];
// `selected` is an array of values. Empty selection = no filter.
// Shared by the Resources tab and the library picker (and reused
// by the Bands picker).
// ============================================================

import React, { useState, useRef, useEffect } from "react";
import { ChevronDown } from "lucide-react";

export function FilterDropdown({ label, options, selected, onChange, colors }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const toggle = (val) =>
    onChange(selected.includes(val) ? selected.filter(v => v !== val) : [...selected, val]);

  const count = selected.length;
  const active = count > 0;

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          padding: "7px 10px", border: "1px solid " + (active ? colors.sidebarHover : colors.inputBorder),
          borderRadius: 8, fontSize: 12, fontWeight: 600, fontFamily: "inherit",
          background: active ? (colors.blueLight || "#EFF6FF") : colors.cardBg,
          color: active ? colors.sidebarHover : colors.textMuted,
          cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 5, whiteSpace: "nowrap",
        }}
      >
        {label}{active ? ` (${count})` : ""} <ChevronDown size={13} />
      </button>
      {open && (
        <div style={{
          position: "absolute", zIndex: 30, top: "calc(100% + 4px)", left: 0,
          minWidth: 180, maxHeight: 280, overflowY: "auto",
          background: colors.cardBg, border: "1px solid " + colors.border,
          borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,0.18)", padding: 6,
        }}>
          {options.length === 0 ? (
            <div style={{ padding: "6px 8px", fontSize: 12, color: colors.textMuted, fontStyle: "italic" }}>No options</div>
          ) : options.map(opt => (
            <label key={opt.value}
              style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 8px", borderRadius: 6, cursor: "pointer", fontSize: 13, color: colors.text }}>
              <input type="checkbox" checked={selected.includes(opt.value)} onChange={() => toggle(opt.value)} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{opt.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
