# scripts/diag/

Forensic / repair scripts authored 27 Apr 2026 to inspect and
repair the `students.instruments[]` JSONB column after the
Phase 3 Spec 1 migration (Commit 3, sessions 104–105).

## Files

- **inspect-students-enrolments.mjs** — read-only diagnostic;
  dumps a small slice of `students` + `enrolments` from
  Supabase to compare shapes. Hardcoded sample of 5 students.
- **audit-instruments-state.mjs** — read-only diagnostic;
  wider inventory of students / enrolments / teachers / groups
  tables, including FK consistency checks.
- **rebuild-students-instruments.mjs** — write-capable repair;
  rebuilds each student's `instruments[]` array from their
  active enrolments. Defaults to dry-run; `--write` mode
  requires interactive `WRITE` confirmation. Canary: Oscar
  Pascoe row classified `SKIP_HAS_DATA`, never written, re-read
  post-write to verify unchanged.

## Auth

All three use interactive Supabase email/password login (no
stored credentials). Embed the same publishable URL + anon key
already present in `src/supabaseClient.js`.

## Lifecycle

These scripts target the legacy `students.instruments[]`
column. Post Spec 1 Commit 8 (final closeout), that column
drops from the schema and the audit + rebuild scripts will
error on first read.

The **inspect** script will continue to work since it dumps
both tables.

The **audit** + **rebuild** scripts are preserved as documented
prior art for any future similar repair work — the auth /
dry-run / canary / interactive-confirmation pattern is
non-trivial to recreate. Treat them as a template, not as
live tooling.

## Last verified

27 Apr 2026 — used during the post-Spec-1-Commit-3 corruption
investigation. No edits since.
