// ============================================================
// ResourcePreview.js — detail-panel content preview for the
// Documents & Resources library. Renders, in a fixed-height area
// that never shifts between states, the best available preview for
// a resource/document via a layered fallback chain:
//
//   1. image file            → <img>
//   2. pdf file              → first page rendered to a canvas
//   3. youtube link          → hqdefault thumbnail
//   4. other link            → rich Open Graph card (hero + text)
//   5. other link (no hero)  → lightweight favicon + hostname card
//   6. anything else / fail  → the caller's type icon
//
// The image/PDF/YouTube sources are resolved here; web-link metadata
// comes from the main-process Open Graph fetch via useOpenGraph.
// ============================================================

import React, { useState, useEffect } from "react";
import { Loader } from "lucide-react";
import { useTheme } from "../context/ThemeContext";
import { fileKind, renderPdfFirstPage, youtubeId, youtubeThumb } from "../utils/filePreviewCore";
import { signedUrlFor } from "../utils/storageHelpers";
import useOpenGraph from "../hooks/useOpenGraph";

function hostnameOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return null; }
}

export default function ResourcePreview({
  fileUrl,            // public, directly-renderable file URL (resources)
  storagePath,        // private storage path (documents) — signed on demand
  linkUrl,            // external link (resource/document URL)
  fileName,           // for extension-based classification
  mime,               // mime type when known (documents)
  title,              // alt text / accessibility
  fallbackIcon: FallbackIcon,
  height = 140,
  surfaceBg,          // optional preview-area background; defaults to page bg
}) {
  const { colors, darkMode } = useTheme();

  const kind = fileKind({ mime, name: fileName, url: fileUrl || storagePath || linkUrl });
  const isFile = kind === "image" || kind === "pdf";
  const ytId = !isFile && linkUrl ? youtubeId(linkUrl) : null;
  const isOtherLink = !!linkUrl && !isFile && !ytId;

  // File / YouTube branch — resolves to an <img> source (or icon on failure).
  // null = still resolving; { type: 'image', src } | { type: 'icon' } once done.
  const [fileState, setFileState] = useState(null);
  // Open Graph branch (only meaningful for plain web links).
  const { data: og, loading: ogLoading } = useOpenGraph(linkUrl, isOtherLink);
  const [heroError, setHeroError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFileState(null);
    setHeroError(false);

    async function resolve() {
      try {
        if (isFile) {
          let src = fileUrl || (linkUrl && !storagePath ? linkUrl : null);
          if (!src && storagePath) src = await signedUrlFor(storagePath);
          if (!src) { if (!cancelled) setFileState({ type: "icon" }); return; }
          if (kind === "image") {
            if (!cancelled) setFileState({ type: "image", src });
          } else {
            const dataUrl = await renderPdfFirstPage(src);
            if (!cancelled) setFileState({ type: "image", src: dataUrl });
          }
          return;
        }
        if (ytId) {
          if (!cancelled) setFileState({ type: "image", src: youtubeThumb(ytId) });
          return;
        }
        // Plain web links are handled by the Open Graph branch below.
        if (!cancelled) setFileState({ type: "icon" });
      } catch {
        if (!cancelled) setFileState({ type: "icon" });
      }
    }
    resolve();
    return () => { cancelled = true; };
  }, [isFile, kind, ytId, fileUrl, storagePath, linkUrl]);

  // Media frame — backs image/PDF/YouTube/icon previews. surfaceBg lets the
  // caller use a dark surface so covers/artwork pop (Documents passes nothing,
  // so it stays on the page background).
  const frame = {
    height,
    background: surfaceBg || colors.bg,
    borderBottom: `1px solid ${colors.borderLight}`,
    overflow: "hidden",
  };
  const centered = { ...frame, display: "flex", alignItems: "center", justifyContent: "center" };
  // Link (Open Graph) cards keep the page surface regardless of surfaceBg so
  // their dark text stays legible — a dark media backing would wash them out.
  const linkFrame = { ...frame, background: colors.bg };
  const linkCentered = { ...linkFrame, display: "flex", alignItems: "center", justifyContent: "center" };

  const iconNode = FallbackIcon
    ? <FallbackIcon size={48} style={{ color: colors.textMuted, opacity: 0.7 }} />
    : null;
  const iconFrame = <div style={centered}>{iconNode}</div>;

  // ── File / YouTube image branch ───────────────────────────────
  if (isFile || ytId) {
    // Loading — a spinner on the held-height surface so a slow render (e.g. a
    // large PDF's first page) reads as "working", not frozen. Self-contained
    // keyframe so it spins wherever ResourcePreview is used (admin + teacher).
    if (fileState === null) return (
      <div style={centered}>
        <style>{"@keyframes rp-spin{to{transform:rotate(360deg)}}"}</style>
        <Loader size={22} style={{ color: colors.textMuted, opacity: 0.8, animation: "rp-spin 0.8s linear infinite" }} />
      </div>
    );
    if (fileState.type === "image") {
      return (
        <div style={centered}>
          <img
            src={fileState.src}
            alt={title || ""}
            onError={() => setFileState({ type: "icon" })}
            style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", display: "block" }}
          />
        </div>
      );
    }
    return iconFrame;
  }

  // ── Web-link branch (Open Graph) ──────────────────────────────
  if (isOtherLink) {
    const host = og?.hostname || hostnameOf(linkUrl);
    if (!host) return iconFrame; // unparseable URL → final icon fallback

    if (ogLoading) {
      // Skeleton mirrors the rich-card shape so loaded state doesn't shift.
      const bar = (w) => <div style={{ height: 9, width: w, borderRadius: 4, background: darkMode ? "#333a48" : "#e4e7ec" }} />;
      return (
        <div style={{ ...linkFrame, display: "flex" }}>
          <div style={{ width: height, height: "100%", flexShrink: 0, background: darkMode ? "#2a3140" : "#eef0f3" }} />
          <div style={{ flex: 1, minWidth: 0, padding: "12px 14px", display: "flex", flexDirection: "column", justifyContent: "center", gap: 9 }}>
            {bar("80%")}{bar("60%")}{bar("40%")}
          </div>
        </div>
      );
    }

    // Rich card when we have a hero image that actually loads.
    if (og?.image && !heroError) {
      return (
        <div style={{ ...linkFrame, display: "flex" }}>
          <img
            src={og.image}
            alt=""
            onError={() => setHeroError(true)}
            style={{ width: height, height: "100%", objectFit: "cover", flexShrink: 0, display: "block" }}
          />
          <div style={{ flex: 1, minWidth: 0, padding: "10px 14px", display: "flex", flexDirection: "column", justifyContent: "center", gap: 4 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: colors.text, lineHeight: 1.25, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
              {og.title || host}
            </div>
            {og.description && (
              <div style={{ fontSize: 12, color: colors.textMuted, lineHeight: 1.3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {og.description}
              </div>
            )}
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: colors.textMuted, minWidth: 0 }}>
              {og.favicon && <img src={og.favicon} alt="" style={{ width: 14, height: 14, borderRadius: 3, flexShrink: 0 }} onError={(e) => { e.target.style.display = "none"; }} />}
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{host}</span>
            </div>
          </div>
        </div>
      );
    }

    // Lightweight fallback card — favicon + hostname + subtitle.
    const favicon = og?.favicon || `https://www.google.com/s2/favicons?domain=${host}&sz=64`;
    return (
      <div style={{ ...linkCentered, flexDirection: "column", gap: 8, padding: "0 16px", textAlign: "center" }}>
        <img
          src={favicon}
          alt=""
          onError={(e) => { e.target.style.visibility = "hidden"; }}
          style={{ width: 32, height: 32, borderRadius: 6 }}
        />
        <div style={{ fontSize: 13, fontWeight: 600, color: colors.text, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{host}</div>
        <div style={{ fontSize: 11, color: colors.textMuted }}>External link</div>
      </div>
    );
  }

  // ── Final fallback — type icon ────────────────────────────────
  return iconFrame;
}
