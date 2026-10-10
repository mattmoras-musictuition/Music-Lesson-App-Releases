// ============================================================
// Dashboard to-do: one item per dragged email message
// (utils/todoEmailKey.js). Called from runSmokeTests with its `assert`.
// The drop() model mirrors dropEmailToTodo through planEmailDrop: skip when
// the message is covered, else add a new item. Only the multi-select add
// (groupBySubject) still folds into a subject match.
// ============================================================

import {
  draggedMessage, draggedMessageId, todoCoversMessage, isSameThreadTodo, findSubjectGroupIdx, todoMessageKey, planEmailDrop,
  plainEmailTask, emailForMessage,
} from "../utils/todoEmailKey";

export function runTodoEmailKeyTests(assert) {
  const msg = (id, t, extra = {}) => ({ id, messageId: id, from: "Pat <pat@x.com>", internalDate: t, isSent: false, ...extra });
  // One thread, viewed at two moments: first with m1 as the latest incoming
  // message, later after m2 arrived. Same thread id both times.
  const T = "thread-1";
  const v1 = { id: T, threadId: T, subject: "Re: Lesson time", threadMessages: [msg("m1", 1000)] };
  const v2 = { ...v1, threadMessages: [msg("m1", 1000), msg("s1", 1500, { isSent: true }), msg("m2", 2000)] };
  const inbox = [v2];

  const drop = (items, email, createdAt = "2026-10-07T00:00:00.000Z", opts = {}) => {
    const plan = planEmailDrop(items, email, { inboxEmails: inbox, ...opts });
    if (plan.action === "ignore") return items;
    const { messageId } = plan;
    if (plan.action === "group") return items.map((t, i) => i === plan.idx ? { ...t, subItems: [...(t.subItems || []), { emailId: email.id, messageId }] } : t);
    return [{ id: "i" + items.length, text: "Contact Pat re: Lesson time", emailId: email.id, messageId, createdAt }, ...items];
  };

  // Which message a row means
  assert("todoKey: dragged message is the latest incoming, not a sent reply",
    draggedMessageId(v2), "m2");
  assert("todoKey: no threadMessages falls back to the thread id",
    draggedMessageId({ id: "t9" }), "t9");

  // Two messages, same thread → two items
  const after1 = drop([], v1);
  const after2 = drop(after1, v2);
  assert("todoKey: two messages in one thread make two items", after2.length, 2);
  assert("todoKey: each item keeps the thread id and its own message",
    after2.map(t => [t.emailId, t.messageId]), [[T, "m2"], [T, "m1"]]);
  assert("todoKey: same-thread item is never a subject-group target",
    findSubjectGroupIdx(after1, v2, inbox), -1);

  // Same message twice → one item
  assert("todoKey: dragging the same message twice makes one item",
    drop(drop([], v2), v2).length, 1);
  assert("todoKey: message covered when it sits in a sub-item",
    todoCoversMessage([{ id: "g", subItems: [{ emailId: T, messageId: "m2" }] }], v2), true);

  // A single dropped email never groups by subject (v2.49.4)
  const other = { id: "thread-2", subject: "Lesson time", threadMessages: [msg("x1", 3000)] };
  const separate = drop(after1, other);
  assert("todoKey: other thread with same subject makes its own task",
    [separate.length, separate.some(t => t.subItems)], [2, false]);
  assert("todoKey: single drop plans a new task even when a subject matches",
    planEmailDrop(after1, other, { inboxEmails: inbox }).action, "new");
  const typed = [{ id: "M", text: "Ask about lesson time for next term", done: false, createdAt: "2026-10-01T00:00:00.000Z" }];
  const afterTyped = drop(typed, other);
  assert("todoKey: typed task containing the subject does not absorb the email",
    [afterTyped.length, afterTyped.find(t => t.id === "M")], [2, typed[0]]);
  assert("todoKey: same message dropped twice still makes one task",
    [drop(drop(after1, other), other).length, planEmailDrop(drop(after1, other), other).action], [2, "ignore"]);

  // Multi-select add keeps its subject grouping (dropMultipleEmailsToTodo
  // passes groupBySubject for an email that is alone from its sender)
  const multi = drop(after1, other, undefined, { groupBySubject: true });
  assert("todoKey: multi-select add still groups another thread with the same subject",
    [multi.length, (multi[0].subItems || []).length], [1, 1]);

  // Legacy thread-keyed items (no messageId)
  const legacy = [{ id: "L", emailId: T, createdAt: new Date(1500).toISOString() }];
  assert("todoKey: legacy item still covers the message it was made from",
    todoCoversMessage(legacy, v1), true);
  assert("todoKey: legacy item does not swallow a newer message",
    todoCoversMessage(legacy, v2), false);
  assert("todoKey: legacy item without createdAt covers its whole thread (as before)",
    todoCoversMessage([{ id: "L", emailId: T }], v2), true);
  assert("todoKey: legacy item still counts as same thread",
    isSameThreadTodo(legacy[0], v2), true);

  assert("todoKey: messageId carried when regrouping", todoMessageKey({ messageId: "m1" }), { messageId: "m1" });
  assert("todoKey: legacy entry carries nothing", todoMessageKey({ emailId: T }), {});

  // A thread with several senders is one row → one plain task (v2.49.4).
  // The row's from/subject are its latest incoming message (electron).
  const ms = (id, t, from, extra = {}) => ({ id, messageId: id, from, internalDate: t, isSent: false, ...extra });
  const row = { id: "thread-3", threadId: "thread-3", subject: "Re: Lesson Invoice Term 4", from: "Jo Lee <jo@x.com>",
    threadMessages: [ms("a1", 100, "Sam Kay <sam@x.com>"), ms("a2", 200, "Al Wu <al@x.com>"),
      ms("a3", 250, "Office <office@school.com>", { isSent: true }), ms("a4", 300, "Jo Lee <jo@x.com>")] };
  assert("todoKey: multi-sender row's dragged message is its latest incoming, the row's sender",
    [draggedMessageId(row), draggedMessage(row).from === row.from], ["a4", true]);
  const plan = planEmailDrop([], row);
  const task = plainEmailTask(row, { id: "n1", createdAt: "2026-10-10T00:00:00.000Z", messageId: plan.messageId,
    fromAddr: "jo@x.com", fromName: "Jo Lee", firstName: "Jo", isParent: true, studentFirst: null,
    composeSubject: "Re: Lesson Invoice Term 4" });
  assert("todoKey: multi-sender row makes one plain task with view target, replyTo and name",
    task, { id: "n1", text: "Contact Jo re: Lesson Invoice Term 4", done: false, tag: "email", emailId: "thread-3",
      messageId: "a4", composeSubject: "Re: Lesson Invoice Term 4", meta: { parentName: "Jo Lee" },
      groupType: "parent-reply", replyTo: "jo@x.com", senderName: "Jo", fullName: "Jo Lee",
      createdAt: "2026-10-10T00:00:00.000Z" });
  assert("todoKey: plain task has no subItems or replyAddrs, and its Contact name is in the text",
    ["subItems" in task, "replyAddrs" in task, task.text.includes(task.senderName)], [false, false, true]);
  assert("todoKey: linked-parent plain task names the student",
    plainEmailTask(row, { id: "n2", messageId: "a4", fromAddr: "jo@x.com", fromName: "Jo Lee", firstName: "Jo",
      isParent: true, studentFirst: "Mia", composeSubject: "" }).text, "Contact Jo re: Mia's Lesson Invoice Term 4");
  assert("todoKey: unknown sender plain task has no groupType",
    JSON.parse(JSON.stringify(plainEmailTask(row, { id: "n3", messageId: "a4", fromAddr: "jo@x.com", fromName: "Jo Lee",
      firstName: "Jo", isParent: false, composeSubject: "" }))).groupType, undefined);

  // Reader selection picks the message (v2.49.5). The row is still thread-3:
  // Sam (a1), Al (a2), You (a3, sent), Jo (a4, latest incoming).
  const fromMsg = (r, sel, id) => {
    const e = emailForMessage(r, sel);
    const addr = e.from.match(/<(.+)>/)[1], name = e.from.split("<")[0].trim();
    return plainEmailTask(e, { id, createdAt: "2026-10-10T00:00:00.000Z", messageId: planEmailDrop([], r, { selectedMsgId: sel }).messageId,
      fromAddr: addr, fromName: name, firstName: name.split(" ")[0], isParent: false, composeSubject: "Re: Lesson Invoice Term 4" });
  };
  const selDrop = (items, r, sel, id) => {
    const plan = planEmailDrop(items, r, { selectedMsgId: sel });
    return plan.action === "ignore" ? items : [fromMsg(r, sel, id), ...items];
  };
  const samTask = fromMsg(row, "a1", "s1");
  assert("todoKey: selected message makes a task for that sender, message and view target",
    [samTask.text, samTask.messageId, samTask.replyTo, samTask.senderName, samTask.emailId],
    ["Contact Sam re: Lesson Invoice Term 4", "a1", "sam@x.com", "Sam", "thread-3"]);
  const twoSel = selDrop(selDrop([], row, "a1", "s1"), row, "a2", "s2");
  assert("todoKey: a second selection in the same thread makes a second task",
    twoSel.map(t => [t.messageId, t.replyTo]), [["a2", "al@x.com"], ["a1", "sam@x.com"]]);
  assert("todoKey: same selected message twice makes one task",
    selDrop(selDrop([], row, "a1", "s1"), row, "a1", "s1b").length, 1);
  assert("todoKey: a task for one message does not block the latest message of its thread",
    [planEmailDrop(twoSel, row).action, planEmailDrop(twoSel, row).messageId], ["new", "a4"]);
  assert("todoKey: selecting You (sent) falls back to the latest incoming message",
    [draggedMessageId(row, "a3"), emailForMessage(row, "a3") === row, fromMsg(row, "a3", "y").replyTo], ["a4", true, "jo@x.com"]);
  assert("todoKey: selecting the row's own message leaves the row unchanged",
    emailForMessage(row, "a4") === row, true);
  assert("todoKey: no selection is exactly v2.49.4",
    [emailForMessage(row) === row, emailForMessage(row, undefined) === row, draggedMessageId(row), JSON.stringify(planEmailDrop([], row))],
    [true, true, "a4", JSON.stringify({ action: "new", messageId: "a4" })]);
  assert("todoKey: unknown selected id falls back to the latest incoming",
    draggedMessageId(row, "nope"), "a4");
  // Single-sender thread with several messages: the selected one wins
  const solo = { id: "thread-5", subject: "Lesson time", from: "Pat <pat@x.com>",
    threadMessages: [ms("p1", 10, "Pat <pat@x.com>", { snippet: "first" }), ms("p2", 20, "Pat <pat@x.com>", { snippet: "second" })] };
  assert("todoKey: single-sender thread uses the selected earlier message",
    [draggedMessageId(solo, "p1"), emailForMessage(solo, "p1").snippet, draggedMessageId(solo)], ["p1", "first", "p2"]);
  // Multi-select add passes no selection: unchanged by the reader state
  assert("todoKey: multi-select plan ignores reader selection (none passed)",
    planEmailDrop(after1, other, { inboxEmails: inbox, groupBySubject: true }).action, "group");
  // Message covered inside a group's sub-item is still ignored when selected
  assert("todoKey: selected message already in a grouped sub-item is ignored",
    planEmailDrop([{ id: "g", subItems: [{ emailId: "thread-3", messageId: "a2" }] }], row, { selectedMsgId: "a2" }).action, "ignore");

  // Existing grouped tasks pass through load (a plain JSON parse of
  // mt-todo-items) and a later single drop unchanged.
  const oldGroup = { id: "G", text: "Contact Sam, Al re: Lesson Invoice Term 4", done: false, tag: "email",
    emailId: "thread-9", messageId: "z1", composeSubject: "Re: Lesson Invoice Term 4", meta: { parentName: "Sam Kay" },
    replyAddrs: ["sam@x.com", "al@x.com"],
    subItems: [{ id: "s1", text: "Reply to Sam", replyTo: "sam@x.com", emailId: "thread-9", messageId: "z1", done: false },
      { id: "s2", text: "Reply to Al", replyTo: "al@x.com", emailId: "thread-9", messageId: "z2", done: false }],
    createdAt: "2026-10-01T00:00:00.000Z" };
  const loaded = JSON.parse(JSON.stringify([oldGroup]));
  assert("todoKey: existing grouped task loads unchanged", loaded, [oldGroup]);
  const afterRow = drop(loaded, row);
  assert("todoKey: a new drop leaves an existing grouped task untouched",
    [afterRow.length, afterRow.find(t => t.id === "G")], [2, oldGroup]);
  assert("todoKey: a message inside an existing group is still ignored",
    planEmailDrop(loaded, { id: "thread-9", threadMessages: [ms("z2", 500, "Al Wu <al@x.com>")] }).action, "ignore");
}
