// ============================================================
// ERROR LOG PANEL + DASHBOARD BACKUP BAR
// ============================================================

import React from "react";
import { STORAGE_KEYS } from "../constants";
import { useTheme } from "../context/ThemeContext";

export function ErrorLogPanel({ errorLog }) {
  const { colors } = useTheme();
  const [open, setOpen] = React.useState(false);
  return (
    <div style={{ marginTop: 16 }}>
      <button onClick={() => setOpen(o => !o)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 11, color: "#9CA3AF", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 4, padding: 0 }}>
        <span style={{ color: "#EF4444", fontWeight: 700 }}>⚠</span>
        {errorLog.length} recent error{errorLog.length > 1 ? "s" : ""}
        <span style={{ fontSize: 10 }}>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div style={{ marginTop: 6, borderRadius: 8, border: "1px solid #FCA5A5", background: "#FFF5F5", padding: "8px 12px", maxHeight: 180, overflowY: "auto" }}>
          {errorLog.map(e => (
            <div key={e.id} style={{ fontSize: 11, color: "#7F1D1D", marginBottom: 6, lineHeight: 1.4 }}>
              <span style={{ color: "#9CA3AF", marginRight: 6 }}>{new Date(e.ts).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
              <strong>{e.message}</strong>
              {e.detail && <span style={{ color: "#B91C1C", marginLeft: 4 }}>— {e.detail}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function DashboardBackupBar({ onBackup, onRestore, notify }) {
  const { colors } = useTheme();
  const fileRef = React.useRef(null);
  const [backupDone, setBackupDone] = React.useState(false);

  const handleBackup = async () => {
    if (onBackup) await onBackup();
    setBackupDone(true);
    setTimeout(() => setBackupDone(false), 2500);
  };

  const handleRestore = async (e) => {
    if (window.electronAPI) {
      const result = await window.electronAPI.openFileDialog();
      if (!result.ok) return;
      try {
        const data = JSON.parse(result.json);
        if (!data.schools && !data.students) throw new Error("Not a valid backup file");
        if (onRestore) onRestore(data);
      } catch (err) { if (notify) notify("Invalid backup file: " + err.message, "danger"); }
      return;
    }
    const file = e?.target?.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        if (!data.schools && !data.students) throw new Error("Not a valid backup file");
        if (onRestore) onRestore(data);
      } catch (err) { if (notify) notify("Invalid backup file: " + err.message, "danger"); }
    };
    reader.readAsText(file);
    if (e?.target) e.target.value = "";
  };

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", background: colors.borderLight, borderRadius: 10, marginTop: 0 }}>
      <div style={{ fontSize: 12, color: colors.textMuted }}>
        {localStorage.getItem(STORAGE_KEYS.lastScheduledBackup) ? (
          <span>⏱ Last auto-backup: {new Date(localStorage.getItem(STORAGE_KEYS.lastScheduledBackup)).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
        ) : (
          <span style={{ color: colors.amber }}>⚠ No auto-backup yet — runs every 6 hours</span>
        )}
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        {!window.electronAPI && <input ref={fileRef} type="file" accept=".json" onChange={handleRestore} style={{ display: "none" }} />}
        <button onClick={handleBackup}
          style={{ padding: "5px 14px", border: "none", borderRadius: 7, background: backupDone ? colors.success : colors.sidebarActive, color: "#fff", fontSize: 12, fontFamily: "inherit", fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: 5, transition: "background 0.2s" }}>
          {backupDone ? <><span style={{ fontSize: 14 }}>✓</span> Saved</> : "Backup"}
        </button>
        <button onClick={() => window.electronAPI ? handleRestore() : fileRef.current?.click()}
          style={{ padding: "5px 14px", border: `1px solid ${colors.border}`, borderRadius: 7, background: colors.cardBg, color: colors.textLight, fontSize: 12, fontFamily: "inherit", fontWeight: 600, cursor: "pointer" }}>
          Restore
        </button>
      </div>
    </div>
  );
}
