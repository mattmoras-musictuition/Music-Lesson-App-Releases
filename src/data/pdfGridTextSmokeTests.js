// ============================================================
// PDF time-grid reader (utils/pdfGridText.js). Called from runSmokeTests
// with its `assert`. Synthetic page data only — no real PDF, no AI call.
// The fixture copies the EBPS "Specialist 1.10.26" layout: day headings at
// y=785, axis labels 9:00am at y=732 … 2:30pm at y=247 (y grows upward),
// 1pt-inset cards, white NFFT/Acc badges, full-width Recess band.
// ============================================================

import {
  parseClockLabel, parseDayHeading, collectFilledRects, extractGridCards,
  formatGridCardsBlock, buildSpecialistPrompt, buildSpecialistPdfRequest, parseSpecialistReply, replyEntryFields,
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

// Shared Import/Update request and reply handling. No AI call: the request
// is built and inspected, and replies are hand-written API JSON.
export function runSpecialistPdfRequestTests(assert) {
  const cards = [
    { page: 1, day: "Monday", start: "10:00", end: "11:00", text: "French 6A Carmen Higgins MAIN8 NFFT" },
    { page: 2, day: "Friday", start: "09:00", end: "11:00", text: "Interschool | Sports  56P, 56S" },
  ];
  assert("pdf req: measured block lines", formatGridCardsBlock(cards).split("\n").slice(1), [
    "page | day | start | end | card text",
    "1 | Monday | 10:00 | 11:00 | French 6A Carmen Higgins MAIN8 NFFT",
    "2 | Friday | 09:00 | 11:00 | Interschool / Sports 56P, 56S",
  ]);
  assert("pdf req: measured block heading", formatGridCardsBlock(cards).startsWith("MEASURED CARD POSITIONS"), true);

  const prompt = buildSpecialistPrompt();
  assert("pdf prompt: no estimate rule", /estimate based on typical school day/.test(prompt), false);
  assert("pdf prompt: printed times win", prompt.includes("- Times printed in the document always take priority"), true);
  assert("pdf prompt: use measured positions", prompt.includes("If a MEASURED CARD POSITIONS block is supplied and times are not printed on the cards, use its day, start and end for each card exactly as given"), true);
  assert("pdf prompt: one entry per class", prompt.includes("Output one entry per class on a card"), true);
  assert("pdf prompt: never from text order", prompt.includes("- Never work out times from the order of the text"), true);
  assert("pdf prompt: unknown times stay empty", prompt.includes('still include the entry with start and end as empty strings (""); never guess'), true);
  assert("pdf prompt: skip classless cards", prompt.includes("- Skip cards that have no class/grade on them"), true);
  assert("pdf prompt: schema unchanged", prompt.includes('[{"class":"3A","day":"Monday","start":"09:00","end":"09:50","subject":"Art"}]'), true);
  assert("pdf prompt: no instructions → no block", prompt.includes("SPECIFIC INSTRUCTIONS FROM THE USER"), false);
  const withInstr = buildSpecialistPrompt({ instructions: "  Only Prep-2  " });
  assert("pdf prompt: instructions block last", withInstr.endsWith("SPECIFIC INSTRUCTIONS FROM THE USER about this document. Follow these carefully, they override general assumptions:\n---\nOnly Prep-2\n---"), true);
  assert("pdf prompt: preamble first", buildSpecialistPrompt({ preamble: "UPDATE CONTEXT" }).startsWith("UPDATE CONTEXT\n\nThis PDF contains"), true);

  const withGrid = JSON.parse(buildSpecialistPdfRequest({ base64: "QUJD", gridCards: cards }).body);
  assert("pdf req: grid → PDF, measured block, prompt", withGrid.messages[0].content.map(c => c.type + (c.type === "text" ? ":" + c.text.slice(0, 12) : "")), ["document", "text:MEASURED CAR", "text:This PDF con"]);
  assert("pdf req: native PDF kept", withGrid.messages[0].content[0].source, { type: "base64", media_type: "application/pdf", data: "QUJD" });
  assert("pdf req: reply cap 16000", withGrid.max_tokens, 16000);
  const noGrid = JSON.parse(buildSpecialistPdfRequest({ base64: "QUJD", gridCards: null }).body);
  assert("pdf req: not a grid → PDF and prompt only", noGrid.messages[0].content.map(c => c.type), ["document", "text"]);
  const emptyGrid = JSON.parse(buildSpecialistPdfRequest({ base64: "QUJD", gridCards: [] }).body);
  assert("pdf req: grid with no cards → no block", emptyGrid.messages[0].content.length, 2);

  const reply = text => ({ content: [{ type: "text", text }] });
  const ok = parseSpecialistReply(reply('```json\n[{"class":"6A","day":"Monday","start":"10:00","end":"11:00","subject":"French"}]\n```'));
  assert("pdf reply: fenced JSON", ok, { entries: [{ class: "6A", day: "Monday", start: "10:00", end: "11:00", subject: "French" }], truncated: false });
  const cut = parseSpecialistReply(reply('[{"class":"6A","day":"Monday","start":"10:00","end":"11:00","subject":"French"},{"class":"5L","day":"Mon'));
  assert("pdf reply: cut-off reply keeps complete rows", [cut.entries.length, cut.truncated], [1, true]);
  const throws = d => { try { parseSpecialistReply(d); return null; } catch (e) { return e.message.split("\n")[0]; } };
  assert("pdf reply: empty", throws(reply("  ")), "AI returned an empty response. The PDF may be image-based or unreadable. Try a clearer PDF or use a spreadsheet instead.");
  assert("pdf reply: API error", throws({ error: { message: "overloaded" } }), "AI error: overloaded");
  assert("pdf reply: not JSON", throws(reply("Sorry, no")), "AI response wasn't valid JSON.");
  assert("pdf reply: empty array", throws(reply("[]")), "AI could not find any specialist entries in this document. Try adding more specific instructions about what to look for.");

  // Times the AI could not determine come back empty and stay empty —
  // the Review screen shows a blank time box for the owner to fill in.
  const blank = parseSpecialistReply(reply('[{"class":"6A","day":"Monday","start":"","end":"","subject":"French"},{"class":"5L","day":"Friday","subject":"PE"}]'));
  assert("pdf reply: empty times accepted", blank.entries.map(replyEntryFields), [
    { className: "6A", day: "Monday", start: "", end: "", subject: "French" },
    { className: "5L", day: "Friday", start: "", end: "", subject: "PE" },
  ]);
}

// Update path (v2.49.20): it now builds its PDF request with the shared
// builder, so it carries the API-key headers (it used to send Content-Type
// only), the 16,000 cap, the measured block and the Import prompt, with
// the existing entries first. Headers are compared with getAnthropicHeaders()
// rather than set here, so the running app's key is never touched.
export function runSpecialistUpdateRequestTests(assert) {
  const cards = [{ page: 1, day: "Friday", start: "11:30", end: "12:00", text: "Recorder 1I Mia Pisano MAIN10 Acc" }];
  const req = buildSpecialistPdfRequest({ base64: "QUJD", gridCards: cards, instructions: "Week A only", preamble: "This is an UPDATED specialist class timetable for EBPS." });
  assert("update req: POST", req.method, "POST");
  assert("update req: API-key headers", req.headers, getAnthropicHeaders());
  assert("update req: JSON content type", req.headers["Content-Type"], "application/json");
  const body = JSON.parse(req.body);
  assert("update req: 16,000 cap", body.max_tokens, 16000);
  assert("update req: measured block sent", body.messages[0].content[1].text.split("\n")[2], "1 | Friday | 11:30 | 12:00 | Recorder 1I Mia Pisano MAIN10 Acc");
  const prompt = body.messages[0].content[2].text;
  assert("update req: existing-entries context first", prompt.startsWith("This is an UPDATED specialist class timetable for EBPS.\n\nThis PDF contains"), true);
  assert("update req: same rules as Import", prompt.includes("- Never work out times from the order of the text"), true);
  assert("update req: instructions block", prompt.endsWith("---\nWeek A only\n---"), true);
}
