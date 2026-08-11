// ============================================================
// concertProgramHtml.js — the printed audience program (§4.7).
//
// Builds a self-contained A4 PORTRAIT HTML document, rendered to PDF
// via electronPrintToPdf. Structured like tallyPdfHtml.js (inline CSS,
// no React, no imports from the app's stylesheet) and deliberately
// independent of exportHelpers.js, whose builders are timetable-shaped
// and whose shared CSS is landscape-biased.
//
// WHAT THIS IS: a handout given to parents at a school concert. It is
// not a running sheet and not a backstage document. That is why there
// are no item numbers, no teachers, no notes, no attachments, no band
// names and no date/venue — the numbering exists in the app for
// ordering only, and everything else is production detail an audience
// does not want.
//
// ── ORIENTATION ─────────────────────────────────────────────
// preload.js:28 accepts only (html) and drops any options argument, so
// orientation CANNOT be passed through the Electron bridge. Portrait is
// therefore set by this document's own `@page` rule, which is how the
// invoice PDFs already come out portrait. Nothing here may depend on
// passing print options.
//
// ── FITTING ─────────────────────────────────────────────────
// Nothing in the existing export pipeline does page fitting, scaling or
// page counting, so the model below is built from scratch. It is an
// ESTIMATE: the PDF is rendered by Chromium in the main process and
// this code never sees the result, so text is measured by a typographic
// model here rather than by the renderer. See layoutProgram() for the
// model and its known biases.
// ============================================================

import { abbreviateInstrument } from "./resourcesDB";
import { preferredDisplayName } from "./studentName";

// ── Page geometry ───────────────────────────────────────────
// A4 portrait. Margins chosen deliberately: 18mm top/bottom and 16mm
// sides clear the non-printable edge every consumer printer reserves
// (typically 5mm, up to ~10mm on some models) with room to spare, and
// leave a 178mm measure — a comfortable line length for centred text
// that doesn't run so wide the eye loses its place.
const MM_TO_PT      = 2.834645669;
const MARGIN_V_MM   = 18;
const MARGIN_H_MM   = 16;
const USABLE_W_PT   = (210 - MARGIN_H_MM * 2) * MM_TO_PT;   // 504.6pt
const USABLE_H_PT   = (297 - MARGIN_V_MM * 2) * MM_TO_PT;   // 739.8pt

// ── Type scale, at scale = 1.0 ──────────────────────────────
const BASE_HEADING_PT   = 26;
const BASE_PIECE_PT     = 15;
const BASE_PERFORMER_PT = 13;

// ── The readability floor ───────────────────────────────────
// The performer line is the smallest text on the page and the thing a
// parent actually squints at in a dim hall, so the floor is set on it:
// 11pt. That is the low end of book body text — comfortably above the
// 8–9pt newspapers use — and stays legible at arm's length (~40cm) in
// poor light for readers with ordinary age-related presbyopia. Below it
// the program fails at its one job, so the program flows onto a second
// page instead. Paper is cheap; an unreadable handout is not.
//
// MIN_PROGRAM_SCALE is derived from that floor rather than picked, so a
// scale that violates the floor is not expressible: at 0.85 the
// performer text is 11.05pt.
export const MIN_PROGRAM_SCALE = 0.85;
export const MAX_PROGRAM_SCALE = 1.30;
export const PROGRAM_SCALE_STEP = 0.05;

export function clampProgramScale(s) {
  const n = Number(s);
  if (!Number.isFinite(n)) return 1;
  return Math.min(MAX_PROGRAM_SCALE, Math.max(MIN_PROGRAM_SCALE, n));
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// studentsById is a Map in ConcertsManager, but accept a plain object
// too so the builder isn't coupled to one caller's data structure.
function lookupStudent(studentsById, id) {
  if (!studentsById || !id) return null;
  if (typeof studentsById.get === "function") return studentsById.get(id) || null;
  return studentsById[id] || null;
}

// ── Content model ───────────────────────────────────────────

// Full name for one performer (§4.7 prints full names, not first names).
// A linked student resolves through studentsById; a free-text performer
// uses their typed name verbatim. A studentId that no longer resolves —
// the student left the school and was deleted — falls back to any name
// stored on the row, and if there is none the performer is dropped
// entirely by buildProgramRows rather than printing a blank or an id.
//
// A resolved student name goes through preferredDisplayName, so
// "Megumi (Meg) Van Haven" prints as "Meg Van Haven" — the name the child
// is actually called in front of an audience. The same helper runs on the
// list rows in ConcertsManager, so screen and paper always agree.
//
// A free-text performer is NOT transformed: that field is labelled "Name as
// it should print", so what was typed is what was meant.
function performerName(p, studentsById) {
  const stored = (p?.name || "").trim();
  if (p?.studentId) {
    const full = (lookupStudent(studentsById, p.studentId)?.name || "").trim();
    if (full) return (preferredDisplayName(full) || full).trim();
    return stored;
  }
  return stored;
}

// "Alice Walker (Gtr)" — or "Alice Walker" when the instrument is blank
// or unresolvable. abbreviateInstrument returns "" for a blank name, and
// that empty string is what suppresses the parenthetical, so "Name ()"
// can never print (§4.8).
function performerText(p, studentsById, abbreviations) {
  const name = performerName(p, studentsById);
  if (!name) return "";
  const ab = abbreviateInstrument(p?.instrument, abbreviations);
  return ab ? `${name} (${ab})` : name;
}

// One row per piece, in the order given. Performers are comma-separated
// on one wrapping run and deliberately NOT grouped by instrument. A
// piece with no resolvable performers keeps its title and prints alone.
export function buildProgramRows(items, studentsById, abbreviations) {
  return (items || []).map(it => ({
    title: (it?.title || "").trim(),
    performers: (it?.performers || [])
      .map(p => performerText(p, studentsById, abbreviations))
      .filter(Boolean)
      .join(", "),
  }));
}

// ── Layout model ────────────────────────────────────────────
//
// ESTIMATED, not measured. Line wrapping is approximated by average
// glyph advance: for mixed-case Latin text in a proportional sans, mean
// advance is close to 0.50em. Real wrapping breaks at spaces, so the
// ragged right edge wastes a little of every line — the 0.95 factor on
// the usable width accounts for that rather than pretending characters
// pack flush to the margin. Known residual bias: an unusually long
// single name straddling a break can still cost one more line than this
// predicts, so the estimate can under-count. It never over-counts by
// more than the same margin.
function wrappedLines(text, sizePt) {
  const s = String(text || "");
  if (!s) return 0;
  const perLine = Math.max(1, Math.floor((USABLE_W_PT * 0.95) / (sizePt * 0.5)));
  return Math.max(1, Math.ceil(s.length / perLine));
}

// Pack the pieces into pages at a given scale and report how they fall.
// A piece block is atomic — title and performers are measured and placed
// together — which is the same guarantee `break-inside: avoid` gives the
// renderer, so the two agree about where pages break.
function layoutProgram({ title, rows, scale }) {
  const s          = clampProgramScale(scale);
  const headingPt  = BASE_HEADING_PT * s;
  const piecePt    = BASE_PIECE_PT * s;
  const perfPt     = BASE_PERFORMER_PT * s;

  const headingH = (title || "").trim()
    ? wrappedLines(title, headingPt) * headingPt * 1.22 + headingPt * 0.9
    : 0;

  // Height of each piece block, excluding the gap that follows it.
  const blockH = rows.map(r => {
    let h = wrappedLines(r.title || "—", piecePt) * piecePt * 1.30;
    if (r.performers) {
      h += perfPt * 0.30;                                        // title→performers
      h += wrappedLines(r.performers, perfPt) * perfPt * 1.45;
    }
    return h;
  });
  const baseGap = perfPt * 1.0;

  // Greedy pack. A block that doesn't fit the remaining space starts a
  // new page — never splits.
  const pages = [];
  let current = [];
  let used    = headingH;
  rows.forEach((_, i) => {
    const need = blockH[i] + (current.length ? baseGap : 0);
    if (current.length && used + need > USABLE_H_PT) {
      pages.push({ idx: current, used });
      current = [i];
      used    = blockH[i];
    } else {
      current.push(i);
      used += need;
    }
  });
  pages.push({ idx: current, used });

  return { scale: s, headingPt, piecePt, perfPt, headingH, blockH, baseGap, pages, pageCount: pages.length };
}

// Largest scale that achieves the FEWEST pages.
//
// Page count falls monotonically as the scale falls, so the minimum is
// found at MIN_PROGRAM_SCALE and the best scale is the largest one that
// still reaches it. This handles both directions of the tension in the
// brief: a program that fits at 1.0 is never shrunk, a program one line
// over is squeezed just enough, and a program that needs two pages no
// matter what is rendered at full size rather than shrunk pointlessly to
// the floor — a smaller two-page program is strictly worse than a
// comfortable two-page program.
//
// Never searches above 1.0: auto-fit does not enlarge. Growing past the
// designed size is the manual nudge's job.
export function autoFitProgramScale({ title, rows }) {
  const candidates = [];
  for (let s = 1.0; s >= MIN_PROGRAM_SCALE - 1e-9; s -= PROGRAM_SCALE_STEP) {
    candidates.push(Math.round(s * 100) / 100);
  }
  let best = candidates[0];
  let bestPages = layoutProgram({ title, rows, scale: best }).pageCount;
  for (const s of candidates) {
    const p = layoutProgram({ title, rows, scale: s }).pageCount;
    if (p < bestPages) { bestPages = p; best = s; }
  }
  return best;
}

// Page count for the dialog's "before saving" report.
export function estimateProgramPages({ title, rows, scale }) {
  return layoutProgram({ title, rows, scale }).pageCount;
}

// ── HTML ────────────────────────────────────────────────────

/**
 * Build the complete printable program document.
 *
 * @param {Object}   params
 * @param {string}   params.title          — concert heading, verbatim from concerts.title
 * @param {Array}    params.items          — concert_items in position order
 * @param {Map|Object} params.studentsById — for resolving linked performers to full names
 * @param {Object}   params.abbreviations  — instrument name → short form (cluster 4)
 * @param {number}   [params.scale=1]      — type scale; clamped to the readability floor
 * @returns {string} a complete HTML document
 */
export function buildConcertProgramHtml({ title, items, studentsById, abbreviations, scale = 1 }) {
  const rows = buildProgramRows(items, studentsById, abbreviations);
  const L    = layoutProgram({ title, rows, scale });

  // ── Vertical distribution (§4.7: fill the page, don't pack to the top) ──
  //
  // SINGLE PAGE: the slack is spread into the gaps between pieces so a
  // short program breathes instead of leaving a block of white below it.
  // The per-gap share is capped at 3× the base gap so a two-piece program
  // doesn't end up with its pieces half a page apart, and whatever slack
  // the cap leaves over is split above and below — centring the block
  // vertically, which reads as deliberate rather than as a gap at the end.
  //
  // MULTI-PAGE: no distribution at all. The full pages are already packed
  // to capacity, and the FINAL page is left top-aligned with however
  // little it holds. A half-full last page is NOT stretched to fill —
  // stretched-out orphans look like a layout fault, and spacing that
  // changes from page to page is worse than honest white space at the end.
  let extraGap = 0;
  let topPad   = 0;
  if (L.pageCount === 1) {
    const contentH = L.headingH
      + L.blockH.reduce((a, b) => a + b, 0)
      + Math.max(0, rows.length - 1) * L.baseGap;
    const slack = Math.max(0, USABLE_H_PT - contentH);
    const gaps  = Math.max(0, rows.length - 1);
    if (gaps > 0) extraGap = Math.min(slack / gaps, L.baseGap * 3);
    topPad = Math.max(0, (slack - extraGap * gaps) / 2);
  }

  const pt = n => `${Math.round(n * 100) / 100}pt`;

  const piecesHtml = rows.map((r, i) => `
    <div class="piece"${i > 0 ? ` style="margin-top:${pt(L.baseGap + extraGap)}"` : ""}>
      <div class="piece-title">${esc(r.title || "Untitled")}</div>
      ${r.performers ? `<div class="performers">${esc(r.performers)}</div>` : ""}
    </div>`).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>${esc(title || "Concert Program")}</title>
<style>
  /* Portrait is set HERE, not via bridge options — preload.js drops them. */
  @page { size: A4 portrait; margin: ${MARGIN_V_MM}mm ${MARGIN_H_MM}mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #FFFFFF; }
  body {
    /* System sans rather than a serif: no fine strokes to lose in the
       dim hall this is read in. */
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    color: #000000;
    text-align: center;              /* §4.7 — everything centred */
    -webkit-font-smoothing: antialiased;
  }
  .heading {
    font-size: ${pt(L.headingPt)};
    line-height: 1.22;
    font-weight: 700;
    margin: 0 0 ${pt(L.headingPt * 0.9)};
    /* The heading repeating mid-program would read as a second concert. */
    break-inside: avoid; page-break-inside: avoid;
  }
  /* A piece is atomic: its title never sits on one page with its
     performers on the next. This is the renderer-side half of the same
     guarantee layoutProgram() models when it packs pages. */
  .piece { break-inside: avoid; page-break-inside: avoid; }
  .piece-title {
    font-size: ${pt(L.piecePt)};
    line-height: 1.30;
    font-weight: 600;
  }
  .performers {
    font-size: ${pt(L.perfPt)};
    line-height: 1.45;
    margin-top: ${pt(L.perfPt * 0.30)};
    /* Long runs of performers wrap rather than shrinking the whole
       program; centred so the ragged edges balance. */
    word-wrap: break-word;
  }
</style>
</head>
<body>
  <div style="padding-top:${pt(topPad)}">
    ${(title || "").trim() ? `<div class="heading">${esc(title)}</div>` : ""}
    ${piecesHtml}
  </div>
</body>
</html>`;
}
