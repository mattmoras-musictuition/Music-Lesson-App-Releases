// ============================================================
// supabaseClient.js — Supabase client + dev-mode write-protection
// ============================================================
//
// In production (NODE_ENV !== 'development') this file exports the
// bare client returned by createClient — no Proxy, zero overhead.
//
// In development it exports the same client wrapped in a Proxy that
// intercepts known write surfaces and replaces them with no-ops that
// log a console.warn naming the table or bucket and the blocked
// method. The wrapper exists so dev sessions can't silently mutate
// the production Supabase project — see SESSION_121_ADDENDUM for
// the data-loss vector this closes (unguarded direct supabase.from()
// calls in InvoicingManager and MessagesView were bypassing App.js's
// per-useEffect `&& !isDev` gates and writing to prod from dev).
//
// What's intercepted in dev:
//   client.from(table).insert / update / upsert / delete
//   client.storage.from(bucket).upload / remove / update / move /
//                                  copy / createSignedUploadUrl
//
// What's passed through (intentional):
//   client.from(table).select / .eq / .match / etc. — reads are fine.
//   client.storage.from(bucket).download / getPublicUrl / list /
//                                          createSignedUrl — reads.
//   client.auth.* — login/logout/getSession etc. pass through.
//   client.rpc, client.channel, client.removeChannel, .realtime,
//   any other top-level surface — passthrough via Reflect.get default.
//
// NOT covered (banked follow-up):
//   client.auth.signUp() — currently used at TeachersManager.js:376
//   for "Add teacher". A careless click in dev still creates a real
//   row in prod's auth.users. Different blast-radius profile from the
//   public-schema writes addressed here; deferred until the .auth.*
//   surface is scoped separately.
//
// Relationship to App.js's per-useEffect `&& !isDev` gates:
//   This wrapper supersedes them. Those gates remain in place as
//   belt-and-braces — leave them for now; cleanup is a separate pass.
// ============================================================

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://eoexqzxrdegyazglpzrv.supabase.co';
const SUPABASE_KEY = 'sb_publishable_t8NIXquR2txP16eigi37Jw_GszCNStY';

const realClient = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false, // Electron runs on file:// — don't try to parse OAuth tokens from the URL
  },
});

// ─── Dev-mode wrapper ──────────────────────────────────────────────────────

const FROM_WRITE_METHODS = new Set(['insert', 'update', 'upsert', 'delete']);
const STORAGE_WRITE_METHODS = new Set([
  'upload',
  'remove',
  'update',
  'move',
  'copy',
  'createSignedUploadUrl',
]);

// A no-op chainable that:
//   • Returns itself for any string method call (so .select().single().eq()
//     and similar chains keep working).
//   • Awaits to { data: null, error: null } via then/catch/finally bound
//     from a real Promise.
function makeNoopChainable() {
  const settled = Promise.resolve({ data: null, error: null });
  let proxy;
  const handler = {
    get(_target, prop) {
      if (typeof prop === 'symbol') return undefined;
      if (prop === 'then' || prop === 'catch' || prop === 'finally') {
        return settled[prop].bind(settled);
      }
      return () => proxy;
    },
  };
  proxy = new Proxy({}, handler);
  return proxy;
}

function wrapFromBuilder(table, realBuilder) {
  return new Proxy(realBuilder, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && FROM_WRITE_METHODS.has(prop)) {
        return function blockedWrite() {
          console.warn(
            '[dev-mode] BLOCKED supabase.from("' + table + '").' + prop +
            '() — call site visible in stack'
          );
          return makeNoopChainable();
        };
      }
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === 'function') return value.bind(target);
      return value;
    },
  });
}

function wrapStorageBucket(bucket, realBucket) {
  return new Proxy(realBucket, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && STORAGE_WRITE_METHODS.has(prop)) {
        return function blockedStorageWrite() {
          console.warn(
            '[dev-mode] BLOCKED supabase.storage.from("' + bucket + '").' + prop +
            '() — call site visible in stack'
          );
          return Promise.resolve({ data: null, error: null });
        };
      }
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === 'function') return value.bind(target);
      return value;
    },
  });
}

function wrapStorage(realStorage) {
  return new Proxy(realStorage, {
    get(target, prop, receiver) {
      if (prop === 'from') {
        return function wrappedStorageFrom(bucket) {
          return wrapStorageBucket(bucket, target.from(bucket));
        };
      }
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === 'function') return value.bind(target);
      return value;
    },
  });
}

function wrapClient(client) {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'from') {
        return function wrappedFrom(table) {
          return wrapFromBuilder(table, target.from(table));
        };
      }
      if (prop === 'storage') {
        return wrapStorage(target.storage);
      }
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === 'function') return value.bind(target);
      return value;
    },
  });
}

// ─── Export ────────────────────────────────────────────────────────────────

export const supabase =
  process.env.NODE_ENV === 'development' ? wrapClient(realClient) : realClient;

// Build a throwaway auth client that reuses the same URL + anon key but
// NEVER persists a session. Used for admin-side teacher account creation:
// calling supabase.auth.signUp() on the main client replaces the active
// session with the newly-created teacher's (persistSession: true) and never
// restores it — which then re-stamps teachers.user_id under the teacher's
// identity via the teachers sync effect (see
// TeachersManager.createTeacherAccount). Running signUp on this isolated,
// non-persisting client leaves the main client's admin session untouched.
export function createIsolatedAuthClient() {
  return createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}
