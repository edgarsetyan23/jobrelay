# JobRelay — notes for Claude Code (and humans)

An async image-thumbnail job service whose real subject is reliability:
idempotent submission, a transactional outbox, bounded retries, and recovery
from a worker dying mid-job. TypeScript (strict, NodeNext ESM), Express 5,
BullMQ on Redis, PostgreSQL, sharp. Node >= 20.

## Architecture in one screen

```
browser ─▶ API (src/api) ──INSERT job + outbox row (one txn)──▶ Postgres
              │ outbox dispatcher (src/outbox) polls unpublished rows ──▶ Redis/BullMQ
              │ demo worker manager spawns/kills 2 demo worker child processes
worker (src/worker) ◀── BullMQ ── processes job, writes thumbnails to STORAGE_DIR
```

- **Postgres is the source of truth** for job state and attempt history.
  Redis/BullMQ is only the delivery mechanism. Never read job status from
  BullMQ to make a decision.
- **Two queues.** Main queue for visitor uploads, demo queue for the failure
  demonstration panel. Fault injection is honored only when the Postgres row
  has `is_demo = true` (`src/worker/processor.ts`); a `_fault` on a normal
  upload is stripped and inert.
- **At-least-once, not exactly-once.** Duplicate delivery is expected; every
  state transition in `src/db/jobsRepo.ts` is a guarded `UPDATE ... WHERE`.

Deep dives: `docs/ARCHITECTURE.md` (components, life of a job),
`docs/FAILURE_SCENARIOS.md` (every recovery case and the test that proves it),
`docs/API.md`.

## Invariants — do not break these

1. **Fencing token on every finalize.** `transitionToRunning` stamps a fresh
   `running_token`; `transitionToRetrying/Succeeded/Failed` must include
   `AND running_token = $n`. A finalize that matches zero rows is a stale
   attempt and must be a no-op, not an error.
2. **Accept = one transaction.** The `jobs` row and its `outbox_events` row
   are written together in `createJobWithOutbox`. Never call `queue.add()`
   directly from a request handler.
3. **No read-then-write races.** Idempotency relies on the unique constraint
   plus `ON CONFLICT DO NOTHING`, not on a prior `SELECT`.
4. **Attempt-isolated files.** Each attempt writes only under
   `results/_attempts/<jobId>/<running_token>/`; downloads resolve via
   `jobs.result_attempt_token`. No "promote to final path" step.
5. **Never guess toward deletion.** If a success write's outcome is
   uncertain, keep the files and rethrow (see Phase 1/2/3 in `processor.ts`).
6. **Permanent vs transient.** `ValidationError` becomes BullMQ
   `UnrecoverableError` (no retry); anything else retries with the capped
   backoff in `src/queue/backoff.ts`.

## Conventions

- Imports use `.js` extensions (NodeNext ESM), even from `.ts` files.
- Config comes only from `src/config.ts` (zod-validated env). Add new knobs
  there **and** in `.env.example` **and** in `testConfig` in
  `test/integration/setup.ts`.
- Schema changes are new numbered files in `src/db/migrations/`
  (`005_*.sql`, ...), idempotent (`IF NOT EXISTS`), with a header comment
  explaining *why*. Never edit an applied migration.
- Comments explain *why* and cite the doc section or test that backs the
  claim. Keep that density in new code.
- Integration tests hit **real** Postgres and Redis — no mocks. Use
  `createTestHarness()`, `waitFor()`, and `createGate()` from
  `test/integration/setup.ts`. Pin race windows with gates
  (`beforeSuccessCommit`/`afterSuccessCommit`), not with sleeps.
- Every reliability claim in docs must point at a test. If you add a
  scenario, add a row to the table in `docs/FAILURE_SCENARIOS.md`.

## Commands

```
npm run typecheck          # tsc --noEmit, ~1s
npm run test:unit          # vitest, no infra needed, <1s
docker compose up -d       # needed for everything below
npm run test:integration   # real Postgres + Redis, uses the jobrelay_test DB
npm run dev:api / dev:worker
```

Flaky-test notes: `demoPanel.test.ts` boots a real Node process and
`redisOutage.test.ts` stops/starts the Redis container. Rerun those alone
before calling something a regression.

## Claude Code setup in this repo

- Hook (`.claude/settings.json` → `.claude/hooks/check-after-edit.mjs`):
  after any edit to a `.ts` file it runs typecheck + unit tests and feeds
  failures back.
- Skills: `/add-fault-scenario`, `/add-migration`.
- Subagent: `reliability-reviewer` — reviews a diff against the invariants
  above. Ask for it before committing anything under `src/worker`,
  `src/db`, `src/outbox`, or `src/queue`.
