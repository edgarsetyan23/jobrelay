#!/usr/bin/env node
// Stop hook: runs when Claude is about to end its turn. Exit 2 sends it back
// to work with stderr as the reason.
//
//   1. Docs drift: docs/FAILURE_SCENARIOS.md must cite exactly the tests
//      that exist (scripts/check-failure-docs.mjs). Blocks until fixed.
//   2. Review gate: if reliability-critical code changed, Claude must run
//      the reliability-reviewer subagent before finishing. Fires once per
//      distinct change set (fingerprinted), so it nudges and doesn't loop.
//
// Both are evaluated before blocking: Claude's next stop arrives with
// stop_hook_active set and is let through, so anything not reported now
// would be skipped for this turn.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { block, diffFingerprint, projectDir, readEvent, readState, writeState } from "./lib.mjs";

const CRITICAL_PATHS = ["src/worker", "src/db", "src/outbox", "src/queue", "src/faults"];

const event = await readEvent();
if (event.stop_hook_active) process.exit(0);

const reasons = [];

const { checkFailureDocs } = await import(pathToFileURL(join(projectDir, "scripts/check-failure-docs.mjs")).href);
const problems = checkFailureDocs(projectDir);
if (problems.length > 0) {
  reasons.push(`docs/FAILURE_SCENARIOS.md is out of sync with the test suite:\n- ${problems.join("\n- ")}\nFix the doc (or the test name) before finishing.`);
}

const fingerprint = diffFingerprint(CRITICAL_PATHS);
const state = readState();
if (fingerprint && state.reviewGate !== fingerprint) {
  writeState({ ...state, reviewGate: fingerprint });
  reasons.push(
    `Reliability-critical files changed (${CRITICAL_PATHS.join(", ")}). Before finishing, run the ` +
      `reliability-reviewer subagent on the uncommitted diff and address any Blocking findings. ` +
      `(This gate fires once per change set.)`,
  );
}

if (reasons.length > 0) block(reasons.join("\n\n"));
