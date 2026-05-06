-- =============================================================================
-- spec-2-cluster-1-schema.sql
--
-- Spec 2 Phase 1 cluster 1 — teacher_coverage table for the lane-ownership
-- model. Source-of-truth record of the schema as applied on the Supabase
-- dashboard during session 141 (7 May 2026).
--
-- Apply via the Supabase SQL editor (dashboard). Project convention places
-- schema on the dashboard, not in repo migrations (Phase 0 finding).
--
-- Lane-ownership model:
--   teacher_coverage row = lane = (school, day, teacher) tuple, first-class
--   entity. Lessons reference lanes via bucket_id (added in cluster 4).
--   Empty lanes are valid (Add-Staff-before-students workflow).
--   Substitution arrives as a sibling lane_overrides table in cluster 6.
--
-- Apply each statement separately on the dashboard — Supabase's SQL editor
-- is unreliable when running multiple statements in one paste.
-- =============================================================================

-- 1. Table
create table public.teacher_coverage (
  id           text        primary key,
  user_id      uuid        not null references auth.users(id) on delete cascade,
  school_id    text        not null references public.schools(id) on delete restrict,
  day          text        not null check (day in (
                              'Monday','Tuesday','Wednesday','Thursday','Friday'
                           )),
  teacher_id   text        not null references public.teachers(id) on delete restrict,
  status       text        not null default 'active'
                           check (status in ('active','archived')),
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- 2. Active-lane uniqueness — partial unique index gated on status='active'.
--    Re-activating an archived lane creates a new row; archived rows remain
--    resolvable for historical lessons that still carry their bucket_id.
create unique index teacher_coverage_active_lane_idx
  on public.teacher_coverage (user_id, school_id, day, teacher_id)
  where status = 'active';

-- 3. School+day query index (page renders).
create index teacher_coverage_school_day_idx
  on public.teacher_coverage (user_id, school_id, day)
  where status = 'active';

-- 4. Teacher query index (teacher app filtering).
create index teacher_coverage_teacher_idx
  on public.teacher_coverage (user_id, teacher_id)
  where status = 'active';

-- 5. Enable RLS.
alter table public.teacher_coverage enable row level security;

-- 6-9. RLS policies (own-rows-only, mirrors existing tables).
create policy teacher_coverage_select_own
  on public.teacher_coverage
  for select
  using (auth.uid() = user_id);

create policy teacher_coverage_insert_own
  on public.teacher_coverage
  for insert
  with check (auth.uid() = user_id);

create policy teacher_coverage_update_own
  on public.teacher_coverage
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy teacher_coverage_delete_own
  on public.teacher_coverage
  for delete
  using (auth.uid() = user_id);

-- =============================================================================
-- Design notes
-- =============================================================================
--
-- id is text (not uuid), no default — generated client-side via the project's
-- uid() helper (Math.random().toString(36).slice(2, 10), 8-char base36),
-- matching the existing pattern on teachers/schools/students/etc. Insert code
-- must supply id; a gen_random_uuid() default would conflict.
--
-- school_id and teacher_id are text FKs because the referenced PKs are text.
-- ON DELETE RESTRICT on both — deleting a school or teacher with active lanes
-- forces explicit cleanup rather than silent cascade. user_id cascades because
-- account deletion is the only realistic trigger.
--
-- status ('active'|'archived') captures lane lifecycle. Refinement C (past-term
-- cache) is implemented via archive: when a term locks, lanes for that term are
-- archived; their teacher_id remains queryable for historical lessons in past
-- weekly_adjustments.lessons JSONB that still carry the lane's bucket_id.
-- Phase 3 cleanup (cluster 12) strips stamped teacherId from those JSONB cards
-- but leaves the bucket_id reference intact.
--
-- updated_at: app-managed via toRow() helpers in *DB.js, mirroring the existing
-- pattern. No DB trigger.
