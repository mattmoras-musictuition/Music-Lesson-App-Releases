// ============================================================
// Dashboard to-do: one item per dragged email message
// (utils/todoEmailKey.js). Called from runSmokeTests with its `assert`.
// The drop() model mirrors dropEmailToTodo through planEmailDrop: skip when
// the message is covered, else add a new item. Only the multi-select add
// (groupBySubject) still folds into a subject match.
// ============================================================

import {
  draggedMessage, draggedMessageId, todoCoversMessage, isSameThreadTodo, findSubjectGroupIdx, todoMessageKey, planEmailDrop,
  plainEmailTask,
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
