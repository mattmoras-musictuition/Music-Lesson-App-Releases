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
// Exported so other previewers (e.g. components/PdfPreviewModal.js) can reuse
// the SAME lazily-imported legacy pdfjs build and self-hosted worker config —
// no second pdfjs import, no duplicate worker setup. Returns the pdfjs module
// with GlobalWorkerOptions.workerSrc already pointed at the bundled worker.
let pdfjsPromise = null;
export function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.min.mjs").then(pdfjs => {
      pdfjs.GlobalWorkerOptions.workerSrc = `${process.env.PUBLIC_URL || ""}/pdf.worker.legacy.min.mjs`;
      return pdfjs;
    });
  }
  return pdfjsPromise;
}

// ── Stable cache key ─────────────────────────────────────────
// Key by the URL *path* (origin + pathname), NOT the full URL. Resource files
// live in a PUBLIC Supabase bucket so getPublicUrl() already returns a stable
// URL — but documents (and any future signed source) carry a per-session
// ?token=… signature that changes every restart. Stripping the query/hash gives
// one key per underlying object, so a render done in a previous session still
// HITS the persistent store after a restart.
function stableKeyFor(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    // Relative/odd URL — best-effort: drop the query string and fragment.
    return String(url).split("#")[0].split("?")[0];
  }
}

// Session-lifetime cache of rendered first-page data URLs, keyed by scale+path.
// Stores the in-flight Promise so concurrent/duplicate requests dedupe and a
// re-selected resource renders instantly. A rejected render is evicted so a
// transient failure can be retried. Backed by IndexedDB (see below) so a
// rendered page survives app restarts — a given preview renders at most once
// per device ever, not once per session.
const firstPageCache = new Map();

// Render page 1 of a PDF to an offscreen canvas, return a data URL.
//
// Resolution order on a request: in-memory cache → IndexedDB → live pdf.js
// render. A hit returns the stored image instantly (no pdf.js). A miss renders,
// then writes the result to BOTH the in-memory cache and IndexedDB.
//
// PERF: pass the URL straight to pdf.js with disableAutoFetch so it pulls only
// the bytes needed for page 1 via HTTP range requests instead of downloading the
// whole file first (a large PDF previously took ~8-10s). Range/streaming stay on
// (the defaults); if the storage host doesn't honour range requests pdf.js falls
// back to a full download on its own, so behaviour degrades gracefully.
export function renderPdfFirstPage(url, { scale = 0.6 } = {}) {
  if (!url) return Promise.reject(new Error("renderPdfFirstPage: no url"));
  const key = `${scale}:${stableKeyFor(url)}`;
  const cached = firstPageCache.get(key);
  if (cached) return cached;
  const p = (async () => {
    // Persistent hit → return instantly, no pdf.js. idbGet never throws.
    const stored = await idbGet(key);
    if (stored) return stored;
    // Miss → render, then persist (only successful renders are stored, so a
    // transient error can retry). idbPut is fire-and-forget and never throws.
    const dataUrl = await _renderPdfFirstPage(url, scale);
    idbPut(key, dataUrl);
    return dataUrl;
  })().catch((err) => {
    // Evict the in-memory entry so the next attempt retries from scratch.
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

// ── Persistent first-page store (IndexedDB) ──────────────────
// On-disk cache of rendered first-page data URLs so a preview renders at most
// once per device ever. Lives in the renderer's default (persistent) storage
// partition, so it survives app restarts.
//
// GRACEFUL FALLBACK: every operation is wrapped — if IndexedDB is unavailable
// (e.g. an in-memory partition) or throws at any point, the helpers resolve to
// null / no-op and rendering falls back to the in-memory-only behaviour. A
// cache error must never break or block a preview.
//
// LRU CAP: the store is bounded by both an entry count and a total byte budget;
// on each write we evict the least-recently-used entries until back under both.
const IDB_NAME = "filePreviewCache";
const IDB_STORE = "firstPages";
const IDB_MAX_ENTRIES = 400;
const IDB_MAX_BYTES = 60 * 1024 * 1024; // ~60 MB of rendered first pages

let idbPromise; // memoised open; undefined = not tried, null-resolving = unavailable
function openIdb() {
  if (idbPromise !== undefined) return idbPromise;
  idbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") { resolve(null); return; }
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE, { keyPath: "key" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return idbPromise;
}

// Promisify a single IDBRequest within an existing transaction.
function reqDone(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Read a stored first page. Bumps its last-used timestamp (for LRU) on a hit.
// Returns the data URL string, or null on miss / any error.
async function idbGet(key) {
  try {
    const db = await openIdb();
    if (!db) return null;
    const tx = db.transaction(IDB_STORE, "readwrite");
    const store = tx.objectStore(IDB_STORE);
    const rec = await reqDone(store.get(key));
    if (!rec || !rec.dataUrl) return null;
    rec.ts = Date.now();
    store.put(rec); // touch for LRU; ignore result
    return rec.dataUrl;
  } catch {
    return null;
  }
}

// Persist a successfully-rendered first page, then prune to the caps. Never
// throws — failure just means this page re-renders next session.
async function idbPut(key, dataUrl) {
  try {
    const db = await openIdb();
    if (!db) return;
    const bytes = dataUrl.length; // data-URL string length ≈ stored size
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put({ key, dataUrl, bytes, ts: Date.now() });
    await txDone(tx);
    await idbPrune();
  } catch {
    /* on-disk cache is best-effort */
  }
}

// Evict least-recently-used entries until under both the entry-count and
// byte-budget caps.
async function idbPrune() {
  try {
    const db = await openIdb();
    if (!db) return;
    const tx = db.transaction(IDB_STORE, "readwrite");
    const store = tx.objectStore(IDB_STORE);
    const all = await reqDone(store.getAll());
    let count = all.length;
    let total = all.reduce((sum, r) => sum + (r.bytes || 0), 0);
    if (count <= IDB_MAX_ENTRIES && total <= IDB_MAX_BYTES) return;
    // Oldest first (smallest ts), delete until both caps are satisfied.
    all.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    for (const r of all) {
      if (count <= IDB_MAX_ENTRIES && total <= IDB_MAX_BYTES) break;
      store.delete(r.key);
      count -= 1;
      total -= r.bytes || 0;
    }
    await txDone(tx);
  } catch {
    /* pruning is best-effort */
  }
}

// Promisify a transaction's completion.
function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
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
