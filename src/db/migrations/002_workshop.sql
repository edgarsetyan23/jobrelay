-- Adds what the "interactive workshop" pivot needs on top of 001_init.sql:
-- a way to route a job to the isolated demo queue/workers, and a heartbeat
-- table the frontend's worker-station display reads from (real backend
-- state, not a simulation).

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT false;

-- Set once the retention sweep has deleted this job's files from disk, so
-- the sweep doesn't keep re-scanning (and re-attempting to delete) jobs it
-- already cleaned up. NULL means "files may still be present".
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS files_purged_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS jobs_retention_sweep_idx ON jobs (finished_at) WHERE files_purged_at IS NULL AND finished_at IS NOT NULL;

-- One row per running worker process (main or demo). Each worker upserts its
-- own row on startup and on every state change / heartbeat tick; a worker
-- whose last_heartbeat_at goes stale is treated as offline by readers (a
-- crashed process can't update its own row to say so).
CREATE TABLE IF NOT EXISTS workers (
    id                TEXT PRIMARY KEY,
    kind              TEXT NOT NULL CHECK (kind IN ('main', 'demo')),
    pid               INT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'busy')),
    current_job_id    UUID REFERENCES jobs (id),
    started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
