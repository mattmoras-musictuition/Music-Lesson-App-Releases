// ============================================================
// PDF TIME-GRID READER
// Some schools send a specialist timetable as a visual grid: one column per
// day, a time axis down the side, and each session drawn as a coloured card
// with no times printed on it. The AI can't reliably read a card's time from
// its position, so the app measures it here and hands the AI the answer.
//
// Cards come from the PDF's drawing data (filled rectangles), never from text
// clustering. A page counts as a time grid only when it has 3+ clock labels
// in one column AND 2+ weekday headings in one row; anything else returns
// null so other schools' PDFs are unaffected.
//
// All coordinates are PDF user space as pdf.js reports them (y grows upward
// on a normal page). The maths only relies on the axis labels, so it works
// whichever way y runs.
// ============================================================

import { loadPdfjs } from "./filePreviewCore";

const DAY_NAMES = {
  mon: "Monday", monday: "Monday",
  tue: "Tuesday", tues: "Tuesday", tuesday: "Tuesday",
  wed: "Wednesday", wednesday: "Wednesday",
  thu: "Thursday", thur: "Thursday", thurs: "Thursday", thursday: "Thursday",
  fri: "Friday", friday: "Friday",
};

// "9:00am", "12:30 pm", "14:30", "9am" → minutes since midnight, else null.
// A bare hour with no am/pm only counts with a colon ("14:30", "2:30");
// hours 1–6 without am/pm are read as afternoon (school-day axis).
export function parseClockLabel(str) {
  const s = String(str || "").trim().toLowerCase().replace(/\s+/g, "");
  let m = s.match(/^(\d{1,2})[:.](\d{2})(am|pm)?$/);
  if (!m) {
    m = s.match(/^(\d{1,2})(am|pm)$/);
    if (!m) return null;
    m = [m[0], m[1], "00", m[2]];
  }
  let h = Number(m[1]);
  const min = Number(m[2]);
  const suffix = m[3];
  if (min > 59 || h > 23) return null;
  if (suffix) {
    if (h < 1 || h > 12) return null;
    if (suffix === "pm" && h !== 12) h += 12;
    if (suffix === "am" && h === 12) h = 0;
  } else if (h >= 1 && h <= 6) {
    h += 12;
  }
  return h * 60 + min;
}

export function parseDayHeading(str) {
  const key = String(str || "").trim().toLowerCase().replace(/[.:]$/, "");
  return DAY_NAMES[key] || null;
}

const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

// Walk a pdf.js operator list and return the bounding box (in page space) of
// every filled path. Tracks the transform stack through save/restore,
// transform and form XObjects. pdf.js 5.x hands constructPath as
// [paintOp, [pathData], minMax] with minMax = [x0, y0, x1, y1] in local space.
export function collectFilledRects(fnArray, argsArray, OPS) {
  const fills = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const rects = [];
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const a = argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || ctm;
    else if (fn === OPS.transform) ctm = mul(ctm, a);
    else if (fn === OPS.paintFormXObjectBegin) { stack.push(ctm); if (a && a[0]) ctm = mul(ctm, a[0]); }
    else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || ctm;
    else if (fn === OPS.constructPath && a && fills.has(a[0]) && a[2]) {
      const b = a[2];
      const corners = [apply(ctm, b[0], b[1]), apply(ctm, b[2], b[3]), apply(ctm, b[0], b[3]), apply(ctm, b[2], b[1])];
      const xs = corners.map(c => c[0]);
      const ys = corners.map(c => c[1]);
      rects.push({ x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) });
    }
  }
  return rects;
}

// pdf.js text item → { str, x, y, w, h } (x/y = baseline start).
export function normalizeTextItem(it) {
  if (!it || typeof it.str !== "string" || !it.transform) return null;
  return { str: it.str, x: it.transform[4], y: it.transform[5], w: it.width || 0, h: it.height || Math.abs(it.transform[3]) || 0 };
}

// The point that decides which rectangle a piece of text sits in: centre of
// its width, middle of a digit's height above the baseline.
const anchor = t => ({ x: t.x + t.w / 2, y: t.y + t.h * 0.35 });

const fmt = min => {
  const r = Math.round(min / 5) * 5;
  return String(Math.floor(r / 60)).padStart(2, "0") + ":" + String(r % 60).padStart(2, "0");
};

// Group values that sit within `tol` of each other.
function cluster(list, key, tol) {
  const sorted = [...list].sort((p, q) => key(p) - key(q));
  const groups = [];
  for (const it of sorted) {
    const g = groups[groups.length - 1];
    if (g && key(it) - key(g[g.length - 1]) <= tol) g.push(it);
    else groups.push([it]);
  }
  return groups;
}

function findTimeAxis(texts) {
  const labels = texts
    .map(t => ({ t, min: parseClockLabel(t.str) }))
    .filter(l => l.min != null)
    .map(l => ({ ...l, cx: l.t.x + l.t.w / 2, cy: anchor(l.t).y }));
  let best = null;
  for (const g of cluster(labels, l => l.cx, 10)) {
    // One label per time; the y order must follow the time order.
    const byMin = new Map();
    for (const l of g) if (!byMin.has(l.min)) byMin.set(l.min, l);
    const pts = [...byMin.values()].sort((p, q) => p.min - q.min);
    if (pts.length < 3) continue;
    const dir = Math.sign(pts[1].cy - pts[0].cy);
    if (!dir) continue;
    let monotone = true;
    for (let i = 1; i < pts.length; i++) if (Math.sign(pts[i].cy - pts[i - 1].cy) !== dir) monotone = false;
    if (!monotone) continue;
    if (!best || pts.length > best.pts.length) best = { pts, dir };
  }
  return best;
}

function findDayRow(texts) {
  const heads = texts
    .map(t => ({ t, day: parseDayHeading(t.str) }))
    .filter(h => h.day)
    .map(h => ({ ...h, cx: h.t.x + h.t.w / 2, y: h.t.y }));
  let best = null;
  for (const g of cluster(heads, h => h.y, 4)) {
    const byDay = new Map();
    for (const h of g) if (!byDay.has(h.day)) byDay.set(h.day, h);
    const cols = [...byDay.values()].sort((p, q) => p.cx - q.cx);
    if (cols.length < 2) continue;
    if (!best || cols.length > best.length) best = cols;
  }
  return best;
}

// Minutes at position y, linear between the two nearest axis labels
// (extrapolated from the end segment beyond the first/last label).
function minutesAt(axis, y) {
  const pts = axis.pts;
  let i = 0;
  while (i < pts.length - 2 && (y - pts[i + 1].cy) * axis.dir > 0) i++;
  const p = pts[i], q = pts[i + 1];
  return p.min + (y - p.cy) * (q.min - p.min) / (q.cy - p.cy);
}

// texts: [{ str, x, y, w, h }]; rects: [{ x0, y0, x1, y1 }].
// Returns null when the page is not a time grid, else
// { cards: [{ page, day, start, end, text, rect }], unplaced: [{ page, text, reason, rect }] }.
export function extractGridCards(texts, rects, { page = 1 } = {}) {
  const items = (texts || []).filter(t => t && t.str && t.str.trim());
  const axis = findTimeAxis(items);
  const days = findDayRow(items);
  if (!axis || !days) return null;

  const spacing = Math.min(...days.slice(1).map((d, i) => d.cx - days[i].cx));
  const half = spacing / 2;
  // Cards may run up to an hour past the first/last axis label.
  const first = axis.pts[0], last = axis.pts[axis.pts.length - 1];
  const hour = 60 * Math.abs((last.cy - first.cy) / (last.min - first.min));
  const yLo = Math.min(first.cy, last.cy) - hour - 0.5;
  const yHi = Math.max(first.cy, last.cy) + hour + 0.5;

  // Full-width bands (Recess, lunch) run edge to edge across a day column,
  // like the grid lines. A card that fills the column (e.g. an all-classes
  // excursion) is drawn inset, so it is narrower than the column's widest
  // full-width shape. Per column: band = within 1pt of that widest width.
  const colOf = r => days.find(d => Math.abs((r.x0 + r.x1) / 2 - d.cx) <= half) || null;
  const wide = (rects || []).filter(r => r.x1 - r.x0 >= 0.9 * spacing && r.x1 - r.x0 < 1.5 * spacing);
  const bandWidth = new Map();
  for (const r of wide) {
    const c = colOf(r);
    if (c) bandWidth.set(c, Math.max(bandWidth.get(c) || 0, r.x1 - r.x0));
  }
  const isBand = r => {
    const w = r.x1 - r.x0;
    if (w < 0.9 * spacing) return false;
    const c = colOf(r);
    return !c || w >= (bandWidth.get(c) || 0) - 1;
  };
  // Candidates: not a line or legend swatch, not a band.
  let cands = (rects || [])
    .filter(r => r.x1 - r.x0 >= 12 && r.y1 - r.y0 >= 6)
    .filter(r => !isBand(r));
  // Drop near-duplicates (the same card filled twice).
  const same = (p, q) => Math.abs(p.x0 - q.x0) <= 1.5 && Math.abs(p.x1 - q.x1) <= 1.5 && Math.abs(p.y0 - q.y0) <= 1.5 && Math.abs(p.y1 - q.y1) <= 1.5;
  cands = cands.filter((r, i) => !cands.slice(0, i).some(q => same(q, r)));
  // Badges sit inside a card; their text stays with the card.
  const inside = (p, q) => p !== q && p.x0 >= q.x0 - 0.5 && p.x1 <= q.x1 + 0.5 && p.y0 >= q.y0 - 0.5 && p.y1 <= q.y1 + 0.5;
  cands = cands.filter(r => !cands.some(q => inside(r, q)));

  const axisLabels = new Set(axis.pts.map(p => p.t));
  const headings = new Set(days.map(d => d.t));
  const body = items.filter(t => !axisLabels.has(t) && !headings.has(t));

  const cards = [];
  const unplaced = [];
  for (const r of cands) {
    const inRect = body.filter(t => { const a = anchor(t); return a.x >= r.x0 - 0.5 && a.x <= r.x1 + 0.5 && a.y >= r.y0 - 0.5 && a.y <= r.y1 + 0.5; });
    if (inRect.length === 0) continue; // a shape with no words is not a card
    const ordered = [...inRect].sort((p, q) => (Math.abs(p.y - q.y) > 2 ? (p.y - q.y) * axis.dir : p.x - q.x));
    const text = ordered.map(t => t.str.trim()).join(" ");
    const rect = { x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1 };
    const cx = (r.x0 + r.x1) / 2;
    const col = days.find(d => Math.abs(cx - d.cx) <= half);
    if (!col) { unplaced.push({ page, text, reason: "not under a day heading", rect }); continue; }
    if (r.y0 < yLo || r.y1 > yHi) { unplaced.push({ page, text, reason: "outside the time axis", rect }); continue; }
    const a = minutesAt(axis, r.y0);
    const b = minutesAt(axis, r.y1);
    cards.push({ page, day: col.day, start: fmt(Math.min(a, b)), end: fmt(Math.max(a, b)), text, rect });
  }
  const dayIdx = d => ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].indexOf(d);
  cards.sort((p, q) => p.page - q.page || dayIdx(p.day) - dayIdx(q.day) || p.start.localeCompare(q.start) || p.rect.x0 - q.rect.x0);
  return { cards, unplaced };
}

// Read every page of a PDF (ArrayBuffer / Uint8Array). Returns null when no
// page is a time grid or anything goes wrong — the import then runs exactly as
// before. `pdfjsLib` is injectable for scripts; the app uses the shared loader.
export async function readPdfGridCards(data, pdfjsLib = null) {
  let doc = null;
  try {
    const pdfjs = pdfjsLib || await loadPdfjs();
    // Always a fresh copy: pdf.js takes ownership of (detaches) the buffer.
    const bytes = new Uint8Array(data instanceof ArrayBuffer ? data.slice(0) : data);
    doc = await pdfjs.getDocument({ data: bytes, verbosity: 0 }).promise;
    const cards = [];
    const unplaced = [];
    let anyGrid = false;
    for (let p = 1; p <= doc.numPages; p++) {
      const pg = await doc.getPage(p);
      const tc = await pg.getTextContent();
      const ol = await pg.getOperatorList();
      const texts = tc.items.map(normalizeTextItem).filter(Boolean);
      const rects = collectFilledRects(ol.fnArray, ol.argsArray, pdfjs.OPS);
      const res = extractGridCards(texts, rects, { page: p });
      if (!res) continue;
      anyGrid = true;
      cards.push(...res.cards);
      unplaced.push(...res.unplaced);
    }
    return anyGrid ? { cards, unplaced } : null;
  } catch (e) {
    console.warn("PDF grid read failed:", e);
    return null;
  } finally {
    if (doc) { try { doc.destroy(); } catch (e) {} }
  }
}
