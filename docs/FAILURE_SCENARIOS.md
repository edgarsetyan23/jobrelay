# Failure scenarios

Every scenario below is backed by a real integration test against real
Postgres and Redis (`test/integration/*.test.ts`), and several are also
reachable live through the UI's demonstration panel. "Implemented, tested,
demo" columns say exactly that -- nothing here is aspirational.

| Scenario | Implemented | Tested | Live demo |
|---|---|---|---|
| Concurrent submissions, same idempotency key | yes | `api.test.ts` | "Send twice" |
| Same key, different payload -> 409 | yes | `api.test.ts` | -- |
| Invalid input fails permanently, no retries | yes | `images.test.ts` | -- |
| Transient failure, then success | yes | `retries.test.ts`, `demoPanel.test.ts` | "Fail this attempt" |
| Retry exhaustion | yes | `retries.test.ts` | -- |
| Worker crash mid-job, recovery | yes | `crashRecovery.test.ts`, `demoPanel.test.ts` (real process) | "Stop this worker" |
| Redis unavailable after Postgres accept, then recovery | yes | `redisOutage.test.ts` | -- |
| Duplicate delivery -> one authoritative result | yes | `duplicateDelivery.test.ts` | -- |
| Graceful shutdown (API and worker) | yes | manual (see below) | -- |

## Concurrent submissions with the same idempotency key

**What happens:** N requests race to submit with the same key. Exactly one
job is created; the rest see the same job back.

**Why it's safe:** the unique constraint on `jobs.idempotency_key` plus
`INSERT ... ON CONFLICT (idempotency_key) DO NOTHING` (in
`createJobWithOutbox`, `src/db/jobsRepo.ts`) make this atomic at the database
level -- there is no read-then-write race window in application code for two
requests to both "see no existing row" and both insert. Exactly one `INSERT`
succeeds; every other caller falls through to a `SELECT` and fingerprint
comparison.

## Reusing a key with a different payload

**What happens:** the second request's fingerprint doesn't match the first's
-> `IdempotencyConflictError` -> HTTP 409 with the existing job's id.

**Why:** same code path as above, just the fingerprint-comparison branch. See
`docs/ARCHITECTURE.md` "Idempotency fingerprint" for exactly what's hashed.

## Invalid input fails permanently

**What happens:** a corrupt file, an unsupported format, or an image
exceeding the configured dimension/pixel limits is accepted (202) -- API-side
validation is deliberately light (see "The worker validates the data"
below) -- and then fails on its very first attempt, with `attempts: 1`
forever.

**How:** `validateImageBuffer` (`src/jobs/thumbnails.ts`) throws
`ValidationError`. `worker/processor.ts` catches specifically that type and
throws BullMQ's `UnrecoverableError`, which "will just move to the failed set
without performing any retries, overriding any `attempts` settings" (BullMQ's
own documented behavior) -- so this never goes through the backoff/retry path
at all.

**Why validation lives in the worker, not the API:** this mirrors the
original design intent for this project (validate where the actual data is
inspected) and makes the async failure genuinely observable end to end on the
dispatch board -- a visitor watches a ticket go from "processing" to "failed"
with a real reason, rather than the API silently pre-rejecting it. Multer
still enforces `MAX_UPLOAD_BYTES` synchronously (413) since that's a
transport-level concern, not a content one.

## Transient failure, then success

**What happens:** an attempt fails for a reason that might not recur; the
job retries and succeeds.

**How:** anything that isn't `ValidationError` is treated as transient.
`transitionToRetrying` records the failure and BullMQ schedules the next
attempt using a **bounded exponential backoff with jitter**
(`src/queue/backoff.ts`, `makeBackoffStrategy`): `delay = min(BACKOFF_BASE_MS
* 2^(attempt-1), BACKOFF_MAX_MS)`, then +/- `delay * BACKOFF_JITTER` applied
randomly. It's registered as a BullMQ *custom* backoff strategy
(`settings.backoffStrategy` on the `Worker`, selected per job via `backoff:
{ type: "custom" }`) specifically so the cap (`BACKOFF_MAX_MS`) is
enforced -- BullMQ's built-in `exponential` type supports a base delay and
jitter but not a hard ceiling.

**Live demo:** "Fail this attempt" submits a demo job with `_fault: {mode:
"transient-fail-count", failCount: 1}` (`src/faults/inject.ts`) -- honored
*only* because the job's Postgres row has `is_demo = true`; the exact same
field on a normal upload is inert (see `docs/ARCHITECTURE.md` "Two queues,
not one").

## Retry exhaustion

**What happens:** every attempt fails; once `attempts >= max_attempts`, the
job is `failed` with `"retries exhausted: <last error>"`.

**How:** `worker/processor.ts` checks `attemptNumber >= record.max_attempts`
(same number passed to BullMQ's `attempts` option at submission time, so the
two stay in lockstep) before deciding whether to retry or give up.

**Where the failed job lives:** **Postgres is authoritative**, not BullMQ's
own failed set. The `jobs` row (`status = 'failed'`) and every attempt in
`job_attempts` (with `error` and `duration_ms` per attempt) persist
indefinitely and are queryable via `GET /api/jobs/:id/attempts` regardless of
what Redis does with the underlying BullMQ job afterward (BullMQ's
`removeOnFail: { count: 5000 }` in `src/queue/queue.ts` trims Redis's own
copy once it's operationally uninteresting -- that's fine, because it was
never the source of truth).

## Worker crash mid-job, and recovery

**What happens:** a worker process dies (crash, `kill -9`, or -- live in the
demo -- the API killing a demo worker child process) while holding a job.
Another worker eventually picks the same job up and finishes it.

**The mechanism, precisely:**

- Every job a `Worker` is processing holds a Redis-backed **lock** for
  `lockDuration` milliseconds (`LOCK_DURATION_MS`, default 8000 here --
  intentionally shorter than BullMQ's usual 30000 default so the *live demo*
  recovers in seconds, not half a minute; see the comment in `config.ts`).
  A healthy worker renews its own lock automatically at roughly half that
  interval.
- Every `stalledInterval` milliseconds (`STALLED_INTERVAL_MS`, default
  2000), **any** active `Worker` instance on that queue checks for jobs
  whose lock has expired without renewal. A crashed process can't renew
  anything, so its job's lock simply expires.
- A stalled job is moved back to `wait` and delivered to whichever worker
  polls next -- which is how "a sibling worker completes it" actually
  happens; there is no special-casing of *which* worker recovers it.
- `maxStalledCount` (default 2) bounds this: a job that stalls repeatedly
  (not just once) is eventually moved to `failed` outright, treating it as a
  poison job rather than retrying forever.
- On the Postgres side, `transitionToRunning` deliberately allows
  transitioning `running -> running` (not just `queued/retrying ->
  running`), because the recovering attempt finds the row already marked
  `running` from the dead worker's last write.

**Graceful vs. crash, and what changes:** `worker.close()` (called on
`SIGINT`/`SIGTERM` in `worker.ts`) stops accepting new jobs and waits for
in-flight ones to finish before exiting -- no stalled-job recovery is
involved because nothing actually stalls. A crash (or the demo's
`SIGKILL`) skips all of that; recovery is entirely the stalled-job mechanism
above. **On Windows specifically**, `child_process.kill()` always hard-
terminates the process regardless of the signal name passed (there's no real
POSIX signal delivery), so on this platform "graceful shutdown" only really
differs from "crash" in whether your own shutdown handler had a chance to
run at all -- both still result in the process actually stopping.

**Live demo:** "Stop this worker" submits a demo job with a `slow` fault
(`{mode: "slow", delayMs: 6000, onlyOnAttempt: 1}`) so there's a window to
identify and kill the worker mid-attempt; `src/api/demoWorkerManager.ts`
kills that *specific* child process (`SIGKILL`) and, after a short delay,
respawns a replacement so the demo pool stays at full strength.

## Redis unavailable after Postgres acceptance

**What happens:** a job is durably accepted (202, row exists in `jobs`) while
Redis happens to be down; once Redis comes back, the job is dispatched and
processed with no further action from the client.

**How:** the outbox row stays `published = false` until a `publishOnce`
sweep successfully calls `queue.add()`. The API's own Redis connection
(`createApiRedisConnection`, `src/queue/connection.ts`) is deliberately
configured with a *small* `maxRetriesPerRequest` and a bounded
`connectTimeout` so a failed publish attempt returns quickly instead of
hanging the sweep loop; the sweeper just tries again on its next tick
(`OUTBOX_SWEEP_INTERVAL_MS`). Meanwhile, workers' own Redis connections
(`createWorkerRedisConnection`) use ioredis's normal indefinite reconnect
behavior (required for BullMQ's blocking commands: `maxRetriesPerRequest:
null`), so a worker that was already running reconnects on its own once
Redis is reachable again -- nothing needs to be restarted.

**Tested by** `test/integration/redisOutage.test.ts`, which actually shells
out to `docker stop`/`docker start` on the `jobrelay-redis` container --
a real outage, not a mocked one.

## Duplicate delivery -> one authoritative result

Covered in detail in `docs/ARCHITECTURE.md` ("At-least-once execution, and
how retries create duplicates"). In short: BullMQ's own `jobId`-based
deduplication prevents most duplicate executions from ever starting; for the
residual case where a duplicate *does* reach a worker, the processor's
terminal-state short-circuit and every state-transition's guarded `UPDATE`
guarantee that only the first execution's result is ever stored.

## Graceful shutdown

**API** (`src/api/server.ts`): on `SIGINT`/`SIGTERM`, stops the outbox and
retention sweepers, stops accepting new HTTP connections
(`server.close()`), closes both BullMQ `Queue` instances, disconnects Redis,
and closes the Postgres pool -- in that order, so in-flight requests finish
before dependencies go away.

**Worker** (`src/worker/worker.ts`): on `SIGINT`/`SIGTERM`, calls
`worker.close()` (BullMQ waits for active jobs to finish processing before
resolving), deletes its own row from the `workers` heartbeat table (so it
disappears from the worker-station board immediately, rather than lingering
as "offline" until the retention sweep's stale-row cleanup), then closes its
Postgres pool and Redis connection.

**What a hard kill leaves behind:** a worker row that stops receiving
heartbeats. `GET /api/workers` (`src/api/routes/workers.ts`) infers
`offline` from `last_heartbeat_at` being older than
`WORKER_OFFLINE_THRESHOLD_MS` -- nothing marks itself offline, because a
truly crashed process can't. `cleanup/retention.ts` prunes worker rows
stale for more than five minutes on its periodic sweep, so long-dead rows
don't accumulate forever.
