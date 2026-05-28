// ============================================================
// filePreview.js — shared file hover-preview helpers
//
// The image / PDF-first-page thumbnail-on-hover used by Student
// Notes attachments and the Documents & Resources library list,
// plus a simple link card for link-type resources. The pure
// pdfjs/classification primitives now live in utils/filePreviewCore
// (shared with the detail-panel ResourcePreview); re-exported here so
// existing consumers keep importing them from this module.
// ============================================================

import React, { useState, useRef, useEffect, useLayoutEffect, useCallback } from "react";
import { useTheme } from "../context/ThemeContext";
import { renderPdfFirstPage, fileKind } from "../utils/filePreviewCore";

export { renderPdfFirstPage, fileKind } from "../utils/filePreviewCore";

// Presentational hover popover. Renders the image (if loaded), then any
// extra children (e.g. a link card), and "Preview unavailable" only when
// nothing else would show and a load error occurred. Clamps itself fully
// inside the viewport, flipping/shifting from the anchor `box` as needed.
export function PreviewPopover({ box, imgSrc, err, children, width = 380 }) {
  const { colors, darkMode } = useTheme();
  const ref = useRef(null);
  const [pos, setPos] = useState({ top: box.top, left: box.left });
  const [tick, setTick] = useState(0); // bumped on image load so we re-clamp at full height
  const hasImg = !!(imgSrc && !err);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const M = 8;
    const w = el.offsetWidth, h = el.offsetHeight;
    let left = box.left;
    let top = box.top;
    if (left + w > window.innerWidth - M) left = window.innerWidth - M - w;
    if (left < M) left = M;
    if (top + h > window.innerHeight - M) top = window.innerHeight - M - h;
    if (top < M) top = M;
    setPos({ top, left });
  }, [box.top, box.left, hasImg, children, tick]);

  if (!hasImg && !children && !err) return null;
  return (
    <div ref={ref} style={{
      position: "fixed", top: pos.top, left: pos.left, zIndex: 1000,
      width: width - 20, padding: 10, borderRadius: 10,
      background: darkMode ? "#1f2430" : "#fff",
      border: `1px solid ${colors.border}`,
      boxShadow: "0 6px 24px rgba(0,0,0,0.18)", pointerEvents: "none",
    }}>
      {hasImg && <img src={imgSrc} alt="" onLoad={() => setTick(t => t + 1)} style={{ maxWidth: "100%", maxHeight: 360, borderRadius: 6, display: "block" }} />}
      {children}
      {!hasImg && !children && err && <div style={{ fontSize: 12, color: colors.textMuted }}>Preview unavailable</div>}
    </div>
  );
}

// Hover-preview hook. Shows an image / PDF first-page thumbnail for a
// previewable file at `url`, and/or a static `card` node (e.g. a link
// card). Inert (no popover) when disabled or when there's neither a
// previewable file nor a card. Attach `ref` + `onMouseEnter`/
// `onMouseLeave` to the trigger element and render `popover`.
export function useFileThumbnailHover({ url, name, mime, card = null, enabled = true, width = 380 }) {
  const ref = useRef(null);
  const timer = useRef(null);
  const loaded = useRef(false);
  const [show, setShow] = useState(false);
  const [box, setBox] = useState({ top: 0, left: 0 });
  const [imgSrc, setImgSrc] = useState(null);
  const [err, setErr] = useState(false);

  const kind = fileKind({ mime, name, url });
  const isThumb = !!(url && (kind === "image" || kind === "pdf"));
  const active = !!(enabled && (isThumb || card));

  // Reset the cached render if the target changes.
  useEffect(() => { loaded.current = false; setImgSrc(null); setErr(false); }, [url]);

  const doLoad = useCallback(async () => {
    if (loaded.current || !isThumb) return;
    loaded.current = true;
    try {
      if (kind === "image") setImgSrc(url);
      else if (kind === "pdf") setImgSrc(await renderPdfFirstPage(url));
    } catch (e) {
      console.error("File preview failed:", e);
      setErr(true);
    }
  }, [isThumb, kind, url]);

  const onMouseEnter = useCallback(() => {
    if (!active) return;
    timer.current = setTimeout(() => {
      const r = ref.current?.getBoundingClientRect();
      if (r) {
        const toRight = r.right + width + 12 < window.innerWidth;
        setBox(toRight ? { top: r.top, left: r.right + 8 } : { top: r.bottom + 6, left: Math.max(8, r.right - width) });
      }
      setShow(true);
      doLoad();
    }, 200);
  }, [active, width, doLoad]);

  const onMouseLeave = useCallback(() => { clearTimeout(timer.current); setShow(false); }, []);
  useEffect(() => () => clearTimeout(timer.current), []);

  const popover = (active && show) ? <PreviewPopover box={box} imgSrc={imgSrc} err={err} width={width}>{card}</PreviewPopover> : null;

  return { ref, onMouseEnter, onMouseLeave, popover, active };
}
