-- Local stub tables for testing drain_teacher_actuals. Throwaway local
-- Postgres only: the columns the function touches, nothing else.

CREATE TABLE weekly_adjustments (
  user_id      uuid,
  week_key     text,
  school_id    text,
  lessons      jsonb,
  missed       jsonb,
  notes        text,
  generated_at text,
  breaks       jsonb,
  day_edited_at jsonb NOT NULL DEFAULT '{}',   -- v2.49.3; read by v4 only
  UNIQUE (week_key, school_id)
);

CREATE TABLE teacher_actuals (
  id         text PRIMARY KEY,
  week_key   text,
  school_id  text,
  teacher_id text,
  lessons    jsonb,
  missed     jsonb
);

-- Fixture dates relative to the run date (Melbourne), so the cutoff split is
-- deterministic: pw() is LAST week's Monday (every day of it is past),
-- fw() is the Monday two weeks ahead (every day of it is future).
CREATE FUNCTION pw() RETURNS text LANGUAGE sql STABLE AS
$$ SELECT (date_trunc('week', (now() AT TIME ZONE 'Australia/Melbourne'))::date - 7)::text $$;
CREATE FUNCTION fw() RETURNS text LANGUAGE sql STABLE AS
$$ SELECT (date_trunc('week', (now() AT TIME ZONE 'Australia/Melbourne'))::date + 14)::text $$;
