---
name: add-migration
description: Add a PostgreSQL schema change to JobRelay — a new numbered migration plus the matching jobsRepo query changes. Use when a feature needs a new column, table, index, or constraint.
---

# Add a migration

`src/db/migrate.ts` applies every `src/db/migrations/*.sql` file not yet in
`schema_migrations`, in filename order, each in its own transaction. There
is no down-migration. Applied files are never edited.

## Steps

1. **Name it.** Next number, snake_case purpose:
   `src/db/migrations/005_<what_it_adds>.sql`. Check `ls src/db/migrations`
   for the current highest number.

2. **Write it idempotently**, with a header comment that says *why* this
   exists and which code reads/writes it (see `004_result_attempt_token.sql`
   for the house style):

   ```sql
   -- <Why this column/table exists, which invariant it supports, and which
   -- function(s) in src/ are its only readers/writers.>
   ALTER TABLE jobs ADD COLUMN IF NOT EXISTS <name> <TYPE>;
   CREATE INDEX IF NOT EXISTS <idx_name> ON jobs (<cols>);
   ```

   - New `NOT NULL` columns need a `DEFAULT` (existing rows).
   - No data backfills that could lock the table for long.
   - Constraints that enforce correctness (uniqueness, state guards) belong
     in the database, not in app code.

3. **Update the types and queries** in `src/db/jobsRepo.ts`:
   - Add the field to the relevant row interface (`JobRow`, etc.).
   - If the column is written during a state transition, write it **inside
     the same guarded `UPDATE`** that performs the transition (including the
     `running_token` predicate), never as a separate follow-up write. See how
     `transitionToSucceeded` stamps `result_attempt_token`.
   - Parameterized queries only (`$1, $2`), never string interpolation.

4. **Expose it** only if needed: `serializeJob` in `src/api/routes/jobs.ts`
   and `docs/API.md`.

5. **Test it.** `npm run test:integration` runs `runMigrations` against the
   `jobrelay_test` database, so a broken migration fails every test file.
   Add assertions for the new behavior to the most relevant existing
   integration test, or a new one.

6. **Apply locally**: `npm run migrate` (dev database).

7. If the column supports a reliability guarantee, add a sentence to the
   relevant section of `docs/ARCHITECTURE.md` or
   `docs/FAILURE_SCENARIOS.md` pointing at the migration file.
