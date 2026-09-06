-- JobRelay initial schema.
-- Single-tenant demo: no tenant_id anywhere. See docs/ARCHITECTURE.md for the
-- multi-tenant discussion of what would need to change.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS jobs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_type            TEXT NOT NULL,
    idempotency_key     TEXT NOT NULL,
    payload_fingerprint TEXT NOT NULL,
    payload             JSONB NOT NULL,
    status              TEXT NOT NULL DEFAULT 'queued'
                          CHECK (status IN ('queued', 'running', 'retrying', 'succeeded', 'failed')),
    attempts            INT NOT NULL DEFAULT 0,
    max_attempts        INT NOT NULL DEFAULT 5,
    result              JSONB,
    error               TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at          TIMESTAMPTZ,
    finished_at         TIMESTAMPTZ,

    -- Idempotency: one row per idempotency key, period. See docs/ARCHITECTURE.md
    -- "Idempotency fingerprint" for how the fingerprint is computed and used.
    CONSTRAINT jobs_idempotency_key_uniq UNIQUE (idempotency_key)
);

CREATE INDEX IF NOT EXISTS jobs_status_created_at_idx ON jobs (status, created_at, id);
CREATE INDEX IF NOT EXISTS jobs_created_at_idx ON jobs (created_at, id);

-- Transactional outbox: written in the same transaction as the jobs row so a
-- job can never exist durably without a corresponding publish intent, and
-- vice versa. A background dispatcher publishes rows where published = false.
CREATE TABLE IF NOT EXISTS outbox_events (
    id           BIGSERIAL PRIMARY KEY,
    job_id       UUID NOT NULL REFERENCES jobs (id),
    event_type   TEXT NOT NULL DEFAULT 'job.created',
    payload      JSONB NOT NULL,
    published    BOOLEAN NOT NULL DEFAULT false,
    publish_attempts INT NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS outbox_unpublished_idx ON outbox_events (id) WHERE published = false;

-- Attempt history: the authoritative, inspectable record of every attempt
-- made at a job, independent of what BullMQ still has in Redis (which can be
-- trimmed or evicted). This is what backs the "failed job collection" and the
-- per-attempt structured logs.
CREATE TABLE IF NOT EXISTS job_attempts (
    id             BIGSERIAL PRIMARY KEY,
    job_id         UUID NOT NULL REFERENCES jobs (id),
    attempt_number INT NOT NULL,
    status         TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'retrying')),
    error          TEXT,
    worker_id      TEXT NOT NULL,
    started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at    TIMESTAMPTZ,
    duration_ms    INT
);

CREATE INDEX IF NOT EXISTS job_attempts_job_id_idx ON job_attempts (job_id, attempt_number);
