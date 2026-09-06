// Controlled fault injection for the interactive demonstration panel (and for
// integration tests, which need the same predictable failures). It only ever
// recognizes this fixed, narrow shape -- never arbitrary code -- and the
// caller (worker/processor.ts) only honors it for jobs on the isolated demo
// queue. A normal visitor upload can never carry a fault spec that does
// anything: see api/routes/jobs.ts, which strips `_fault` from every
// non-demo submission before it ever reaches storage.
import { z } from "zod";

export const FaultSpecSchema = z
  .object({
    // Fail every attempt up to and including `failCount`, then let the
    // (failCount + 1)th attempt succeed. attemptNumber is 1-based.
    mode: z.enum(["transient-fail-count", "always-fail", "slow"]),
    failCount: z.number().int().min(0).max(20).optional(),
    delayMs: z.number().int().min(0).max(120_000).optional(),
    // "slow" only: restrict the artificial delay to one specific attempt
    // number (used to simulate "the first attempt is slow enough to crash
    // mid-processing, but a recovering attempt completes quickly").
    onlyOnAttempt: z.number().int().min(1).optional(),
  })
  .optional();

export type FaultSpec = z.infer<typeof FaultSpecSchema>;

export class InjectedTransientError extends Error {
  readonly name = "InjectedTransientError";
}

/**
 * Applies a fault spec for the given attempt. Resolves normally (possibly
 * after an artificial delay) if no fault should fire this attempt; throws
 * InjectedTransientError if this attempt should fail transiently.
 *
 * Permanent ("always-fail" reaching exhaustion is just repeated transient
 * failures -- retry exhaustion is exercised by setting failCount >= max
 * attempts) failures are represented by the caller checking `mode` and
 * throwing the job's own ValidationError instead, so BullMQ sees the same
 * UnrecoverableError path a real permanent failure would take.
 */
export async function applyFault(fault: FaultSpec, attemptNumber: number, enabled: boolean): Promise<void> {
  if (!enabled || !fault) return;

  if (fault.mode === "slow" && fault.delayMs) {
    if (fault.onlyOnAttempt === undefined || fault.onlyOnAttempt === attemptNumber) {
      await new Promise((resolve) => setTimeout(resolve, fault.delayMs));
    }
    return;
  }

  if (fault.mode === "always-fail") {
    throw new InjectedTransientError(`fault injection: always-fail (attempt ${attemptNumber})`);
  }

  if (fault.mode === "transient-fail-count") {
    const failCount = fault.failCount ?? 1;
    if (attemptNumber <= failCount) {
      throw new InjectedTransientError(`fault injection: transient-fail-count (attempt ${attemptNumber} of ${failCount} to fail)`);
    }
  }
}
