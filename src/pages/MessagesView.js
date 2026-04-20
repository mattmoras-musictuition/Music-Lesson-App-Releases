// ============================================================
// MessagesView.js — Admin messaging page
// Real-time staff messaging via Supabase Realtime
// ============================================================

import React, { useState, useEffect, useRef, useCallback } from "react";
import { MessageSquare, Plus, Send, X, Search, Users, Paperclip } from "lucide-react";
import { useTheme } from "../context/ThemeContext";
import { supabase } from "../supabaseClient";
import { PageTitle } from "../components/ui/SharedUI";

// ── Constants ─────────────────────────────────────────────────
const ADMIN_ID   = "admin";
const ADMIN_TYPE = "admin";

// ── Helpers ───────────────────────────────────────────────────

function formatTime(ts) {
  if (!ts) return "";
  const d    = new Date(ts);
  const now  = new Date();
  const diff = now - d;
  const days = Math.floor(diff / 86400000);
  if (days === 0) return d.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit", hour12: true });
  if (days === 1) return "Yesterday";
  if (days < 7)  return d.toLocaleDateString("en-AU", { weekday: "short" });
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
}

function getInitials(name) {
  return (name || "?").split(" ").map(w => w[0] || "").join("").slice(0, 2).toUpperCase();
}

const QUICK_EMOJIS = [
  "👍","👎","❤️","🔥","😂","😮","😢","😡",
  "🙏","🎉","✅","🫡","💪","👏","🤔","😍",
];

// ── Component ─────────────────────────────────────────────────

export function MessagesView({
  teachers,
  notify,
  soundSettings,
  messengerDisplayName,
  messengerBubbleColour,
  onPlaySound,
  onUnreadCountChange,
  isActive,
  goBack,
  goForward,
  historyCursor,
  pageHistory,
}) {
  const { colors, darkMode } = useTheme();

  // ── Identity ────────────────────────────────────────────────
  const adminName   = messengerDisplayName || "Admin";
  const adminColour = messengerBubbleColour || "#C47A6A";

  // ── State ───────────────────────────────────────────────────
  const [threads,        setThreads]        = useState([]);
  const [activeThreadId, setActiveThreadId] = useState(null);
  const [messages,       setMessages]       = useState([]);
  const [threadMembers,  setThreadMembers]  = useState({}); // threadId → [member rows]
  const [messageReads,   setMessageReads]   = useState({}); // threadId → last_read_at string
  const [lastMessages,   setLastMessages]   = useState({}); // threadId → last message row
  // Session 95: actual unread count per thread (was 0-or-1). Computed from
  // messages not sent by admin with created_at > message_reads.last_read_at.
  // Populated in loadThreads; incremented on each global INSERT; reset on
  // markAsRead. Sidebar badge sums this.
  const [unreadCounts,   setUnreadCounts]   = useState({}); // threadId → integer count

  const [input,          setInput]          = useState("");
  const [sending,        setSending]        = useState(false);
  const [loading,        setLoading]        = useState(true);
  const [loadingMsgs,    setLoadingMsgs]    = useState(false);

  // Reply
  const [replyingTo, setReplyingTo] = useState(null); // message being replied to

  // Attachments & reactions
  const [pendingAttachment, setPendingAttachment] = useState(null); // { url, type, name }
  const [dragOverChat, setDragOverChat] = useState(false); // file drag over message area
  const [reactions,         setReactions]         = useState({}); // messageId → [reaction rows]
  const [hoveredMsgId,      setHoveredMsgId]      = useState(null);
  const [emojiPickerMsgId,  setEmojiPickerMsgId]  = useState(null);
  const [emojiPickerPos,   setEmojiPickerPos]    = useState({ x: 0, y: 0, above: false });
  const [uploadingFile,     setUploadingFile]     = useState(false);

  // New thread modal
  const [showNew,         setShowNew]         = useState(false);
  const [newSearch,       setNewSearch]       = useState("");
  const [newSelected,     setNewSelected]     = useState([]);   // teacher IDs
  const [newGroupName,    setNewGroupName]    = useState("");
  const [creating,        setCreating]        = useState(false);

  // Swipe-to-delete (wheel-based for trackpad)
  const [swipeOffsets,     setSwipeOffsets]     = useState({}); // threadId → px offset
  const [deleteConfirmId,  setDeleteConfirmId]  = useState(null);
  const swipeSettleRef     = useRef({});         // { [threadId]: timeoutId }
  const wheelHandlerRef    = useRef(null);
  const threadListRef      = useRef(null);
  const SWIPE_OPEN_ADMIN   = 200;
  const SWIPE_THRESHOLD    = 60;

  // Wire non-passive wheel listener to thread list container
  useEffect(() => {
    const el = threadListRef.current;
    if (!el) return;
    const handler = (e) => { if (wheelHandlerRef.current) wheelHandlerRef.current(e); };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

  const messagesEndRef       = useRef(null);
  const messagesContainerRef = useRef(null);
  const inputRef             = useRef(null);
  const activeChannelRef     = useRef(null); // realtime subscription for active thread
  const globalChannelRef     = useRef(null); // realtime subscription for badge updates
  const activeThreadIdRef    = useRef(null); // mirror of activeThreadId readable in closures
  const threadsRef           = useRef([]);   // mirror of threads for synchronous membership checks
  const globalFirstSubRef    = useRef(true); // Session 95: distinguish initial vs recovery SUBSCRIBED
  const isActiveRef          = useRef(isActive); // mirror of isActive prop — always current in closures
  const fileInputRef         = useRef(null);
  const reactionChannelRef   = useRef(null);
  const instanceIdRef        = useRef(`mv-${Date.now()}-${Math.random().toString(36).slice(2)}`); // unique per mount
  const typingChannelRef     = useRef(null);
  const typingTimerRef       = useRef(null); // debounce outgoing typing broadcast
  const typingTimeoutsRef    = useRef({}); // { [userId]: timeoutId } — auto-clear stale typing
  const [typingUsers, setTypingUsers] = useState([]); // [{ userId, name }]
  activeThreadIdRef.current = activeThreadId;
  isActiveRef.current = isActive;
  threadsRef.current = threads;

  // ── Resolved teacher info ────────────────────────────────────
  const getTeacher = useCallback((id) => teachers.find(t => t.id === id) || null, [teachers]);

  const getUserName = useCallback((userId, userType) => {
    if (userId === ADMIN_ID || userType === ADMIN_TYPE) return adminName;
    const t = getTeacher(userId);
    if (!t) return "Teacher";
    return t.firstName || (t.name || "").split(" ")[0] || t.name || "Teacher";
  }, [adminName, getTeacher]);

  const getUserColour = useCallback((userId, userType) => {
    if (userId === ADMIN_ID || userType === ADMIN_TYPE) return adminColour;
    const t = getTeacher(userId);
    return t?.colour || t?.color || "#6B9FD4";
  }, [adminColour, getTeacher]);

  // ── Thread display helpers ───────────────────────────────────
  const getThreadName = useCallback((thread) => {
    if (thread.is_group) {
      if (thread.name && thread.name !== "Group") return thread.name;
      const members = threadMembers[thread.id] || [];
      const names = members
        .filter(m => m.user_id !== ADMIN_ID)
        .map(m => getUserName(m.user_id, m.user_type))
        .filter(Boolean);
      return names.length > 0 ? names.join(", ") : "Group";
    }
    const members = threadMembers[thread.id] || [];
    const other   = members.find(m => m.user_id !== ADMIN_ID);
    if (!other) return "Thread";
    return getUserName(other.user_id, other.user_type);
  }, [threadMembers, getUserName]);

  const getThreadColour = useCallback((thread) => {
    if (thread.is_group) return "#9E6B8A";
    const members = threadMembers[thread.id] || [];
    const other   = members.find(m => m.user_id !== ADMIN_ID);
    if (!other) return adminColour;
    return getUserColour(other.user_id, other.user_type);
  }, [threadMembers, getUserColour, adminColour]);

  // Session 95: getUnread returns the actual unread count per thread. Source
  // is unreadCounts state, populated by loadThreads and maintained by the
  // global INSERT handler and markAsRead. If the thread is missing from the
  // map (shouldn't happen after loadThreads completes), default to 0.
  const getUnread = useCallback((threadId) => {
    return unreadCounts[threadId] || 0;
  }, [unreadCounts]);

  // ── Sound helpers ────────────────────────────────────────────
  const playPop = useCallback(() => {
    if (soundSettings?.reactionSound === false) return;
    onPlaySound?.("reaction.mp3");
  }, [soundSettings, onPlaySound]);

  const playReceive = useCallback(() => {
    if (soundSettings?.messageReceive === false) return;
    onPlaySound?.("message-receive.mp3");
  }, [soundSettings, onPlaySound]);

  const playSend = useCallback(() => {
    if (soundSettings?.messageSend === false) return;
    onPlaySound?.("message-send.mp3");
  }, [soundSettings, onPlaySound]);

  // ── Mark read ────────────────────────────────────────────────
  const markAsRead = useCallback(async (threadId) => {
    if (!threadId) return;
    const now = new Date().toISOString();
    try {
      await supabase.from("message_reads").upsert(
        { thread_id: threadId, user_id: ADMIN_ID, last_read_at: now },
        { onConflict: "thread_id,user_id" }
      );
      setMessageReads(prev => ({ ...prev, [threadId]: now }));
      // Session 95: zero the unread count for this thread.
      setUnreadCounts(prev => (prev[threadId] ? { ...prev, [threadId]: 0 } : prev));
    } catch {}
  }, []);

  // ── Mark teacher messages as read (sets read_at for read receipts on teacher side) ──
  const markTeacherMessagesRead = useCallback(async (threadId) => {
    if (!threadId) return;
    const now = new Date().toISOString();
    try {
      await supabase
        .from("messages")
        .update({ read_at: now })
        .eq("thread_id", threadId)
        .neq("sender_id", ADMIN_ID)
        .is("read_at", null);
      setMessages(prev => prev.map(m =>
        m.sender_id !== ADMIN_ID && !m.read_at ? { ...m, read_at: now } : m
      ));
    } catch {}
  }, []);


  // ── Load reactions for active thread ─────────────────────────
  const loadReactions = useCallback(async (threadId) => {
    if (!threadId) return;
    try {
      const { data } = await supabase.from("message_reactions").select("*").eq("thread_id", threadId);
      const map = {};
      (data || []).forEach(r => { if (!map[r.message_id]) map[r.message_id] = []; map[r.message_id].push(r); });
      setReactions(map);
    } catch {}
  }, []);

  // ── Toggle emoji reaction ─────────────────────────────────────
  const toggleReaction = useCallback(async (messageId, emoji) => {
    if (!activeThreadId || !messageId) return;
    const existing = (reactions[messageId] || []).find(r => r.user_id === ADMIN_ID && r.emoji === emoji);
    setEmojiPickerMsgId(null);
    if (existing) {
      setReactions(prev => ({ ...prev, [messageId]: (prev[messageId] || []).filter(r => r.id !== existing.id) }));
      await supabase.from("message_reactions").delete().eq("id", existing.id);
    } else {
      const tempId = `opt-${Date.now()}`;
      const opt = { id: tempId, message_id: messageId, thread_id: activeThreadId, user_id: ADMIN_ID, user_type: ADMIN_TYPE, emoji };
      setReactions(prev => ({ ...prev, [messageId]: [...(prev[messageId] || []), opt] }));
      playPop();
      const { data } = await supabase.from("message_reactions")
        .insert({ message_id: messageId, thread_id: activeThreadId, user_id: ADMIN_ID, user_type: ADMIN_TYPE, emoji })
        .select().single();
      if (data) setReactions(prev => ({ ...prev, [messageId]: (prev[messageId] || []).map(r => r.id === tempId ? data : r) }));
    }
  }, [reactions, activeThreadId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Upload file attachment ─────────────────────────────────────
  const uploadAttachment = useCallback(async (file) => {
    if (!file || !activeThreadId) return null;
    setUploadingFile(true);
    try {
      const ext = file.name.split(".").pop().toLowerCase();
      const path = `${activeThreadId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
      const { error } = await supabase.storage.from("message-attachments").upload(path, file, { contentType: file.type });
      if (error) throw error;
      const { data: { publicUrl } } = supabase.storage.from("message-attachments").getPublicUrl(path);
      return { url: publicUrl, type: file.type, name: file.name };
    } catch {
      notify?.("Failed to upload file", "danger");
      return null;
    } finally { setUploadingFile(false); }
  }, [activeThreadId, notify]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load threads ─────────────────────────────────────────────
  const loadThreads = useCallback(async () => {
    setLoading(true);
    try {
      // 1. Thread IDs for admin
      const { data: myMemberships, error: e1 } = await supabase
        .from("thread_members")
        .select("thread_id")
        .eq("user_id", ADMIN_ID);
      if (e1) throw e1;
      if (!myMemberships || myMemberships.length === 0) {
        setThreads([]); setLoading(false); return;
      }
      const threadIds = myMemberships.map(r => r.thread_id);

      // 2. Thread rows
      const { data: threadRows, error: e2 } = await supabase
        .from("threads")
        .select("*")
        .in("id", threadIds);
      if (e2) throw e2;

      // 3. All members for those threads
      const { data: allMemberRows, error: e3 } = await supabase
        .from("thread_members")
        .select("*")
        .in("thread_id", threadIds);
      if (e3) throw e3;

      // 4. Last message per thread (one query per thread — acceptable for typical ≤20 threads)
      const lastMsgMap = {};
      for (const tid of threadIds) {
        const { data: msgs } = await supabase
          .from("messages")
          .select("*")
          .eq("thread_id", tid)
          .order("created_at", { ascending: false })
          .limit(1);
        if (msgs && msgs.length > 0) lastMsgMap[tid] = msgs[0];
      }

      // 5. Message reads for admin
      const { data: readRows } = await supabase
        .from("message_reads")
        .select("*")
        .eq("user_id", ADMIN_ID);

      // Session 95: 6. Unread candidates — all non-admin messages across these
      // threads. We only need id/thread_id/created_at to count, not bodies.
      // Compared against readsMap to tally per thread. Single query rather
      // than N per-thread counts.
      const { data: unreadCandidates } = await supabase
        .from("messages")
        .select("id, thread_id, created_at")
        .in("thread_id", threadIds)
        .neq("sender_id", ADMIN_ID);

      // ── Build maps ───────────────────────────────────────────
      const membersMap = {};
      (allMemberRows || []).forEach(m => {
        if (!membersMap[m.thread_id]) membersMap[m.thread_id] = [];
        membersMap[m.thread_id].push(m);
      });

      const readsMap = {};
      (readRows || []).forEach(r => { readsMap[r.thread_id] = r.last_read_at; });

      // Session 95: tally unread per thread.
      const unreadMap = {};
      (unreadCandidates || []).forEach(m => {
        const lastRead = readsMap[m.thread_id];
        if (!lastRead || new Date(m.created_at) > new Date(lastRead)) {
          unreadMap[m.thread_id] = (unreadMap[m.thread_id] || 0) + 1;
        }
      });

      // Sort by last message time desc
      const sorted = (threadRows || []).sort((a, b) => {
        const at = (lastMsgMap[a.id]?.created_at) || a.created_at;
        const bt = (lastMsgMap[b.id]?.created_at) || b.created_at;
        return new Date(bt) - new Date(at);
      });

      setThreads(sorted);
      setThreadMembers(membersMap);
      setLastMessages(lastMsgMap);
      setMessageReads(readsMap);
      setUnreadCounts(unreadMap);
    } catch (err) {
      console.error("MessagesView loadThreads:", err);
    }
    setLoading(false);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load messages for active thread ─────────────────────────
  const loadMessages = useCallback(async (threadId) => {
    if (!threadId) return;
    setLoadingMsgs(true);
    try {
      const { data, error } = await supabase
        .from("messages")
        .select("*")
        .eq("thread_id", threadId)
        .order("created_at", { ascending: true });
      if (error) throw error;
      setMessages(data || []);
    } catch (err) {
      console.error("MessagesView loadMessages:", err);
    }
    setLoadingMsgs(false);
  }, []);

  // ── Initial load — runs once on mount ────────────────────────
  useEffect(() => { loadThreads(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── When Messages tab becomes active, mark current thread as read ──
  useEffect(() => {
    if (isActive && activeThreadId) { markAsRead(activeThreadId); markTeacherMessagesRead(activeThreadId); }
  }, [isActive]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Active thread changes: load messages + subscribe ─────────
  useEffect(() => {
    if (!activeThreadId) { setMessages([]); return; }

    loadMessages(activeThreadId);
    loadReactions(activeThreadId);
    markAsRead(activeThreadId);
    markTeacherMessagesRead(activeThreadId);

    // Remove previous channel
    if (activeChannelRef.current) {
      supabase.removeChannel(activeChannelRef.current);
      activeChannelRef.current = null;
    }

    const channel = supabase
      .channel(`messages-thread-${activeThreadId}-${instanceIdRef.current}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages", filter: `thread_id=eq.${activeThreadId}` },
        (payload) => {
          const msg = payload.new;
          setMessages(prev => {
            // Avoid duplicates (optimistic inserts)
            if (prev.some(m => m.id === msg.id)) return prev;
            return [...prev, msg];
          });
          setLastMessages(prev => ({ ...prev, [activeThreadId]: msg }));
          if (msg.sender_id !== ADMIN_ID) {
            playReceive();
            if (isActiveRef.current) {
              markAsRead(activeThreadId); markTeacherMessagesRead(activeThreadId);
            } else {
              // Session 95: admin has this thread selected but is on a
              // different tab (Dashboard, etc.). Bump unread so the sidebar
              // badge is accurate. markAsRead fires on tab return and resets.
              setUnreadCounts(prev => ({ ...prev, [activeThreadId]: (prev[activeThreadId] || 0) + 1 }));
            }
          }
        }
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "messages", filter: `thread_id=eq.${activeThreadId}` },
        (payload) => {
          const updated = payload.new;
          if (updated.read_at) {
            setMessages(prev => prev.map(m => m.id === updated.id ? { ...m, read_at: updated.read_at } : m));
          }
        }
      )
      .subscribe();

    activeChannelRef.current = channel;

    // Reaction realtime subscription — wrapped in try-catch to isolate from message channel
    try {
      if (reactionChannelRef.current) {
        supabase.removeChannel(reactionChannelRef.current);
        reactionChannelRef.current = null;
      }
      const reactionChannel = supabase
        .channel(`reactions-thread-${activeThreadId}-${instanceIdRef.current}`)
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "message_reactions", filter: `thread_id=eq.${activeThreadId}` },
          (payload) => {
            const r = payload.new;
            setReactions(prev => {
              if ((prev[r.message_id] || []).some(e => e.id === r.id)) return prev;
              return { ...prev, [r.message_id]: [...(prev[r.message_id] || []), r] };
            });
            if (r.user_id !== ADMIN_ID) playPop();
          }
        )
        .on("postgres_changes", { event: "DELETE", schema: "public", table: "message_reactions", filter: `thread_id=eq.${activeThreadId}` },
          (payload) => {
            const r = payload.old;
            setReactions(prev => ({ ...prev, [r.message_id]: (prev[r.message_id] || []).filter(e => e.id !== r.id) }));
          }
        )
        .subscribe((status, err) => {
          if (err) console.warn("Reaction channel error:", err);
        });
      reactionChannelRef.current = reactionChannel;
    } catch (err) {
      console.warn("Failed to create reaction channel:", err);
    }

    return () => {
      if (activeChannelRef.current) {
        supabase.removeChannel(activeChannelRef.current);
        activeChannelRef.current = null;
      }
      if (reactionChannelRef.current) {
        supabase.removeChannel(reactionChannelRef.current);
        reactionChannelRef.current = null;
      }
      if (typingChannelRef.current) {
        supabase.removeChannel(typingChannelRef.current);
        typingChannelRef.current = null;
      }
      setTypingUsers([]);
      Object.values(typingTimeoutsRef.current).forEach(clearTimeout);
      typingTimeoutsRef.current = {};
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeThreadId]);

  // ── Typing indicator channel (broadcast) ──────────────────────
  useEffect(() => {
    if (!activeThreadId) return;
    if (typingChannelRef.current) {
      supabase.removeChannel(typingChannelRef.current);
      typingChannelRef.current = null;
    }
    setTypingUsers([]);
    const ch = supabase.channel(`typing-${activeThreadId}`)
      .on("broadcast", { event: "typing" }, ({ payload }) => {
        if (!payload || payload.userId === ADMIN_ID) return;
        const { userId, userName } = payload;
        setTypingUsers(prev => {
          if (prev.some(u => u.userId === userId)) return prev;
          return [...prev, { userId, name: userName }];
        });
        // Clear after 3s of no further typing event from this user
        if (typingTimeoutsRef.current[userId]) clearTimeout(typingTimeoutsRef.current[userId]);
        typingTimeoutsRef.current[userId] = setTimeout(() => {
          setTypingUsers(prev => prev.filter(u => u.userId !== userId));
          delete typingTimeoutsRef.current[userId];
        }, 3000);
      })
      .subscribe();
    typingChannelRef.current = ch;
    return () => {
      supabase.removeChannel(ch);
      typingChannelRef.current = null;
    };
  }, [activeThreadId]);

  // ── Global subscription for badge updates ────────────────────
  useEffect(() => {
    const channel = supabase
      .channel(`messages-global-${instanceIdRef.current}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages" },
        (payload) => {
          const msg = payload.new;
          // Update last-message map (for preview + sorting). Harmless for
          // threads admin isn't a member of — key just becomes dead data.
          setLastMessages(prev => {
            const cur = prev[msg.thread_id];
            if (!cur || new Date(msg.created_at) > new Date(cur.created_at)) {
              return { ...prev, [msg.thread_id]: msg };
            }
            return prev;
          });
          // Ignore messages admin sent, and messages in the currently-viewed
          // thread (the active channel handles those with mark-as-read).
          if (msg.thread_id === activeThreadIdRef.current || msg.sender_id === ADMIN_ID) return;
          // Session 95 BUG 3 FIX: only play sound + bump unread if admin is
          // actually a member of this thread. Previously the global channel
          // pinged on every INSERT — including teacher-to-teacher messages
          // that admin shouldn't hear. threadsRef gives us a synchronous
          // membership check without relying on state update timing.
          const isMember = threadsRef.current.some(t => t.id === msg.thread_id);
          if (!isMember) {
            // Admin may have just been added to a new thread — reload so the
            // list + unread counts are correct. No sound until confirmed.
            loadThreads();
            return;
          }
          playReceive();
          // Session 95 FEATURE 4: bump unread count so the badge reflects the
          // actual message count, not just 0-or-1.
          setUnreadCounts(prev => ({ ...prev, [msg.thread_id]: (prev[msg.thread_id] || 0) + 1 }));
          setThreads(prev => {
            const thread = prev.find(t => t.id === msg.thread_id);
            if (!thread) return prev;
            return [thread, ...prev.filter(t => t.id !== msg.thread_id)];
          });
        }
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "threads" },
        (payload) => {
          const deletedId = payload.old?.id;
          if (deletedId) {
            setThreads(prev => prev.filter(t => t.id !== deletedId));
            if (activeThreadIdRef.current === deletedId) {
              setActiveThreadId(null);
              setMessages([]);
            }
          }
        }
      )
      .subscribe((status, err) => {
        console.log(`[msg-global] channel status: ${status}`, err || "");
        // Session 95 BUG 2 FIX: on every SUBSCRIBED after the first, re-fetch
        // threads so messages that arrived during a CLOSED/CHANNEL_ERROR gap
        // are reflected in lastMessages + unreadCounts. The admin equivalent
        // of the teacher bug — prevents the "first message after login has
        // no badge" class of failure if it ever hits admin too.
        // No sound on recovery: missed messages get the badge but not a ding,
        // matching normal messaging-app behaviour.
        if (status === 'SUBSCRIBED') {
          if (globalFirstSubRef.current) {
            globalFirstSubRef.current = false;
          } else {
            console.log('[msg-global] recovery — refreshing threads');
            loadThreads();
          }
        }
      });

    globalChannelRef.current = channel;

    return () => {
      if (globalChannelRef.current) {
        supabase.removeChannel(globalChannelRef.current);
        globalChannelRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Scroll to bottom (without touching outer page scroll) ────
  useEffect(() => {
    if (messagesContainerRef.current) {
      messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight;
    }
  }, [messages]);

  // ── Focus input when thread changes ─────────────────────────
  useEffect(() => {
    if (activeThreadId) setTimeout(() => inputRef.current?.focus(), 80);
  }, [activeThreadId]);

  // ── Typing indicator broadcast ───────────────────────────────
  const broadcastTyping = useCallback(() => {
    if (!typingChannelRef.current || !activeThreadIdRef.current) return;
    if (typingTimerRef.current) return; // already sent recently — debounce
    typingChannelRef.current.send({
      type: "broadcast", event: "typing",
      payload: { userId: ADMIN_ID, userName: adminName }
    });
    typingTimerRef.current = setTimeout(() => { typingTimerRef.current = null; }, 2000);
  }, [adminName]);

  // ── Send message ─────────────────────────────────────────────
  const sendMessage = async () => {
    const body = input.trim();
    if (!body && !pendingAttachment) return;
    if (!activeThreadId || sending) return;
    setSending(true);
    const att = pendingAttachment;
    const replyRef = replyingTo;
    setInput("");
    setPendingAttachment(null);
    setReplyingTo(null);

    const optimistic = {
      id: `opt-${Date.now()}`,
      thread_id: activeThreadId,
      sender_id: ADMIN_ID,
      sender_type: ADMIN_TYPE,
      body,
      attachment_url: att?.url || null,
      attachment_type: att?.type || null,
      reply_to_id: replyingTo?.id || null,
      created_at: new Date().toISOString(),
      _optimistic: true,
    };
    setMessages(prev => [...prev, optimistic]);
    setLastMessages(prev => ({ ...prev, [activeThreadId]: optimistic }));

    try {
      const { data, error } = await supabase
        .from("messages")
        .insert({ thread_id: activeThreadId, sender_id: ADMIN_ID, sender_type: ADMIN_TYPE, body, attachment_url: att?.url || null, attachment_type: att?.type || null, reply_to_id: replyingTo?.id || null })
        .select()
        .single();
      if (error) throw error;
      setMessages(prev => prev.map(m => m.id === optimistic.id ? data : m));
      setLastMessages(prev => ({ ...prev, [activeThreadId]: data }));
      setThreads(prev => {
        const thread = prev.find(t => t.id === activeThreadId);
        if (!thread) return prev;
        return [thread, ...prev.filter(t => t.id !== activeThreadId)];
      });
      playSend();
    } catch (err) {
      console.error("sendMessage error:", err);
      setMessages(prev => prev.filter(m => m.id !== optimistic.id));
      setInput(body);
      setPendingAttachment(att);
      setReplyingTo(replyRef);
      notify?.("Failed to send message", "danger");
    }
    setSending(false);
  };

  // ── Create new thread ─────────────────────────────────────────
  const createThread = async () => {
    if (newSelected.length === 0 || creating) return;
    setCreating(true);
    try {
      const isGroup = newSelected.length > 1;
      const name    = isGroup ? (newGroupName.trim() || null) : null;

      // For DMs: check if a thread with this teacher already exists
      if (!isGroup) {
        const otherId  = newSelected[0];
        const existing = threads.find(t => {
          if (t.is_group) return false;
          const members = threadMembers[t.id] || [];
          return members.some(m => m.user_id === otherId) && members.some(m => m.user_id === ADMIN_ID);
        });
        if (existing) {
          setActiveThreadId(existing.id);
          closeNewModal();
          setCreating(false);
          return;
        }
      }

      // Insert thread
      const { data: thread, error: tErr } = await supabase
        .from("threads")
        .insert({ name, is_group: isGroup, created_by: ADMIN_ID, created_by_type: ADMIN_TYPE })
        .select()
        .single();
      if (tErr) throw tErr;

      // Insert members
      const memberRows = [
        { thread_id: thread.id, user_id: ADMIN_ID,     user_type: ADMIN_TYPE  },
        ...newSelected.map(tid => ({ thread_id: thread.id, user_id: tid, user_type: "teacher" })),
      ];
      const { error: mErr } = await supabase.from("thread_members").insert(memberRows);
      if (mErr) throw mErr;

      // Update local state
      setThreads(prev => [thread, ...prev]);
      setThreadMembers(prev => ({ ...prev, [thread.id]: memberRows }));
      setMessages([]);
      setActiveThreadId(thread.id);
      closeNewModal();
    } catch (err) {
      console.error("createThread error:", err);
      notify?.("Failed to create conversation", "error");
    }
    setCreating(false);
  };

  const closeNewModal = () => {
    setShowNew(false);
    setNewSelected([]);
    setNewSearch("");
    setNewGroupName("");
  };

  // ── Swipe handlers (wheel/trackpad) ──────────────────────────
  const closeSwipe = (threadId) => setSwipeOffsets(prev => ({ ...prev, [threadId]: 0 }));
  const closeAllSwipes = () => setSwipeOffsets({});

  // Keep wheelHandlerRef current so the non-passive listener always has fresh state
  wheelHandlerRef.current = (e) => {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return; // ignore vertical scroll
    e.preventDefault();

    // Find which thread item the wheel is over via data-threadid attribute
    let target = e.target;
    let threadId = null;
    while (target && !threadId) {
      threadId = target.dataset?.threadid;
      target = target.parentElement;
    }
    if (!threadId) return;

    setSwipeOffsets(prev => {
      const cur = prev[threadId] || 0;
      // Close any other open thread
      const next = {};
      Object.keys(prev).forEach(id => { next[id] = id === threadId ? 0 : 0; });
      next[threadId] = Math.max(0, Math.min(SWIPE_OPEN_ADMIN, cur + e.deltaX));
      return next;
    });

    // Snap to open or closed after wheel settles
    clearTimeout(swipeSettleRef.current[threadId]);
    swipeSettleRef.current[threadId] = setTimeout(() => {
      setSwipeOffsets(prev => {
        const cur = prev[threadId] || 0;
        return { ...prev, [threadId]: cur > SWIPE_THRESHOLD ? SWIPE_OPEN_ADMIN : 0 };
      });
    }, 200);
  };

  // ── Delete functions ──────────────────────────────────────────
  const deleteForMe = async (threadId) => {
    closeSwipe(threadId);
    try {
      await supabase.from("thread_members").delete().eq("thread_id", threadId).eq("user_id", ADMIN_ID);
      setThreads(prev => prev.filter(t => t.id !== threadId));
      if (activeThreadId === threadId) { setActiveThreadId(null); setMessages([]); }
    } catch (err) { console.error("deleteForMe:", err); notify?.("Failed to remove conversation", "error"); }
  };

  const deleteForAll = async (threadId) => {
    setDeleteConfirmId(null);
    closeSwipe(threadId);
    try {
      await supabase.from("threads").delete().eq("id", threadId);
      setThreads(prev => prev.filter(t => t.id !== threadId));
      if (activeThreadId === threadId) { setActiveThreadId(null); setMessages([]); }
    } catch (err) { console.error("deleteForAll:", err); notify?.("Failed to delete conversation", "error"); }
  };

  // ── Derived ───────────────────────────────────────────────────
  const activeThread  = threads.find(t => t.id === activeThreadId) || null;
  const totalUnread   = threads.reduce((sum, t) => sum + getUnread(t.id), 0);
  useEffect(() => { onUnreadCountChange?.(totalUnread); }, [totalUnread]); // eslint-disable-line react-hooks/exhaustive-deps
  const filteredTeachers = teachers.filter(t => {
    if (!newSearch) return true;
    const q = newSearch.toLowerCase();
    return (t.name || "").toLowerCase().includes(q) || (t.firstName || "").toLowerCase().includes(q);
  });

  // ── Style tokens ─────────────────────────────────────────────
  const SPLIT_H   = "calc(100vh - 224px)";
  const LEFT_W    = 288;
  const borderR   = { borderRight: `1px solid ${colors.border}` };

  return (
    <div style={{ padding: "28px 36px" }}>
      {/* Page title */}
      <PageTitle
        subtitle="Real-time messaging with your teaching staff."
        goBack={goBack}
        goForward={goForward}
        historyCursor={historyCursor}
        pageHistory={pageHistory}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          Messages
          {totalUnread > 0 && (
            <span style={{
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              minWidth: 20, height: 20, borderRadius: 10,
              background: colors.accent, color: "#fff",
              fontSize: 11, fontWeight: 700, padding: "0 5px",
            }}>
              {totalUnread}
            </span>
          )}
        </span>
      </PageTitle>

      {/* Main split layout */}
      <div style={{
        display: "flex", height: SPLIT_H,
        border: `1px solid ${colors.border}`, borderRadius: 12,
        overflow: "hidden", background: colors.cardBg,
      }}>

        {/* ── Left: thread list ─────────────────────────────────── */}
        <div style={{ width: LEFT_W, flexShrink: 0, display: "flex", flexDirection: "column", background: colors.bg, ...borderR }}>

          {/* Header */}
          <div style={{ padding: "13px 14px", display: "flex", alignItems: "center", gap: 8, flexShrink: 0, ...borderR, borderRight: "none", borderBottom: `1px solid ${colors.border}` }}>
            <span style={{ flex: 1, fontSize: 13, fontWeight: 700, color: colors.text }}>Conversations</span>
            <button
              onClick={() => setShowNew(true)}
              title="New conversation"
              style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 27, height: 27, borderRadius: 7, border: `1px solid ${colors.border}`, background: "none", color: colors.textMuted, cursor: "pointer" }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = colors.accent; e.currentTarget.style.color = colors.accent; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = colors.border; e.currentTarget.style.color = colors.textMuted; }}
            >
              <Plus size={14} />
            </button>
          </div>

          {/* Threads */}
          <div ref={threadListRef} style={{ flex: 1, overflowY: "auto" }}>
            {loading ? (
              <div style={{ padding: 32, textAlign: "center", color: colors.textMuted, fontSize: 13 }}>Loading…</div>
            ) : threads.length === 0 ? (
              <div style={{ padding: "40px 20px", textAlign: "center" }}>
                <MessageSquare size={28} strokeWidth={1.5} style={{ color: colors.textMuted, opacity: 0.4, marginBottom: 10 }} />
                <p style={{ fontSize: 13, color: colors.textMuted, margin: 0, lineHeight: 1.6 }}>No conversations yet.<br />Tap + to start one.</p>
              </div>
            ) : (
              threads.map(thread => {
                const isActive    = thread.id === activeThreadId;
                const unread      = getUnread(thread.id);
                const lastMsg     = lastMessages[thread.id];
                const threadName  = getThreadName(thread);
                const threadCol   = getThreadColour(thread);
                const preview     = lastMsg
                  ? (lastMsg.sender_id === ADMIN_ID ? `You: ${lastMsg.body}` : lastMsg.body)
                  : "No messages yet";
                const swipeOffset  = swipeOffsets[thread.id] || 0;
                const isConfirming = deleteConfirmId === thread.id;

                return (
                  <div key={thread.id} style={{ position: "relative", overflow: "hidden", borderBottom: `1px solid ${colors.borderLight}`, flexShrink: 0 }}>

                    {/* ── Delete buttons (revealed by swipe) ── */}
                    <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: SWIPE_OPEN_ADMIN, display: "flex" }}>
                      {/* Delete for me */}
                      <button
                        onClick={() => deleteForMe(thread.id)}
                        style={{ flex: 1, border: "none", background: "#C45454", color: "#fff", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}
                      >
                        {thread.is_group ? "Leave" : "Delete\nfor me"}
                      </button>
                      {/* Delete for all — with inline confirm */}
                      {isConfirming ? (
                        <div style={{ flex: 1, display: "flex", flexDirection: "column", background: "#7B1212" }}>
                          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "#fff", fontWeight: 600, padding: "0 4px", textAlign: "center", lineHeight: 1.3 }}>Delete for everyone?</div>
                          <div style={{ display: "flex", borderTop: "1px solid rgba(255,255,255,0.2)" }}>
                            <button onClick={() => setDeleteConfirmId(null)} style={{ flex: 1, border: "none", borderRight: "1px solid rgba(255,255,255,0.2)", background: "transparent", color: "rgba(255,255,255,0.7)", fontSize: 11, cursor: "pointer", padding: "6px 0", fontFamily: "inherit" }}>Cancel</button>
                            <button onClick={() => deleteForAll(thread.id)} style={{ flex: 1, border: "none", background: "transparent", color: "#fff", fontSize: 11, fontWeight: 700, cursor: "pointer", padding: "6px 0", fontFamily: "inherit" }}>Yes</button>
                          </div>
                        </div>
                      ) : (
                        <button
                          onClick={() => setDeleteConfirmId(thread.id)}
                          style={{ flex: 1, border: "none", borderLeft: "1px solid rgba(255,255,255,0.15)", background: "#7B1212", color: "#fff", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", lineHeight: 1.3 }}
                        >
                          Delete{"\n"}for all
                        </button>
                      )}
                    </div>

                    {/* ── Thread row (slides right on swipe) ── */}
                    <div
                      data-threadid={thread.id}
                      onClick={() => { if (swipeOffset > 4) { closeSwipe(thread.id); return; } closeAllSwipes(); setDeleteConfirmId(null); setActiveThreadId(thread.id); }}
                      style={{
                        display: "flex", alignItems: "center", gap: 10,
                        padding: "10px 14px", cursor: "pointer",
                        background: isActive ? colors.accentLight : colors.bg,
                        transform: `translateX(${swipeOffset}px)`,
                        transition: "transform 0.15s ease",
                        userSelect: "none",
                      }}
                    >
                      {/* Avatar */}
                      <div style={{ width: 38, height: 38, borderRadius: 19, background: threadCol, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, color: "#fff" }}>
                        {thread.is_group ? <Users size={16} color="#fff" /> : getInitials(threadName)}
                      </div>
                      {/* Info */}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
                          <span style={{ flex: 1, fontSize: 13, fontWeight: unread ? 700 : 500, color: colors.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                            {threadName}
                          </span>
                          {lastMsg && <span style={{ fontSize: 11, color: colors.textMuted, flexShrink: 0 }}>{formatTime(lastMsg.created_at)}</span>}
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <span style={{ flex: 1, fontSize: 12, color: colors.textMuted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{preview}</span>
                          {unread > 0 && <span style={{ width: 8, height: 8, borderRadius: 4, background: colors.accent, flexShrink: 0 }} />}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* ── Right: message panel ──────────────────────────────── */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, position: "relative" }}
          onDragOver={e => { if (activeThread && e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragOverChat(true); } }}
          onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setDragOverChat(false); }}
          onDrop={async e => {
            e.preventDefault(); setDragOverChat(false);
            if (!activeThread) return;
            const file = e.dataTransfer.files?.[0];
            if (!file) return;
            const att = await uploadAttachment(file);
            if (att) setPendingAttachment(att);
          }}
        >
          {/* Drop overlay */}
          {dragOverChat && (
            <div style={{ position: "absolute", inset: 0, zIndex: 100, background: "rgba(79,142,247,0.12)", border: "3px dashed " + (colors.accent || "#4F8EF7"), borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
              <span style={{ fontSize: 16, fontWeight: 600, color: colors.accent || "#4F8EF7", background: colors.cardBg, padding: "10px 24px", borderRadius: 10, boxShadow: "0 4px 16px rgba(0,0,0,0.15)" }}>
                Drop file to attach
              </span>
            </div>
          )}

          {!activeThread ? (
            /* Empty / welcome state */
            <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14, padding: 32 }}>
              <MessageSquare size={42} strokeWidth={1.3} style={{ color: colors.accent, opacity: 0.4 }} />
              <p style={{ fontSize: 14, color: colors.textMuted, margin: 0, textAlign: "center" }}>
                Select a conversation or start a new one
              </p>
              <button
                onClick={() => setShowNew(true)}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 6,
                  padding: "8px 18px", borderRadius: 9, border: "none",
                  background: colors.accent, color: "#fff",
                  fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
                }}
                onMouseEnter={e => e.currentTarget.style.background = colors.accentDark}
                onMouseLeave={e => e.currentTarget.style.background = colors.accent}
              >
                <Plus size={14} /> New conversation
              </button>
            </div>
          ) : (
            <>
              {/* Thread header */}
              <div style={{
                padding: "11px 16px", borderBottom: `1px solid ${colors.border}`,
                display: "flex", alignItems: "center", gap: 10, flexShrink: 0,
              }}>
                <div style={{
                  width: 34, height: 34, borderRadius: 17,
                  background: getThreadColour(activeThread), flexShrink: 0,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 12, fontWeight: 700, color: "#fff",
                }}>
                  {activeThread.is_group
                    ? <Users size={15} color="#fff" />
                    : getInitials(getThreadName(activeThread))}
                </div>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: colors.text, lineHeight: 1.3 }}>
                    {getThreadName(activeThread)}
                  </div>
                  {activeThread.is_group && (
                    <div style={{ fontSize: 11, color: colors.textMuted }}>
                      {(threadMembers[activeThread.id] || [])
                        .map(m => getUserName(m.user_id, m.user_type))
                        .join(", ")}
                    </div>
                  )}
                </div>
              </div>

              {/* Message list */}
              <div ref={messagesContainerRef} style={{ flex: 1, overflowY: "auto", padding: "14px 16px 6px" }}>
                {loadingMsgs ? (
                  <div style={{ textAlign: "center", color: colors.textMuted, fontSize: 13, paddingTop: 28 }}>Loading…</div>
                ) : messages.length === 0 ? (
                  <div style={{ textAlign: "center", color: colors.textMuted, fontSize: 13, paddingTop: 28 }}>
                    No messages yet — say hello!
                  </div>
                ) : (
                  messages.map((msg, i) => {
                    const isMe          = msg.sender_id === ADMIN_ID;
                    const senderName    = getUserName(msg.sender_id, msg.sender_type);
                    const senderCol     = getUserColour(msg.sender_id, msg.sender_type);
                    const prevMsg       = messages[i - 1];
                    const nextMsg       = messages[i + 1];
                    const isFirstRun    = !prevMsg || prevMsg.sender_id !== msg.sender_id;
                    const isLastRun     = !nextMsg || nextMsg.sender_id !== msg.sender_id;
                    const showName      = !isMe && isFirstRun;
                    const msgReactions  = reactions[msg.id] || [];
                    const reactionGroups = msgReactions.reduce((acc, r) => { if (!acc[r.emoji]) acc[r.emoji] = []; acc[r.emoji].push(r); return acc; }, {});
                    const hasAttachment = !!msg.attachment_url;
                    const isImage       = hasAttachment && msg.attachment_type?.startsWith("image/");

                    const hasReactions  = Object.keys(reactionGroups).length > 0;

                    return (
                      <div key={msg.id}
                        data-msgid={msg.id}
                        style={{ display: "flex", flexDirection: "column", alignItems: isMe ? "flex-end" : "flex-start", marginBottom: hasReactions ? 20 : (isLastRun ? 10 : 2), width: "100%" }}
                        onMouseEnter={() => setHoveredMsgId(msg.id)}
                        onMouseLeave={() => setHoveredMsgId(null)}
                      >
                        {/* Sender name + timestamp — received messages */}
                        {showName && !isMe && (
                          <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 2, marginLeft: 30 }}>
                            <span style={{ fontSize: 11, color: senderCol, fontWeight: 600 }}>{senderName}</span>
                            <span style={{ fontSize: 10, color: colors.textMuted }}>{formatTime(msg.created_at)}</span>
                          </div>
                        )}
                        {/* Timestamp only (no name) — received continuation */}
                        {!showName && !isMe && isFirstRun && (
                          <div style={{ marginBottom: 2, marginLeft: 30 }}>
                            <span style={{ fontSize: 10, color: colors.textMuted }}>{formatTime(msg.created_at)}</span>
                          </div>
                        )}
                        {/* Timestamp above — own messages */}
                        {isMe && isFirstRun && (
                          <div style={{ marginBottom: 2 }}>
                            <span style={{ fontSize: 10, color: colors.textMuted }}>{formatTime(msg.created_at)}</span>
                          </div>
                        )}
                        {/* Seen receipt — admin side, above own messages */}
                        {isMe && isLastRun && (() => {
                          const lastAdminMsg = [...messages].reverse().find(m => m.sender_id === ADMIN_ID && !m._optimistic);
                          if (msg.id !== lastAdminMsg?.id || !msg.read_at) return null;
                          return (
                            <span style={{ fontSize: 10, color: colors.accent, marginBottom: 2, opacity: 0.75 }}>
                              Seen {formatTime(msg.read_at)}
                            </span>
                          );
                        })()}

                        <div style={{ display: "flex", alignItems: "flex-end", gap: 6, flexDirection: isMe ? "row-reverse" : "row" }}>
                          {/* Avatar (only on last bubble in a run) */}
                          {!isMe && (
                            <div style={{ width: 24, height: 24, borderRadius: 12, flexShrink: 0, background: isLastRun ? senderCol : "transparent", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, color: "#fff" }}>
                              {isLastRun ? getInitials(senderName) : ""}
                            </div>
                          )}

                          <div style={{ display: "flex", flexDirection: "column", alignItems: isMe ? "flex-end" : "flex-start", gap: 3 }}>
                            {/* Message bubble */}
                            <div style={{ position: "relative", maxWidth: 420, padding: hasAttachment && !msg.body ? "6px 8px" : "8px 12px", borderRadius: isMe ? (isFirstRun ? "14px 14px 4px 14px" : "14px 4px 4px 14px") : (isFirstRun ? "14px 14px 14px 4px" : "4px 14px 14px 4px"), background: isMe ? senderCol : (darkMode ? colors.tagBg : "#F0EDE8"), color: isMe ? "#fff" : colors.text, fontSize: 13, lineHeight: 1.55, wordBreak: "break-word", opacity: msg._optimistic ? 0.7 : 1 }}>
                              {/* Image attachment */}
                              {isImage && (
                                <img src={msg.attachment_url} alt="attachment" style={{ maxWidth: 240, maxHeight: 180, borderRadius: 8, display: "block", marginBottom: msg.body ? 6 : 0, cursor: "pointer" }}
                                  onClick={() => window.open(msg.attachment_url, "_blank")} />
                              )}
                              {/* File attachment */}
                              {hasAttachment && !isImage && (
                                <a href={msg.attachment_url} target="_blank" rel="noreferrer"
                                  style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "5px 8px", borderRadius: 7, background: "rgba(0,0,0,0.12)", color: "inherit", textDecoration: "none", marginBottom: msg.body ? 6 : 0, fontSize: 12 }}>
                                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
                                  {msg.attachment_type?.split("/")[1]?.toUpperCase() || "File"}
                                </a>
                              )}
                              {/* Reply quote */}
                              {msg.reply_to_id && (() => {
                                const quoted = messages.find(m => m.id === msg.reply_to_id);
                                const qName = quoted ? getUserName(quoted.sender_id, quoted.sender_type) : "Unknown";
                                const qText = quoted?.body || (quoted?.attachment_url ? "📎 Attachment" : "Message");
                                return (
                                  <div
                                    onClick={() => document.querySelector(`[data-msgid="${msg.reply_to_id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" })}
                                    style={{ borderLeft: `2px solid ${isMe ? "rgba(255,255,255,0.55)" : colors.accent}`, paddingLeft: 7, marginBottom: 6, opacity: 0.78, cursor: "pointer" }}
                                  >
                                    <div style={{ fontSize: 10, fontWeight: 700, marginBottom: 1 }}>{qName}</div>
                                    <div style={{ fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 200 }}>
                                      {qText.length > 60 ? qText.slice(0, 60) + "…" : qText}
                                    </div>
                                  </div>
                                );
                              })()}
                              {msg.body}
                              {/* Reaction pills — outer bottom corner */}
                              {Object.keys(reactionGroups).length > 0 && (
                                <div style={{ position: "absolute", bottom: -14, ...(isMe ? { right: 6 } : { left: 6 }), display: "flex", flexDirection: isMe ? "row-reverse" : "row", flexWrap: "wrap", gap: 3, zIndex: 10 }}>
                                  {Object.entries(reactionGroups).map(([emoji, rs]) => {
                                    const isMine = rs.some(r => r.user_id === ADMIN_ID);
                                    return (
                                      <button key={emoji} onClick={() => toggleReaction(msg.id, emoji)}
                                        style={{ display: "inline-flex", alignItems: "center", gap: 2, padding: "1px 6px", borderRadius: 10, border: `1.5px solid ${isMine ? senderCol : (darkMode ? colors.border : "rgba(0,0,0,0.15)")}`, background: isMine ? senderCol + "30" : (darkMode ? colors.cardBg : "#fff"), fontSize: 13, cursor: "pointer", fontFamily: "inherit", boxShadow: "0 1px 4px rgba(0,0,0,0.15)" }}
                                        title={isMine ? "Remove reaction" : "Add reaction"}
                                      >
                                        {emoji}{rs.length > 1 && <span style={{ fontSize: 11, color: isMine ? colors.accent : colors.textMuted }}>{rs.length}</span>}
                                      </button>
                                    );
                                  })}
                                </div>
                              )}
                              {/* Hover toolbar — overlapping top inner corner */}
                              {hoveredMsgId === msg.id && !msg._optimistic && (
                                <div style={{ position: "absolute", top: -13, ...(isMe ? { left: -44 } : { right: -44 }), display: "flex", gap: 0, background: darkMode ? colors.cardBg : "#fff", border: `1px solid ${colors.border}`, borderRadius: 11, padding: "1px 2px", boxShadow: "0 2px 8px rgba(0,0,0,0.18)", zIndex: 50 }}>
                                  <button onClick={() => { setReplyingTo(msg); setEmojiPickerMsgId(null); }} title="Reply"
                                    style={{ background: "none", border: "none", cursor: "pointer", fontSize: 13, padding: "2px 5px", borderRadius: 8, color: colors.textMuted, lineHeight: 1 }}
                                    onMouseEnter={e => e.currentTarget.style.background = colors.tagBg}
                                    onMouseLeave={e => e.currentTarget.style.background = "none"}
                                  >↩</button>
                                  <button onClick={(e) => { const rect = e.currentTarget.getBoundingClientRect(); const above = rect.bottom > window.innerHeight - 200; setEmojiPickerPos({ x: rect.left, y: above ? rect.top : rect.bottom, above }); setEmojiPickerMsgId(prev => prev === msg.id ? null : msg.id); }} title="React"
                                    style={{ background: "none", border: "none", cursor: "pointer", fontSize: 13, padding: "2px 5px", borderRadius: 8, lineHeight: 1 }}
                                    onMouseEnter={e => e.currentTarget.style.background = colors.tagBg}
                                    onMouseLeave={e => e.currentTarget.style.background = "none"}
                                  >😊</button>
                                </div>
                              )}
                              {/* Emoji picker — fixed position to escape scroll clipping */}
                              {emojiPickerMsgId === msg.id && (
                                <>
                                  <div onClick={() => setEmojiPickerMsgId(null)} style={{ position: "fixed", inset: 0, zIndex: 199 }} />
                                  <div
                                    onClick={e => e.stopPropagation()}
                                    style={{ position: "fixed", ...(emojiPickerPos.above ? { bottom: window.innerHeight - emojiPickerPos.y + 4 } : { top: emojiPickerPos.y + 4 }), left: Math.min(Math.max(emojiPickerPos.x - 60, 8), window.innerWidth - 200), display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 1, padding: "8px 6px", background: darkMode ? colors.cardBg : "#fff", border: `1px solid ${colors.border}`, borderRadius: 14, boxShadow: "0 8px 28px rgba(0,0,0,0.22)", zIndex: 200 }}
                                  >
                                    {QUICK_EMOJIS.map(emoji => (
                                      <button key={emoji} onClick={() => toggleReaction(msg.id, emoji)}
                                        style={{ background: "none", border: "none", cursor: "pointer", fontSize: 20, padding: "5px", borderRadius: 8, lineHeight: 1, transition: "transform 0.1s" }}
                                        onMouseEnter={e => e.currentTarget.style.transform = "scale(1.3)"}
                                        onMouseLeave={e => e.currentTarget.style.transform = "scale(1)"}
                                      >{emoji}</button>
                                    ))}
                                  </div>
                                </>
                              )}
                            </div>




                          </div>
                        </div>

                        
                      </div>
                    );
                  })
                )}
                <div ref={messagesEndRef} />
              </div>

              {/* Input area */}
              <div style={{ borderTop: `1px solid ${colors.border}`, flexShrink: 0 }}>
                {/* Reply banner */}
                {replyingTo && (
                  <div style={{ padding: "8px 14px 0", display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ flex: 1, minWidth: 0, borderLeft: `3px solid ${colors.accent}`, paddingLeft: 8 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: colors.accent, marginBottom: 1 }}>
                        Replying to {getUserName(replyingTo.sender_id, replyingTo.sender_type)}
                      </div>
                      <div style={{ fontSize: 11, color: colors.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {replyingTo.attachment_url && !replyingTo.body ? "📎 Attachment" : (replyingTo.body || "Message").slice(0, 80)}
                      </div>
                    </div>
                    <button onClick={() => setReplyingTo(null)} style={{ background: "none", border: "none", cursor: "pointer", color: colors.textMuted, padding: 2, display: "flex", flexShrink: 0 }}>
                      <X size={13} />
                    </button>
                  </div>
                )}
                {/* Pending attachment preview */}
                {pendingAttachment && (
                  <div style={{ padding: "8px 14px 0", display: "flex", alignItems: "center", gap: 8 }}>
                    {pendingAttachment.type.startsWith("image/") ? (
                      <img src={pendingAttachment.url} alt="preview" style={{ height: 52, borderRadius: 7, border: `1px solid ${colors.border}`, display: "block" }} />
                    ) : (
                      <div style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 10px", borderRadius: 8, background: colors.tagBg, border: `1px solid ${colors.border}`, fontSize: 12, color: colors.text }}>
                        📎 {pendingAttachment.name}
                      </div>
                    )}
                    <button onClick={() => setPendingAttachment(null)} style={{ background: "none", border: "none", cursor: "pointer", color: colors.textMuted, padding: 2, display: "flex" }}>
                      <X size={14} />
                    </button>
                  </div>
                )}
                {/* Typing indicator */}
                {typingUsers.length > 0 && (
                  <div style={{ padding: "4px 16px 0", fontSize: 11, color: colors.textMuted, fontStyle: "italic" }}>
                    {typingUsers.map(u => u.name).join(", ")} {typingUsers.length === 1 ? "is" : "are"} typing…
                  </div>
                )}
                <div style={{ padding: "10px 14px", display: "flex", gap: 8, alignItems: "flex-end" }}>
                  {/* Hidden file input */}
                  <input ref={fileInputRef} type="file" accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.txt,.csv" style={{ display: "none" }}
                    onChange={async e => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      e.target.value = "";
                      const att = await uploadAttachment(file);
                      if (att) setPendingAttachment(att);
                    }}
                  />
                  {/* Clip button */}
                  <button onClick={() => fileInputRef.current?.click()} disabled={uploadingFile} title="Attach file"
                    style={{ width: 36, height: 36, borderRadius: 9, border: `1px solid ${colors.border}`, background: "none", color: uploadingFile ? colors.accent : colors.textMuted, cursor: uploadingFile ? "default" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, transition: "all 0.15s" }}
                    onMouseEnter={e => { if (!uploadingFile) { e.currentTarget.style.borderColor = colors.accent; e.currentTarget.style.color = colors.accent; }}}
                    onMouseLeave={e => { if (!uploadingFile) { e.currentTarget.style.borderColor = colors.border; e.currentTarget.style.color = colors.textMuted; }}}
                  >
                    {uploadingFile ? <span style={{ fontSize: 11 }}>…</span> : <Paperclip size={14} />}
                  </button>
                  <textarea
                    ref={inputRef}
                    value={input}
                    onChange={e => {
                      setInput(e.target.value);
                      e.target.style.height = "auto";
                      e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px";
                      if (e.target.value.trim()) broadcastTyping();
                    }}
                    onKeyDown={e => {
                      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
                      if (e.key === "Escape") { setReplyingTo(null); setEmojiPickerMsgId(null); }
                    }}
                    placeholder="Message… (Enter to send, Shift+Enter for new line)"
                    rows={1}
                    style={{
                      flex: 1, padding: "8px 12px",
                      border: `1px solid ${colors.inputBorder}`,
                      borderRadius: 10, fontSize: 13, fontFamily: "inherit",
                      resize: "none", color: colors.text, background: colors.inputBg,
                      outline: "none", lineHeight: 1.5, overflowY: "hidden",
                      minHeight: 36, maxHeight: 120,
                    }}
                    onFocus={e => e.target.style.borderColor = colors.accent}
                    onBlur={e => e.target.style.borderColor = colors.inputBorder}
                  />
                  <button
                    onClick={sendMessage}
                    disabled={(!input.trim() && !pendingAttachment) || sending}
                    title="Send (Enter)"
                    style={{
                      width: 36, height: 36, borderRadius: 9, border: "none",
                      background: (input.trim() || pendingAttachment) ? colors.accent : colors.border,
                      color: "#fff", cursor: (input.trim() || pendingAttachment) ? "pointer" : "default",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      flexShrink: 0, transition: "background 0.15s",
                    }}
                    onMouseEnter={e => { if (input.trim() || pendingAttachment) e.currentTarget.style.background = colors.accentDark; }}
                    onMouseLeave={e => { if (input.trim() || pendingAttachment) e.currentTarget.style.background = colors.accent; }}
                  >
                    <Send size={14} />
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── New conversation modal ────────────────────────────────── */}
      {showNew && (
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 1200, display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={e => { if (e.target === e.currentTarget) closeNewModal(); }}
        >
          <div style={{
            background: colors.cardBg, borderRadius: 14,
            width: 400, maxHeight: "72vh",
            display: "flex", flexDirection: "column",
            boxShadow: "0 24px 64px rgba(0,0,0,0.28)",
            overflow: "hidden",
          }}>

            {/* Header */}
            <div style={{ padding: "15px 18px", borderBottom: `1px solid ${colors.border}`, display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ flex: 1, fontSize: 15, fontWeight: 700, color: colors.text }}>New Conversation</span>
              <button onClick={closeNewModal}
                style={{ background: "none", border: "none", cursor: "pointer", color: colors.textMuted, padding: 4, display: "flex" }}>
                <X size={18} />
              </button>
            </div>

            {/* Selected chips */}
            {newSelected.length > 0 && (
              <div style={{ padding: "8px 16px", display: "flex", flexWrap: "wrap", gap: 6, borderBottom: `1px solid ${colors.borderLight}` }}>
                {newSelected.map(tid => {
                  const t     = getTeacher(tid);
                  const name  = t?.firstName || (t?.name || "").split(" ")[0] || "Teacher";
                  const col   = t?.colour || t?.color || "#6B9FD4";
                  return (
                    <span key={tid} style={{
                      display: "inline-flex", alignItems: "center", gap: 4,
                      padding: "3px 8px 3px 5px", borderRadius: 20,
                      background: col + "22", border: `1px solid ${col}55`,
                      fontSize: 12, color: colors.text,
                    }}>
                      <span style={{ width: 14, height: 14, borderRadius: 7, background: col, display: "inline-block", flexShrink: 0 }} />
                      {name}
                      <button onClick={() => setNewSelected(prev => prev.filter(id => id !== tid))}
                        style={{ background: "none", border: "none", cursor: "pointer", color: colors.textMuted, padding: 0, display: "flex", marginLeft: 2 }}>
                        <X size={11} />
                      </button>
                    </span>
                  );
                })}
              </div>
            )}

            {/* Group name (if 2+ selected) */}
            {newSelected.length > 1 && (
              <div style={{ padding: "8px 16px", borderBottom: `1px solid ${colors.borderLight}` }}>
                <input
                  value={newGroupName}
                  onChange={e => setNewGroupName(e.target.value)}
                  placeholder="Group name (optional)"
                  style={{
                    width: "100%", padding: "7px 10px", boxSizing: "border-box",
                    border: `1px solid ${colors.inputBorder}`, borderRadius: 8,
                    fontSize: 13, fontFamily: "inherit",
                    color: colors.text, background: colors.inputBg, outline: "none",
                  }}
                />
              </div>
            )}

            {/* Search */}
            <div style={{ padding: "10px 16px", borderBottom: `1px solid ${colors.borderLight}` }}>
              <div style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "7px 10px", border: `1px solid ${colors.inputBorder}`,
                borderRadius: 8, background: colors.inputBg,
              }}>
                <Search size={13} style={{ color: colors.textMuted, flexShrink: 0 }} />
                <input
                  value={newSearch}
                  onChange={e => setNewSearch(e.target.value)}
                  placeholder="Search teachers…"
                  autoFocus
                  style={{ border: "none", outline: "none", background: "none", fontSize: 13, fontFamily: "inherit", color: colors.text, flex: 1 }}
                />
              </div>
            </div>

            {/* Teacher list */}
            <div style={{ flex: 1, overflowY: "auto" }}>
              {filteredTeachers.length === 0 ? (
                <div style={{ padding: 24, textAlign: "center", color: colors.textMuted, fontSize: 13 }}>No teachers found</div>
              ) : (
                filteredTeachers.map(t => {
                  const isSelected = newSelected.includes(t.id);
                  const tName  = t.name || "Teacher";
                  const tCol   = t.colour || t.color || "#6B9FD4";

                  return (
                    <div
                      key={t.id}
                      onClick={() => setNewSelected(prev =>
                        isSelected ? prev.filter(id => id !== t.id) : [...prev, t.id]
                      )}
                      style={{
                        display: "flex", alignItems: "center", gap: 10,
                        padding: "10px 16px", cursor: "pointer",
                        borderBottom: `1px solid ${colors.borderLight}`,
                        background: isSelected ? colors.accentLight : "transparent",
                        transition: "background 0.1s",
                      }}
                      onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = colors.tagBg; }}
                      onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = "transparent"; }}
                    >
                      <div style={{
                        width: 34, height: 34, borderRadius: 17, flexShrink: 0,
                        background: tCol,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: 12, fontWeight: 700, color: "#fff",
                      }}>
                        {getInitials(tName)}
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 13, fontWeight: 500, color: colors.text }}>{tName}</div>
                        {t.email && <div style={{ fontSize: 11, color: colors.textMuted }}>{t.email}</div>}
                      </div>
                      {isSelected && (
                        <div style={{
                          width: 18, height: 18, borderRadius: 9,
                          background: colors.accent, flexShrink: 0,
                          display: "flex", alignItems: "center", justifyContent: "center",
                        }}>
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>

            {/* Create button */}
            <div style={{ padding: "12px 16px", borderTop: `1px solid ${colors.border}` }}>
              <button
                onClick={createThread}
                disabled={newSelected.length === 0 || creating}
                style={{
                  width: "100%", padding: "9px", borderRadius: 9, border: "none",
                  background: newSelected.length > 0 ? colors.accent : colors.border,
                  color: "#fff", fontSize: 13, fontWeight: 600,
                  cursor: newSelected.length > 0 ? "pointer" : "default",
                  fontFamily: "inherit", transition: "background 0.15s",
                }}
                onMouseEnter={e => { if (newSelected.length) e.currentTarget.style.background = colors.accentDark; }}
                onMouseLeave={e => { if (newSelected.length) e.currentTarget.style.background = colors.accent; }}
              >
                {creating
                  ? "Starting…"
                  : newSelected.length > 1
                    ? "Start group conversation"
                    : newSelected.length === 1
                      ? "Start conversation"
                      : "Select someone to message"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
