// ============================================================
// ResourcePreview.js — detail-panel content preview for the
// Documents & Resources library. Renders, in a fixed-height area
// that never shifts between states, the best available preview for
// a resource/document via a layered fallback chain:
//
//   1. image file            → <img>
//   2. pdf file              → first page rendered to a canvas
//   3. youtube link          → hqdefault thumbnail
//   4. other link            → rich Open Graph card  (added in a
//                              later commit)
//   5. other link (no OG)    → lightweight favicon + hostname card
//   6. anything else / fail  → the caller's type icon
//
// Image/PDF/YouTube live here; the link branches arrive with the
// Open Graph work.
// ============================================================

import React, { useState, useEffect } from "react";
import { useTheme } from "../context/ThemeContext";
import { fileKind, renderPdfFirstPage, youtubeId, youtubeThumb } from "../utils/filePreviewCore";
import { signedUrlFor } from "../utils/storageHelpers";

export default function ResourcePreview({
  fileUrl,            // public, directly-renderable file URL (resources)
  storagePath,        // private storage path (documents) — signed on demand
  linkUrl,            // external link (resource/document URL)
  fileName,           // for extension-based classification
  mime,               // mime type when known (documents)
  title,              // alt text / accessibility
  fallbackIcon: FallbackIcon,
  height = 140,
}) {
  const { colors } = useTheme();

  // null = still deciding; { type: 'image'|'icon', src? } once resolved.
  const [state, setState] = useState(null);

  const kind = fileKind({ mime, name: fileName, url: fileUrl || storagePath || linkUrl });
  const ytId = !kind && linkUrl ? youtubeId(linkUrl) : null;

  useEffect(() => {
    let cancelled = false;
    setState(null);

    async function resolve() {
      try {
        // 1 & 2 — file previews (image / pdf), public or signed-private.
        if (kind === "image" || kind === "pdf") {
          let src = fileUrl || (linkUrl && !storagePath ? linkUrl : null);
          if (!src && storagePath) src = await signedUrlFor(storagePath);
          if (!src) { if (!cancelled) setState({ type: "icon" }); return; }
          if (kind === "image") {
            if (!cancelled) setState({ type: "image", src });
          } else {
            const dataUrl = await renderPdfFirstPage(src);
            if (!cancelled) setState({ type: "image", src: dataUrl });
          }
          return;
        }
        // 3 — YouTube thumbnail.
        if (ytId) {
          if (!cancelled) setState({ type: "image", src: youtubeThumb(ytId) });
          return;
        }
        // 4/5 — other links: Open Graph branch is wired in a later commit.
        if (!cancelled) setState({ type: "icon" });
      } catch {
        if (!cancelled) setState({ type: "icon" });
      }
    }
    resolve();
    return () => { cancelled = true; };
  }, [kind, ytId, fileUrl, storagePath, linkUrl]);

  const frame = {
    height,
    background: colors.bg,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderBottom: `1px solid ${colors.borderLight}`,
    overflow: "hidden",
  };

  const icon = FallbackIcon
    ? <FallbackIcon size={48} style={{ color: colors.textMuted, opacity: 0.7 }} />
    : null;

  // Loading: keep the frame at full height so nothing shifts on resolve.
  if (state === null) return <div style={frame} />;

  if (state.type === "image") {
    return (
      <div style={frame}>
        <img
          src={state.src}
          alt={title || ""}
          onError={() => setState({ type: "icon" })}
          style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", display: "block" }}
        />
      </div>
    );
  }

  return <div style={frame}>{icon}</div>;
}
