-- add_day_edited_at.sql — admin v2.49.3 (record only; the owner applied this
-- before the release). Per-day admin edit stamps for weekly_adjustments:
--   day_edited_at = { "<Day>": ISO timestamp } — when the admin last changed
--   that day's lessons or missed entries (src/utils/dayEdits.js).
-- Read by drain_teacher_actuals v4 (draft) to let a later admin edit win over
-- an older teacher copy. Rows written before v2.49.3 hold '{}'.
ALTER TABLE public.weekly_adjustments
  ADD COLUMN IF NOT EXISTS day_edited_at jsonb NOT NULL DEFAULT '{}'::jsonb;
