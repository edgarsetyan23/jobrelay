# Demo walkthrough

About five minutes, start to finish. Assumes the API and worker are running
(see the README's quick start).

1. **Open `http://localhost:3000`.** You'll see the dispatch board, the worker
   stations, and an empty ticket list. Nothing on screen is simulated --
   every number comes from polling a real endpoint.
2. **Submit a job.** Click "Try a sample," then "Submit ticket." The ticket
   moves from waiting to processing to completed. Click it to see the
   thumbnails and the attempt history.
3. **Demo panel: "Send twice."** Submits the same request twice with the same
   idempotency key. Both responses come back with the same job id, and only
   one job is created.
4. **Demo panel: "Fail this attempt."** The first attempt fails on purpose and
   shows up as retrying with a reason; the second attempt succeeds after a
   backoff. This fault can only be triggered on jobs flagged `is_demo` in the
   database.
5. **Demo panel: "Stop this worker."** This kills a real OS process mid-job.
   The worker station goes offline, then the ticket's attempt history shows a
   second attempt picked up by a different worker, which finishes the job.
6. **Read further.** [ARCHITECTURE.md](ARCHITECTURE.md) covers why there are
   two databases and an outbox, and why the system is at-least-once rather
   than exactly-once. [FAILURE_SCENARIOS.md](FAILURE_SCENARIOS.md) maps each
   recovery case to the test that proves it.
