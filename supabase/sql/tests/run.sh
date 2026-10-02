#!/bin/zsh
# Local test runner for drain_teacher_actuals v1 / v2 / v3.
#
# Throwaway LOCAL Postgres only — never points at Supabase. Spins up a
# private cluster in a temp dir on a unix socket, runs the same fixtures
# through v1 (backup), v2 and v3, then:
#   1. diffs the non-band schools (nb_*) between v1 and v2 → must be identical;
#   2. runs checks.sql against v2 → every check must PASS;
#   3. runs checks.sql against v1 for contrast (band cases expected to FAIL);
#   4. preview + Riptide files on an undrained copy;
#   5. v2 vs v3 on every school without teacher stamps → must be identical;
#   6. checks.sql (minus v2-only) and checks_v3.sql against v3 → all PASS;
#   7. re-sends every stamped teacher row and drains again → no change;
#   8. runs the v3 preview (P6) on an undrained copy.
# The temp cluster is removed on exit.
#
# usage: supabase/sql/tests/run.sh       (PGBIN overrides the binaries dir)

set -u
HERE=${0:A:h}
SQL=${HERE:h}
PGBIN=${PGBIN:-/opt/homebrew/opt/postgresql@16/bin}
TMP=$(mktemp -d -t drain-test)
PORT=54329
export PGHOST=$TMP PGPORT=$PORT PGUSER=postgres LC_ALL=C LANG=C

cleanup() { $PGBIN/pg_ctl -D $TMP/data -m immediate stop >/dev/null 2>&1; rm -rf $TMP; }
trap cleanup EXIT

$PGBIN/initdb -D $TMP/data -U postgres -A trust >/dev/null || { echo "initdb failed"; exit 2; }
$PGBIN/pg_ctl -D $TMP/data -o "-k $TMP -p $PORT -c listen_addresses=''" -l $TMP/pg.log -w start >/dev/null || { echo "postgres failed to start"; cat $TMP/pg.log; exit 2; }

PSQL=($PGBIN/psql -X -q -v ON_ERROR_STOP=1 -At)

dump() {  # $1 db → full post-drain state, one line per row
  $PSQL -d $1 -c "SELECT 'WA', school_id, week_key, user_id, notes, generated_at, breaks::text, lessons::text, missed::text FROM weekly_adjustments ORDER BY school_id, week_key" \
              -c "SELECT 'TA', school_id, week_key, id, teacher_id, lessons::text, missed::text FROM teacher_actuals ORDER BY school_id, week_key, id"
}

for v in v1 v2; do
  $PGBIN/createdb drain_$v || exit 2
  $PSQL -d drain_$v -f $HERE/schema.sql -f $HERE/fixtures.sql || exit 2
  if [[ $v == v1 ]]; then f=$SQL/drain_teacher_actuals_v1_backup.sql; else f=$SQL/drain_teacher_actuals_v2.sql; fi
  $PSQL -d drain_$v -f $f || { echo "$v: function did not compile"; exit 2; }
  $PSQL -d drain_$v -c "SELECT drain_teacher_actuals(NULL, true)" >/dev/null || { echo "$v: drain failed"; exit 2; }
  dump drain_$v > $TMP/state_$v.txt
done

echo "== run date (Melbourne): $($PSQL -d drain_v2 -c "SELECT (now() AT TIME ZONE 'Australia/Melbourne')::date") ; pw=$($PSQL -d drain_v2 -c "SELECT pw()") fw=$($PSQL -d drain_v2 -c "SELECT fw()")"

echo "== 1. non-band schools, v1 vs v2 (must be identical)"
grep '|nb_' $TMP/state_v1.txt > $TMP/nb_v1.txt
grep '|nb_' $TMP/state_v2.txt > $TMP/nb_v2.txt
echo "   rows compared: $(wc -l < $TMP/nb_v1.txt | tr -d ' ')"
if diff $TMP/nb_v1.txt $TMP/nb_v2.txt; then echo "   IDENTICAL"; nb_ok=1; else echo "   DIFFERENT"; nb_ok=0; fi

echo "== 2. checks against v2"
$PSQL -d drain_v2 -F '  ' -f $HERE/checks.sql > $TMP/checks_v2.txt || exit 2
awk -F'  ' '{ printf "   %s  %s\n", $1, $2; if ($1 == "FAIL") printf "         got: %s\n", $3 }' $TMP/checks_v2.txt
v2_fail=$(grep -c '^FAIL' $TMP/checks_v2.txt)
v2_total=$(wc -l < $TMP/checks_v2.txt | tr -d ' ')

echo "== 3. same checks against v1 (contrast only)"
$PSQL -d drain_v1 -F '  ' -f $HERE/checks.sql > $TMP/checks_v1.txt || exit 2
awk -F'  ' '$1 == "FAIL" { printf "   v1 FAIL  %s\n         got: %s\n", $2, $3 }' $TMP/checks_v1.txt

echo "== 4. preview + Riptide files on a fresh, undrained copy"
$PGBIN/createdb drain_pre || exit 2
$PSQL -d drain_pre -f $HERE/schema.sql -f $HERE/fixtures.sql -f $HERE/riptide_fixture.sql || exit 2
$PSQL -d drain_pre -F ' | ' -f $SQL/drain_v2_preview.sql > $TMP/preview.txt || { echo "   preview FAILED to run"; exit 2; }
echo "   preview ran; P1 band copies:"
$PSQL -d drain_pre -F ' | ' -c "$(awk '/^-- \(P1\)/{f=1} /^-- \(P2\)/{f=0} f' $SQL/drain_v2_preview.sql)" \
  | awk -F' \\| ' '{ printf "     %-22s %-18s %-11s → %s\n", $3, $5, $11, $15 }'
for P in P2 P3; do
  N=$([[ $P == P2 ]] && echo P3 || echo P4)
  echo "   preview $P:"
  $PSQL -d drain_pre -F ' | ' -c "$(awk "/^-- \\($P\\)/{f=1} /^-- \\($N\\)/{f=0} f" $SQL/drain_v2_preview.sql)" | sed 's/^/     /'
done
rip_ok=1
rip_ids() { $PSQL -d drain_pre -c "SELECT string_agg(l->>'id', ',' ORDER BY o) FROM weekly_adjustments, jsonb_array_elements(lessons) WITH ORDINALITY j(l,o) WHERE school_id='pwa2twgi'"; }
before=$(rip_ids)
upd=$($PGBIN/psql -X -v ON_ERROR_STOP=1 -d drain_pre -c "$(awk '/^-- \(ii\)/{f=1} f' $SQL/riptide_cleanup.sql)" 2>&1 | tail -1)
upd2=$($PGBIN/psql -X -v ON_ERROR_STOP=1 -d drain_pre -c "$(awk '/^-- \(ii\)/{f=1} f' $SQL/riptide_cleanup.sql)" 2>&1 | tail -1)
after=$(rip_ids)
$PSQL -d drain_pre -f $SQL/riptide_cleanup.sql > /dev/null 2>&1 || { echo "   riptide_cleanup.sql FAILED to run"; rip_ok=0; }
echo "   Riptide lessons before: $before"
echo "   Riptide UPDATE: $upd ; second run: $upd2"
echo "   Riptide lessons after:  $after"
[[ $upd == "UPDATE 1" && $upd2 == "UPDATE 0" && $after == "before1,adminRip,middle1,after1" ]] && echo "   PASS  Riptide removes only the copy, order kept, idempotent" || { echo "   FAIL  Riptide"; rip_ok=0; }

# ── v3 ──────────────────────────────────────────────────────────────
# v2 and v3 both get the base fixtures PLUS the v3 stamp fixtures (s_*).
for v in v2s v3; do
  $PGBIN/createdb drain_$v || exit 2
  $PSQL -d drain_$v -f $HERE/schema.sql -f $HERE/fixtures.sql -f $HERE/v3_fixtures.sql -f $HERE/snapshot.sql || exit 2
  if [[ $v == v2s ]]; then f=$SQL/drain_teacher_actuals_v2.sql; else f=$SQL/drain_teacher_actuals_v3.sql; fi
  $PSQL -d drain_$v -f $f || { echo "$v: function did not compile"; exit 2; }
  $PSQL -d drain_$v -c "SELECT drain_teacher_actuals(NULL, true)" >/dev/null || { echo "$v: drain failed"; exit 2; }
  dump drain_$v > $TMP/state_$v.txt
done

echo "== 5. v2 vs v3 on every school without teacher stamps (must be identical)"
# Excluded: the s_* stamp schools, and b_ms_stamped — the v2 fixture whose T
# entries carry writerTeacherId with NO writtenAt; v2 copied them (inert
# rule), v3 requires writtenAt and skips them by design.
grep -v -e '|s_' -e '|b_ms_stamped|' $TMP/state_v2s.txt > $TMP/ns_v2.txt
grep -v -e '|s_' -e '|b_ms_stamped|' $TMP/state_v3.txt  > $TMP/ns_v3.txt
echo "   rows compared: $(wc -l < $TMP/ns_v2.txt | tr -d ' ') (non-band nb_*: $(grep -c '|nb_' $TMP/ns_v2.txt))"
if diff $TMP/ns_v2.txt $TMP/ns_v3.txt; then echo "   IDENTICAL"; v23_ok=1; else echo "   DIFFERENT"; v23_ok=0; fi
grep '|b_ms_stamped|' $TMP/state_v3.txt | grep -q '"writerTeacherId": null' && grep '|b_ms_stamped|' $TMP/state_v3.txt | grep -q '"absence": {"reason": "Old"}' \
  && echo "   b_ms_stamped under v3: stamps without writtenAt skipped (A unchanged) — expected" \
  || { echo "   b_ms_stamped under v3: UNEXPECTED"; v23_ok=0; }

echo "== 6. checks against v3"
$PSQL -d drain_v3 -F '  ' -f $HERE/checks.sql | grep -v '  v2-only ' > $TMP/checks_v3a.txt || exit 2
$PSQL -d drain_v3 -F '  ' -f $HERE/checks_v3.sql > $TMP/checks_v3b.txt || exit 2
cat $TMP/checks_v3a.txt $TMP/checks_v3b.txt > $TMP/checks_v3.txt
awk -F'  ' '{ printf "   %s  %s\n", $1, $2; if ($1 == "FAIL") printf "         got: %s\n", $3 }' $TMP/checks_v3b.txt
echo "   (+ $(wc -l < $TMP/checks_v3a.txt | tr -d ' ') v2 checks re-run on v3: $(grep -c '^PASS' $TMP/checks_v3a.txt) PASS)"
awk -F'  ' '$1 == "FAIL" { printf "   FAIL (v2 check on v3)  %s\n         got: %s\n", $2, $3 }' $TMP/checks_v3a.txt
v3_fail=$(grep -c '^FAIL' $TMP/checks_v3.txt)
v3_total=$(wc -l < $TMP/checks_v3.txt | tr -d ' ')

echo "== 7. idempotent re-drain: re-send every stamped teacher row, drain again"
grep '|s_' $TMP/state_v3.txt > $TMP/s_first.txt
$PSQL -d drain_v3 -c "INSERT INTO teacher_actuals SELECT * FROM ta_snapshot WHERE school_id LIKE 's\_%'" || exit 2
echo "   re-sent rows: $($PSQL -d drain_v3 -c "SELECT count(*) FROM teacher_actuals WHERE school_id LIKE 's\_%'")"
$PSQL -d drain_v3 -c "SELECT drain_teacher_actuals(NULL, true)" >/dev/null || { echo "v3 re-drain failed"; exit 2; }
dump drain_v3 | grep '|s_' > $TMP/s_second.txt
if diff $TMP/s_first.txt $TMP/s_second.txt; then echo "   IDENTICAL after re-drain"; idem_ok=1; else echo "   CHANGED on re-drain"; idem_ok=0; fi

echo "== 8. v3 preview (P6) on an undrained copy"
$PGBIN/createdb drain_pre3 || exit 2
$PSQL -d drain_pre3 -f $HERE/schema.sql -f $HERE/fixtures.sql -f $HERE/v3_fixtures.sql || exit 2
$PSQL -d drain_pre3 -F ' | ' -f $SQL/drain_v3_preview.sql > $TMP/preview3.txt || { echo "   v3 preview FAILED to run"; exit 2; }
awk -F' \\| ' '{ printf "     %-20s %-4s %-7s %s\n", $3, $7, $8, $16 }' $TMP/preview3.txt

echo "== summary: v2 $((v2_total - v2_fail))/$v2_total; v3 $((v3_total - v3_fail))/$v3_total; v1-v2 non-band $([[ $nb_ok == 1 ]] && echo identical || echo DIFFERENT); v2-v3 $([[ $v23_ok == 1 ]] && echo identical || echo DIFFERENT); re-drain $([[ $idem_ok == 1 ]] && echo idempotent || echo CHANGED); Riptide $([[ $rip_ok == 1 ]] && echo PASS || echo FAIL)"
[[ $v2_fail == 0 && $nb_ok == 1 && $rip_ok == 1 && $v3_fail == 0 && $v23_ok == 1 && $idem_ok == 1 ]]
