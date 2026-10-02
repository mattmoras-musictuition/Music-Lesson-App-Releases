-- Pre-drain copies the checks compare against (taken right after fixtures load).
CREATE TABLE fixture_snapshot AS SELECT * FROM weekly_adjustments;
CREATE TABLE ta_snapshot AS SELECT * FROM teacher_actuals;
CREATE TABLE catchups_snapshot AS SELECT string_agg(row_to_json(c)::text, ',' ORDER BY id) AS snap FROM catchups c;
