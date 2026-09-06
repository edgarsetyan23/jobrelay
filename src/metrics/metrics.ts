// Deliberately simple, in-process metrics -- no Prometheus client, no
// external TSDB. Good enough for "a simple status endpoint or CLI is
// sufficient" (the spec's own words); the /stats endpoint below and
// `npm run cli:status` both read this. Restarting the API process resets
// counters; job-level truth always lives in Postgres, not here.
interface DurationSample {
  count: number;
  sum: number;
  min: number;
  max: number;
}

function emptySample(): DurationSample {
  return { count: 0, sum: 0, min: Infinity, max: -Infinity };
}

function record(sample: DurationSample, value: number): void {
  sample.count += 1;
  sample.sum += value;
  sample.min = Math.min(sample.min, value);
  sample.max = Math.max(sample.max, value);
}

function summarize(sample: DurationSample) {
  if (sample.count === 0) return { count: 0, avgMs: 0, minMs: 0, maxMs: 0 };
  return {
    count: sample.count,
    avgMs: Math.round(sample.sum / sample.count),
    minMs: Math.round(sample.min),
    maxMs: Math.round(sample.max),
  };
}

class Metrics {
  accepted = 0;
  completed = 0;
  retried = 0;
  failed = 0;
  rejected409 = 0;
  private queueWait = emptySample();
  private processing = emptySample();

  recordAccepted(): void {
    this.accepted += 1;
  }
  recordRejected409(): void {
    this.rejected409 += 1;
  }
  recordCompleted(): void {
    this.completed += 1;
  }
  recordRetried(): void {
    this.retried += 1;
  }
  recordFailed(): void {
    this.failed += 1;
  }
  recordQueueWaitMs(ms: number): void {
    record(this.queueWait, ms);
  }
  recordProcessingMs(ms: number): void {
    record(this.processing, ms);
  }

  snapshot() {
    return {
      accepted: this.accepted,
      completed: this.completed,
      retried: this.retried,
      failed: this.failed,
      rejected409: this.rejected409,
      queueWaitMs: summarize(this.queueWait),
      processingMs: summarize(this.processing),
    };
  }
}

/** Process-wide singleton -- one API process, one worker process, each with its own view. */
export const metrics = new Metrics();
