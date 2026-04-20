// ============================================================
// groupsDB.js — Supabase load/sync for groups
// ============================================================

import { supabase } from "../supabaseClient";

function rowToGroup(row) {
  return {
    id:         row.id,
    name:       row.name        || "",
    schoolId:   row.school_id   || "",
    instrument: row.instrument  || "",
    minSize:    row.min_size    ?? 2,
    maxSize:    row.max_size    ?? 4,
    teacherId:  row.teacher_id  || "",
    studentIds: row.student_ids || [],
    status:     row.status      || "forming",
    notes:      row.notes       || "",
  };
}

function groupToRow(group, userId) {
  return {
    id:          group.id,
    user_id:     userId,
    name:        group.name        || "",
    school_id:   group.schoolId    || "",
    instrument:  group.instrument  || "",
    min_size:    group.minSize     ?? 2,
    max_size:    group.maxSize     ?? 4,
    teacher_id:  group.teacherId   || "",
    student_ids: group.studentIds  || [],
    status:      group.status      || "forming",
    notes:       group.notes       || "",
  };
}

export async function loadGroupsFromSupabase() {
  const { data, error } = await supabase
    .from("groups")
    .select("*")
    .order("name", { ascending: true });
  if (error) throw new Error(error.message);
  return (data || []).map(rowToGroup);
}

export async function syncGroupsToSupabase(groups, userId) {
  if (!userId) return;
  const rows = groups.map(g => groupToRow(g, userId));
  const { error: upsertError } = await supabase
    .from("groups")
    .upsert(rows, { onConflict: "id" });
  if (upsertError) throw new Error(upsertError.message);

  const currentIds = groups.map(g => g.id);
  if (currentIds.length === 0) return;
  const { error: deleteError } = await supabase
    .from("groups")
    .delete()
    .eq("user_id", userId)
    .not("id", "in", `(${currentIds.join(",")})`);
  if (deleteError) throw new Error(deleteError.message);
}
