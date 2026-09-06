# JobRelay -- an interactive dispatch workshop

**Pull the plug. Watch it recover.**

JobRelay is a small, complete asynchronous job-processing service. It looks
like a toy (upload an image, get three thumbnails back) but underneath it
demonstrates the reliability engineering a real background-job system needs:
durable submission, a transactional outbox, idempotency, bounded retries with
backoff, and recovery from a worker crashing mid-job -- and it lets you
*trigger* that crash yourself, on real processes, and watch the queue recover
in front of you.

It is a local, single-tenant demonstration. It has no authentication and is
not meant to be deployed publicly (see [Security](#security)).

## Quick start (Windows CMD)

```cmd
docker compose up -d
copy .env.example .env
npm install
npm run migrate
npm run dev:worker
```

In a second terminal:

```cmd
npm run dev:api
```

Then open **http://localhost:3000**. Click "Try a sample" and "Submit
ticket", or scroll to the Demonstration panel and click "Stop this worker".

See [5-minute demo script](docs/STUDY_GUIDE.md#five-minute-demo-script) for a
guided walkthrough.

## What it does

- Submit a JPEG/PNG/WebP image (or use the built-in sample). A worker
  generates three gallery thumbnails (small/medium/large) and you can preview
  and download each.
- Watch a live dispatch board (waiting / processing / completed / failed) and
  worker stations (idle / busy / offline) -- all backed by real data polled
  from the API, never simulated.
- Click any ticket to see its full attempt history and, once it succeeds, its
  thumbnails.
- Use the demonstration panel to run three real failure scenarios against an
  isolated demo queue and demo worker pool:
  1. **Send twice** -- same idempotency key, same ticket back both times.
  2. **Fail this attempt** -- a controlled transient failure, then a
     successful retry.
  3. **Stop this worker** -- the API kills a real demo worker child process
     mid-job; a sibling worker picks the job up once BullMQ's stalled-job
     check notices, and it finishes anyway.

## Architecture at a glance

```
                     ┌─────────────────────────┐
 visitor's browser──▶│   API process (Express) │
 (polls every ~1.5s) │  + outbox dispatcher     │
                     │  + retention sweeper     │
                     │  + demo worker manager   │──spawns/kills──▶ 2x demo worker
                     └───────────┬─────────────┘                  (child processes)
                                 │
                     ┌───────────┴─────────────┐
                     │        PostgreSQL        │  durable job state,
                     │  jobs / outbox_events /  │  outbox, attempt history,
                     │  job_attempts / workers  │  worker heartbeats
                     └───────────┬─────────────┘
                                 │ outbox dispatch
                     ┌───────────┴─────────────┐
                     │          Redis           │  queued execution
                     │   (BullMQ: main queue,   │
                     │       demo queue)         │
                     └───────────┬─────────────┘
                                 │
                     ┌───────────┴─────────────┐
                     │   main worker process    │  independently run,
                     │  (npm run dev:worker)    │  reads/writes shared
                     └───────────┬─────────────┘  STORAGE_DIR
                                 │
                     ┌───────────┴─────────────┐
                     │   ./data (shared local   │  uploaded originals +
                     │      filesystem)          │  generated thumbnails
                     └──────────────────────────┘
```

Full detail, including the life of one job end to end: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Local startup commands (Windows CMD)

```cmd
docker compose up -d
copy .env.example .env
npm install
npm run migrate
npm run dev:worker
```
(second terminal)
```cmd
npm run dev:api
```

Other useful commands:

```cmd
npm run test:unit
npm run test:integration
npm run bench -- --jobs=40 --concurrencies=1,2,4,8
npm run cli:status
docker compose down
```

`npm run dev:api` automatically spawns and manages two demo worker child
processes (unless `DEMO_ENABLED=false`); `npm run dev:worker` is the one
process you start yourself, matching "one API process, one independently
runnable worker process."

## Test results (this session)

```
npm run test:unit        -> 13 passed  (2 files)
npm run test:integration -> 24 passed  (8 files, real Postgres + Redis;
                                         one test spawns and kills a real
                                         OS worker process)
```

See [docs/FAILURE_SCENARIOS.md](docs/FAILURE_SCENARIOS.md) for what each
integration test actually exercises, and the benchmark section below for
measured throughput.

## Benchmark

`npm run bench` submits real HTTP requests through a real API + worker at
several `WORKER_CONCURRENCY` settings and reports accept rate, completed
jobs/sec, queue wait, and processing latency. Results from this session (8-core
desktop, local Postgres/Redis, 40 jobs/run, ~5.9KB synthetic JPEG) are in
[bench/RESULTS.md](bench/RESULTS.md) -- summary:

| concurrency | completed jobs/s | avg queue wait (ms) |
|---|---|---|
| 1 | 24.2 | 772 |
| 2 | 40.1 | 435 |
| 4 | 76.3 | 251 |
| 8 | 73.9 | 191 |

Throughput scales with concurrency up to a point, then plateaus (single
machine, tiny synthetic images -- see the limitations noted in
`bench/RESULTS.md`). Re-run it yourself; the script and its own limitations
are documented there.

## Limitations

- **No authentication.** Anyone who can reach the API can submit jobs, list
  all jobs, and use the demo panel. Acceptable for "runs on your own machine,
  not exposed publicly"; not acceptable for anything else. See
  [Security](#security).
- **Single-tenant.** No concept of separate users/organizations; every job is
  visible to every caller. See docs/ARCHITECTURE.md "Multi-tenant" for what
  would need to change.
- **Local filesystem storage**, not object storage. Fine for one machine;
  would need a shared/networked store (S3-compatible, NFS, etc.) the moment
  the API and worker run on different machines. See docs/ARCHITECTURE.md
  "Storage".
- **At-least-once execution, not exactly-once.** A duplicate delivery is
  handled safely (one authoritative result), but the underlying computation
  can genuinely run more than once for the same job. See
  docs/ARCHITECTURE.md "Retries create duplicates".
- **Windows-signal caveat**: on Windows, `child_process.kill()` always hard-
  terminates regardless of signal name (there's no real POSIX SIGKILL vs
  SIGTERM distinction), so the demo's "Stop this worker" and a graceful
  `Ctrl+C` behave differently mainly in whether the worker's own shutdown
  code gets to run at all.
- **CSV-style narrow parsing choices carried over conceptually to images**:
  only JPEG/PNG/WebP are accepted, and only three fixed thumbnail sizes are
  produced -- deliberately narrow scope, not a general image pipeline.
- The real-child-process test in `test/integration/demoPanel.test.ts` is
  slower and marginally more environment-sensitive than the rest of the
  suite (it boots an actual Node process). It passed repeatedly in this
  session; flag it first if the integration suite is ever flaky.

## Security

This is a local, single-tenant demonstration:

- No credentials are committed anywhere in this repository.
- There is deliberately **no API key or auth** on any endpoint, unlike a
  typical backend demo -- this app is meant to be driven directly from a
  browser by an anonymous visitor, and a client-visible "secret" embedded in
  the page would be security theater, not security.
- Upload size, image dimensions, and worker concurrency are all bounded and
  configurable (`.env.example`).
- Uploaded files and generated thumbnails are deleted automatically after
  `RETENTION_MINUTES` (default 60).
- **Do not deploy this publicly** as-is. A public deployment would need, at
  minimum: authentication, per-caller rate limiting, and antivirus/content
  scanning on uploads -- none of which are in scope here.

## Documentation

- [docs/API.md](docs/API.md) -- every endpoint, with example requests,
  responses, and error codes.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) -- every component, the full
  lifecycle of one job, and the tradeoffs (why a queue, why two databases,
  why the outbox, multi-tenant, comparison with a Postgres-only queue).
- [docs/FAILURE_SCENARIOS.md](docs/FAILURE_SCENARIOS.md) -- every recovery
  case, how it's implemented, and which test proves it.
- [docs/STUDY_GUIDE.md](docs/STUDY_GUIDE.md) -- file-reading order, key
  functions explained, interview questions, exercises, and the 5-minute demo
  script.
