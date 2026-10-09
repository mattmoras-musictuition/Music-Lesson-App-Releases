// ============================================================
// Dashboard to-do: one item per dragged email message
// (utils/todoEmailKey.js). Called from runSmokeTests with its `assert`.
// The drop() model mirrors dropEmailToTodo through planEmailDrop: skip when
// the message is covered, else add a new item. Only the multi-select add
// (groupBySubject) still folds into a subject match.
// ============================================================

import {
  draggedMessageId, todoCoversMessage, isSameThreadTodo, findSubjectGroupIdx, todoMessageKey, planEmailDrop,
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
}
