// ============================================================
// LinkBrowser.js — Shared lightweight browser panel
// Draggable, resizable. Electron <webview> for viewing URLs.
// Features: back/forward/reload, URL bar, print, open external.
// Used by both admin and teacher apps for viewing band links.
// ============================================================

import React from "react";
import { useTheme } from "../context/ThemeContext";

// Toolbar always uses dark chrome palette
const TB = { bg: "#1E2230", border: "rgba(255,255,255,0.08)", text: "rgba(255,255,255,0.75)", muted: "rgba(255,255,255,0.4)", hover: "#2E3448", input: "#2A2F42" };

const tbBtn = (active = false) => ({
  background: active ? "rgba(255,255,255,0.12)" : "none",
  border: "none", borderRadius: 5, cursor: "pointer",
  color: active ? "#fff" : TB.text,
  display: "inline-flex", alignItems: "center", justifyContent: "center",
  padding: "0 8px", height: 28, flexShrink: 0, fontFamily: "inherit", fontSize: 12, gap: 5,
});

export function LinkBrowser({ initialUrl, title, onClose }) {
  const { colors } = useTheme();

  // ── Position / size ────────────────────────────────────────
  const [pos, setPos] = React.useState(() => ({
    x: Math.max(0, Math.round((window.innerWidth - 820) / 2)),
    y: Math.max(0, Math.round((window.innerHeight - 580) / 2)),
  }));
  const [size, setSize] = React.useState({ w: 820, h: 580 });
  const posRef = React.useRef(pos);
  const sizeRef = React.useRef(size);
  React.useEffect(() => { posRef.current = pos; }, [pos]);
  React.useEffect(() => { sizeRef.current = size; }, [size]);

  // ── URL / nav ─────────────────────────────────────────────
  const [currentUrl, setCurrentUrl] = React.useState(initialUrl || "");
  const [inputUrl, setInputUrl] = React.useState(initialUrl || "");
  const [canGoBack, setCanGoBack] = React.useState(false);
  const [canGoFwd, setCanGoFwd] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const webviewRef = React.useRef(null);

  const navigate = React.useCallback((rawUrl) => {
    let url = rawUrl.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;
    setCurrentUrl(url); setInputUrl(url);
    try { if (webviewRef.current) webviewRef.current.src = url; } catch {}
  }, []);

  // ── Webview wiring ────────────────────────────────────────
  React.useEffect(() => {
    const wv = webviewRef.current;
    if (!wv) return;
    const onNav = () => {
      try {
        const url = wv.getURL?.() || "";
        setCurrentUrl(url); setInputUrl(url);
        setCanGoBack(wv.canGoBack?.() || false);
        setCanGoFwd(wv.canGoForward?.() || false);
      } catch {}
    };
    const onStart = () => setLoading(true);
    const onStop = () => { setLoading(false); try { setCanGoBack(wv.canGoBack?.() || false); setCanGoFwd(wv.canGoForward?.() || false); } catch {} };
    wv.addEventListener("did-navigate", onNav);
    wv.addEventListener("did-navigate-in-page", onNav);
    wv.addEventListener("did-start-loading", onStart);
    wv.addEventListener("did-stop-loading", onStop);
    if (initialUrl) try { wv.src = initialUrl; } catch {}
    return () => {
      try {
        wv.removeEventListener("did-navigate", onNav);
        wv.removeEventListener("did-navigate-in-page", onNav);
        wv.removeEventListener("did-start-loading", onStart);
        wv.removeEventListener("did-stop-loading", onStop);
      } catch {}
    };
  }, []); // eslint-disable-line

  // ── Drag ──────────────────────────────────────────────────
  const handleDragStart = React.useCallback((e) => {
    if (e.button !== 0 || e.target.tagName === "INPUT") return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY;
    const { x: ox, y: oy } = posRef.current;
    const onMove = (ev) => setPos({ x: ox + ev.clientX - sx, y: oy + ev.clientY - sy });
    const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, []);

  // ── Resize ────────────────────────────────────────────────
  const startResize = React.useCallback((e, n, s, east, w) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const sx = e.clientX, sy = e.clientY;
    const { x: ox, y: oy } = posRef.current;
    const { w: ow, h: oh } = sizeRef.current;
    const onMove = (ev) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      let nx = ox, ny = oy, nw = ow, nh = oh;
      if (east) nw = Math.max(480, ow + dx);
      if (w) { nw = Math.max(480, ow - dx); nx = ox + ow - nw; }
      if (s) nh = Math.max(340, oh + dy);
      if (n) { nh = Math.max(340, oh - dy); ny = oy + oh - nh; }
      setPos({ x: nx, y: ny }); setSize({ w: nw, h: nh });
    };
    const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, []);

  // ── Print ─────────────────────────────────────────────────
  const handlePrint = () => {
    try { webviewRef.current?.print?.(); } catch {}
  };

  const isElectron = !!window.electronAPI?.isElectron;

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 9990, pointerEvents: "none" }}>
      <div style={{ position: "fixed", left: pos.x, top: pos.y, width: size.w, height: size.h, display: "flex", flexDirection: "column", background: colors.cardBg, borderRadius: 10, overflow: "hidden", boxShadow: "0 20px 60px rgba(0,0,0,0.4)", pointerEvents: "auto", userSelect: "none" }}>

        {/* Toolbar */}
        <div onMouseDown={handleDragStart}
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

          {/* Title badge */}
          {title && (
            <span style={{ fontSize: 11, color: TB.muted, padding: "0 6px", maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flexShrink: 0 }}>
              {title}
            </span>
          )}

          {/* Print */}
          <button style={tbBtn()} onMouseDown={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); handlePrint(); }} title="Print">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
            <span>Print</span>
          </button>

          {/* Open external */}
          <button style={tbBtn()} onMouseDown={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); if (currentUrl) window.electronAPI?.openExternal?.(currentUrl) || window.open(currentUrl, "_blank"); }}
            title="Open in default browser">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
          </button>

          <div style={{ width: 1, height: 18, background: TB.border, flexShrink: 0, margin: "0 2px" }} />

          {/* Close */}
          <button style={tbBtn()} onMouseDown={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); onClose(); }} title="Close"
            onMouseEnter={e => e.currentTarget.style.color = "#F87171"}
            onMouseLeave={e => e.currentTarget.style.color = TB.text}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        {/* Webview */}
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
              partition: "persist:link-browser",
              style: { width: "100%", height: "100%", display: "flex" },
              allowpopups: "true",
            })
          )}
        </div>

        {/* Resize handles */}
        <div onMouseDown={e => startResize(e, false, false, true, false)} style={{ position: "absolute", top: 8, right: 0, bottom: 8, width: 5, cursor: "ew-resize", zIndex: 11 }} />
        <div onMouseDown={e => startResize(e, false, false, false, true)} style={{ position: "absolute", top: 8, left: 0, bottom: 8, width: 5, cursor: "ew-resize", zIndex: 11 }} />
        <div onMouseDown={e => startResize(e, false, true, false, false)} style={{ position: "absolute", bottom: 0, left: 8, right: 8, height: 5, cursor: "ns-resize", zIndex: 11 }} />
        <div onMouseDown={e => startResize(e, true, false, false, false)} style={{ position: "absolute", top: 0, left: 8, right: 8, height: 5, cursor: "ns-resize", zIndex: 11 }} />
        <div onMouseDown={e => startResize(e, false, true, true, false)} style={{ position: "absolute", bottom: 0, right: 0, width: 10, height: 10, cursor: "nwse-resize", zIndex: 12 }} />
        <div onMouseDown={e => startResize(e, false, true, false, true)} style={{ position: "absolute", bottom: 0, left: 0, width: 10, height: 10, cursor: "nesw-resize", zIndex: 12 }} />
        <div onMouseDown={e => startResize(e, true, false, true, false)} style={{ position: "absolute", top: 0, right: 0, width: 10, height: 10, cursor: "nesw-resize", zIndex: 12 }} />
        <div onMouseDown={e => startResize(e, true, false, false, true)} style={{ position: "absolute", top: 0, left: 0, width: 10, height: 10, cursor: "nwse-resize", zIndex: 12 }} />
      </div>
    </div>
  );
}
