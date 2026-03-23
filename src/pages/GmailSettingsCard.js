// ============================================================
// GMAIL SETTINGS CARD
// ============================================================

import React from "react";
import { colors } from "../constants";
import { Btn } from "../components/ui/SharedUI";

export function GmailSettingsCard({ notify, cardStyle, gmailStatus, setGmailStatus }) {
  const [gmailLoading, setGmailLoading] = React.useState(false);
  // Local override so the UI reflects connect/disconnect immediately without
  // waiting for the prop to propagate down from the parent
  const [localConnected, setLocalConnected] = React.useState(null);
  const isConnected = localConnected !== null ? localConnected : gmailStatus?.connected;
  const [suppressPatterns, setSuppressPatterns] = React.useState(() => { try { return JSON.parse(localStorage.getItem("mt-email-suppress") || "[]"); } catch { return []; } });

  // Reset loading state on mount — guards against stuck state from a previous
  // failed attempt where the finally block didn't run (e.g. thrown before try)
  React.useEffect(() => { setGmailLoading(false); }, []);

  // Re-check status when window regains focus (OAuth window may have completed)
  React.useEffect(() => {
    const onFocus = () => {
      if (window.electronAPI?.gmailGetStatus) {
        window.electronAPI.gmailGetStatus().then(s => setGmailStatus(s));
      }
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [setGmailStatus]);

  const connect = async () => {
    setGmailLoading(true);
    try {
      const result = await window.electronAPI.gmailOAuthConnect();
      const status = await window.electronAPI.gmailGetStatus();
      setGmailStatus(status);
      setLocalConnected(!!status?.connected);
      if (status?.connected) notify("Gmail connected ✓");
      else if (result?.error && result.error !== "Window closed") notify("Connection failed: " + result.error, "danger");
    } catch (e) {
      notify("Connection failed: " + (e?.message || String(e)), "danger");
    } finally {
      setGmailLoading(false);
    }
  };
  const disconnect = async () => {
    try {
      await window.electronAPI.gmailDisconnect();
      setLocalConnected(false);
      setGmailStatus({ connected: false });
      notify("Gmail disconnected");
    } catch (e) {
      notify("Disconnect failed: " + (e?.message || String(e)), "danger");
    }
  };

  const removePattern = (idx) => {
    const next = suppressPatterns.filter((_, i) => i !== idx);
    setSuppressPatterns(next);
    try { localStorage.setItem("mt-email-suppress", JSON.stringify(next)); } catch {}
  };

  return (
    <div style={{ ...cardStyle }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: suppressPatterns.length > 0 ? 12 : 0 }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: 14 }}>✉ Gmail</div>
          <div style={{ fontSize: 12, color: colors.textLight, marginTop: 2 }}>
            {isConnected
              ? <span style={{ color: colors.success, fontWeight: 500 }}>● Connected — emails send directly from the app</span>
              : "Not connected — click Connect to authorise once"}
          </div>
        </div>
        {isConnected
          ? <Btn variant="secondary" onClick={disconnect} style={{ fontSize: 12 }}>Disconnect</Btn>
          : <Btn onClick={connect} disabled={gmailLoading} style={{ fontSize: 12 }}>{gmailLoading ? "Connecting…" : "Connect Gmail"}</Btn>}
      </div>
      {suppressPatterns.length > 0 && (
        <div style={{ borderTop: `1px solid ${colors.borderLight}`, paddingTop: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: colors.textLight, marginBottom: 6 }}>Hidden email text patterns</div>
          {suppressPatterns.map((p, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <span style={{ flex: 1, fontSize: 12, color: colors.text, background: colors.bg, borderRadius: 5, padding: "3px 8px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                "{p.slice(0, 80)}{p.length > 80 ? "…" : ""}"
              </span>
              <button onClick={() => removePattern(i)}
                style={{ background: "none", border: "none", cursor: "pointer", color: colors.danger, fontSize: 14, lineHeight: 1, padding: "0 2px", flexShrink: 0 }}>×</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
