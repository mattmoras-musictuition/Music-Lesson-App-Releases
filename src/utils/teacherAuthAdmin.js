// ============================================================
// teacherAuthAdmin.js — admin-side teacher login management
// ============================================================
//
// Thin wrappers over five SECURITY DEFINER Postgres functions that let the
// admin app manage teacher auth accounts. The app authenticates with the
// publishable/anon key and has no service-role reach, so it cannot touch
// auth.users directly — these functions are the only route.
//
// Each function internally checks auth.uid() against the admin uid and raises
// 'not authorised' for anyone else, so the security boundary lives in the
// database, not here. Nothing in this module grants privilege.
//
// Every wrapper returns { ok: true, value } or { ok: false, message }, where
// message is the raw Postgres error message. These messages are written for a
// human ("An account already exists for that address") and MUST be surfaced
// verbatim — never swapped for a generic "something went wrong", which is the
// failure mode that let an unusable account look like a created one.
//
// No UI, no state, no side effects beyond the RPC call.
// ============================================================

import { supabase } from "../supabaseClient";

// Matt's own auth uid. The RPCs refuse to operate on it; the UI uses this to
// render its own row read-only rather than offering actions that always fail.
export const ADMIN_USER_ID = "daf539a2-ec67-45e5-8533-a3a5beb5b9e5";

async function callRpc(fn, args) {
  try {
    const { data, error } = await supabase.rpc(fn, args);
    if (error) return { ok: false, message: error.message };
    return { ok: true, value: data };
  } catch (err) {
    return { ok: false, message: err?.message || String(err) };
  }
}

// -> [{ user_id, login_email, confirmed_at, last_password_sign_in, created }]
export function listTeacherAccounts() {
  return callRpc("admin_list_teacher_accounts");
}

// Also confirms the account if unconfirmed, and revokes all refresh tokens —
// the teacher is signed out everywhere. Requires >= 8 chars. -> email
export function setTeacherPassword(userId, newPassword) {
  return callRpc("admin_set_teacher_password", {
    p_user_id: userId,
    p_new_password: newPassword,
  });
}

// Updates auth.users.email, auth.identities identity_data AND
// public.teachers.email for p_teacher_id in one transaction, so the RLS link
// (lower(teachers.email) = lower(auth.email())) cannot drift. Confirms if
// unconfirmed, revokes refresh tokens. -> email
export function setTeacherLoginEmail(userId, teacherId, newEmail) {
  return callRpc("admin_set_teacher_login_email", {
    p_user_id: userId,
    p_teacher_id: teacherId,
    p_new_email: newEmail,
  });
}

// -> email
export function confirmTeacherAccount(userId) {
  return callRpc("admin_confirm_teacher_account", { p_user_id: userId });
}

// Deletes the auth account only. Does not touch public.teachers, the
// teacher's students, or any history. -> email
export function deleteTeacherAccount(userId) {
  return callRpc("admin_delete_teacher_account", { p_user_id: userId });
}
