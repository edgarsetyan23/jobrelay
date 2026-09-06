# Study guide

## File-reading order

Read in this order; each step builds on the last.

1. **`src/config.ts`** -- every setting the system has, with defaults and
   comments explaining *why* each one is what it is. Skimming this tells you
   the shape of the whole system before reading a line of logic.
2. **`src/db/migrations/001_init.sql`** through **`004_result_attempt_token.sql`**
   -- the schema is the ground truth for what state the system tracks.
3. **`src/db/jobsRepo.ts`** -- every read/write of that schema, in one file.
   Read `createJobWithOutbox` first (idempotency + outbox in one
   transaction), then the `transitionTo*` functions (the guarded state
   machine), then the outbox/worker-registry helpers at the bottom.
4. **`src/jobs/fingerprint.ts`** and **`src/jobs/thumbnails.ts`** -- the
   actual "business logic," deliberately small and dependency-light so it's
   easy to unit test (see `test/unit/`).
5. **`src/outbox/dispatcher.ts`** -- bridges Postgres and Redis; read the big
   comment on `publishOnce` closely, it explains the duplicate-publication
   story referenced everywhere else.
6. **`src/api/submitImageJob.ts`** then **`src/api/routes/jobs.ts`** -- how a
   request becomes a job.
7. **`src/worker/processor.ts`**, alongside **`src/storage/paths.ts`**'s
   "Attempt isolation" functions -- the other half of a job's life. This is
   the single most important file to understand deeply; every reliability
   guarantee in the project is enforced somewhere in this function.
8. **`src/worker/worker.ts`** -- how a processor becomes a running BullMQ
   `Worker`, plus the heartbeat and graceful-shutdown wiring.
9. **`src/api/demoWorkerManager.ts`** and **`src/api/routes/demo.ts`** -- the
   interactive panel's process-control surface, and why it's safely scoped.
10. **`public/app.js`** -- how the frontend turns polled API responses into
    the dispatch board / worker stations / ticket detail you see on screen.
11. **`docs/ARCHITECTURE.md`** and **`docs/FAILURE_SCENARIOS.md`** -- now that
    you've read the code, these should mostly confirm what you already
    inferred, and fill in the "why" behind the choices.

## Key functions explained

### `createJobWithOutbox` (`src/db/jobsRepo.ts`)

Takes a pre-generated job id (so the caller can write the uploaded file to
disk under that id *before* any database row references it), computes the
idempotency fingerprint, and does `INSERT ... ON CONFLICT (idempotency_key)
DO NOTHING` plus an outbox insert in one transaction. If the insert didn't
happen (conflict), it reads back the existing row and either returns it (same
fingerprint: this is a replay) or throws `IdempotencyConflictError`
(different fingerprint: 409). The three-way branch -- created / replayed /
conflict -- is the entire idempotency contract in about 30 lines.

### `publishOnce` (`src/outbox/dispatcher.ts`)

Claims a batch of unpublished outbox rows with `SELECT ... FOR UPDATE SKIP
LOCKED` (so this is safe even if called concurrently, though today only one
process ever calls it), tries `queue.add()` for each, and commits
success/failure state for the whole batch in one transaction. Read this
alongside `docs/ARCHITECTURE.md`'s "how duplicate publication is handled" --
the short version is that BullMQ's `jobId`-based dedup makes a second
`add()` for the same job a no-op in the common case.

### `makeProcessor` -> `processJob` (`src/worker/processor.ts`)

The heart of the system. In order: fetch the job; if it's already terminal,
return the stored result and stop (duplicate-delivery guard); otherwise mint
a fresh `runningToken` (`randomUUID()`) and guard-transition to `running`
with it; record an attempt; run the fault-injection hook (only ever live for
demo jobs); validate + generate thumbnails; on success, guard-transition to
`succeeded`; on `ValidationError`, guard-transition to `failed` and throw
`UnrecoverableError` (no retry); on any other error, guard-transition to
`retrying` or `failed` (if attempts are exhausted) and re-throw a plain error
so BullMQ's own retry/backoff bookkeeping applies. Every transition function
it calls is one of the guarded `UPDATE ... WHERE status NOT IN (...)`
functions in `jobsRepo.ts` -- that's what makes this function safe to call
twice for the same job.

The finalizing transitions (`transitionToSucceeded`/`Retrying`/`Failed`) also
require `runningToken` to match the job's *current* `running_token` in
Postgres. That's a second, independent guard from the status check: status
alone stops a stale write from clobbering a *terminal* job, but it can't
arbitrate between two attempts that are simultaneously non-terminal -- e.g. a
worker whose lock merely expired (so BullMQ redelivered the job) but which is
still alive and still processing. Both attempts see `status = 'running'` and
would be equally entitled to finalize under a status-only guard. Because
`transitionToRunning` stamps a fresh token every time a job (re-)enters
`running`, the older attempt's eventual finalize call presents a token that's
already been overwritten, and its write is a no-op instead of a race -- see
`test/integration/attemptOwnership.test.ts` and
`src/db/migrations/003_attempt_ownership.sql`. When a finalize call loses
this race, `processJob` logs a warning and discards its own write; it does
not retry or error out on account of the loss, since a different attempt
already owns the job's outcome. Note this also means BullMQ's own
`attemptsMade` (and the job's `attempts` column) can repeat across attempts
in a stall-recovery scenario -- it isn't incremented just because a stalled
job was redelivered, only when an attempt actually threw -- which is exactly
why `runningToken` is a fresh random value per attempt rather than derived
from `attemptsMade`.

The same `runningToken` also isolates *files*, not just the database row:
`generateThumbnails` is pointed at
`attemptThumbnailPathFor(storagePaths, jobId, runningToken, label)` -- a
directory unique to this attempt, which it never leaves. There is no
promotion step: if `transitionToSucceeded` confirms this attempt won, that
same guarded UPDATE also stamps `result_attempt_token = runningToken` --
this attempt's directory simply *is* the job's result from then on, until
retention purges it. A losing or errored attempt calls `discardAttemptResult`
instead, deleting its directory outright. The download endpoint
(`api/routes/files.ts`) looks up `result_attempt_token` in Postgres on every
request and serves straight from that attempt's directory -- there's no
fixed, job-scoped path it could instead assume. This is what stops a
stale-but-still-alive attempt from overwriting (or partially overwriting
mid-write) a winner's already-published thumbnails: there's nothing to
overwrite, because nothing the winner wrote ever moves. See
`test/integration/attemptIsolation.test.ts`,
`test/integration/successCommitCrash.test.ts`, and the "Attempt isolation"
part of docs/ARCHITECTURE.md's Storage section.

### `makeBackoffStrategy` (`src/queue/backoff.ts`)

A closure over the configured base/max/jitter that BullMQ calls with
`attemptsMade` and expects a delay in milliseconds back. Small, pure,
directly unit-testable (though today it's covered indirectly through the
retry integration tests) -- a good example of keeping BullMQ-specific
plumbing (`Worker` construction) separate from the actual policy (the delay
math).

### `DemoWorkerManager` (`src/api/demoWorkerManager.ts`)

Spawns demo worker processes with `child_process.spawn(process.execPath,
[tsxCliPath, workerScriptPath], { env: {...} })` -- a direct process spawn,
not a shell wrapper, specifically so `child.kill('SIGKILL')` reliably reaches
the actual Node process instead of a `cmd.exe`/shell layer sitting in front
of it. It tracks spawned ids in memory; `stop(id)` only acts if `id` is in
that map, which is the entire safety guarantee behind "this can't kill
anything else."

## Interview questions

Try answering these from memory, then check your answer against the code.

1. Two requests submit with the same idempotency key at the same instant.
   Walk through exactly what happens at the database level and why there's
   no race condition.
2. A job's outbox event is published to Redis, but the process crashes
   before marking it published in Postgres. What happens the next time the
   sweeper runs, and why doesn't it create a duplicate job?
3. Why is `UnrecoverableError` used for validation failures instead of just
   letting the job run out of retries naturally?
4. What's the difference between BullMQ's `lockDuration` and
   `stalledInterval`, and what would happen if `stalledInterval` were set
   *longer* than a typical job's processing time?
5. Why does `transitionToRunning` allow `running -> running`, when every
   other transition only allows leaving a specific starting state?
6. `transitionToRunning` also stamps a fresh `running_token` every time,
   unconditionally. `job.attemptsMade` (BullMQ's own attempt counter) can't
   be used for this instead -- why not? What specific scenario does
   `running_token` guard against that the `status`-only guard alone doesn't?
7. The benchmark shows completed-jobs/sec roughly doubling from concurrency 1
   to 2, then leveling off well before concurrency 8. What are three
   plausible reasons throughput would plateau like that?
8. The payload fingerprint includes `contentSha256`, a hash of the image
   bytes, alongside `originalFilename` and `fileSizeBytes`. Why isn't the
   filename/size pair enough on its own?
9. What specifically stops a normal (non-demo) upload from ever being
   affected by the `_fault` mechanism, at the code level (not just "it's not
   exposed in the UI")?
10. If Redis's data were completely lost right now, what could be recovered
    from Postgres alone, and what's missing to actually do that automatically?
11. Why are there two separate BullMQ queues instead of one queue with an
    `is_demo` flag inspected by a single shared worker pool?
12. `src/worker/worker.ts` tracks its in-flight jobs in a `Set<string>`
    rather than a single `currentJobId` variable. Construct a concrete
    sequence of events with `WORKER_CONCURRENCY=2` where the single-variable
    version reports `idle` while a job is still actually running.
13. `jobs` has both `running_token` and `result_attempt_token`. Why can't one
    column do both jobs? (Hint: what does `running_token` do on every
    `running -> running` re-entry that `result_attempt_token` must never do
    once a job has succeeded?)
14. There's no `promoteAttemptResult` function -- a winning attempt's files
    never move. What would have to be true for a "promote the winner's
    directory into a shared, job-scoped path" design to be just as safe as
    the current one? Why is that harder to guarantee than it sounds?

## Exercises

1. **Add a fourth thumbnail size.** Change `THUMBNAIL_SIZES` in
   `src/jobs/thumbnails.ts`, and update the relevant unit test's expectations.
   Notice you don't have to touch the worker, the API, or the frontend at
   all -- the result shape and thumbnail URLs are generated generically.
2. **Add a `GET /api/jobs/:id/original` endpoint** that serves the uploaded
   source file (careful: only while it hasn't been purged by the retention
   sweep -- handle the "file gone" case the way `routes/files.ts` already
   does for thumbnails).
3. **Make retry exhaustion configurable per-request** (e.g. an optional
   `maxAttempts` field the client can lower, bounded server-side to
   `MAX_JOB_ATTEMPTS`). Think about where the validation belongs and what
   should happen to a job already in flight when this changes nothing about
   its `max_attempts`.
4. **Implement the "rebuild the queue from Postgres" recovery** referenced in
   `docs/ARCHITECTURE.md`: a script that finds jobs stuck `queued` for longer
   than some threshold with no matching unpublished (or published) outbox
   row, and re-inserts an outbox event for them.
5. **Add a fourth demo control**: "Simulate always-fail" using the existing
   `always-fail` fault mode, and design (in a paragraph, no code needed) how
   you'd keep it from being confused with a *real* systemic outage on the
   dispatch board.
6. **Multi-tenant, for real**: sketch (schema + one endpoint's code) what
   changes to add a `tenant_id` and enforce it on `GET /api/jobs`.

## Five-minute demo script

1. **(0:00-0:30)** Open `http://localhost:3000`. Point out the dispatch
   board, worker stations, and the "no simulated progress" framing -- every
   number on screen came from a poll of a real endpoint.
2. **(0:30-1:15)** Click "Try a sample," then "Submit ticket." Watch the
   ticket move from "waiting" to "processing" to "completed" in real time;
   click it and show the thumbnails and attempt history.
3. **(1:15-2:00)** Demo panel, control 1: "Send twice." Explain the
   idempotency-key mechanism while it runs; point at the matching job ids in
   the result.
4. **(2:00-3:00)** Control 2: "Fail this attempt." Narrate the attempt
   history as it appears: attempt 1 retrying with a reason, attempt 2
   succeeding. Mention the bounded exponential backoff with jitter, and that
   this fault is only possible because the job is flagged `is_demo` at the
   database level.
5. **(3:00-4:15)** Control 3: "Stop this worker" -- the centerpiece. Explain
   *before* clicking that this kills a real OS process. Click it, and narrate
   live: the worker station flips to "offline," a moment later the ticket's
   attempt history shows a second attempt from a different worker, and it
   finishes successfully anyway. This is the whole "pull the plug, watch it
   recover" pitch in one interaction.
6. **(4:15-5:00)** Close with the tradeoffs: why two databases, why an
   outbox, and that this deliberately claims at-least-once (not
   exactly-once) execution -- point at `docs/ARCHITECTURE.md` and
   `docs/FAILURE_SCENARIOS.md` for anyone who wants the details afterward.
