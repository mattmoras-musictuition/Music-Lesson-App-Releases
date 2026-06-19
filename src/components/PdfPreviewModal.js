// ============================================================
// PdfPreviewModal — full-document PDF preview popup for the admin app.
//
// The admin app has NO react-pdf and Electron's built-in PDFium viewer is
// plugin-gated/disabled, so <iframe src="data:application/pdf"> can't render.
// Instead we render with pdf.js directly, REUSING filePreviewCore's existing
// lazy pdfjs loader + self-hosted worker (the same one the hover thumbnails
// already use in the packaged build). No new dependency, no new worker config.
//
// UX mirrors the teacher app's PdfPreviewModal: a 90vw/90vh dark popup that
// renders every page, scrollable, width-responsive, closes on Esc or backdrop.
// ============================================================

import React, { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { loadPdfjs } from "../utils/filePreviewCore";

// Decode a BARE base64 string (no data: prefix) into bytes. pdf.js getDocument
// accepts raw bytes via { data }. Note: getDocument may detach the buffer it's
// given, so callers decode a FRESH array for each getDocument call.
function base64ToBytes(b64) {
  const bin = atob(b64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Props: base64 (bare base64 string, or null/empty → renders nothing) + onClose.
export default function PdfPreviewModal({ base64, onClose }) {
  const contentRef = useRef(null);   // scroll container; also the width-measure target
  const canvasRefs = useRef([]);     // one <canvas> per page, by index
  const pdfRef = useRef(null);       // the loaded pdf.js document, held for the render pass
  const [numPages, setNumPages] = useState(0);
  const [pageWidth, setPageWidth] = useState(800);
  const [status, setStatus] = useState("loading"); // "loading" | "ready" | "error"

  // Esc closes. Capture phase so an ancestor that calls stopPropagation on
  // keydown (the compose window does) can't swallow it before we see it.
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // Width-responsive: fit pages to the available content width (cap at 900).
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const measure = () => setPageWidth(Math.min(900, Math.max(120, el.clientWidth - 48)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [base64]);

  // Load the document once per base64. Held in a ref for the render pass below.
  useEffect(() => {
    if (!base64) return;
    let cancelled = false;
    let pdf = null;
    setStatus("loading");
    setNumPages(0);
    canvasRefs.current = [];
    (async () => {
      try {
        const pdfjs = await loadPdfjs();
        pdf = await pdfjs.getDocument({ data: base64ToBytes(base64) }).promise;
        if (cancelled) { try { pdf.destroy(); } catch { /* ignore */ } return; }
        pdfRef.current = pdf;
        setNumPages(pdf.numPages);
        setStatus("ready");
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
      pdfRef.current = null;
      if (pdf) { try { pdf.destroy(); } catch { /* ignore */ } }
    };
  }, [base64]);

  // Render every page into its canvas. Re-runs when the doc loads (numPages) or
  // the width changes. Cancels in-flight render tasks on cleanup so a width
  // change can't collide with a pending render on the same canvas.
  useEffect(() => {
    const pdf = pdfRef.current;
    if (!pdf || !numPages) return;
    let cancelled = false;
    const tasks = [];
    (async () => {
      for (let i = 0; i < numPages; i++) {
        if (cancelled) return;
        const canvas = canvasRefs.current[i];
        if (!canvas) continue;
        let page;
        try { page = await pdf.getPage(i + 1); } catch { return; }
        if (cancelled) return;
        const baseVp = page.getViewport({ scale: 1 });
        const scale = (pageWidth || 800) / baseVp.width;
        const viewport = page.getViewport({ scale });
        const dpr = window.devicePixelRatio || 1;
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        const ctx = canvas.getContext("2d");
        const task = page.render({
          canvasContext: ctx,
          viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        });
        tasks.push(task);
        try { await task.promise; } catch { /* cancelled / superseded render */ }
      }
    })();
    return () => { cancelled = true; tasks.forEach(t => { try { t.cancel(); } catch { /* ignore */ } }); };
  }, [numPages, pageWidth]);

  if (!base64) return null;

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 10200,
        background: "rgba(0,0,0,0.6)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "relative", width: "90vw", height: "90vh",
          background: "#525659", borderRadius: 12,
          boxShadow: "0 20px 60px rgba(0,0,0,0.45)",
          overflow: "hidden", display: "flex", flexDirection: "column",
        }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          style={{
            position: "absolute", top: 10, right: 10, zIndex: 2,
            width: 32, height: 32, borderRadius: 999, border: "none",
            cursor: "pointer", background: "rgba(0,0,0,0.55)", color: "#fff",
            display: "inline-flex", alignItems: "center", justifyContent: "center",
          }}
        >
          <X size={18} />
        </button>

        <div
          ref={contentRef}
          style={{
            flex: 1, overflow: "auto", padding: 24,
            display: "flex", flexDirection: "column", alignItems: "center", gap: 16,
          }}
        >
          {status === "loading" && <div style={{ color: "#fff", padding: 40 }}>Loading PDF…</div>}
          {status === "error" && <div style={{ color: "#fff", padding: 40 }}>Couldn't display the PDF.</div>}
          {status === "ready" && Array.from({ length: numPages }, (_, i) => (
            <canvas
              key={i}
              ref={(el) => { canvasRefs.current[i] = el; }}
              style={{ maxWidth: "100%", borderRadius: 4, boxShadow: "0 2px 12px rgba(0,0,0,0.35)" }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
