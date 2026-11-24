#!/usr/bin/env node
// PostToolUse hook: after Claude edits a TypeScript file, run the fast checks
// (typecheck + unit tests, ~2s total) and report failures back to Claude.
//
// Exit 0  -> nothing to say (or the edit wasn't to a .ts file).
// Exit 2  -> stderr is shown to Claude as feedback so it fixes the break
//            before moving on. Integration tests are deliberately NOT run
//            here: they need Docker and take tens of seconds.
import { spawnSync } from "node:child_process";

let input = "";
for await (const chunk of process.stdin) input += chunk;

let filePath = "";
try {
  const event = JSON.parse(input);
  filePath = event.tool_input?.file_path ?? event.tool_input?.notebook_path ?? "";
} catch {
  process.exit(0); // malformed event: never block on our own bug
}

if (!/\.(ts|mts|cts)$/.test(filePath)) process.exit(0);

const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
// A single command string (not an args array) so `npm` resolves to npm.cmd on
// Windows without Node's shell-args deprecation warning.
const run = (command) => spawnSync(command, { cwd: projectDir, encoding: "utf8", shell: true, env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" } });

const failures = [];
for (const [label, command] of [
  ["typecheck", "npm run --silent typecheck"],
  ["unit tests", "npm run --silent test:unit"],
]) {
  const result = run(command);
  if (result.status !== 0) {
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split("\n").slice(-40).join("\n");
    failures.push(`### ${label} failed\n${output}`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`Checks failed after editing ${filePath}:\n\n${failures.join("\n\n")}\n`);
  process.exit(2);
}
