// ============================================================
// filePreviewCore.js — pure, UI-free preview primitives shared by
// the hover popover (components/filePreview.js) and the detail-panel
// preview (components/ResourcePreview.js).
//
// PDF rendering lazy-loads pdfjs-dist's legacy build (transpiled for
// the app's Electron 29 / Chromium 122), self-hosting the matching
// worker from public/pdf.worker.legacy.min.mjs.
// ============================================================

// ── pdfjs (lazy) ─────────────────────────────────────────────
let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.min.mjs").then(pdfjs => {
      pdfjs.GlobalWorkerOptions.workerSrc = `${process.env.PUBLIC_URL || ""}/pdf.worker.legacy.min.mjs`;
      return pdfjs;
    });
  }
  return pdfjsPromise;
}

// Render page 1 of a PDF to an offscreen canvas, return a data URL.
export async function renderPdfFirstPage(url, { scale = 0.6 } = {}) {
  const pdfjs = await loadPdfjs();
  const pdf = await pdfjs.getDocument(url).promise;
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  return canvas.toDataURL();
}

// Classify a file as 'image' | 'pdf' | null, by mime if present, else
// by the file name / URL extension (resources don't store a mime type).
export function fileKind({ mime, name, url } = {}) {
  const m = (mime || "").toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m === "application/pdf") return "pdf";
  const s = (name || url || "").toLowerCase();
  if (/\.(png|jpe?g|gif|webp|bmp|svg)(\?|#|$)/.test(s)) return "image";
  if (/\.pdf(\?|#|$)/.test(s)) return "pdf";
  return null;
}

// Extract an 11-char YouTube video ID from watch / youtu.be / embed
// URLs, else null.
export function youtubeId(url) {
  if (!url) return null;
  const patterns = [
    /youtube\.com\/watch\?(?:.*&)?v=([\w-]{11})/,
    /youtu\.be\/([\w-]{11})/,
    /youtube\.com\/embed\/([\w-]{11})/,
  ];
  for (const re of patterns) {
    const m = url.match(re);
    if (m) return m[1];
  }
  return null;
}

// hqdefault is the most widely-available thumbnail size (always present).
export function youtubeThumb(id) {
  return `https://img.youtube.com/vi/${id}/hqdefault.jpg`;
}
