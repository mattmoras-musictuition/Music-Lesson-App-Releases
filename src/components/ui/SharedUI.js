// ============================================================
// SHARED UI COMPONENTS
// Reusable building blocks used across all pages.
// ============================================================

import React, { useRef } from "react";
import { HEADER_HEIGHT } from "../../constants";
import { useTheme } from "../../context/ThemeContext";
import { getXLSX } from "../../utils/api";

// ── Page layout ───────────────────────────────────────────────────────────────

export const PAGE_COLORS = {
  dashboard: "#344565", schools: "#344565", specialists: "#344565",
  interruptions: "#344565", students: "#344565", teachers: "#344565",
  groups: "#344565", pending: "#344565", timetable: "#344565",
  weekly: "#344565", tally: "#344565", contacts: "#344565",
  bands: "#344565", resources: "#344565", settings: "#344565",
};

export function PageTitle({ children, subtitle, action, pageColor, navButtons }) {
  const { colors, darkMode } = useTheme();
  const bg = pageColor || colors.sidebarActive;
  const titleColor = darkMode ? colors.sidebar : "#fff";
  const subtitleColor = darkMode ? colors.sidebar : "rgba(255,255,255,0.55)";
  return (
    <div style={{
      marginLeft: -36, marginRight: -36, marginTop: -28, marginBottom: 20,
      position: "sticky", top: 0, zIndex: 50,
      background: bg, borderBottom: `1px solid ${colors.border}`,
      minHeight: HEADER_HEIGHT, boxSizing: "border-box",
    }}>
      <div style={{ padding: "0 36px", minHeight: HEADER_HEIGHT, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
          <h1 style={{ fontSize: 26, fontWeight: 700, fontFamily: "'DM Sans', sans-serif", margin: 0, color: titleColor, lineHeight: 1.1, textTransform: "uppercase", whiteSpace: "nowrap" }}>{children}</h1>
          {subtitle && (
            <span style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 13, fontWeight: 500, color: subtitleColor, lineHeight: 1, marginTop: 3, textTransform: "uppercase", letterSpacing: "0.08em", display: "block", whiteSpace: "nowrap" }}>
              {subtitle}
            </span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
          {action && <ActionBar>{action}</ActionBar>}
          {navButtons}
        </div>
      </div>
    </div>
  );
}

export function NavButtons({ goBack, goForward, historyCursor, pageHistory }) {
  const btnStyle = (disabled) => ({
    height: 28, padding: "0 4px", border: "none", borderRadius: 4, background: "none",
    color: disabled ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.8)",
    cursor: disabled ? "default" : "pointer", fontSize: 22, fontFamily: "inherit",
    display: "inline-flex", alignItems: "center", lineHeight: 1,
  });
  return (
    <div style={{ display: "flex", gap: 2 }}>
      <button onClick={goBack} disabled={historyCursor <= 0} style={btnStyle(historyCursor <= 0)} title="Back">‹</button>
      <button onClick={goForward} disabled={historyCursor >= pageHistory.length - 1} style={btnStyle(historyCursor >= pageHistory.length - 1)} title="Forward">›</button>
    </div>
  );
}

export function ActionBar({ children }) {
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
      {children}
    </div>
  );
}

// ── Cards ─────────────────────────────────────────────────────────────────────

export function Card({ children, style, onClick, ...rest }) {
  const { colors } = useTheme();
  return (
    <div onClick={onClick} {...rest} style={{ background: colors.cardBg, border: `1px solid ${colors.border}`, borderRadius: 12, padding: 24, cursor: onClick ? "pointer" : undefined, ...style }}>
      {children}
    </div>
  );
}

export function FrozenCard({ children, style }) {
  return (
    <>
      <div data-frozen-card="true" style={{ position: "fixed", top: HEADER_HEIGHT + 13, left: 240, right: 0, zIndex: 40, padding: "0 36px 0" }}>
        <Card style={{ ...style, padding: 14, marginBottom: 0 }}>{children}</Card>
      </div>
      <div style={{ visibility: "hidden", padding: "0 0 16px" }}>
        <Card style={{ ...style, padding: 14, marginBottom: 0 }}>{children}</Card>
      </div>
    </>
  );
}

// ── Buttons & inputs ──────────────────────────────────────────────────────────

export function Btn({ children, onClick, variant = "primary", style, disabled }) {
  const { colors } = useTheme();
  const base = {
    height: 34, padding: "0 16px", border: "2px solid transparent", borderRadius: 8, fontSize: 13,
    fontWeight: 600, cursor: disabled ? "not-allowed" : "pointer", fontFamily: "inherit",
    transition: "all 0.15s", opacity: disabled ? 0.5 : 1, display: "inline-flex",
    alignItems: "center", gap: 6, boxSizing: "border-box", flexShrink: 0, marginTop: -2
  };
  const variants = {
    primary: { background: colors.accent, color: "#fff" },
    secondary: { background: colors.tagBg, color: colors.text, borderColor: colors.border },
    danger: { background: colors.redLight, color: colors.danger, border: `1px solid ${colors.danger}50` },
    success: { background: `${colors.success}18`, color: colors.success, border: `1px solid ${colors.success}50` },
    ghost: { background: "transparent", color: colors.textLight }
  };
  return <button onClick={onClick} disabled={disabled} style={{ ...base, ...variants[variant], ...style }}>{children}</button>;
}

export function Input({ label, value, onChange, type = "text", placeholder, style, options, multiline }) {
  const { colors } = useTheme();
  const inputStyle = {
    width: "100%", padding: "9px 12px", border: `1px solid ${colors.inputBorder}`,
    borderRadius: 8, fontSize: 14, fontFamily: "inherit", background: colors.inputBg,
    color: colors.text, outline: "none", boxSizing: "border-box", transition: "border-color 0.15s"
  };
  return (
    <div style={{ marginBottom: 14, ...style }}>
      {label && <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: colors.textLight, marginBottom: 5, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</label>}
      {options ? (
        <select value={value} onChange={e => onChange(e.target.value)} style={{ ...inputStyle, cursor: "pointer" }}>
          <option value="">Select...</option>
          {options.map(o => <option key={typeof o === "string" ? o : o.value} value={typeof o === "string" ? o : o.value}>{typeof o === "string" ? o : o.label}</option>)}
        </select>
      ) : multiline ? (
        <textarea value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} rows={3} style={{ ...inputStyle, resize: "vertical" }} />
      ) : (
        <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} style={inputStyle} />
      )}
    </div>
  );
}

export function Checkbox({ label, checked, onChange }) {
  const { colors } = useTheme();
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, cursor: "pointer", marginBottom: 8 }}>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} style={{ accentColor: colors.accent, width: 16, height: 16 }} />
      {label}
    </label>
  );
}

// ── Tags & status ─────────────────────────────────────────────────────────────

export function Tag({ children, color, onRemove }) {
  const { colors } = useTheme();
  const tagColor = color || colors.accent;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, background: tagColor + "18", color: tagColor, fontSize: 12, fontWeight: 600, padding: "3px 10px", borderRadius: 6, margin: "2px 4px 2px 0" }}>
      {children}
      {onRemove && <span onClick={onRemove} style={{ cursor: "pointer", marginLeft: 2, opacity: 0.7 }}>×</span>}
    </span>
  );
}

export function EmptyState({ icon, title, subtitle, action, onAction }) {
  const { colors } = useTheme();
  return (
    <div style={{ textAlign: "center", padding: "60px 20px", color: colors.textMuted }}>
      <div style={{ fontSize: 48, marginBottom: 16, opacity: 0.5 }}>{icon}</div>
      <div style={{ fontSize: 18, fontWeight: 600, color: colors.textLight, marginBottom: 8 }}>{title}</div>
      <div style={{ fontSize: 14, marginBottom: 24, maxWidth: 400, margin: "0 auto 24px" }}>{subtitle}</div>
      {action && <Btn onClick={onAction}>{action}</Btn>}
    </div>
  );
}

// ── File upload ───────────────────────────────────────────────────────────────

export function FileUpload({ onData, accept = ".csv,.xlsx,.xls", label = "Import Spreadsheet" }) {
  const ref = useRef(null);
  const handleFile = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.name.endsWith(".csv")) {
      window.Papa.parse(file, {
        header: true, skipEmptyLines: true,
        complete: (results) => onData(results.data, file.name)
      });
    } else {
      const reader = new FileReader();
      reader.onload = async (ev) => {
        try {
          const XLSX = await getXLSX();
          const wb = XLSX.read(ev.target.result, { type: "binary" });
          const ws = wb.Sheets[wb.SheetNames[0]];
          const data = XLSX.utils.sheet_to_json(ws, { defval: "" });
          onData(data, file.name);
        } catch (err) { console.error("Excel parse error:", err); }
      };
      reader.readAsBinaryString(file);
    }
    e.target.value = "";
  };
  return (
    <>
      <input ref={ref} type="file" accept={accept} onChange={handleFile} style={{ display: "none" }} />
      <Btn variant="secondary" onClick={() => ref.current?.click()}>{ label}</Btn>
    </>
  );
}

// ── Memory input ──────────────────────────────────────────────────────────────

export function AddMemoryInput({ onAdd }) {
  const { colors } = useTheme();
  const [val, setVal] = React.useState("");
  return (
    <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
      <input value={val} onChange={e => setVal(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter" && val.trim()) { onAdd(val.trim()); setVal(""); } }}
        placeholder="Add a new memory…"
        style={{ flex: 1, padding: "6px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 12, fontFamily: "inherit", color: colors.text, outline: "none", background: colors.inputBg }} />
      <button onClick={() => { if (val.trim()) { onAdd(val.trim()); setVal(""); } }}
        style={{ padding: "6px 14px", border: "none", borderRadius: 6, background: colors.accent, color: "#fff", fontSize: 12, fontFamily: "inherit", cursor: "pointer" }}>
        Add
      </button>
    </div>
  );
}

// ── useDragScroll hook ────────────────────────────────────────────────────────

export function useDragScroll(scrollRef, isDragging) {
  const rafRef = React.useRef(null);
  const posRef = React.useRef(null);
  React.useEffect(() => {
    if (!isDragging) { cancelAnimationFrame(rafRef.current); posRef.current = null; return; }
    const EDGE = 80, MAX_SPEED = 18;
    const onDragOver = (e) => { posRef.current = e.clientY; };
    document.addEventListener("dragover", onDragOver);
    const tick = () => {
      if (posRef.current !== null && scrollRef?.current) {
        const { top, bottom } = scrollRef.current.getBoundingClientRect();
        const distTop = posRef.current - top;
        const distBottom = bottom - posRef.current;
        if (distTop < EDGE && distTop > 0) scrollRef.current.scrollTop -= Math.round(MAX_SPEED * (1 - distTop / EDGE));
        else if (distBottom < EDGE && distBottom > 0) scrollRef.current.scrollTop += Math.round(MAX_SPEED * (1 - distBottom / EDGE));
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(rafRef.current); document.removeEventListener("dragover", onDragOver); };
  }, [isDragging, scrollRef]);
}
