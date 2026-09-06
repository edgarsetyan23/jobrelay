-- running_token (003) answers "which attempt currently owns this job while
-- it's in flight" -- it keeps being overwritten every time a job (re-)enters
-- 'running', so by itself it isn't a stable pointer to *where a succeeded
-- job's files live*. result_attempt_token is that stable pointer: it is
-- written exactly once, by the same guarded UPDATE that flips a job to
-- 'succeeded', and never touched again. The download endpoint
-- (src/api/routes/files.ts) reads this column to know which attempt's
-- directory to serve -- see src/worker/processor.ts and
-- src/storage/paths.ts "Attempt isolation".
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS result_attempt_token TEXT;
