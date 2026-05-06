# Spec 2 Phase 0 — Data Audit Report

**Branch:** `phase-3-spec-2`
**Date authored:** 2026-05-06
**Today (audit reference):** 2026-05-06 (Term 2 2026)
**Status:** Phase 0 complete. Audit run, verdicts landed, ready for Phase 1 design. Three verdicts captured in §8: granularity = `(school, day, teacher)` lanes (V1), persistence = separate `teacher_coverage` table (V2), migration = auto-seed feasible (V3).

---

## 0. How the audit was run

```sh
node scripts/diag/audit-spec-2-buckets.mjs --out=audits/spec-2-phase-0/data.json 2>&1 | tee audits/spec-2-phase-0/run.log
```

- Interactive Supabase email/password login (masked).
- Sectioned summary printed to stdout (captured in [`run.log`](run.log)).
- Full machine-readable dump in [`data.json`](data.json).
- Run completed 2026-05-06T11:16:42Z by `matt@mattmorasmusic.com` against the live (prod) Supabase project.

---

## 1. Critical pre-flight finding — model differs from spec assumption

The spec assumed `master_timetable` and `weekly_timetable` are tables. **They are not.** The full Supabase table list is:

```
app_settings, bands, contacts, day_slips, documents, enrolments, groups,
interruptions, invoices, master_breaks, message_reactions, message_reads,
messages, resources, schools, specialists, students, tally_entries,
teachers, thread_members, threads, voice_notes, weekly_adjustments
```

### Where MTT lives

- Generated client-side by [`timetableGenerator.js`](../../src/data/timetableGenerator.js) from `enrolments` + `groups` + `bands` + `students` + `schools` + `teachers`.
- Stored in React state `timetable` and localStorage key `mt-timetable` ([`constants.js:49`](../../src/constants.js:49)).
- **Not synced to Supabase as cards.** No queryable rows exist.

### Where WTT lives

- Generated from MTT by [`weeklyTimetableGenerator.js`](../../src/data/weeklyTimetableGenerator.js).
- Persisted in `weekly_adjustments`:

```
weekly_adjustments(
  id uuid PK, user_id uuid, week_key text, school_id text,
  lessons jsonb,  -- WTT cards live here as JSONB array
  missed jsonb, breaks jsonb,
  notes text, generated_at text, updated_at timestamptz,
  UNIQUE(week_key, school_id)
)
```

- Each lesson object inside `lessons` carries `{ teacherId, schoolId, day, start, end, studentId, instrument, isGroup, groupId, isBandSession, ... }`.

### How teacher data is currently structured (legacy model — to be replaced)

| Card type | Live source | Stored field on card |
|---|---|---|
| Solo lesson | `enrolments.teacher_id` (matched by `enrolmentId` else `studentId+instrument`) | `lesson.teacherId` (denormalized stamp) |
| Group lesson | `groups.teacher_id` (matched by `groupId`) | `lesson.teacherId` (denormalized stamp) |
| Band session | `bands.teacher_id` (matched by `bandId`/`groupId`) | `lesson.teacherId` (denormalized stamp) |

The stored `lesson.teacherId` field is **stale denormalization** — Phase 1 introduces lane ownership (lanes own teachers; lessons reference lanes via `bucket_id`); Phase 3 cleanup strips the stamped `teacherId` field from existing JSONB lesson objects.

The stored-vs-live divergence count was originally framed as the substitute-teaching signal — but Section 5.4 below shows divergences are zero, because substitution today is a manual workaround (admins restamp `lesson.teacherId` directly). Substitution becomes a clean data structure under Phase 1's `lane_overrides` table.

---

## 2. Hypothesis pass (predictions, written before any queries)

Order-of-magnitude buckets: **single digits (1–9), tens (10–99), hundreds (100–999), thousands (1k+)**.

### Temporal layers

| Layer | Prediction | Reasoning |
|---|---|---|
| Current term MTT cards | hundreds | Multiple schools × ~5 days × multiple teachers × multiple slots/day |
| Current term WTT lessons | thousands | MTT cards × ~10 weeks/term materialised |
| Populated future terms | zero or tens | Term 3 likely not started or stub-only |
| Past terms (sampled) | many terms × thousands of WTT lessons each | Out of migration scope; sampled only |

### Structural — `(school, day, teacher)` trios in current+future terms

| Category | Prediction | Reasoning |
|---|---|---|
| `(school, day)` pairs with **1 teacher** | tens, dominant | Spec 2 premise depends on this being true |
| Pairs with **2 teachers** | single digits | E.g. piano + strings split day; possible but rare |
| Pairs with **3+ teachers** | zero or single digits | Outlier territory |
| Pairs with **0 real teachers** (all empty teacherId) | single digits | Half-created cards or band placeholders |
| WTT-only `(school, day, teacher)` trios | single digits to tens | Bands + genuine one-off subs |

### Substitute / divergence

| Category | Prediction | Reasoning |
|---|---|---|
| Stored-vs-live divergences (current term, all weeks) | single digits to low tens | Mid-term substitution is real but uncommon |
| Per-enrolment divergence count >1/term | single digits | Sustained substitution would be a flag |

### Edge cases

| Category | Prediction | Reasoning |
|---|---|---|
| Cards with null `teacherId` | tens, mostly bands | Memory: bands = WTT-only ad-hoc; band teacherId behaviour unknown |
| Broken FK to teacher | zero or single digits | Spec-1 audit found no missing FKs in enrolments |
| Group lessons | tens of MTT trios, hundreds of WTT cards | Groups sit cleanly inside the bucket model |
| Bands | single digits to tens | Canonical WTT-only-trio source |

### Highest-uncertainty items (audit will speak loudest here)

1. **Band cards' teacher_id behaviour** — real / null / placeholder?
2. **2-teacher `(school, day)` pairs** — predicted single digits; tens would force a rethink.
3. **`(school, day)` granularity vs `(school, day, time-block)`** — multi-teacher pairs may be time-segmented (one teacher mornings, another afternoons). Time/slot data is included in Section 5.3 to expose this.

---

## 3. Schema inspection (Supabase tables relevant to Spec 2)

All tables snake_case in Supabase. App layer uses camelCase via `rowToX`/`xToRow` mappers. Column lists below confirmed by schema probe at audit run start (see [`data.json`](data.json) `.schema`).

### `enrolments` — recurring teacher assignment for solo + group-as-enrolment

```
id uuid PK
user_id uuid
student_id text  → students.id
instrument text
teacher_id text  → teachers.id (nullable)
is_group boolean (default false)
group_id text  → groups.id (nullable; set when is_group=true)
start_date date (nullable)
end_date date (nullable)  ← soft-delete: end_date != null = ended
updated_at timestamptz
```

**No `school_id`, no `day`, no `time`** — these come from the timetable generator output, not the row. Soft-delete via `end_date`.

### `groups` — group-lesson definitions

```
id text PK, user_id uuid
name text, school_id text → schools.id, instrument text
min_size int, max_size int
teacher_id text → teachers.id
student_ids text[]
status text  (forming / scheduled / …)
notes text, created_at timestamptz
```

### `bands` — band-session definitions

```
id text PK, user_id uuid
name text, school_id text → schools.id
teacher_id text → teachers.id
teacher_instrument text
members jsonb, links jsonb, notes text, created_at timestamptz
```

### `weekly_adjustments` — WTT card persistence (JSONB)

```
id uuid PK, user_id uuid
week_key text  (YYYY-MM-DD of Monday)
school_id text → schools.id
lessons jsonb   ← WTT cards: array of {teacherId, schoolId, day, start, end, studentId, instrument, isGroup, groupId, isBandSession, bandId, enrolmentId, ...}
missed jsonb, breaks jsonb
notes text, generated_at text, updated_at timestamptz
UNIQUE(week_key, school_id)
```

### `teachers`

Full column list (27): `id, user_id, name, email, phone, color, notes, instruments, availability, teacher_breaks, hourly_rate, has_account, sort_order, last_seen, personalEmail, plus invoice_*` (10 invoice metadata columns), `updated_at`.

**No archive/soft-delete column** on `teachers`. Deletion is hard delete.

### `schools`

```
id text PK, user_id uuid
name, acronym text
days text[], slots jsonb
specialist_policy text, teacher_breaks jsonb
newsletter_url, newsletter_guidance, sender_email,
timetable_upload_url, notes, color text
updated_at timestamptz
```

### `interruptions` — drives term scoping

```
id text PK, user_id uuid
type text  (term_break, public_holiday, school_event, ...)
title text, date date, end_date date (nullable)
start_time, end_time text
school_id text  ("all" or schools.id)
affects_classes text, notes text, source text, created_at timestamptz
```

**Term scoping** = `interruptions.where(type='term_break').sortBy(date)` → fed to `computeTermKey(weekKey, termBreaks)` from [`tallyHelpers.js:34`](../../src/utils/tallyHelpers.js:34). The audit script replicates this function inline.

> **Wrinkle — term labelling bug:** `computeTermKey` returned `2025-T1` for current 2026 data (likely missing 2026 `term_break` rows in `interruptions`). Data scope is correct (the right rows are picked up), the label is stale. Separate ticket; doesn't block Phase 1.

---

## 4. Code-side coupling audit — sites that read teacher off cards

These are the sites that will need swapping to lane lookup in Phase 1. Categorised by file. **Total: 218 grep hits across `src/` for `lesson.teacherId` / `l.teacherId` / `getLiveTeacherId` / `teacherId:` patterns.**

### High-leverage call sites (must change in Phase 1)

| File | Sample lines | What it does | Phase 1 swap |
|---|---|---|---|
| [`src/utils/helpers.js:181`](../../src/utils/helpers.js:181) | `getLiveTeacherId` | Resolves live teacher; falls back to `lesson.teacherId` | Resolve via lane lookup (lessons reference lanes by `bucket_id`) |
| [`src/pages/TimetableView.js`](../../src/pages/TimetableView.js) | 491, 504, 555, 561, 573, 1278 | MTT renderer: teacher name lookup, conflict checks | Read teacher from lane |
| [`src/pages/WeeklyAdjustments.js`](../../src/pages/WeeklyAdjustments.js) | 562, 574, 609, 611, 624, 682, 691, 4081 | WTT renderer: live teacher per band/group/solo lesson; conflict checks | Read teacher from lane (with `lane_overrides` for substitution) |
| [`src/utils/tallyHelpers.js`](../../src/utils/tallyHelpers.js) | 152, 167, 186, 238 | Tally-entry construction stamps `teacherId: lesson.teacherId` | Read teacher from lane |
| [`src/utils/tallyDerive.js:104`](../../src/utils/tallyDerive.js:104) | shim entry: `teacherId: wttEntry.teacherId` | Tally derivation shim | Read teacher from lane |
| [`src/data/exportHelpers.js:421`](../../src/data/exportHelpers.js:421) | distinct `lesson.teacherId` for school export | Export pipeline | Read teacher from lane |

### App.js — many sites; key categories

| Lines | Pattern | Purpose |
|---|---|---|
| 1951–1966 | live teacher resolution (compares stored vs live) | Sub-detection — replaced by `lane_overrides` lookup |
| 3003–3013 | bulk teacher reassign for school visit swaps | **Mutates** `lesson.teacherId` — lane-based version updates lane assignment instead |
| 3286–3330 | AI-driven lesson edits with teacherId | AI tool surface |
| 4337–4655 | timetable generation re-conflict checks | Generator-side teacher conflict checks |
| 4509–4791 | group/instrument sync writes `lesson.teacherId` | Lesson-write paths after group/enrolment edits |
| 6207–6367 | lesson move/swap operations | Drag-and-drop teacher reassignment |

### Generators — write `teacherId` onto every card

- [`src/data/timetableGenerator.js`](../../src/data/timetableGenerator.js): 88, 89, 94, 111, 187, 225–226, 332, 337, 422, 428, 432, 584, 595, 665, 677, 801, 893, 904, 933, 1034, 1035, 1042, 1081, 1112
- [`src/data/weeklyTimetableGenerator.js`](../../src/data/weeklyTimetableGenerator.js): 258, 291, 294, 313, 318 (carries swap-hint substitution logic)

Phase 1 stamps `bucket_id` (lane FK) onto each generated card; Phase 3 cleanup strips the stale `teacherId` denormalization. Until Phase 3, `lesson.teacherId` remains for backward-compat reads but is **not** the source of truth — lane lookup is.

### NOT touched directly by `lesson.teacherId`

- [`src/pages/InvoicingManager.js`](../../src/pages/InvoicingManager.js): zero direct `lesson.teacherId` reads. Reads teacher via enrolment/group/band paths only. **No change needed for invoicing.**
- [`src/pages/BandsManager.js`](../../src/pages/BandsManager.js): writes `band.teacherId` (table column), not card.
- [`src/pages/ContactsManager.js`](../../src/pages/ContactsManager.js): reads `inst.teacherId` from enrolments adapter, not card.

---

## 5. Data audit results — Step 5

Numbers below pulled from the 2026-05-06 run ([`run.log`](run.log) + [`data.json`](data.json)).

### 5.1 Schema probe + counts

All 8 tables read cleanly. Row counts:

| Table | Rows |
|---|---|
| teachers | 5 |
| schools | 3 |
| students | 105 |
| enrolments | 112 |
| groups | 3 |
| bands | 13 |
| interruptions | 58 |
| weekly_adjustments | 26 |

### 5.2 Term distribution

| termKey (label) | rows | lessons |
|---|---|---|
| `2025-T1` (actually current Term 2 2026) | 26 | 517 |

- **Current term (resolved from today 2026-05-06):** `2025-T1` per `computeTermKey` — stale label per the term-labelling bug (see §3 wrinkle). Rows are the correct current-term scope; only the human-readable label is wrong.
- **Future populated terms:** none.
- **Past terms sampled:** none — the bug collapses all weeks into one termKey, so no rows fell into the "past" bucket. Past-term sampling was therefore skipped.

Total in-scope rows = 26 (1 termKey × 3 schools × ~9 weeks ≈ ~26 rows when accounting for week-school combinations).

### 5.3 `(school, day)` teacher distribution — current term

| Pair count | Number of `(school, day)` pairs |
|---|---|
| 1 teacher | 8 |
| 2 teachers | 3 |
| 3+ teachers | 4 |
| 0 real teachers (all empty teacherId) | 0 |
| **Total pairs** | **15** |

Multi-teacher pairs: **7 of 15 (47%)**.

#### Multi-teacher pairs — concurrent-overlapping, NOT time-segmented

Time-band analysis from `data.json.sections.teacherDistribution.multiPairs` shows every multi-teacher pair has overlapping start-time ranges across teachers — different students simultaneously, not different time-of-day shifts:

| `(school, day)` | Teachers | Time bands |
|---|---|---|
| Moorabbin / Tuesday | Matt, Xandri, Rauzah | 08:00–15:00 / 09:30–10:00 / 09:00–09:30 — Xandri and Rauzah's bands sit inside Matt's |
| Moorabbin / Friday | Xandri, Phillip, Matt | 09:30–11:10 / 10:30–15:00 / 09:00–14:00 — three overlapping bands |
| East Bentleigh / Wednesday | Matt, Rauzah | 09:00–15:00 / 10:00–11:30 — Rauzah inside Matt |
| East Bentleigh / Thursday | Matt, Xandri, Rauzah | 09:00–15:00 / 12:30 / 09:30–14:00 — all overlapping |
| East Bentleigh / Monday | Rauzah, Matt | 10:00–16:30 / 09:00–09:30 — concurrent |
| East Bentleigh / Friday | Rauzah, Xandri | 10:00–14:00 / 09:00–13:30 — concurrent |
| Moorabbin / Monday | Phillip, Matt, Xandri | 09:00–12:40 / 12:10 / 09:30–10:00 — concurrent |

Conclusion: granularity is correctly `(school, day, teacher)`. Time-of-day is NOT a missing dimension; teachers run concurrently with different students.

> **Caveat — multi-teacher prevalence is unrepresentative.** The captured week coincides with three concurrent edge cases:
> 1. Matt's injury → substitute teaching his own students.
> 2. Rauzah out sick → Matt + Xandri covering some of hers.
> 3. East Bentleigh school camp → students rescheduled onto unusual days.
>
> Per Matt's confirmation, the **baseline multi-teacher rate is 0%** (one teacher per `(school, day)` in normal operation). Every one of the 7 multi-teacher pairs above is edge-case noise from this specific window. Multi-teacher UI stays in scope (Matt's call) for future-proofing, but should not drive the bucket-model design.

### 5.4 Stored-vs-live teacher divergence

| Metric | Count |
|---|---|
| Total in-scope lessons | 517 |
| Stored = live (match) | 506 |
| Stored ≠ live (diverge) | **0** |
| Stored teacherId null | 0 |
| Live teacherId null | 11 |
| Live source unmatched (no enrolment/group/band found) | 11 |

#### Per-enrolment divergence frequency

| Divergent week count | Number of enrolments |
|---|---|
| 1 | 0 |
| 2–5 | 0 |
| 6–10 | 0 |
| 11+ | 0 |

Zero divergences. No persistent-substitute enrolments.

> **Caveat — substitution capture in current data is messy.** Zero stored-vs-live divergences does **not** mean zero substitution. Substitution today is a manual workaround:
> - Admin restamps `lesson.teacherId` directly with the substitute's ID (so the stamp matches "live" at the moment of substitution).
> - Or scheduling adjustments are made outside the data system.
>
> Either way, the data structure has no first-class place to record "lesson on date D in lane L was covered by teacher T instead of the lane's owner". Phase 1's new `lane_overrides` table provides exactly that — a clean signal currently absent from the data.

The 11 unmatched-live lessons (live teacher couldn't be resolved from enrolment/group/band) warrant a Phase 1 design-time eyeball but don't block migration. Sample IDs available in `data.json.sections.divergence.samples`.

### 5.5 Orphan / broken FK on stored `lesson.teacherId`

| Metric | Count |
|---|---|
| null/empty teacherId | 0 |
| valid FK to teachers | 514 |
| broken FK | **3** |

All 3 broken-FK lessons reference the placeholder teacher ID `_test_tch_` for placeholder students `s1`/`s2`/`s3` at placeholder school `_test_school_`. Trivially filtered during migration (skip any row with `teacherId` matching `_test_*` or `schoolId === _test_school_`).

### 5.6 (school, day, teacher) trio analysis — by teacher_id status

Total weeks in scope: 9.

| Status | Trio count |
|---|---|
| `real` (teacherId present in teachers table) | 24 |
| `null` (teacherId empty) | 0 |
| `broken` (teacherId not in teachers) | 2 (both `_test_school_`) |

#### Stable vs one-off real-teacher trios

From the per-trio frequencies (`data.json.sections.trios.byStatus.real`):

- **Stable trios (≥80% of weeks)** = MTT-implied, the dominant lane structure. Top examples: Rauzah at Moorabbin Wednesday (7/9 weeks, 73 lessons), Matt at Moorabbin Tuesday (8/9, 63), Xandri at Moorabbin Thursday (7/9, 58).
- **One-off trios (1 of 9 weeks)** = WTT-only / the substitute-teaching pattern. 8 such trios, all involving Matt/Xandri/Rauzah at unusual `(school, day)` combinations — these line up with the edge-case caveat in §5.3.

#### Band teacher_id behaviour summary — answers a §2 high-uncertainty item

Band-related lessons surface inside the `real` trios (no null or broken band trios):

- **Band-related trios with `null` teacherId:** 0
- **Band-related trios with `real` teacherId:** 1 (Matt Moras at East Bentleigh / Thursday — 4 band-session lessons)
- **Band-related trios with broken FK:** 0

**Verdict:** Bands carry valid real teacher_ids in current data. Hypothesis "bands = WTT-only with null teacher" was wrong — they're WTT-only-presence (no MTT card) but teacher attribution is clean.

#### Wrinkle — `__catchup__` pseudo-school in trios

Two trios reference school_id `__catchup__` (Matt at `__catchup__` / Thursday with 5 lessons, and `__catchup__` / Friday with 2). This is the catch-up subsystem deferred to **Spec 3**, not a real school. Lane seeding skips `__catchup__`; rendering ignores it.

### 5.7 Past-term sample

No past-term rows available — all 26 in-scope rows resolve to `2025-T1` per the term-labelling bug. Past-term sampling was therefore not exercised on this run. Re-running the audit after fixing the `interruptions` term_break rows would unblock past-term analysis if needed; not blocking Phase 1.

---

## 6. Hypothesis vs actuals comparison

| Prediction | Bucket | Actual | Verdict |
|---|---|---|---|
| Current term MTT cards | hundreds | 24 stable real-teacher trios across 15 `(school, day)` pairs (~155 distinct lessons in stable trios) | ✅ matched (low end) |
| Current term WTT lessons | thousands | 517 | ⚠ off by an order of magnitude — 1 admin × 3 schools × 9 weeks is much smaller than envisioned |
| 1-teacher pairs dominant | tens (dominant) | 8 of 15 (53% — appears ❌, but baseline 0% per caveat → ✅) | ✅ when caveat applied |
| 2-teacher pairs | single digits | 3 | ✅ matched (but caveat: 0 in normal operation) |
| 3+-teacher pairs | zero / single digits | 4 | ⚠ off (predicted "rare", got 4 — caveat explains) |
| Null teacherId cards | tens | 0 | ❌ wildly off — null/empty teacherId never occurs |
| Broken FK | zero / single digits | 3 (all `_test_*`) | ✅ matched |
| Stored-vs-live divergences | single digits / low tens | 0 | ❌ wildly off — substitution invisible in data due to manual restamp workaround |
| Per-enrolment >1 divergence | single digits | 0 | ✅ matched |
| Bands with null teacherId | tens | 0 | ❌ wildly off — bands carry valid real teacher IDs |

**Wildly-off predictions surfaced two real signals worth flagging into Phase 1 design:**
1. **Substitution is invisible in the data** — not because it doesn't happen, but because the data structure has no place to record it. `lane_overrides` fixes this.
2. **Bands have clean teacher_ids** — simpler than expected; bands fold cleanly into the lane model.

The "off by an order of magnitude" on lesson count is just scale calibration — small studio, fewer cards than envisioned. Doesn't change any structural conclusion.

---

## 7. Data-model implications (locked decisions)

### 7.1 Teacher currently lives per-enrolment, not per-(school, day)

Source-of-truth columns: `enrolments.teacher_id`, `groups.teacher_id`, `bands.teacher_id`. Each is **per-instance** — one row per student-instrument pairing, one row per group, one row per band.

The `(school, day, teacher)` lane is a **new abstraction**, not a restructure of existing rows. There is no existing column or table that natively expresses "teacher X owns school Y on day Z".

### 7.2 Persistence shape — locked: separate `teacher_coverage` table

**Decision (V2):** lanes are first-class entities — separate `teacher_coverage` table with FK to teachers. Not JSONB on schools, not derive-at-render.

Reasons:
- Supports **empty lanes** (Add-Staff workflow before any students enrolled).
- Supports **lane-level overrides** for substitution (`lane_overrides` table referencing lane FK).
- Lane FK on lessons (`bucket_id`) gives a clean "lessons reference lanes" model — teacher data leaves the JSONB lesson objects entirely.
- The audit shows `(school, day, teacher)` trio structure is mostly clean (24 real-teacher trios, baseline 1 teacher per pair), so a hard table schema fits the data.

Rejected alternatives:
- **JSONB column on `schools`** — soft denormalisation; enrolment teacher and lane teacher could disagree without a clean FK; doesn't support `lane_overrides` cleanly.
- **Derive at render only** — drops empty-lane and lane-override workflows; insufficient for the spec's needs.

### 7.3 Audit-finding implications (verdicts inline)

| Audit finding | Implication | Verdict |
|---|---|---|
| Multi-teacher `(school, day)` pairs are 47% of total in this snapshot | Granularity question | Resolved — concurrent-overlapping (not time-segmented), `(school, day, teacher)` lane model handles it. Unrepresentative window per caveat. |
| Multi-teacher pairs are time-segmented | Would force `(school, day, time-block)` granularity | **Refuted** — every multi-teacher pair has overlapping time bands (see §5.3 table). |
| Null/empty stored teacherId in single-digit numbers | Auto-bucket migration feasibility | Resolved — 0 nulls, migration auto-seed feasible. |
| Broken FK >0 | Hard data corruption — fix before migration | Resolved — 3 broken FKs are `_test_*` placeholder rows; trivially filtered. |
| Sustained per-enrolment divergence (6+ weeks) | Substitution as first-class concept | 0 detected, but caveat: substitution is manual restamp workaround; `lane_overrides` table is the clean structure. |
| Bands have null teacher_id | Bands as canonical WTT-only-trio source with placeholder teachers | **Refuted** — bands carry valid real teacher IDs. Bands fold cleanly into lanes. |

---

## 8. Decision-gate recommendation — verdicts landed

### V1 — Granularity: `(school, day, teacher)` is the right tuple

Multi-teacher days are concurrent-overlapping (different students simultaneously, not different time blocks). Lane abstraction handles the pattern correctly. `(school, day, time-block)` is **not** needed — time is per-lesson, not per-lane.

Confidence: high. Refuted by no audit finding; supported by every multi-teacher time-band observation in §5.3.

### V2 — Persistence: separate `teacher_coverage` table

Lanes are first-class entities with FK to teachers. Empty lanes supported. Lane-level overrides via a sibling `lane_overrides` table (introduced in Phase 1) handle substitution as first-class data — a clean structure currently absent.

Rejected: JSONB on schools (soft denormalisation), derive-at-render (no empty-lane support).

Confidence: high.

### V3 — Migration feasibility: auto-seed feasible

- 506 of 517 lessons (98%) have stored=live teacher match.
- 0 null/empty stored teacherIds.
- 3 broken FKs all reference `_test_*` placeholder rows — trivially filtered.
- 11 unmatched-live lessons (live teacher unresolvable from enrolment/group/band) warrant a Phase 1 design-time eyeball but don't block.

**Auto-bucket migration is viable.** Strip-and-manually-reassign is unnecessary.

Confidence: high.

### Phase 1 design inputs surfaced by the audit

1. Lane model resolves cleanly (V1 + V2).
2. Multi-teacher UI stays in scope (Matt's call) — caveat baseline is 0% but data showed 47% in this snapshot due to edge-case overlap; future-proofing matters.
3. `lane_overrides` table is a needed companion — substitution data is missing today and the new structure should solve it.
4. Skip `__catchup__` pseudo-school in lane seeding (Spec 3 territory).
5. Filter `_test_*` rows during seeding.
6. The 11 unmatched-live lessons need a Phase 1 design-time inspection — likely band sessions with non-canonical `bandId` linkage, or stale enrolments.

---

## 9. Branch + file state

- On branch `phase-3-spec-2`, working tree clean apart from this Phase 0 deliverable.
- New files (uncommitted, staged-only-on-request):
  - [`scripts/diag/audit-spec-2-buckets.mjs`](../../scripts/diag/audit-spec-2-buckets.mjs) — audit script
  - [`audits/spec-2-phase-0/report.md`](report.md) — this file
  - [`audits/spec-2-phase-0/data.json`](data.json) — machine-readable audit dump
  - [`audits/spec-2-phase-0/run.log`](run.log) — stdout transcript from the 2026-05-06 audit run

No commits. No edits to existing source files. No schema changes. No Supabase writes.
