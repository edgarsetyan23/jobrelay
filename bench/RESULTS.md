# JobRelay benchmark results

**Status: measured** -- run on 2026-09-06T21:38:25.134Z.

## Environment

- OS: Windows_NT 10.0.26200 (x64)
- CPUs: 8x AMD Ryzen 7 9800X3D 8-Core Processor           
- Total memory: 66.1 GB
- Node: v24.16.0
- Docker: Docker version 29.5.2, build 79eb04c
- Dependency versions: {"bullmq":"^6.3.4","ioredis":"^6.0.0","pg":"^8.23.0","sharp":"^0.35.4","express":"^5.2.1"}
- Image payload: 5893 bytes (1200x800 synthetic JPEG)
- Jobs per run: 40

## Results

| concurrency | jobs | accepted | 409s | accept req/s | completed | failed | completed jobs/s | avg queue wait (ms) | avg processing (ms) | p95 processing (ms) |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 40 | 40 | 0 | 367.0 | 40 | 0 | 24.21 | 772 | 29 | 35 |
| 2 | 40 | 40 | 0 | 563.4 | 40 | 0 | 40.08 | 435 | 31 | 38 |
| 4 | 40 | 40 | 0 | 615.4 | 40 | 0 | 76.34 | 251 | 34 | 40 |
| 8 | 40 | 40 | 0 | 533.3 | 40 | 0 | 73.94 | 191 | 52 | 62 |

## Reading this table

- **accept req/s**: how fast the API durably accepts submissions (Postgres commit + 202 response) -- this is independent of how fast jobs actually get processed, which is the whole point of decoupling submission from execution with a queue.
- **completed jobs/s**: wall-clock throughput from "first request sent" to "last job reached succeeded/failed", including the submission burst itself.
- **avg queue wait**: time between a job's row being created and a worker actually starting it (started_at - created_at).
- **avg / p95 processing**: time a worker spent running the job once it started (finished_at - started_at).

## Limitations of this benchmark

- Single machine, Postgres/Redis/API/worker all local -- no network latency between components, which a real deployment would have.
- All jobs use the same synthetic 1200x800 image; real-world payload size/complexity varies and would shift processing time.
- Concurrency is varied on a single worker process; this does not measure scaling *across* multiple worker processes/machines.
