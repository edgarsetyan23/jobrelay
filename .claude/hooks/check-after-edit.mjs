#!/usr/bin/env node
// PostToolUse hook: after Claude edits a TypeScript file, run the fast checks
// (typecheck + unit tests, ~2s total) and report failures back to Claude.
//
// Exit 0  -> nothing to say (or the edit wasn't to a .ts file).
// Exit 2  -> stderr is shown to Claude as feedback so it fixes the break
//            before moving on. Integration tests are deliberately NOT run
//            here: they need Docker and take tens of seconds.
import { readEvent, sh, tail } from "./lib.mjs";

const event = await readEvent();
const filePath = event.tool_input?.file_path ?? "";
if (!/\.(ts|mts|cts)$/.test(filePath)) process.exit(0);

const failures = [];
for (const [label, command] of [
  ["typecheck", "npm run --silent typecheck"],
  ["unit tests", "npm run --silent test:unit"],
]) {
  const result = sh(command);
  if (result.status !== 0) failures.push(`### ${label} failed\n${tail(result.output)}`);
}

if (failures.length > 0) {
  process.stderr.write(`Checks failed after editing ${filePath}:\n\n${failures.join("\n\n")}\n`);
  process.exit(2);
}
