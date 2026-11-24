---
name: add-fault-scenario
description: Add a new failure scenario to JobRelay — a fault-injection mode or crash window, the integration test that proves recovery, and the docs row. Use when asked to "add a fault", "simulate a new failure", "test what happens if X crashes", or extend the demo panel.
---

# Add a fault-injection scenario

A scenario is only "done" in this repo when it has three things: a way to
trigger it, an integration test against real Postgres + Redis that proves
the recovery, and a row in `docs/FAILURE_SCENARIOS.md`. Nothing aspirational.

## 1. Decide how to trigger it

Pick the narrowest mechanism that reproduces the failure **deterministically**:

| Failure shape | Mechanism | Example |
|---|---|---|
| Attempt fails N times, then works | existing `transient-fail-count` | `retries.test.ts` |
| Every attempt fails | existing `always-fail` | `retries.test.ts` |
| Attempt is slow / gets killed mid-run | existing `slow` + `onlyOnAttempt` | `crashRecovery.test.ts` |
| Crash at an *exact* instant in the processor | a gate on a `ProcessorDeps` seam (`beforeSuccessCommit`, `afterSuccessCommit`, or a new `?.()` seam) | `successCommitCrash.test.ts` |
| A specific DB write fails | a real Postgres trigger created/dropped by the test | `postSuccessFailureIsolation.test.ts` |
| Infrastructure outage | real `docker stop`/`start` | `redisOutage.test.ts` |

Prefer an existing mode. Only add a new `FaultSpec` mode when none fits.
Never use two timed delays to "probably" create an overlap — use a gate.

## 2. If you need a new fault mode

Edit `src/faults/inject.ts`:

- Add the mode to the `z.enum([...])` and any new fields to `FaultSpecSchema`
  with **bounded** zod validators (`.int().min().max()`), because this
  schema parses untrusted JSON from `POST /api/demo/jobs`.
- Handle it in `applyFault()`. Throw `InjectedTransientError` for retryable
  failures. For a permanent failure, the caller must throw `ValidationError`
  so BullMQ takes the `UnrecoverableError` path.
- Do **not** loosen the gate: `applyFault` is called with `record.is_demo`
  read from Postgres. A fault must never be honorable on the main queue.

If you need a new crash seam instead, add an optional
`() => Promise<void> | void` to `ProcessorDeps` in `src/worker/processor.ts`,
call it as `await deps.newSeam?.()`, document it in the `ProcessorDeps` doc
comment, add it to `ProcessorTestHooks` in `test/integration/setup.ts`, and
confirm `src/worker/worker.ts` never sets it.

## 3. Write the integration test

Create `test/integration/<scenarioName>.test.ts`:

```ts
// Requires `docker compose up -d`. <One paragraph: what failure this
// simulates, what the system must do, and why this trigger is deterministic.>
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { submitImageJob } from "../../src/api/submitImageJob.js";
import { getJobById, listJobAttempts } from "../../src/db/jobsRepo.js";
import { createTestHarness, sampleImageBuffer, waitFor, type TestHarness } from "./setup.js";

describe("<scenario>", () => {
  let harness: TestHarness;
  let image: Buffer;

  beforeAll(async () => {
    harness = await createTestHarness({ /* only the config this scenario needs */ });
    image = await sampleImageBuffer();
  });
  afterAll(async () => { await harness.cleanup(); });

  it("<observable outcome, phrased as the guarantee>", async () => {
    const { job } = await submitImageJob(
      { pool: harness.pool, dispatcher: harness.dispatcher, storagePaths: harness.storagePaths, maxJobAttempts: harness.config.MAX_JOB_ATTEMPTS },
      { idempotencyKey: randomUUID(), file: { buffer: image, originalname: "x.jpg" }, isDemo: true, fault: { /* ... */ } },
    );
    harness.startWorker("demo");
    await waitFor(async () => (await getJobById(harness.pool, job.id))?.status === "succeeded");
    // Assert on Postgres (the source of truth): final status, attempts,
    // the job_attempts history, and -- if files are involved -- that the
    // published downloads are intact.
  });
});
```

Rules:
- Real Postgres/Redis only. No mocks of `pg`, `ioredis`, or BullMQ.
- `isDemo: true` and `harness.startWorker("demo")` — faults only fire there.
- Assert the **guarantee** (one result, no lost files, bounded attempts),
  not just "it didn't throw".
- If you changed a fault mode, also add a negative case proving the same
  spec is inert with `isDemo: false` (pattern in `retries.test.ts`).

Run it alone first: `npx vitest run test/integration/<file> --no-file-parallelism`,
then the full `npm run test:integration`.

## 4. Document it

In `docs/FAILURE_SCENARIOS.md`:
- Add a row to the summary table (Implemented / Tested / Live demo).
- Add a `##` section: **What happens**, **How** (file + function names),
  **Tested by**.

Update the integration test count in `README.md` "Test results" only after
actually running the suite and reading the real number.

## 5. Optional: expose it in the demo panel

Only if it's visual and safe to trigger from a browser: add a button in
`public/index.html` and call `demoSubmit({ mode: ... })` in `public/app.js`.
Extend `test/integration/demoPanel.test.ts` with the HTTP-level version.

## Before you finish

Ask the `reliability-reviewer` subagent to review the diff. If it reports a
PLAUSIBLE finding, have the `failure-hunter` subagent try to prove it with a
real test.
