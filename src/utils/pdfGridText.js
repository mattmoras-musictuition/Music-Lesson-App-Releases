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
import { anthropicFetch, getAnthropicHeaders } from "./api";
import { ANTHROPIC_MODEL } from "../constants";

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

// ============================================================
// SPECIALIST PDF REQUEST (shared by Import and Update)
// Two paths:
//  - Grid: the app has measured every card, so the PDF is not sent. The AI
//    gets a numbered card list (no times) and names each card's class(es)
//    and subject; joinGridReply puts the app's day/start/end back on.
//  - Native: any other PDF goes as a document, as before.
// Both replies are constrained to a JSON schema (output_config.format).
// ============================================================

const AI_URL = "https://api.anthropic.com/v1/messages";
const MAX_TOKENS = 16000;

function instructionsBlock(instructions) {
  if (!instructions || !instructions.trim()) return "";
  return `\n\nIMPORTANT — SPECIFIC INSTRUCTIONS FROM THE USER about this document. Follow these carefully, they override general assumptions:\n---\n${instructions.trim()}\n---`;
}

const strictObject = (properties) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });

export const ENTRY_SCHEMA = strictObject({
  entries: { type: "array", items: strictObject({
    class: { type: "string" }, day: { type: "string" }, start: { type: "string" }, end: { type: "string" }, subject: { type: "string" },
  }) },
});

export const CARD_SCHEMA = strictObject({
  cards: { type: "array", items: strictObject({
    card: { type: "integer" }, classes: { type: "array", items: { type: "string" } }, subject: { type: "string" },
  }) },
});

const jsonFormat = schema => ({ format: { type: "json_schema", schema } });

// The extraction prompt for a PDF sent as a document. `preamble` (Update
// only) goes first; the user's Instructions box goes last, as before.
export function buildSpecialistPrompt({ instructions = "", preamble = "" } = {}) {
  return `${preamble ? preamble + "\n\n" : ""}This PDF contains a specialist class timetable for a primary/elementary school.\nExtract ALL specialist class entries from this document.\n\nFor each entry I need:\n- class: The class/grade name (e.g. "Prep A", "1B", "3/4C", "Year 5")\n- day: The day of the week (Monday, Tuesday, Wednesday, Thursday, or Friday)\n- start: Start time in HH:MM 24-hour format (e.g. "09:00", "14:30")\n- end: End time in HH:MM 24-hour format\n- subject: The specialist subject (e.g. "Art", "PE/Sport", "LOTE", "Music", "Science", "Library", "Digital Tech", "Drama", "Dance", "STEM")\n\nRespond ONLY with a JSON array, no other text, no markdown backticks. Example:\n[{"class":"3A","day":"Monday","start":"09:00","end":"09:50","subject":"Art"}]\n\nRules:\n- Extract EVERY entry you can find\n- If times are in 12-hour format, convert to 24-hour\n- Use exact class names from the document\n- Times printed in the document always take priority\n- If a MEASURED CARD POSITIONS block is supplied and times are not printed on the cards, use its day, start and end for each card exactly as given\n- Output one entry per class on a card: a card listing several classes (e.g. "56P, 56S, 5L, 6A") gives one entry for each class, all with that card's day, start, end and subject\n- Never work out times from the order of the text\n- If a time genuinely cannot be determined, still include the entry with start and end as empty strings (""); never guess\n- Skip cards that have no class/grade on them\n- Include ALL classes and ALL specialist subjects shown\n- Use compact JSON with no extra whitespace to fit everything${instructionsBlock(instructions)}`;
}

// fetch options for a PDF sent as a document, reply as { entries: [...] }.
export function buildSpecialistPdfRequest({ base64, instructions = "", preamble = "" }) {
  const content = [
    { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } },
    { type: "text", text: buildSpecialistPrompt({ instructions, preamble }) },
  ];
  return {
    method: "POST",
    headers: getAnthropicHeaders(),
    body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: MAX_TOKENS, output_config: jsonFormat(ENTRY_SCHEMA), messages: [{ role: "user", content }] }),
  };
}

// The numbered card list: card number | card text. No times, no PDF.
export function formatCardList(cards) {
  const clean = s => String(s || "").replace(/\|/g, "/").replace(/\s+/g, " ").trim();
  return cards.map((c, i) => `${i + 1} | ${clean(c.text)}`).join("\n");
}

export function buildGridPrompt({ cards, instructions = "" }) {
  return `Below are the session cards from a primary/elementary school's specialist timetable, one per line as "card number | card text". The app has already worked out each card's day and times, so you only identify what each card is.\n\nFor each card that is a specialist class, return:\n- card: the card number exactly as given\n- classes: the class/grade code(s) on the card, exactly as written (e.g. ["6A"]; a card listing several classes such as "56P, 56S, 5L, 6A" gives ["56P","56S","5L","6A"])\n- subject: the specialist subject (e.g. "Art", "PE/Sport", "LOTE", "Music", "Science", "Library", "Digital Tech", "Drama", "Dance", "STEM", or the card's own subject name)\n\nRules:\n- Leave out cards with no class/grade on them (meetings, planning, duties, rooms only)\n- Leave out cards the user's instructions say to skip\n- Do not invent cards or card numbers\n- Never write explanation; return only the data\n\nCards:\n${formatCardList(cards)}${instructionsBlock(instructions)}`;
}

// fetch options for a measured grid, reply as { cards: [...] }.
export function buildSpecialistGridRequest({ cards, instructions = "" }) {
  return {
    method: "POST",
    headers: getAnthropicHeaders(),
    body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: MAX_TOKENS, output_config: jsonFormat(CARD_SCHEMA),
      messages: [{ role: "user", content: [{ type: "text", text: buildGridPrompt({ cards, instructions }) }] }] }),
  };
}

// First complete JSON array in `text` (string-aware bracket matching), or null.
function firstJsonArray(text) {
  for (let start = text.indexOf("["); start >= 0; start = text.indexOf("[", start + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === "[") depth++;
      else if (ch === "]" && --depth === 0) {
        try { const v = JSON.parse(text.slice(start, i + 1)); if (Array.isArray(v)) return v; } catch (e) {}
        break;
      }
    }
  }
  return null;
}

// Every complete item of a list that was cut off part-way. Items are flat
// objects (an item's only nested value is a string array), so the last "}"
// always closes a whole item.
function salvageItems(text) {
  const start = text.indexOf("[");
  const last = text.lastIndexOf("}");
  if (start < 0 || last < start) return null;
  try { const v = JSON.parse(text.slice(start, last + 1) + "]"); return Array.isArray(v) ? v : null; } catch (e) { return null; }
}

export const OUT_OF_ROOM_MESSAGE = "The AI ran out of room before it finished the list, so nothing could be kept. Try again, or add instructions to import fewer classes at a time (e.g. 'only Prep–Year 2').";

// API reply JSON → { items, truncated }. `key` is the list's name in the
// schema ("entries" or "cards"); a bare array, or the first array inside
// prose, is accepted too. A reply that ran out of room keeps every
// complete item and reports truncated: true.
export function parseStructuredReply(data, key = "entries") {
  if (data && data.error) {
    throw new Error(`AI error: ${data.error.message || JSON.stringify(data.error)}`);
  }
  if (data && data.stop_reason === "refusal") {
    throw new Error("The AI declined to read this document. Try again, or use a spreadsheet instead.");
  }
  const textContent = (data && data.content)?.map(c => c.type === "text" ? c.text : "").join("") || "";
  if (!textContent.trim()) {
    throw new Error("AI returned an empty response. The PDF may be image-based or unreadable. Try a clearer PDF or use a spreadsheet instead.");
  }
  const cleaned = textContent.replace(/```json|```/g, "").trim();
  const outOfRoom = !!(data && data.stop_reason === "max_tokens");
  let items = null;
  let truncated = false;
  try {
    const v = JSON.parse(cleaned);
    if (Array.isArray(v)) items = v;
    else if (v && Array.isArray(v[key])) items = v[key];
  } catch (e) { /* fall through */ }
  if (!items) items = firstJsonArray(cleaned);
  if (!items) {
    items = salvageItems(cleaned);
    if (items) truncated = true;
  }
  if (!items) {
    if (outOfRoom) throw new Error(OUT_OF_ROOM_MESSAGE);
    throw new Error("AI response wasn't valid JSON.\n\nRaw response preview: " + cleaned.substring(0, 300));
  }
  if (outOfRoom) truncated = true;
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("AI could not find any specialist entries in this document. Try adding more specific instructions about what to look for.");
  }
  return { items, truncated };
}

// Back-compat name for the native path: { entries, truncated }.
export function parseSpecialistReply(data) {
  const { items, truncated } = parseStructuredReply(data, "entries");
  return { entries: items, truncated };
}

// One reply entry → the row fields the Review screen edits. Missing or empty
// times stay "" (a blank time box the owner fills in).
export function replyEntryFields(e) {
  return { className: e.class || "", day: e.day || "", start: e.start || "", end: e.end || "", subject: e.subject || "" };
}

// Grid reply → Review rows. One row per class; day/start/end always come
// from the app's measured card, never from the reply. Card numbers are
// 1-based positions in `cards`; unknown or repeated numbers are ignored.
export function joinGridReply(cards, replyCards) {
  const rows = [];
  const seen = new Set();
  let unknown = 0, duplicate = 0;
  for (const r of replyCards || []) {
    const n = Number(r && r.card);
    if (!Number.isInteger(n) || n < 1 || n > cards.length) { unknown++; continue; }
    if (seen.has(n)) { duplicate++; continue; }
    seen.add(n);
    const c = cards[n - 1];
    const classes = [];
    for (const raw of Array.isArray(r.classes) ? r.classes : [r.classes]) {
      for (const part of String(raw || "").split(",")) {
        const code = part.trim();
        if (code && !classes.includes(code)) classes.push(code);
      }
    }
    for (const className of classes) {
      rows.push({ className, day: c.day, start: c.start, end: c.end, subject: String(r.subject || "").trim() });
    }
  }
  return { rows, cardsUsed: seen.size, unknown, duplicate };
}

async function postAI(fetchFn, request) {
  let response;
  try {
    response = await fetchFn(AI_URL, request);
  } catch (fetchErr) {
    throw new Error("Network error connecting to AI service. Check your internet connection and try again.");
  }
  if (!response.ok) {
    let errBody = "";
    try { errBody = await response.text(); } catch (e) {}
    throw new Error(`AI service returned error ${response.status}: ${errBody.substring(0, 200)}`);
  }
  return response.json();
}

// The whole PDF extraction, shared by Import and Update. Returns
// { rows: [{ className, day, start, end, subject }], truncated, measured }
// where measured = { cards, entries, unknown, duplicate } on the grid path,
// else null. fetchFn / readGrid are injectable for tests.
export async function extractSpecialistRows({ pdfBytes, base64, instructions = "", preamble = "", fetchFn = anthropicFetch, readGrid = readPdfGridCards }) {
  const grid = await readGrid(pdfBytes);
  if (grid && Array.isArray(grid.cards) && grid.cards.length > 0) {
    const data = await postAI(fetchFn, buildSpecialistGridRequest({ cards: grid.cards, instructions }));
    const { items, truncated } = parseStructuredReply(data, "cards");
    const join = joinGridReply(grid.cards, items);
    if (join.rows.length === 0) {
      throw new Error("AI could not find any specialist entries in this document. Try adding more specific instructions about what to look for.");
    }
    return { rows: join.rows, truncated, measured: { cards: grid.cards.length, entries: join.rows.length, unknown: join.unknown, duplicate: join.duplicate } };
  }
  const data = await postAI(fetchFn, buildSpecialistPdfRequest({ base64, instructions, preamble }));
  const { items, truncated } = parseStructuredReply(data, "entries");
  return { rows: items.map(replyEntryFields), truncated, measured: null };
}
