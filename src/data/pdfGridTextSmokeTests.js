// ============================================================
// PDF time-grid reader (utils/pdfGridText.js). Called from runSmokeTests
// with its `assert`. Synthetic page data only — no real PDF, no AI call.
// The fixture copies the EBPS "Specialist 1.10.26" layout: day headings at
// y=785, axis labels 9:00am at y=732 … 2:30pm at y=247 (y grows upward),
// 1pt-inset cards, white NFFT/Acc badges, full-width Recess band.
// ============================================================

import {
  parseClockLabel, parseDayHeading, collectFilledRects, extractGridCards,
  buildSpecialistPrompt, buildSpecialistPdfRequest, parseSpecialistReply, replyEntryFields,
  formatCardList, buildGridPrompt, buildSpecialistGridRequest, parseStructuredReply, joinGridReply, extractSpecialistRows,
  ENTRY_SCHEMA, CARD_SCHEMA, OUT_OF_ROOM_MESSAGE, readPdfGridCards,
} from "../utils/pdfGridText";
import { getAnthropicHeaders } from "../utils/api";

const K = 485 / 330; // pt per minute (9:00 → 2:30 spans 485pt)
const LABEL_H = 6;
const labelY = min => 732 - (min - 540) * K;          // label baseline
const lineY = min => labelY(min) + LABEL_H * 0.35;     // the grid line the label marks
const hm = s => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };

const DAY_CX = { Monday: 170.6, Tuesday: 392.6, Wednesday: 614.6, Thursday: 836.6, Friday: 1058.6 };
const COL = d => ({ x0: DAY_CX[d] - 110.6, x1: DAY_CX[d] + 110.6 }); // 221.2 wide, like EBPS

const text = (str, x, y, h = 7.5, w = str.length * 4) => ({ str, x, y, w, h });

function axisAndHeadings(days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]) {
  const items = [];
  for (let min = 510; min <= 870; min += 30) {
    const h = Math.floor(min / 60), m = min % 60;
    const h12 = h > 12 ? h - 12 : h;
    const s = h12 + ":" + String(m).padStart(2, "0") + (h >= 12 ? "pm" : "am");
    items.push(text(s, 56 - s.length * 3.3, labelY(min), LABEL_H, s.length * 3.3));
  }
  for (const d of days) items.push(text(d, DAY_CX[d] - d.length * 2.5, 785, 7.9, d.length * 5));
  return items;
}

// One card: rect inset like EBPS (top on the start line, 2.5pt gap at the
// bottom), subject / class / teacher / room lines, optional badge.
function card(day, start, end, lines, { slot = 0, slots = 4, badge = "NFFT" } = {}) {
  const c = COL(day);
  const w = (c.x1 - c.x0 - 2) / slots;
  const x0 = c.x0 + 1.1 + slot * w;
  const x1 = x0 + w - 2.2;
  const y1 = lineY(hm(start));
  const y0 = lineY(hm(end)) + 2.5;
  const rects = [{ x0, y0, x1, y1 }];
  const items = lines.map((s, i) => text(s, x0 + 3, y1 - 9.3 - i * 8.7, 7.5, Math.min(s.length * 4, x1 - x0 - 6)));
  if (badge) {
    rects.push({ x0: x1 - 16, y0: y0 + 1.2, x1: x1 - 1, y1: y0 + 10.2 });
    items.push(text(badge, x1 - 14, y0 + 3.4, 5.25, 11.8));
  }
  return { rects, items };
}

function band(day, start, end, label) {
  const c = COL(day);
  return { rects: [{ x0: c.x0, y0: lineY(hm(end)), x1: c.x1, y1: lineY(hm(start)) }], items: [text(label, c.x0 + 3, lineY(hm(start)) - 20)] };
}

function gridLines(day) {
  const c = COL(day);
  const rects = [];
  for (let min = 510; min <= 960; min += 15) rects.push({ x0: c.x0, y0: lineY(min) - 0.35, x1: c.x1, y1: lineY(min) + 0.35 });
  return { rects, items: [] };
}

function page(...parts) {
  return {
    items: [...axisAndHeadings(), ...parts.flatMap(p => p.items)],
    rects: parts.flatMap(p => p.rects),
  };
}

const row = c => c.day + " " + c.start + "-" + c.end + " " + c.text;

export function runPdfGridTextTests(assert) {
  // ── Clock labels and day headings ──
  assert("grid: 9:00am", parseClockLabel("9:00am"), 540);
  assert("grid: 12:30pm", parseClockLabel("12:30pm"), 750);
  assert("grid: 12:00am is midnight", parseClockLabel("12:00am"), 0);
  assert("grid: 2:30 pm with space", parseClockLabel("2:30 pm"), 870);
  assert("grid: 24h 14:30", parseClockLabel("14:30"), 870);
  assert("grid: bare 2:30 read as afternoon", parseClockLabel("2:30"), 870);
  assert("grid: 9am", parseClockLabel("9am"), 540);
  assert("grid: class code is not a time", parseClockLabel("34D"), null);
  assert("grid: plain number is not a time", parseClockLabel("12"), null);
  assert("grid: day heading full", parseDayHeading("Wednesday"), "Wednesday");
  assert("grid: day heading short", parseDayHeading("Thurs"), "Thursday");
  assert("grid: not a day", parseDayHeading("Recess"), null);

  // ── EBPS Monday: starts 9:00 / 10:00 / 11:30 / 12:30 / 2:30 ──
  const ebps = page(
    gridLines("Monday"),
    band("Monday", "11:00", "11:30", "Recess"),
    card("Monday", "09:00", "10:00", ["PE", "5L", "John Seeary", "HALL"], { slot: 2 }),
    card("Monday", "10:00", "11:00", ["French", "6A", "Carmen Higgins", "MAIN8"], { slot: 2 }),
    card("Monday", "11:30", "12:30", ["Kitchen", "34D", "Nikki Gordon", "KITCHEN"], { slot: 0, slots: 3 }),
    card("Monday", "12:30", "13:30", ["PE", "12H", "John Seeary", "HALL"], { slot: 1 }),
    card("Monday", "14:30", "15:30", ["Kitchen", "34R", "Nikki Gordon", "KITCHEN"], { slot: 0 }),
  );
  const res = extractGridCards(ebps.items, ebps.rects);
  assert("grid: EBPS Monday cards", ((res && res.cards) || []).map(row), [
    "Monday 09:00-10:00 PE 5L John Seeary HALL NFFT",
    "Monday 10:00-11:00 French 6A Carmen Higgins MAIN8 NFFT",
    "Monday 11:30-12:30 Kitchen 34D Nikki Gordon KITCHEN NFFT",
    "Monday 12:30-13:30 PE 12H John Seeary HALL NFFT",
    "Monday 14:30-15:30 Kitchen 34R Nikki Gordon KITCHEN NFFT",
  ]);
  assert("grid: EBPS nothing unplaced", res && res.unplaced, []);
  assert("grid: page number defaults to 1", res && res.cards.map(c => c.page), [1, 1, 1, 1, 1]);
  assert("grid: page number passed through", extractGridCards(ebps.items, ebps.rects, { page: 3 }).cards[0].page, 3);
  assert("grid: Recess band is not a card", res && res.cards.some(c => /Recess/.test(c.text)), false);

  // ── Short cards with offset starts ──
  const short = page(
    gridLines("Thursday"),
    card("Thursday", "09:30", "10:00", ["Folk Dance", "34D"], { badge: "Acc" }),
    card("Thursday", "10:15", "11:00", ["Folk Dance", "34T"], { badge: "Acc" }),
  );
  assert("grid: 30 and 45 minute cards", extractGridCards(short.items, short.rects).cards.map(row), [
    "Thursday 09:30-10:00 Folk Dance 34D Acc",
    "Thursday 10:15-11:00 Folk Dance 34T Acc",
  ]);

  // ── Side-by-side cards in one day stay separate ──
  const side = page(
    gridLines("Tuesday"),
    card("Tuesday", "09:00", "10:00", ["Art", "3A"], { slot: 0 }),
    card("Tuesday", "09:00", "10:00", ["Music", "3B"], { slot: 1 }),
    card("Tuesday", "09:00", "10:00", ["LOTE", "3C"], { slot: 2 }),
  );
  assert("grid: side-by-side cards", extractGridCards(side.items, side.rects).cards.map(row), [
    "Tuesday 09:00-10:00 Art 3A NFFT",
    "Tuesday 09:00-10:00 Music 3B NFFT",
    "Tuesday 09:00-10:00 LOTE 3C NFFT",
  ]);

  // ── A card as wide as the column (inset) is kept; the edge-to-edge band is not ──
  const wideCard = page(
    gridLines("Friday"),
    band("Friday", "11:00", "11:30", "Recess"),
    card("Friday", "09:00", "11:00", ["Interschool Sports", "56P, 56S, 5L, 6A", "John Seeary", "OFFSITE"], { slots: 1, badge: "Acc" }),
    card("Friday", "11:30", "12:00", ["Recorder", "1I"], { badge: "Acc" }),
  );
  assert("grid: full-width card kept, band dropped", extractGridCards(wideCard.items, wideCard.rects).cards.map(row), [
    "Friday 09:00-11:00 Interschool Sports 56P, 56S, 5L, 6A John Seeary OFFSITE Acc",
    "Friday 11:30-12:00 Recorder 1I Acc",
  ]);

  // ── Shapes with no words are ignored; a card under no heading is reported ──
  const stray = page(
    gridLines("Monday"),
    { rects: [{ x0: 70, y0: lineY(hm("10:00")), x1: 110, y1: lineY(hm("09:00")) }], items: [] },
    { rects: [{ x0: 1300, y0: lineY(hm("10:00")), x1: 1350, y1: lineY(hm("09:00")) }], items: [text("Club", 1305, lineY(hm("09:00")) - 9)] },
  );
  const strayRes = extractGridCards(stray.items, stray.rects);
  assert("grid: empty shape ignored", strayRes.cards, []);
  assert("grid: card outside the day columns is unplaced", strayRes.unplaced.map(u => u.text + " / " + u.reason), ["Club / not under a day heading"]);

  // ── Not a time grid → null ──
  const noAxis = { items: axisAndHeadings().filter(t => parseClockLabel(t.str) == null), rects: ebps.rects };
  assert("grid: no time axis → null", extractGridCards(noAxis.items, noAxis.rects), null);
  const noDays = { items: axisAndHeadings([]).concat(ebps.items.filter(t => !parseDayHeading(t.str))), rects: ebps.rects };
  assert("grid: no day headings → null", extractGridCards(noDays.items, noDays.rects), null);
  const oneDay = { items: axisAndHeadings(["Monday"]), rects: ebps.rects };
  assert("grid: a single day heading → null", extractGridCards(oneDay.items, oneDay.rects), null);
  // Printed-times table: time column + day row but no filled cards → no cards.
  const table = { items: axisAndHeadings().concat([text("Art 3A", 150, labelY(540))]), rects: [] };
  assert("grid: printed table with no cards → empty list", extractGridCards(table.items, table.rects), { cards: [], unplaced: [] });

  // ── Drawing data: transforms, save/restore, forms, stroke vs fill ──
  const OPS = { save: 10, restore: 11, transform: 12, constructPath: 91, paintFormXObjectBegin: 74, paintFormXObjectEnd: 75,
    stroke: 20, fill: 22, eoFill: 23, fillStroke: 24, eoFillStroke: 25, closeFillStroke: 26, closeEOFillStroke: 27, endPath: 28 };
  const fns = [OPS.save, OPS.transform, OPS.constructPath, OPS.constructPath, OPS.restore,
    OPS.paintFormXObjectBegin, OPS.constructPath, OPS.paintFormXObjectEnd, OPS.constructPath, OPS.constructPath];
  const args = [null, [0.75, 0, 0, -0.75, 0, 842], [OPS.fill, [], [0, 0, 100, 40]], [OPS.stroke, [], [0, 0, 5, 5]], null,
    [[2, 0, 0, 2, 10, 10], [0, 0, 1, 1]], [OPS.eoFill, [], [0, 0, 5, 5]], null, [OPS.endPath, [], [0, 0, 9, 9]], [OPS.fill, [], [1, 2, 3, 4]]];
  assert("grid: filled rects through transforms", collectFilledRects(fns, args, OPS), [
    { x0: 0, y0: 812, x1: 75, y1: 842 },
    { x0: 10, y0: 10, x1: 20, y1: 20 },
    { x0: 1, y0: 2, x1: 3, y1: 4 },
  ]);
}

// Shared Import/Update request and reply handling. No AI call: requests
// are built and inspected, replies are hand-written API JSON, and the whole
// flow runs against a fake fetch.
const reply = (text, stop_reason = "end_turn") => ({ content: [{ type: "text", text }], stop_reason });
const throws = fn => { try { fn(); return null; } catch (e) { return e.message.split("\n")[0]; } };

const MEASURED = [
  { page: 1, day: "Monday", start: "10:00", end: "11:00", text: "French 6A Carmen Higgins MAIN8 NFFT" },
  { page: 1, day: "Monday", start: "12:30", end: "13:00", text: "Specialist …" },
  { page: 1, day: "Friday", start: "09:00", end: "11:00", text: "Interschool | Sports  56P, 56S, 5L, 6A John Seeary OFFSITE Acc" },
];

export function runSpecialistPdfRequestTests(assert, assertAsync) {
  // ── Grid path request: numbered cards, no times, no PDF ──
  assert("grid req: card list", formatCardList(MEASURED).split("\n"), [
    "1 | French 6A Carmen Higgins MAIN8 NFFT",
    "2 | Specialist …",
    "3 | Interschool / Sports 56P, 56S, 5L, 6A John Seeary OFFSITE Acc",
  ]);
  const gridPrompt = buildGridPrompt({ cards: MEASURED });
  assert("grid prompt: no times sent", /\d{1,2}:\d{2}/.test(gridPrompt), false);
  assert("grid prompt: skip classless cards", gridPrompt.includes("Leave out cards with no class/grade on them"), true);
  assert("grid prompt: skip what instructions say", gridPrompt.includes("Leave out cards the user's instructions say to skip"), true);
  assert("grid prompt: no explanation", gridPrompt.includes("Never write explanation"), true);
  assert("grid prompt: instructions block last", buildGridPrompt({ cards: MEASURED, instructions: " Ignore Ready Room " }).endsWith("---\nIgnore Ready Room\n---"), true);
  const gridReq = buildSpecialistGridRequest({ cards: MEASURED });
  const gridBody = JSON.parse(gridReq.body);
  assert("grid req: API-key headers", gridReq.headers, getAnthropicHeaders());
  assert("grid req: no PDF sent", gridBody.messages[0].content.map(c => c.type), ["text"]);
  assert("grid req: structured reply", gridBody.output_config, { format: { type: "json_schema", schema: CARD_SCHEMA } });
  assert("grid req: 16,000 cap", gridBody.max_tokens, 16000);
  assert("grid schema: card / classes / subject", CARD_SCHEMA.properties.cards.items.required, ["card", "classes", "subject"]);

  // ── Native path request: PDF + prompt, structured reply ──
  const pdfBody = JSON.parse(buildSpecialistPdfRequest({ base64: "QUJD" }).body);
  assert("pdf req: PDF then prompt", pdfBody.messages[0].content.map(c => c.type), ["document", "text"]);
  assert("pdf req: native PDF kept", pdfBody.messages[0].content[0].source, { type: "base64", media_type: "application/pdf", data: "QUJD" });
  assert("pdf req: structured reply", pdfBody.output_config, { format: { type: "json_schema", schema: ENTRY_SCHEMA } });
  assert("pdf schema: row fields", ENTRY_SCHEMA.properties.entries.items.required, ["class", "day", "start", "end", "subject"]);
  assert("pdf prompt: no estimate rule", /estimate based on typical school day/.test(buildSpecialistPrompt()), false);
  assert("pdf prompt: instructions block last", buildSpecialistPrompt({ instructions: "  Only Prep-2  " }).endsWith("---\nOnly Prep-2\n---"), true);
  assert("pdf prompt: preamble first", buildSpecialistPrompt({ preamble: "UPDATE CONTEXT" }).startsWith("UPDATE CONTEXT\n\nThis PDF contains"), true);

  // ── Join: the app's times always win ──
  const join = joinGridReply(MEASURED, [
    { card: 3, classes: ["56P", "56S", "5L", "6A"], subject: "PE" },
    { card: 1, classes: ["6A"], subject: "French" },
    { card: 9, classes: ["1I"], subject: "Art" },
    { card: 1, classes: ["6B"], subject: "Music" },
  ]);
  assert("join: rows (multi-class card → one row each, same times)", join.rows, [
    { className: "56P", day: "Friday", start: "09:00", end: "11:00", subject: "PE" },
    { className: "56S", day: "Friday", start: "09:00", end: "11:00", subject: "PE" },
    { className: "5L", day: "Friday", start: "09:00", end: "11:00", subject: "PE" },
    { className: "6A", day: "Friday", start: "09:00", end: "11:00", subject: "PE" },
    { className: "6A", day: "Monday", start: "10:00", end: "11:00", subject: "French" },
  ]);
  assert("join: skipped card gives no rows", join.rows.some(r => r.start === "12:30"), false);
  assert("join: unknown and duplicate counted", [join.unknown, join.duplicate, join.cardsUsed], [1, 1, 2]);
  assert("join: times always the measured ones", joinGridReply(MEASURED, [{ card: 1, classes: ["6A"], subject: "French", start: "09:00", day: "Tuesday" }]).rows[0], { className: "6A", day: "Monday", start: "10:00", end: "11:00", subject: "French" });
  assert("join: comma-joined classes split", joinGridReply(MEASURED, [{ card: 3, classes: ["56P, 56S"], subject: "PE" }]).rows.map(r => r.className), ["56P", "56S"]);
  assert("join: bad card numbers ignored", joinGridReply(MEASURED, [{ card: 0, classes: ["x"] }, { card: "2.5", classes: ["y"] }, { classes: ["z"] }]), { rows: [], cardsUsed: 0, unknown: 3, duplicate: 0 });

  // ── Reply parsing ──
  assert("reply: structured object", parseStructuredReply(reply('{"cards":[{"card":1,"classes":["6A"],"subject":"French"}]}'), "cards"), { items: [{ card: 1, classes: ["6A"], subject: "French" }], truncated: false });
  assert("reply: bare array still accepted", parseSpecialistReply(reply('```json\n[{"class":"6A","day":"Monday","start":"10:00","end":"11:00","subject":"French"}]\n```')).entries.length, 1);
  assert("reply: first array pulled out of prose", parseStructuredReply(reply('Here you go: [{"card":2,"classes":["5L"],"subject":"PE"}] hope that helps [1]'), "cards").items, [{ card: 2, classes: ["5L"], subject: "PE" }]);
  const outOfRoom = parseStructuredReply(reply('{"cards":[{"card":1,"classes":["6A"],"subject":"French"},{"card":2,"classes":["5', "max_tokens"), "cards");
  assert("reply: out of room keeps complete items", [outOfRoom.items.length, outOfRoom.truncated], [1, true]);
  assert("reply: out of room with nothing complete → plain message", throws(() => parseStructuredReply(reply("Looking at the timetable carefully, I need to", "max_tokens"))), OUT_OF_ROOM_MESSAGE);
  assert("reply: out-of-room message is plain", /couldn't be recovered/.test(OUT_OF_ROOM_MESSAGE), false);
  assert("reply: cut off without stop reason still salvaged", parseSpecialistReply(reply('[{"class":"6A","day":"Monday","start":"10:00","end":"11:00","subject":"French"},{"class":"5L","day":"Mon')).truncated, true);
  assert("reply: empty", throws(() => parseSpecialistReply(reply("  "))), "AI returned an empty response. The PDF may be image-based or unreadable. Try a clearer PDF or use a spreadsheet instead.");
  assert("reply: API error", throws(() => parseSpecialistReply({ error: { message: "overloaded" } })), "AI error: overloaded");
  assert("reply: refusal", throws(() => parseSpecialistReply(reply("", "refusal"))), "The AI declined to read this document. Try again, or use a spreadsheet instead.");
  assert("reply: prose, not out of room", throws(() => parseSpecialistReply(reply("Sorry, no"))), "AI response wasn't valid JSON.");
  assert("reply: empty list", throws(() => parseSpecialistReply(reply('{"entries":[]}'))), "AI could not find any specialist entries in this document. Try adding more specific instructions about what to look for.");

  // Times the AI could not determine come back empty and stay empty —
  // the Review screen shows a blank time box for the owner to fill in.
  const blank = parseSpecialistReply(reply('{"entries":[{"class":"6A","day":"Monday","start":"","end":"","subject":"French"},{"class":"5L","day":"Friday","subject":"PE"}]}'));
  assert("reply: empty times accepted", blank.entries.map(replyEntryFields), [
    { className: "6A", day: "Monday", start: "", end: "", subject: "French" },
    { className: "5L", day: "Friday", start: "", end: "", subject: "PE" },
  ]);

  // ── Whole flow against a fake fetch ──
  const fakeFetch = (data, sent) => async (url, req) => { sent.push(JSON.parse(req.body)); return { ok: true, status: 200, json: async () => data, text: async () => "" }; };
  const sentGrid = [];
  assertAsync("flow: grid → rows with measured times, no PDF sent", extractSpecialistRows({
    pdfBytes: new Uint8Array(1), base64: "QUJD",
    readGrid: async () => ({ cards: MEASURED, unplaced: [] }),
    fetchFn: fakeFetch(reply('{"cards":[{"card":1,"classes":["6A"],"subject":"French"},{"card":3,"classes":["56P","56S","5L","6A"],"subject":"PE"}]}'), sentGrid),
  }).then(r => [r.rows.length, r.rows[0], r.measured, sentGrid[0].messages[0].content.map(c => c.type)]), [
    5, { className: "6A", day: "Monday", start: "10:00", end: "11:00", subject: "French" },
    { cards: 3, entries: 5, unknown: 0, duplicate: 0 }, ["text"],
  ]);
  const sentPdf = [];
  assertAsync("flow: not a grid → PDF path, measured null", extractSpecialistRows({
    pdfBytes: new Uint8Array(1), base64: "QUJD",
    readGrid: async () => null,
    fetchFn: fakeFetch(reply('{"entries":[{"class":"3A","day":"Monday","start":"09:00","end":"09:50","subject":"Art"}]}'), sentPdf),
  }).then(r => [r.rows, r.measured, sentPdf[0].messages[0].content.map(c => c.type)]), [
    [{ className: "3A", day: "Monday", start: "09:00", end: "09:50", subject: "Art" }], null, ["document", "text"],
  ]);
  assertAsync("flow: HTTP error reported", extractSpecialistRows({
    pdfBytes: new Uint8Array(1), base64: "QUJD", readGrid: async () => null,
    fetchFn: async () => ({ ok: false, status: 529, text: async () => "overloaded" }),
  }).then(() => "no error", e => e.message), "AI service returned error 529: overloaded");
}

// Update path: builds its PDF request with the shared builder, so it carries
// the API-key headers, the 16,000 cap, the Import prompt and a structured
// reply, with the existing entries first. Headers are compared with
// getAnthropicHeaders() rather than set here, so the app's key is untouched.
export function runSpecialistUpdateRequestTests(assert) {
  const req = buildSpecialistPdfRequest({ base64: "QUJD", instructions: "Week A only", preamble: "This is an UPDATED specialist class timetable for EBPS." });
  assert("update req: POST", req.method, "POST");
  assert("update req: API-key headers", req.headers, getAnthropicHeaders());
  assert("update req: JSON content type", req.headers["Content-Type"], "application/json");
  const body = JSON.parse(req.body);
  assert("update req: 16,000 cap", body.max_tokens, 16000);
  assert("update req: structured reply", body.output_config.format.type, "json_schema");
  const prompt = body.messages[0].content[1].text;
  assert("update req: existing-entries context first", prompt.startsWith("This is an UPDATED specialist class timetable for EBPS.\n\nThis PDF contains"), true);
  assert("update req: instructions block", prompt.endsWith("---\nWeek A only\n---"), true);
}

// Non-grid PDFs and grid-read failures (v2.49.21). The native prompt has no
// measured-block rules; "no grid" is silent, a failed read is reported.
export function runSpecialistNonGridTests(assert, assertAsync) {
  const p = buildSpecialistPrompt();
  assert("native prompt: no block rules", /MEASURED|card positions|order of the text/i.test(p), false);
  assert("native prompt: printed times first", p.includes("- Times printed in the document take priority"), true);
  assert("native prompt: read layout when not printed", p.includes("- Where times are not printed, read them from the document's layout as best you can"), true);
  assert("native prompt: unknown times empty", p.includes('- If a time cannot be determined, still include the entry with start and end as empty strings ("")'), true);
  assert("native prompt: never explain", p.includes("- Never write explanation; return only the data"), true);
  assert("native prompt: entries wrapper example", p.includes('{"entries":[{"class":"3A","day":"Monday","start":"09:00","end":"09:50","subject":"Art"}]}'), true);

  // A stand-in pdf.js: one page whose text/drawing come from `page`.
  const fakePdfjs = (page, { failOpen = false } = {}) => ({
    OPS: { save: 10, restore: 11, transform: 12, constructPath: 91, paintFormXObjectBegin: 74, paintFormXObjectEnd: 75, fill: 22, eoFill: 23, fillStroke: 24, eoFillStroke: 25, closeFillStroke: 26, closeEOFillStroke: 27 },
    getDocument: () => ({ promise: failOpen ? Promise.reject(new Error("e is not async iterable")) : Promise.resolve({
      numPages: 1,
      getPage: async () => page,
      destroy: () => {},
    }) }),
  });
  const textOnly = { getTextContent: async () => ({ items: [{ str: "Art 3A Monday 9:00-9:50", transform: [8, 0, 0, 8, 50, 700], width: 90, height: 8 }] }), getOperatorList: async () => ({ fnArray: [], argsArray: [] }) };
  assertAsync("grid read: not a grid → null (silent)", readPdfGridCards(new Uint8Array(4), fakePdfjs(textOnly)), null);
  assertAsync("grid read: failure → { error }", readPdfGridCards(new Uint8Array(4), fakePdfjs(textOnly, { failOpen: true })), { error: "e is not async iterable" });
  const throwingText = { getTextContent: async () => { throw new TypeError("e is not async iterable"); }, getOperatorList: async () => ({ fnArray: [], argsArray: [] }) };
  assertAsync("grid read: getTextContent throwing → { error }", readPdfGridCards(new Uint8Array(4), fakePdfjs(throwingText)), { error: "e is not async iterable" });

  const sent = [];
  const fetchFn = async (url, req) => { sent.push(JSON.parse(req.body)); return { ok: true, status: 200, json: async () => ({ stop_reason: "end_turn", content: [{ type: "text", text: '{"entries":[{"class":"3A","day":"Monday","start":"","end":"","subject":"Art"}]}' }] }), text: async () => "" }; };
  assertAsync("flow: failed grid read → native PDF path with gridError", extractSpecialistRows({
    pdfBytes: new Uint8Array(4), base64: "QUJD", fetchFn, readGrid: async () => ({ error: "e is not async iterable" }),
  }).then(r => [r.gridError, r.measured, r.rows, sent[0].messages[0].content.map(c => c.type)]), [
    "e is not async iterable", null, [{ className: "3A", day: "Monday", start: "", end: "", subject: "Art" }], ["document", "text"],
  ]);
  assertAsync("flow: no grid → no gridError", extractSpecialistRows({
    pdfBytes: new Uint8Array(4), base64: "QUJD", fetchFn, readGrid: async () => null,
  }).then(r => r.gridError), null);
}
