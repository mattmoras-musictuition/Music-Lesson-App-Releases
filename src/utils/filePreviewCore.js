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

// Session-lifetime cache of rendered first-page data URLs, keyed by scale+url.
// Stores the in-flight Promise so concurrent/duplicate requests dedupe and a
// re-selected resource renders instantly. A rejected render is evicted so a
// transient failure can be retried.
const firstPageCache = new Map();

// Render page 1 of a PDF to an offscreen canvas, return a data URL.
//
// PERF: pass the URL straight to pdf.js with disableAutoFetch so it pulls only
// the bytes needed for page 1 via HTTP range requests instead of downloading the
// whole file first (a large PDF previously took ~8-10s). Range/streaming stay on
// (the defaults); if the storage host doesn't honour range requests pdf.js falls
// back to a full download on its own, so behaviour degrades gracefully.
export function renderPdfFirstPage(url, { scale = 0.6 } = {}) {
  if (!url) return Promise.reject(new Error("renderPdfFirstPage: no url"));
  const key = `${scale}:${url}`;
  const cached = firstPageCache.get(key);
  if (cached) return cached;
  const p = _renderPdfFirstPage(url, scale).catch((err) => {
    firstPageCache.delete(key);
    throw err;
  });
  firstPageCache.set(key, p);
  return p;
}

async function _renderPdfFirstPage(url, scale) {
  const pdfjs = await loadPdfjs();
  const loadingTask = pdfjs.getDocument({ url, disableAutoFetch: true });
  const pdf = await loadingTask.promise;
  try {
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    return canvas.toDataURL();
  } finally {
    // We only ever need page 1 — free the worker doc (and cancel any pending
    // range fetches) once it's rendered.
    try { pdf.destroy(); } catch { /* ignore */ }
  }
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
