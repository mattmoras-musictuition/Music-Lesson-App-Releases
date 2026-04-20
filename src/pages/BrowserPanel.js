// ============================================================
// BrowserPanel.js — Floating in-app browser panel
// Draggable, resizable. Powered by Electron <webview>.
// Features: bookmarks, text grab → Claude/Reminders, page scan.
// ============================================================

import React from "react";
import { useTheme } from "../context/ThemeContext";
import { uid } from "../utils/helpers";
import { anthropicFetch, getAnthropicHeaders } from "../utils/api";

const SUBTYPES = [
  { value: "student_free", label: "Student Free Day" },
  { value: "excursion",    label: "Excursion" },
  { value: "carnival",     label: "Carnival / Sports" },
  { value: "swimming",     label: "Swimming" },
  { value: "assembly",     label: "Assembly" },
  { value: "camp",         label: "Camp" },
  { value: "photos",       label: "Photo Day" },
  { value: "concert",      label: "Concert" },
  { value: "other",        label: "Other" },
];

// Inline SVG helpers — keeps toolbar icons consistent on dark chrome
const Icon = ({ d, d2, d3, w = 14, viewBox = "0 0 24 24", fill = "none", strokeWidth = 2 }) => (
  <svg width={w} height={w} viewBox={viewBox} fill={fill} stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
    {d  && <path d={d} />}
    {d2 && <path d={d2} />}
    {d3 && <path d={d3} />}
  </svg>
);

export function BrowserPanel({
  schools,
  interruptions, setInterruptions,
  setContacts,
  notify,
  onSendToClaude,
  onSendToReminders,
  onClose,
  onBadgeClear,
}) {
  const { colors } = useTheme();

  // ── Position / size (persisted) ──────────────────────────────
  const [pos, setPos] = React.useState(() => {
    try { return JSON.parse(localStorage.getItem("mt-browser-pos") || "null"); } catch { return null; }
  });
  const [size, setSize] = React.useState(() => {
    try { return JSON.parse(localStorage.getItem("mt-browser-size") || "null") || { w: 920, h: 660 }; } catch { return { w: 920, h: 660 }; }
  });
  const posRef  = React.useRef(pos);
  const sizeRef = React.useRef(size);
  React.useEffect(() => { posRef.current = pos;  if (pos)  try { localStorage.setItem("mt-browser-pos",  JSON.stringify(pos));  } catch {} }, [pos]);
  React.useEffect(() => { sizeRef.current = size; try { localStorage.setItem("mt-browser-size", JSON.stringify(size)); } catch {} }, [size]);

  // Centre on first open
  React.useEffect(() => {
    if (!pos) {
      const w = Math.min(920, Math.round(window.innerWidth  * 0.75));
      const h = Math.min(660, Math.round(window.innerHeight * 0.82));
      setPos({ x: Math.round((window.innerWidth  - w) / 2), y: Math.round((window.innerHeight - h) / 2) });
      setSize({ w, h });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── URL / nav ────────────────────────────────────────────────
  const [currentUrl, setCurrentUrl] = React.useState(() => { try { return localStorage.getItem("mt-browser-url") || ""; } catch { return ""; } });
  const [inputUrl,   setInputUrl]   = React.useState(currentUrl);
  const [canGoBack,  setCanGoBack]  = React.useState(false);
  const [canGoFwd,   setCanGoFwd]   = React.useState(false);
  const [loading,    setLoading]    = React.useState(false);
  const webviewRef = React.useRef(null);

  // ── Bookmarks ────────────────────────────────────────────────
  const [userBmks,     setUserBmks]     = React.useState(() => { try { return JSON.parse(localStorage.getItem("mt-browser-bookmarks") || "[]"); } catch { return []; } });
  const [showBmks,     setShowBmks]     = React.useState(false);
  const saveUserBmks = (bm) => { setUserBmks(bm); try { localStorage.setItem("mt-browser-bookmarks", JSON.stringify(bm)); } catch {} };
  const schoolBmks = schools.filter(s => s.newsletterUrl).map(s => ({ id: `sc-${s.id}`, label: s.name.replace(/Primary School/gi, "PS"), url: s.newsletterUrl, schoolId: s.id }));

  // ── Grab text ────────────────────────────────────────────────
  const [grabText, setGrabText] = React.useState(null);

  // ── Scan panel ───────────────────────────────────────────────
  const [scanOpen,    setScanOpen]    = React.useState(false);
  const [scanCtx,     setScanCtx]     = React.useState(null); // "interruptions" | "contacts" | "general"
  const [scanLoading, setScanLoading] = React.useState(false);
  const [scanResults, setScanResults] = React.useState(null); // { type, items?, generalText?, empty? }
  const [scanH,       setScanH]       = React.useState(300);
  const scanHRef = React.useRef(300);

  // ── Drag ─────────────────────────────────────────────────────
  const handleDragStart = React.useCallback((e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY;
    const { x: ox, y: oy } = posRef.current || { x: 0, y: 0 };
    const onMove = (ev) => setPos({ x: ox + ev.clientX - sx, y: oy + ev.clientY - sy });
    const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, []);

  // ── Resize (edges + corners) ─────────────────────────────────
  const startResize = React.useCallback((e, n, s, east, w) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const sx = e.clientX, sy = e.clientY;
    const { x: ox, y: oy } = posRef.current  || { x: 0, y: 0 };
    const { w: ow, h: oh } = sizeRef.current;
    const onMove = (ev) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      let nx = ox, ny = oy, nw = ow, nh = oh;
      if (east) nw = Math.max(520, ow + dx);
      if (w)    { nw = Math.max(520, ow - dx); nx = ox + ow - nw; }
      if (s)    nh = Math.max(400, oh + dy);
      if (n)    { nh = Math.max(400, oh - dy); ny = oy + oh - nh; }
      setPos({ x: nx, y: ny }); setSize({ w: nw, h: nh });
    };
    const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, []);

  // ── Scan panel resize handle ─────────────────────────────────
  const startScanResize = React.useCallback((e) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const sy = e.clientY, origH = scanHRef.current;
    const onMove = (ev) => {
      const newH = Math.max(140, Math.min(520, origH - (ev.clientY - sy)));
      scanHRef.current = newH; setScanH(newH);
    };
    const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, []);

  // ── Navigate ─────────────────────────────────────────────────
  const navigate = React.useCallback((rawUrl) => {
    let url = rawUrl.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;
    setCurrentUrl(url); setInputUrl(url);
    try { localStorage.setItem("mt-browser-url", url); } catch {}
    try { if (webviewRef.current) webviewRef.current.src = url; } catch {}
    setShowBmks(false);
    if (onBadgeClear) {
      try {
        const host = new URL(url).hostname;
        const match = schools.find(s => { try { return new URL(s.newsletterUrl || "").hostname === host; } catch { return false; } });
        if (match) onBadgeClear(match.id);
      } catch {}
    }
  }, [schools, onBadgeClear]);

  // ── Webview event wiring ─────────────────────────────────────
  React.useEffect(() => {
    const wv = webviewRef.current;
    if (!wv) return;
    const onNav = () => {
      try {
        const url = wv.getURL?.() || "";
        setCurrentUrl(url); setInputUrl(url);
        try { localStorage.setItem("mt-browser-url", url); } catch {}
        setCanGoBack(wv.canGoBack?.() || false);
        setCanGoFwd(wv.canGoForward?.() || false);
      } catch {}
    };
    const onStart = () => setLoading(true);
    const onStop  = () => { setLoading(false); try { setCanGoBack(wv.canGoBack?.() || false); setCanGoFwd(wv.canGoForward?.() || false); } catch {} };
    wv.addEventListener("did-navigate",        onNav);
    wv.addEventListener("did-navigate-in-page", onNav);
    wv.addEventListener("did-start-loading",    onStart);
    wv.addEventListener("did-stop-loading",     onStop);
    if (currentUrl) try { wv.src = currentUrl; } catch {}
    return () => {
      try {
        wv.removeEventListener("did-navigate",        onNav);
        wv.removeEventListener("did-navigate-in-page", onNav);
        wv.removeEventListener("did-start-loading",    onStart);
        wv.removeEventListener("did-stop-loading",     onStop);
      } catch {}
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Grab selected text ───────────────────────────────────────
  const handleGrab = async () => {
    if (!webviewRef.current) return;
    try {
      const text = await webviewRef.current.executeJavaScript("window.getSelection().toString()");
      if (text?.trim()) setGrabText(text.trim());
      else notify("No text selected — select some text in the browser first", "warning");
    } catch { notify("Could not read selection", "warning"); }
  };

  // ── Page scan ────────────────────────────────────────────────
  const handleScan = async () => {
    if (!scanCtx || !webviewRef.current) return;
    setScanLoading(true); setScanResults(null);
    try {
      const pageText = await webviewRef.current.executeJavaScript(
        "(document.body ? document.body.innerText : '').slice(0, 40000)"
      );
      if (!pageText?.trim()) { notify("Page appears empty or couldn't be read", "warning"); setScanLoading(false); return; }

      const matchedSchool = schools.find(s => {
        try { return currentUrl.includes(new URL(s.newsletterUrl || "").hostname); } catch { return false; }
      });
      const today = new Date().toLocaleDateString("en-AU");
      let prompt;

      if (scanCtx === "interruptions") {
        prompt = `You are scanning a school newsletter or events page for music lesson interruptions. Today is ${today}. School: ${matchedSchool?.name || "unknown"}.\n\nExtract upcoming events that would interrupt music lessons: excursions, carnivals, sports days, student free days, camps, assemblies, swimming programs, photo days, concerts, NAPLAN, etc. Only include FUTURE events (after ${today}).\n\nFor each event return: title (string), date (YYYY-MM-DD), endDate (YYYY-MM-DD, same as date if one day), startTime (HH:MM or ""), endTime (HH:MM or ""), affectsClasses (comma-separated year levels or "all"), subtype (student_free|excursion|carnival|swimming|concert|camp|assembly|photos|other), details (brief string or "").\n\nRespond ONLY with a JSON array. If nothing found, return [].\n\nPAGE CONTENT:\n${pageText}`;
      } else if (scanCtx === "contacts") {
        prompt = `You are scanning a school staff page or newsletter for contact information. School: ${matchedSchool?.name || "unknown"}.\n\nExtract staff names, roles, email addresses, and phone numbers.\n\nFor each person return: name (string), role (string or ""), email (string or ""), phone (string or "").\n\nRespond ONLY with a JSON array. If nothing found, return [].\n\nPAGE CONTENT:\n${pageText}`;
      } else {
        prompt = `Summarise the following school website content for a music teacher. Highlight upcoming events, important dates, contact information, or anything that could affect music lesson scheduling.\n\nPAGE CONTENT:\n${pageText}`;
      }

      const response = await anthropicFetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: getAnthropicHeaders(),
        body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 2000, messages: [{ role: "user", content: prompt }] }),
      });
      if (!response.ok) { notify("Scan failed — check your API key", "warning"); setScanLoading(false); return; }
      const data = await response.json();
      const text = data.content?.filter(c => c.type === "text").map(c => c.text).join("") || "";

      if (scanCtx === "general") {
        setScanResults({ type: "general", generalText: text });
      } else {
        try {
          const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
          if (!Array.isArray(parsed) || parsed.length === 0) {
            setScanResults({ type: scanCtx, items: [], empty: true });
          } else {
            setScanResults({ type: scanCtx, items: parsed.map(item => ({ ...item, id: uid(), schoolId: matchedSchool?.id || (schools[0]?.id || "") })) });
          }
        } catch { setScanResults({ type: "general", generalText: text }); }
      }
    } catch (e) { notify("Scan error: " + e.message, "warning"); }
    setScanLoading(false);
  };

  const updateItem = (id, field, value) => setScanResults(prev => prev ? { ...prev, items: prev.items.map(i => i.id === id ? { ...i, [field]: value } : i) } : prev);
  const removeItem = (id) => setScanResults(prev => prev ? { ...prev, items: prev.items.filter(i => i.id !== id) } : prev);

  const saveInterruptions = () => {
    const approved = scanResults?.items; if (!approved?.length) return;
    const newEntries = approved.map(item => ({ id: uid(), schoolId: item.schoolId, date: item.date, endDate: item.endDate || item.date, title: item.title, type: item.subtype || "other", affectsClasses: item.affectsClasses || "all", startTime: item.startTime || "", endTime: item.endTime || "", notes: item.details || "", source: currentUrl }));
    const existing = interruptions || [];
    const deduped = newEntries.filter(ne => !existing.some(e => e.title === ne.title && e.date === ne.date && e.schoolId === ne.schoolId));
    setInterruptions([...existing, ...deduped]);
    notify(`${deduped.length} interruption${deduped.length !== 1 ? "s" : ""} saved to Calendar`);
    setScanResults(null); setScanCtx(null);
  };

  const saveContacts = () => {
    const approved = scanResults?.items; if (!approved?.length) return;
    if (setContacts) setContacts(prev => [...prev, ...approved.map(item => ({ id: uid(), name: item.name, role: item.role || "", email: item.email || "", phone: item.phone || "", schoolId: item.schoolId, notes: "", source: currentUrl }))]);
    notify(`${approved.length} contact${approved.length !== 1 ? "s" : ""} saved`);
    setScanResults(null); setScanCtx(null);
  };

  // ── Style helpers ────────────────────────────────────────────
  // Toolbar always uses dark browser-chrome palette
  const TB = { bg: "#1E2230", border: "rgba(255,255,255,0.08)", text: "rgba(255,255,255,0.75)", muted: "rgba(255,255,255,0.4)", hover: "#2E3448", input: "#2A2F42", accent: "#C47A6A" };

  const tbBtn = (active = false) => ({
    background: active ? "rgba(255,255,255,0.12)" : "none",
    border: "none", borderRadius: 5, cursor: "pointer",
    color: active ? "#fff" : TB.text,
    display: "inline-flex", alignItems: "center", justifyContent: "center",
    padding: "0 8px", height: 28, flexShrink: 0, fontFamily: "inherit", fontSize: 12, gap: 5,
  });

  const field = { width: "100%", boxSizing: "border-box", padding: "3px 7px", border: `1px solid ${colors.border}`, borderRadius: 4, fontSize: 12, fontFamily: "inherit", color: colors.text, background: colors.cardBg, outline: "none" };

  const isElectron = !!window.electronAPI?.isElectron;
  const curPos = pos || { x: 80, y: 60 };

  // ── Render ───────────────────────────────────────────────────
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 9990, pointerEvents: "none" }}>
      <div
        style={{ position: "fixed", left: curPos.x, top: curPos.y, width: size.w, height: size.h, display: "flex", flexDirection: "column", background: colors.cardBg, borderRadius: 10, overflow: "hidden", boxShadow: "0 20px 60px rgba(0,0,0,0.4)", pointerEvents: "auto", userSelect: "none" }}>

        {/* ── Toolbar ─────────────────────────────────────────────── */}
        <div
          onMouseDown={handleDragStart}
          style={{ height: 44, display: "flex", alignItems: "center", gap: 3, padding: "0 8px", background: TB.bg, borderBottom: `1px solid ${TB.border}`, flexShrink: 0, cursor: "grab" }}>

          {/* Back */}
          <button style={{ ...tbBtn(canGoBack), opacity: canGoBack ? 1 : 0.3 }} disabled={!canGoBack}
            onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); try { webviewRef.current?.goBack?.(); } catch {} }} title="Back">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          {/* Forward */}
          <button style={{ ...tbBtn(canGoFwd), opacity: canGoFwd ? 1 : 0.3 }} disabled={!canGoFwd}
            onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); try { webviewRef.current?.goForward?.(); } catch {} }} title="Forward">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
          </button>
          {/* Reload / stop */}
          <button style={tbBtn()} onMouseDown={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); try { loading ? webviewRef.current?.stop?.() : webviewRef.current?.reload?.(); } catch {} }}
            title={loading ? "Stop" : "Reload"}>
            {loading
              ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
            }
          </button>

          {/* URL bar */}
          <input
            value={inputUrl}
            onChange={e => setInputUrl(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") { e.stopPropagation(); navigate(inputUrl); } }}
            onFocus={e => e.target.select()}
            onMouseDown={e => e.stopPropagation()}
            placeholder="Enter URL…"
            style={{ flex: 1, height: 28, background: TB.input, border: `1px solid ${TB.border}`, borderRadius: 5, color: "#fff", fontSize: 12, padding: "0 10px", outline: "none", fontFamily: "inherit", minWidth: 0 }}
          />

          {/* Bookmarks */}
          <div style={{ position: "relative" }} onMouseDown={e => e.stopPropagation()}>
            <button style={tbBtn(showBmks)} onClick={e => { e.stopPropagation(); setShowBmks(o => !o); }} title="Bookmarks">
              <svg width="13" height="13" viewBox="0 0 24 24" fill={showBmks ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>
            </button>
            {showBmks && (
              <div onClick={e => e.stopPropagation()}
                style={{ position: "absolute", top: "calc(100% + 4px)", right: 0, background: TB.bg, border: `1px solid ${TB.border}`, borderRadius: 8, minWidth: 240, zIndex: 20, boxShadow: "0 8px 24px rgba(0,0,0,0.35)", overflow: "hidden", maxHeight: 340, overflowY: "auto" }}>
                {schoolBmks.length > 0 && <>
                  <div style={{ padding: "6px 12px 3px", fontSize: 10, fontWeight: 700, color: TB.muted, textTransform: "uppercase", letterSpacing: "0.06em" }}>School Newsletters</div>
                  {schoolBmks.map(bm => (
                    <button key={bm.id} onClick={() => navigate(bm.url)}
                      style={{ width: "100%", padding: "7px 12px", background: "none", border: "none", color: TB.text, fontSize: 12, fontFamily: "inherit", textAlign: "left", cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                      onMouseEnter={e => e.currentTarget.style.background = TB.hover}
                      onMouseLeave={e => e.currentTarget.style.background = "none"}>
                      {bm.label}
                    </button>
                  ))}
                </>}
                {userBmks.length > 0 && <>
                  <div style={{ height: 1, background: TB.border, margin: "3px 0" }} />
                  <div style={{ padding: "6px 12px 3px", fontSize: 10, fontWeight: 700, color: TB.muted, textTransform: "uppercase", letterSpacing: "0.06em" }}>Saved</div>
                  {userBmks.map(bm => (
                    <div key={bm.id} style={{ display: "flex", alignItems: "center" }}
                      onMouseEnter={e => e.currentTarget.style.background = TB.hover}
                      onMouseLeave={e => e.currentTarget.style.background = "none"}>
                      <button onClick={() => navigate(bm.url)}
                        style={{ flex: 1, padding: "7px 12px", background: "none", border: "none", color: TB.text, fontSize: 12, fontFamily: "inherit", textAlign: "left", cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {bm.label || bm.url}
                      </button>
                      <button onClick={() => saveUserBmks(userBmks.filter(b => b.id !== bm.id))}
                        style={{ background: "none", border: "none", color: TB.muted, cursor: "pointer", padding: "4px 8px", flexShrink: 0, display: "flex", alignItems: "center" }} title="Remove">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                      </button>
                    </div>
                  ))}
                </>}
                <div style={{ height: 1, background: TB.border, margin: "3px 0" }} />
                <button onClick={() => { if (!currentUrl) return; const label = currentUrl.replace(/^https?:\/\//, "").split("/")[0]; saveUserBmks([...userBmks, { id: uid(), label, url: currentUrl }]); }}
                  style={{ width: "100%", padding: "7px 12px", background: "none", border: "none", color: TB.accent, fontSize: 12, fontFamily: "inherit", textAlign: "left", cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}
                  onMouseEnter={e => e.currentTarget.style.background = TB.hover}
                  onMouseLeave={e => e.currentTarget.style.background = "none"}>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                  Save current page
                </button>
              </div>
            )}
          </div>

          {/* Grab selection */}
          <button style={tbBtn()} onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); handleGrab(); }} title="Grab selected text → Claude or Reminders">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="15" x2="15" y2="15"/></svg>
            <span>Grab</span>
          </button>

          {/* Scan */}
          <button style={tbBtn(scanOpen)} onMouseDown={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); setScanOpen(o => !o); if (scanOpen) { setScanResults(null); setScanCtx(null); } }}
            title="Scan page with Claude">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <span>Scan</span>
          </button>

          <div style={{ width: 1, height: 18, background: TB.border, flexShrink: 0, margin: "0 2px" }} />

          {/* Close */}
          <button style={tbBtn()} onMouseDown={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); onClose(); }}
            title="Close browser"
            onMouseEnter={e => e.currentTarget.style.color = "#F87171"}
            onMouseLeave={e => e.currentTarget.style.color = TB.text}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        {/* ── Webview ───────────────────────────────────────────────── */}
        <div style={{ flex: 1, minHeight: 0, position: "relative", background: "#fff" }}>
          {!isElectron ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: colors.textMuted, fontSize: 13, textAlign: "center", padding: 24 }}>
              <div>
                <div style={{ fontSize: 32, marginBottom: 10 }}>🌐</div>
                <div style={{ fontWeight: 600, color: colors.text, marginBottom: 5 }}>Browser panel</div>
                <div>Only available in the desktop app.</div>
              </div>
            </div>
          ) : (
            React.createElement("webview", {
              ref: webviewRef,
              partition: "persist:browser-panel",
              style: { width: "100%", height: "100%", display: "flex" },
              allowpopups: "true",
            })
          )}

          {/* Grab text popup */}
          {grabText && (
            <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.32)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 20 }}
              onClick={() => setGrabText(null)}>
              <div onClick={e => e.stopPropagation()}
                style={{ background: colors.cardBg, borderRadius: 10, padding: 16, width: 340, boxShadow: "0 12px 32px rgba(0,0,0,0.28)", border: `1px solid ${colors.border}` }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: colors.textMuted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Selected text</div>
                <div style={{ fontSize: 12, color: colors.text, maxHeight: 120, overflowY: "auto", lineHeight: 1.5, background: colors.bg, borderRadius: 6, padding: "8px 10px", marginBottom: 12, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                  {grabText.slice(0, 800)}{grabText.length > 800 ? "…" : ""}
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => { onSendToClaude(grabText); setGrabText(null); }}
                    style={{ flex: 1, padding: "7px 0", background: colors.sidebarActive, color: "#fff", border: "none", borderRadius: 7, fontSize: 12, cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}>
                    → Claude
                  </button>
                  <button onClick={() => { onSendToReminders(grabText); setGrabText(null); }}
                    style={{ flex: 1, padding: "7px 0", background: colors.accent, color: "#fff", border: "none", borderRadius: 7, fontSize: 12, cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}>
                    → Reminders
                  </button>
                  <button onClick={() => setGrabText(null)}
                    style={{ padding: "7px 10px", background: "none", color: colors.textMuted, border: `1px solid ${colors.border}`, borderRadius: 7, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
                    ✕
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ── Scan panel ────────────────────────────────────────────── */}
        {scanOpen && (
          <>
            {/* Resize handle */}
            <div onMouseDown={startScanResize} style={{ height: 5, cursor: "ns-resize", background: colors.border, flexShrink: 0 }} />
            <div style={{ height: scanH, display: "flex", flexDirection: "column", background: colors.cardBg, borderTop: `1px solid ${colors.border}`, overflow: "hidden", flexShrink: 0 }}>

              {/* Header row */}
              <div style={{ display: "flex", alignItems: "center", padding: "8px 12px", borderBottom: `1px solid ${colors.border}`, gap: 6, flexShrink: 0 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: colors.text, marginRight: 4 }}>Scan</span>
                {[{ id: "interruptions", label: "Interruptions" }, { id: "contacts", label: "Contacts" }, { id: "general", label: "General" }].map(ctx => (
                  <button key={ctx.id} onClick={() => { setScanCtx(ctx.id); setScanResults(null); }}
                    style={{ padding: "3px 10px", borderRadius: 5, border: `1px solid ${scanCtx === ctx.id ? colors.sidebarActive : colors.border}`, background: scanCtx === ctx.id ? colors.sidebarActive : "none", color: scanCtx === ctx.id ? "#fff" : colors.textLight, fontSize: 11, cursor: "pointer", fontFamily: "inherit", fontWeight: scanCtx === ctx.id ? 600 : 400 }}>
                    {ctx.label}
                  </button>
                ))}
                <button onClick={handleScan} disabled={!scanCtx || scanLoading}
                  style={{ marginLeft: "auto", padding: "4px 14px", background: !scanCtx || scanLoading ? colors.border : colors.sidebarActive, color: !scanCtx || scanLoading ? colors.textMuted : "#fff", border: "none", borderRadius: 6, fontSize: 12, cursor: !scanCtx || scanLoading ? "default" : "pointer", fontFamily: "inherit", fontWeight: 600, display: "flex", alignItems: "center", gap: 5 }}>
                  {scanLoading ? <><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" style={{ animation: "spin 1s linear infinite" }}><path d="M21 12a9 9 0 1 1-6.22-8.56"/></svg>Scanning…</> : "Scan"}
                </button>
                <button onClick={() => { setScanOpen(false); setScanResults(null); setScanCtx(null); }}
                  style={{ background: "none", border: "none", cursor: "pointer", color: colors.textMuted, display: "flex", alignItems: "center", padding: 2 }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              </div>

              {/* Results body */}
              <div style={{ flex: 1, overflowY: "auto", padding: "10px 12px" }}>
                {!scanCtx && !scanLoading && (
                  <div style={{ color: colors.textMuted, fontSize: 12, textAlign: "center", padding: "20px 0" }}>Choose a scan type above, then click Scan.</div>
                )}
                {scanLoading && (
                  <div style={{ color: colors.textMuted, fontSize: 12, textAlign: "center", padding: "20px 0", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" style={{ animation: "spin 1s linear infinite" }}><path d="M21 12a9 9 0 1 1-6.22-8.56"/></svg>
                    Reading page and scanning with Claude…
                  </div>
                )}
                {scanResults && !scanLoading && (
                  <>
                    {scanResults.type === "general" && (
                      <div style={{ fontSize: 12, color: colors.text, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{scanResults.generalText}</div>
                    )}
                    {(scanResults.type === "interruptions" || scanResults.type === "contacts") && (
                      scanResults.empty || !scanResults.items?.length ? (
                        <div style={{ color: colors.textMuted, fontSize: 12, textAlign: "center", padding: "16px 0" }}>
                          No {scanResults.type === "interruptions" ? "upcoming interruptions" : "contacts"} found on this page.
                        </div>
                      ) : (
                        <>
                          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                            {scanResults.items.map(item => (
                              <div key={item.id} style={{ background: colors.bg, borderRadius: 8, padding: "10px 12px", border: `1px solid ${colors.border}`, position: "relative" }}>
                                <button onClick={() => removeItem(item.id)} title="Discard"
                                  style={{ position: "absolute", top: 6, right: 6, background: "none", border: "none", cursor: "pointer", color: colors.textMuted, display: "flex", alignItems: "center", padding: 2 }}
                                  onMouseEnter={e => e.currentTarget.style.color = colors.danger}
                                  onMouseLeave={e => e.currentTarget.style.color = colors.textMuted}>
                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                                </button>
                                {scanResults.type === "interruptions" ? (
                                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 10px", paddingRight: 20 }}>
                                    <div style={{ gridColumn: "1/-1" }}>
                                      <div style={{ fontSize: 10, color: colors.textMuted, fontWeight: 700, marginBottom: 2 }}>TITLE</div>
                                      <input value={item.title || ""} onChange={e => updateItem(item.id, "title", e.target.value)} style={field} />
                                    </div>
                                    <div><div style={{ fontSize: 10, color: colors.textMuted, fontWeight: 700, marginBottom: 2 }}>DATE</div><input type="date" value={item.date || ""} onChange={e => updateItem(item.id, "date", e.target.value)} style={field} /></div>
                                    <div><div style={{ fontSize: 10, color: colors.textMuted, fontWeight: 700, marginBottom: 2 }}>END DATE</div><input type="date" value={item.endDate || ""} onChange={e => updateItem(item.id, "endDate", e.target.value)} style={field} /></div>
                                    <div><div style={{ fontSize: 10, color: colors.textMuted, fontWeight: 700, marginBottom: 2 }}>START TIME</div><input type="time" value={item.startTime || ""} onChange={e => updateItem(item.id, "startTime", e.target.value)} style={field} /></div>
                                    <div><div style={{ fontSize: 10, color: colors.textMuted, fontWeight: 700, marginBottom: 2 }}>END TIME</div><input type="time" value={item.endTime || ""} onChange={e => updateItem(item.id, "endTime", e.target.value)} style={field} /></div>
                                    <div><div style={{ fontSize: 10, color: colors.textMuted, fontWeight: 700, marginBottom: 2 }}>AFFECTS</div><input value={item.affectsClasses || "all"} onChange={e => updateItem(item.id, "affectsClasses", e.target.value)} placeholder="all" style={field} /></div>
                                    <div>
                                      <div style={{ fontSize: 10, color: colors.textMuted, fontWeight: 700, marginBottom: 2 }}>SCHOOL</div>
                                      <select value={item.schoolId || ""} onChange={e => updateItem(item.id, "schoolId", e.target.value)} style={field}>
                                        {schools.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                                      </select>
                                    </div>
                                    <div>
                                      <div style={{ fontSize: 10, color: colors.textMuted, fontWeight: 700, marginBottom: 2 }}>TYPE</div>
                                      <select value={item.subtype || "other"} onChange={e => updateItem(item.id, "subtype", e.target.value)} style={field}>
                                        {SUBTYPES.map(st => <option key={st.value} value={st.value}>{st.label}</option>)}
                                      </select>
                                    </div>
                                  </div>
                                ) : (
                                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 10px", paddingRight: 20 }}>
                                    <div><div style={{ fontSize: 10, color: colors.textMuted, fontWeight: 700, marginBottom: 2 }}>NAME</div><input value={item.name || ""} onChange={e => updateItem(item.id, "name", e.target.value)} style={field} /></div>
                                    <div><div style={{ fontSize: 10, color: colors.textMuted, fontWeight: 700, marginBottom: 2 }}>ROLE</div><input value={item.role || ""} onChange={e => updateItem(item.id, "role", e.target.value)} style={field} /></div>
                                    <div><div style={{ fontSize: 10, color: colors.textMuted, fontWeight: 700, marginBottom: 2 }}>EMAIL</div><input value={item.email || ""} onChange={e => updateItem(item.id, "email", e.target.value)} style={field} /></div>
                                    <div><div style={{ fontSize: 10, color: colors.textMuted, fontWeight: 700, marginBottom: 2 }}>PHONE</div><input value={item.phone || ""} onChange={e => updateItem(item.id, "phone", e.target.value)} style={field} /></div>
                                    <div style={{ gridColumn: "1/-1" }}>
                                      <div style={{ fontSize: 10, color: colors.textMuted, fontWeight: 700, marginBottom: 2 }}>SCHOOL</div>
                                      <select value={item.schoolId || ""} onChange={e => updateItem(item.id, "schoolId", e.target.value)} style={field}>
                                        {schools.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                                      </select>
                                    </div>
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                          <div style={{ marginTop: 10, display: "flex", justifyContent: "flex-end", gap: 8 }}>
                            <button onClick={() => { setScanResults(null); setScanCtx(null); }}
                              style={{ padding: "5px 14px", background: "none", border: `1px solid ${colors.border}`, borderRadius: 6, fontSize: 12, cursor: "pointer", color: colors.textMuted, fontFamily: "inherit" }}>
                              Clear
                            </button>
                            <button onClick={scanResults.type === "interruptions" ? saveInterruptions : saveContacts}
                              style={{ padding: "5px 16px", background: colors.sidebarActive, color: "#fff", border: "none", borderRadius: 6, fontSize: 12, cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}>
                              Save {scanResults.items.length} to {scanResults.type === "interruptions" ? "Calendar" : "Contacts"}
                            </button>
                          </div>
                        </>
                      )
                    )}
                  </>
                )}
              </div>
            </div>
          </>
        )}

        {/* ── Resize handles (edges + corners) ─────────────────────── */}
        <div onMouseDown={e => startResize(e, false, false, true,  false)} style={{ position:"absolute", top:8, right:0, bottom:8, width:5, cursor:"ew-resize", zIndex:11 }} />
        <div onMouseDown={e => startResize(e, false, false, false, true)}  style={{ position:"absolute", top:8, left:0, bottom:8, width:5, cursor:"ew-resize", zIndex:11 }} />
        <div onMouseDown={e => startResize(e, false, true, false, false)}  style={{ position:"absolute", bottom:0, left:8, right:8, height:5, cursor:"ns-resize", zIndex:11 }} />
        <div onMouseDown={e => startResize(e, true, false, false, false)}  style={{ position:"absolute", top:0, left:8, right:8, height:5, cursor:"ns-resize", zIndex:11 }} />
        <div onMouseDown={e => startResize(e, false, true, true, false)}   style={{ position:"absolute", bottom:0, right:0, width:10, height:10, cursor:"nwse-resize", zIndex:12 }} />
        <div onMouseDown={e => startResize(e, false, true, false, true)}   style={{ position:"absolute", bottom:0, left:0, width:10, height:10, cursor:"nesw-resize", zIndex:12 }} />
        <div onMouseDown={e => startResize(e, true, false, true, false)}   style={{ position:"absolute", top:0, right:0, width:10, height:10, cursor:"nesw-resize", zIndex:12 }} />
        <div onMouseDown={e => startResize(e, true, false, false, true)}   style={{ position:"absolute", top:0, left:0, width:10, height:10, cursor:"nwse-resize", zIndex:12 }} />
      </div>
    </div>
  );
}
