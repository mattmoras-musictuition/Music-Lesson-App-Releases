// ============================================================
// Dashboard to-do: one item per dragged email MESSAGE
// An inbox row is a Gmail thread (email.id === threadId). The row shows the
// thread's latest incoming message, so that is the message a drag means.
// To-do items keep emailId = thread id (open/scroll/reply lookups key on it)
// and gain messageId = the dragged message, which is the dedupe key.
// Items created before messageId existed are thread-keyed ("legacy").
// Pure — no React, no storage.
// ============================================================

const normSubject = s => (s || "").replace(/^(re:\s*)+/gi, "").trim();

// The message an inbox row stands for: latest non-sent by internalDate,
// else latest of any; ties go to the later array position. Mirrors the
// displayMsg pick in electron.js. Falls back to the thread id.
export function draggedMessage(email) {
  const msgs = (email && email.threadMessages) || [];
  const nonSent = msgs.filter(m => !m.isSent);
  const pool = nonSent.length ? nonSent : msgs;
  let best = null;
  for (const m of pool) if (!best || (m.internalDate || 0) >= (best.internalDate || 0)) best = m;
  return best;
}

export function draggedMessageId(email) {
  const m = draggedMessage(email);
  return (m && (m.messageId || m.id)) || (email && email.id) || null;
}

// True when an item or sub-item already stands for the dragged message.
// Message-keyed entries match on messageId. A legacy thread-keyed entry of
// the same thread covers every message that already existed when it was
// created (so re-dragging the message it was made from stays a no-op);
// with no timestamp to compare it covers the whole thread, as before.
export function todoCoversMessage(items, email) {
  const msgId = draggedMessageId(email);
  const msgTime = draggedMessage(email)?.internalDate || 0;
  const covers = t => {
    if (!t) return false;
    if (t.messageId) return t.messageId === msgId;
    if (t.emailId !== email.id) return false;
    const made = Date.parse(t.createdAt || "");
    if (!made || !msgTime) return true;
    return msgTime <= made;
  };
  return (items || []).some(t => covers(t) || (t.subItems || []).some(covers));
}

// Item (or one of its sub-items) belongs to the same thread as `email`.
export function isSameThreadTodo(t, email) {
  if (!t || !email) return false;
  return t.emailId === email.id || (t.subItems || []).some(s => s.emailId === email.id);
}

// Index of an open item to fold a new email into by matching subject, or -1.
// Items from the SAME thread are never targets: each dragged message gets
// its own item. Different threads sharing a subject still group.
export function findSubjectGroupIdx(items, email, inboxEmails) {
  const cleanSubject = normSubject(email.subject);
  if (!cleanSubject) return -1;
  const want = cleanSubject.toLowerCase();
  return (items || []).findIndex(t => {
    if (t.done || isSameThreadTodo(t, email)) return false;
    const tSubject = (t.emailId
      ? normSubject((inboxEmails || []).find(e => e.id === t.emailId)?.subject)
      : t.text
    ).toLowerCase().replace(/^contact \S+ re: /i, "").replace(/^contact parents re: /i, "");
    return tSubject === want || (t.text || "").toLowerCase().includes(want);
  });
}

// { messageId } to carry when an item/sub-item is regrouped or split out, so
// the dedupe key survives; {} for legacy thread-keyed entries.
export function todoMessageKey(t) {
  return t && t.messageId ? { messageId: t.messageId } : {};
}
