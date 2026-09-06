# Architecture

## Components

| Component | File(s) | Responsibility |
|---|---|---|
| API process | `src/api/*` | HTTP surface, upload handling, outbox dispatch, retention sweep, demo worker process management |
| Main worker | `src/worker/*` | Processes normal (non-demo) jobs; you run this yourself (`npm run dev:worker`) |
| Demo workers | `src/worker/*`, spawned by `src/api/demoWorkerManager.ts` | Process demo-queue jobs only; the API spawns, and can kill, exactly these processes |
| PostgreSQL | `src/db/*` | Durable job state, outbox, attempt history, worker heartbeats -- the single source of truth |
| Redis + BullMQ | `src/queue/*` | Queued, retried, concurrency-controlled execution -- disposable, rebuildable from Postgres if lost |
| Local filesystem | `src/storage/paths.ts` | Uploaded originals and generated thumbnails |
| Frontend | `public/*` | Single static page, polls the API, renders real state |

### Why a queue at all?

Without one, the API would have to run the image-processing work itself,
inline, while the visitor's HTTP request waits. That couples "accepting the
request" to "having capacity to do the work right now" -- a burst of uploads
either queues up inside a single process's event loop (with no visibility
into how backed-up it is) or starts failing requests outright. A queue
separates those two concerns: the API's job is just "durably record that this
work needs to happen" (fast, cheap, always available), and workers pull from
the queue at whatever rate they can sustain, with retries and backoff handled
uniformly instead of ad hoc in every request handler.

### Why PostgreSQL *and* Redis -- different responsibilities

They are deliberately not interchangeable here:

- **PostgreSQL is the durable record.** ACID transactions, a real query
  language, and no data loss on restart. It's slow-ish for the specific
  pattern "many workers racing to grab the next available unit of work,"
  but that's not what it's used for.
- **Redis (via BullMQ) is the execution engine.** Fast atomic operations
  (via Lua scripts) for "give me the next job, and guarantee no other worker
  also gets it," push-based delivery, delayed/retry scheduling, and stalled-
  job detection -- all things you'd have to hand-roll with polling and
  row-level locks if you tried to do it in Postgres alone (see
  [Comparison with a Postgres-only queue](#comparison-with-a-postgres-only-queue)).

If Redis's data were lost entirely, JobRelay could rebuild the queue from
Postgres (every non-terminal job's outbox event would need to be marked
unpublished and re-swept -- not implemented today, but the data to do it is
all there, because Postgres is authoritative). If Postgres's data were lost,
there would be nothing left describing what the jobs even were.

### Why the transactional outbox exists

The moment a job is accepted, two separate systems need to end up consistent:
"there's a durable record in Postgres" and "there's a queued unit of work in
Redis." A network hiccup, a process restart, or Redis simply being down for a
few seconds sits right in the gap between those two writes. Two naive
approaches both fail:

- **Write to Postgres, then call `queue.add()` before responding.** If the
  `queue.add()` call fails (Redis down), do you fail the whole request after
  already committing the Postgres row? Now you have a job that exists
  durably but will never run, with no record of that inconsistency.
- **Call `queue.add()` first, then write to Postgres.** Now a crash between
  the two leaves a queued BullMQ job with no Postgres row for the worker to
  update -- worse, because the queue side has no way to know it's orphaned.

The outbox pattern (`outbox_events` table, `src/outbox/dispatcher.ts`) fixes
this by writing the job row *and* an outbox row in one Postgres transaction
(`createJobWithOutbox` in `src/db/jobsRepo.ts`). The 202 response is gated
only on that transaction committing -- "durably accepted" means exactly what
it says regardless of Redis's health at that instant. A background sweeper
(and a best-effort immediate attempt right after submission, for low latency
in the common case) then publishes any outbox rows still marked unpublished.
See [docs/FAILURE_SCENARIOS.md](FAILURE_SCENARIOS.md) for the Redis-outage
case end to end.

**How duplicate publication is handled:** every BullMQ job is added with
`jobId` set to the Postgres job's own UUID. BullMQ treats `queue.add()` with
an already-present `jobId` (waiting/active/delayed) as a no-op -- so if the
sweeper's transaction fails to commit *after* a successful `queue.add()` (and
therefore retries the same row later), the second `add()` just doesn't create
a second job. The narrow case where the first execution already *completed
and was trimmed* from Redis before a retry lands would cause a second real
execution -- which is exactly why result persistence is also independently
idempotent (next section), rather than relying on BullMQ's dedup alone.

### At-least-once execution, and how retries create duplicates

JobRelay never claims exactly-once execution -- it isn't achievable across
two independent systems (Postgres + Redis) without a distributed transaction,
which BullMQ doesn't offer and most real systems don't use for this reason.
Instead, every layer is built to make **at-least-once** safe:

1. A worker can be delivered the same job twice (duplicate BullMQ delivery,
   or a stalled-job requeue after a crash that *hadn't* actually died -- a
   slow GC pause past the lock's TTL, for instance).
2. `worker/processor.ts` re-reads the job's current Postgres status before
   doing any work. If it's already `succeeded` or `failed`, it returns the
   stored result immediately and does nothing else.
3. Every write that moves a job to a terminal state is a guarded SQL
   `UPDATE ... WHERE status NOT IN ('succeeded','failed')`. If two workers
   somehow raced past step 2, only one's `UPDATE` actually changes anything;
   the other affects zero rows and is a silent no-op.

The upshot: retries (and any other form of duplicate delivery) can cause the
same computation to run more than once, but never cause more than one
authoritative result to be stored, and never let a stale/duplicate worker
overwrite a terminal outcome. `test/integration/duplicateDelivery.test.ts`
and `test/integration/crashRecovery.test.ts` both exercise this directly.

### Two queues, not one

`src/queue/queue.ts` creates a `main` queue and a `demo` queue on the same
Redis instance, with entirely separate BullMQ `Queue`/`Worker` instances.
This is the mechanism that makes the interactive demonstration panel safe:
demo workers (`src/api/demoWorkerManager.ts`) only ever consume the demo
queue, so "Stop this worker" can only ever kill a process handling a
demo-flagged job -- it has no path to a normal visitor's upload, which always
goes through the main queue and the main worker you start yourself. Fault
injection (`src/faults/inject.ts`) is likewise only ever read from
`job.is_demo` at the Postgres row level, never from anything the client can
set on a normal submission.

### Storage

Uploaded originals live at `STORAGE_DIR/uploads/<jobId>.upload`; generated
thumbnails at `STORAGE_DIR/results/<jobId>/<small|medium|large>.jpg`. Both
the API (writes the upload) and every worker (reads the upload, writes
results) need to see the same `STORAGE_DIR` -- on one machine that's just a
shared path, which is what this project assumes throughout. The moment the
API and workers run on *different* machines, this stops being true: you'd
need either a network filesystem, or (more realistically for most real
deployments) to swap local disk for an object store (S3-compatible) and have
workers fetch/upload by key instead of by path. Nothing else about the
architecture changes -- `src/storage/paths.ts` is the one module that would
need a different implementation.

### Multi-tenant

Today `is_demo` is the only dimension separating jobs, and there is no
`tenant_id` anywhere. To support multiple tenants safely:

- Add `tenant_id` to `jobs`, and make the idempotency-key uniqueness
  constraint `(tenant_id, idempotency_key)` instead of global -- otherwise
  one tenant's key collides with another's.
- Every read endpoint (`GET /api/jobs`, `GET /api/jobs/:id`, `.../attempts`)
  needs a tenant filter, not just an id lookup -- right now any caller can
  read any job.
- Some actual authentication to establish which tenant a request belongs to
  (today: none, by design, for this local demo -- see README "Security").
- Storage paths would need a `tenant_id` segment so two tenants can't
  guess/collide on each other's job ids (unlikely with UUIDs, but defense in
  depth matters more once it's not just you using it).
- Worker fairness: today all jobs share one queue/worker pool; a noisy
  tenant could starve others. A real multi-tenant version would need
  per-tenant rate limiting or separate queues/priority.

### Comparison with a simpler PostgreSQL-only queue

A `SELECT ... FOR UPDATE SKIP LOCKED` polling loop directly against a
`jobs` table is a legitimate, much simpler alternative for many workloads,
and this project's own `jobs`/`outbox_events` tables already show the shape
of it. What you give up by *not* adding Redis/BullMQ:

| | Postgres-only queue | JobRelay (Postgres + Redis/BullMQ) |
|---|---|---|
| Moving parts | 1 database | 2 systems to run and reason about |
| Delivery | Poll on an interval (latency = poll interval) | Push-based (near-zero latency) |
| Retry/backoff scheduling | Hand-rolled (a `next_attempt_at` column + more polling) | Built in, with jitter |
| Stalled-job detection | Hand-rolled (a lease/heartbeat column) | Built in (`lockDuration`/`stalledInterval`) |
| Throughput ceiling | Bounded by Postgres write throughput for lock contention | Redis handles the hot "what's next" path; Postgres only does durable bookkeeping |
| Operational familiarity | If you already run Postgres, nothing new to operate | One more system (Redis) to monitor/back up/scale |

If your volume is low and latency requirements are relaxed, skip Redis
entirely. JobRelay adds it because the assignment explicitly wants push-based
delivery, backoff-with-jitter, and stalled-job recovery demonstrated as
first-class behavior, not because a Postgres-only queue can't work.

## Life of one job, end to end

Using a normal (non-demo) image upload as the example; the demo path is
identical except for the queue name and (for demo jobs only) an optional
fault spec read from the payload.

1. **`POST /api/jobs`** (`src/api/routes/jobs.ts`) -- multer buffers the
   upload in memory (bounded by `MAX_UPLOAD_BYTES`); the handler requires an
   `Idempotency-Key` header and a file.
2. **`submitImageJob`** (`src/api/submitImageJob.ts`) generates a job id
   (`crypto.randomUUID()`), writes the raw bytes to
   `STORAGE_DIR/uploads/<id>.upload` *before* touching Postgres -- so by the
   time any DB row exists, the file it refers to is already durably on disk.
3. **`createJobWithOutbox`** (`src/db/jobsRepo.ts`) computes a payload
   fingerprint (sha256 of a canonicalized JSON descriptor -- see
   [Idempotency fingerprint](#idempotency-fingerprint) below) and, in one
   transaction, `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING` into
   `jobs` plus an `outbox_events` row. If the insert lost the race (another
   request already used this key), the existing row's fingerprint is
   compared: same fingerprint -> return it (replay); different -> throw
   `IdempotencyConflictError` (mapped to HTTP 409).
4. The API responds **202** (job status `queued`) the instant that
   transaction commits, and fires a best-effort, non-blocking attempt to
   publish the outbox event immediately.
5. **`publishOnce`** (`src/outbox/dispatcher.ts`), either from that immediate
   attempt or the next tick of the periodic sweeper, claims the outbox row
   (`SELECT ... FOR UPDATE SKIP LOCKED`) and calls `queue.add()` with
   `jobId` = the Postgres job id, then marks the row published.
6. A **worker** (`src/worker/worker.ts` running `makeProcessor` from
   `src/worker/processor.ts`) picks the job off the queue. It re-fetches the
   Postgres row (duplicate-delivery guard), transitions it to `running`
   (`UPDATE ... WHERE status NOT IN ('succeeded','failed')`), and records an
   attempt row.
7. The worker reads the uploaded file, validates it for real
   (`validateImageBuffer` in `src/jobs/thumbnails.ts` -- format, dimensions,
   pixel count), and generates three thumbnails.
8. **Success**: `transitionToSucceeded` (guarded the same way), attempt row
   marked `succeeded`, structured log with job id/attempt/transition/duration.
   **Permanent failure** (bad input): `transitionToFailed` +
   `UnrecoverableError`, so BullMQ never retries. **Transient failure**: if
   attempts remain, `transitionToRetrying` and a plain `Error` is thrown so
   BullMQ schedules a retry with jittered exponential backoff
   (`src/queue/backoff.ts`); if attempts are exhausted, `transitionToFailed`
   with `"retries exhausted: ..."`.
9. The frontend, polling `GET /api/jobs` and `GET /api/jobs/:id/attempts`
   every ~1.5s, reflects each of these transitions as they happen -- there is
   no simulated progress anywhere in the UI.

### Idempotency fingerprint

`src/jobs/fingerprint.ts` computes `sha256(canonicalJSON(payload))`, where
`canonicalize()` recursively sorts object keys (so `{a,b}` and `{b,a}` hash
identically) before `JSON.stringify`. For an image submission, the "payload"
fingerprinted is `{ originalFilename, fileSizeBytes, contentSha256, _fault? }`
-- `contentSha256` is a sha256 of the uploaded bytes themselves, computed once
in `submitImageJob.ts` before the file is written to disk. Hashing the bytes
(not just the display filename and byte count) is what makes the
idempotency-conflict check trustworthy: two different images that happen to
share a filename and size -- easy to construct by accident or on purpose --
must not be treated as "the same request" just because an idempotency key was
reused. Hashing is a single streaming pass over a buffer already held in
memory, so the cost is negligible next to the thumbnail generation the job
does anyway.

## What would need to change for real production use

- Authentication (see README "Security").
- Object storage instead of local disk once workers aren't co-located with
  the API (see "Storage" above).
- Multi-tenant isolation (see "Multi-tenant" above).
- A real metrics/alerting pipeline (`src/metrics/metrics.ts` is intentionally
  a minimal in-process counter set, reset on restart, per the assignment's
  "a simple status endpoint or CLI is sufficient").
