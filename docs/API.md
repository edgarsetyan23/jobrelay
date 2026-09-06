# API reference

No authentication (see README "Security"). All examples use `curl`; Windows
CMD users can copy these as-is if `curl` is on PATH (it ships with Windows
10+), or use the `-F`/`-H` flags in a POSIX shell (git-bash, WSL).

## `POST /api/jobs`

Submit a normal image job. Multipart form upload.

**Headers:** `Idempotency-Key: <any string, max 200 chars>` (required)

**Body:** `image` field, a JPEG/PNG/WebP file (max `MAX_UPLOAD_BYTES`, default 8MB)

```
curl -X POST http://localhost:3000/api/jobs \
  -H "Idempotency-Key: my-key-1" \
  -F "image=@public/sample.jpg;type=image/jpeg"
```

**202** -- newly accepted or still in flight:
```json
{ "job": { "id": "…", "jobType": "thumbnail", "status": "queued", "isDemo": false,
           "attempts": 0, "maxAttempts": 5, "result": null, "error": null,
           "createdAt": "…", "updatedAt": "…", "startedAt": null, "finishedAt": null },
  "replayed": false }
```

**200** -- replay of an already-terminal job for the same key+payload (`replayed: true`).

**400** `MISSING_IDEMPOTENCY_KEY` / `MISSING_FILE` / `VALIDATION_ERROR`

**409** `IDEMPOTENCY_KEY_CONFLICT` -- same key, different file:
```json
{ "error": { "code": "IDEMPOTENCY_KEY_CONFLICT", "message": "…", "existingJobId": "…" } }
```

**413** `UPLOAD_LIMIT_FILE_SIZE` -- file exceeds `MAX_UPLOAD_BYTES`.

## `GET /api/jobs/:id`

```
curl http://localhost:3000/api/jobs/<id>
```
**200** `{ "job": { ...same shape as above, "result" populated once succeeded... } }`
**404** `JOB_NOT_FOUND`

A succeeded job's `result`:
```json
{ "originalFilename": "sample.jpg", "format": "jpeg", "width": 900, "height": 600,
  "fileSizeBytes": 24679,
  "thumbnails": [
    { "label": "small",  "width": 150, "height": 100, "fileSizeBytes": 1698, "url": "/files/results/<id>/small.jpg" },
    { "label": "medium", "width": 400, "height": 267, "fileSizeBytes": 7355, "url": "/files/results/<id>/medium.jpg" },
    { "label": "large",  "width": 800, "height": 533, "fileSizeBytes": 19732, "url": "/files/results/<id>/large.jpg" }
  ] }
```

## `GET /api/jobs/:id/attempts`

```
curl http://localhost:3000/api/jobs/<id>/attempts
```
**200**
```json
{ "jobId": "…", "attempts": [
  { "id": "1", "job_id": "…", "attempt_number": 1, "status": "succeeded",
    "error": null, "worker_id": "main-HOST-1234-abcdef", "started_at": "…",
    "finished_at": "…", "duration_ms": 27 } ] }
```

## `GET /api/jobs`

Cursor pagination.

**Query params:** `status` (one of `queued|running|retrying|succeeded|failed`, optional), `cursor` (optional, from a previous response), `limit` (1-100, default 20)

```
curl "http://localhost:3000/api/jobs?status=failed&limit=10"
```
**200** `{ "jobs": [ ... ], "nextCursor": "opaque-string-or-null" }`

## `GET /files/results/:jobId/:label.jpg`

Serves a generated thumbnail (`label` is `small`, `medium`, or `large`).
Every request looks up which attempt's directory is authoritative for this
job in Postgres (`jobs.result_attempt_token`) before touching the
filesystem -- there is no fixed on-disk path this could otherwise assume
(see docs/ARCHITECTURE.md "Attempt isolation"). **404** if the job id or
label doesn't match the expected shape, the job hasn't succeeded (or
succeeded to a token whose files aren't there for some other reason), or the
files have since been deleted by the retention sweep -- these all look
identical from the outside.

## `GET /healthz`

Liveness -- always `200 {"status":"ok"}` if the process is up. No dependency checks.

## `GET /readyz`

Readiness -- checks Postgres and Redis with a short timeout each.
**200** `{"status":"ready","checks":{"database":"ok","redis":"ok"}}`
**503** `{"status":"not_ready","checks":{"database":"error","redis":"ok"}}` (or similar)

## `GET /stats`

```json
{ "process": "api", "jobCountsByStatus": { "succeeded": 12, "failed": 1 },
  "accepted": 13, "completed": 12, "retried": 2, "failed": 1, "rejected409": 0,
  "queueWaitMs": { "count": 12, "avgMs": 340, "minMs": 50, "maxMs": 900 },
  "processingMs": { "count": 12, "avgMs": 30, "minMs": 20, "maxMs": 60 } }
```

## `GET /api/workers`

```json
{ "workers": [
  { "id": "main-HOST-1234-abcdef", "kind": "main", "status": "idle",
    "currentJobId": null, "startedAt": "…", "lastHeartbeatAt": "…" },
  { "id": "demo-abc12345", "kind": "demo", "status": "busy",
    "currentJobId": "…", "startedAt": "…", "lastHeartbeatAt": "…" } ] }
```
`status` is `idle`, `busy`, or `offline` (inferred from a stale heartbeat,
never self-reported -- see docs/FAILURE_SCENARIOS.md), and is `busy` whenever
the worker has *any* job in flight -- with `WORKER_CONCURRENCY > 1` that can
be more than one at a time. `currentJobId` is only one representative job id
out of a possibly larger active set, useful for a quick look but not a
complete picture of concurrency > 1; it is not what `status` is derived
from.

## `GET /api/config`

```json
{ "demoEnabled": true }
```

## Demonstration panel endpoints (only mounted when `DEMO_ENABLED=true`)

### `POST /api/demo/jobs`

Same shape as `POST /api/jobs`, plus an optional `fault` form field (a JSON
string matching one of):
```json
{ "mode": "transient-fail-count", "failCount": 1 }
{ "mode": "always-fail" }
{ "mode": "slow", "delayMs": 6000, "onlyOnAttempt": 1 }
```
Always creates a job on the isolated demo queue (`isDemo: true` in the
response). `fault` is ignored/rejected on `POST /api/jobs` -- there is no way
to reach this behavior through the normal upload endpoint.

**400** `INVALID_FAULT_SPEC` if `fault` isn't valid JSON matching the schema.

### `POST /api/demo/workers/:id/stop`

```
curl -X POST http://localhost:3000/api/demo/workers/demo-abc12345/stop
```
**200** `{ "stopped": true, "workerId": "demo-abc12345" }`
**404** `DEMO_WORKER_NOT_FOUND` -- `id` isn't a currently-tracked demo worker
(this is the entire safety boundary: it is structurally impossible to stop
anything else through this endpoint).
