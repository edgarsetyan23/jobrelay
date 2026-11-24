// Tests for the Claude Code hooks. Run with `npm run test:hooks`.
// Each hook is run as a real child process with a real hook event on stdin,
// the same way Claude Code invokes it.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";

const hooksDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(hooksDir, "..", "..");

function runHook(name, event, projectDir = repoRoot) {
  const result = spawnSync(process.execPath, [join(hooksDir, name)], {
    input: JSON.stringify(event),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
  });
  return { code: result.status, stderr: result.stderr, stdout: result.stdout };
}

const edit = (filePath, newString = "x") => ({
  tool_name: "Edit",
  tool_input: { file_path: join(repoRoot, filePath), old_string: "a", new_string: newString },
});

describe("guard-edits (PreToolUse)", () => {
  test("blocks editing a committed migration", () => {
    const r = runHook("guard-edits.mjs", edit("src/db/migrations/001_init.sql"));
    assert.equal(r.code, 2);
    assert.match(r.stderr, /immutable/);
  });

  test("allows writing a new, uncommitted migration", () => {
    const r = runHook("guard-edits.mjs", edit("src/db/migrations/999_new_thing.sql"));
    assert.equal(r.code, 0);
  });

  test("blocks editing .env but not .env.example", () => {
    assert.equal(runHook("guard-edits.mjs", edit(".env")).code, 2);
    assert.equal(runHook("guard-edits.mjs", edit(".env.example")).code, 0);
  });

  test("blocks content containing a credential", () => {
    const fakeKey = ["sk", "ant", "a".repeat(30)].join("-");
    const r = runHook("guard-edits.mjs", edit("src/config.ts", `const key = "${fakeKey}";`));
    assert.equal(r.code, 2);
    assert.match(r.stderr, /Anthropic API key/);
  });

  test("checks every edit in a MultiEdit", () => {
    const fakeAws = "AKIA" + "A".repeat(16);
    const event = { tool_name: "MultiEdit", tool_input: { file_path: join(repoRoot, "src/config.ts"), edits: [{ new_string: "ok" }, { new_string: fakeAws }] } };
    assert.equal(runHook("guard-edits.mjs", event).code, 2);
  });

  test("allows an ordinary edit", () => {
    assert.equal(runHook("guard-edits.mjs", edit("src/config.ts", "const x = 1;")).code, 0);
  });
});

describe("stop-gate (Stop)", () => {
  // A throwaway git repo with just enough of JobRelay's layout for the gate.
  const sandbox = mkdtempSync(join(tmpdir(), "jobrelay-hooks-"));
  after(() => rmSync(sandbox, { recursive: true, force: true }));
  const git = (...args) => spawnSync("git", args, { cwd: sandbox, encoding: "utf8" });

  mkdirSync(join(sandbox, "scripts"));
  cpSync(join(repoRoot, "scripts/check-failure-docs.mjs"), join(sandbox, "scripts/check-failure-docs.mjs"));
  mkdirSync(join(sandbox, "docs"));
  writeFileSync(join(sandbox, "docs/FAILURE_SCENARIOS.md"), "| Crash | `crashRecovery.test.ts` |\n");
  mkdirSync(join(sandbox, "test/integration"), { recursive: true });
  writeFileSync(join(sandbox, "test/integration/crashRecovery.test.ts"), "");
  mkdirSync(join(sandbox, "src/worker"), { recursive: true });
  writeFileSync(join(sandbox, "src/worker/processor.ts"), "export {};\n");
  writeFileSync(join(sandbox, ".gitignore"), ".claude/state/\n");
  git("init", "-q");
  git("-c", "user.name=t", "-c", "user.email=t@t", "add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");

  test("passes with a clean tree", () => {
    assert.equal(runHook("stop-gate.mjs", {}, sandbox).code, 0);
  });

  test("requires review once per change set to critical code", () => {
    writeFileSync(join(sandbox, "src/worker/processor.ts"), "export const changed = 1;\n");
    const first = runHook("stop-gate.mjs", {}, sandbox);
    assert.equal(first.code, 2);
    assert.match(first.stderr, /reliability-reviewer/);
    assert.equal(runHook("stop-gate.mjs", {}, sandbox).code, 0, "same diff: gate already fired");

    writeFileSync(join(sandbox, "src/worker/processor.ts"), "export const changed = 2;\n");
    assert.equal(runHook("stop-gate.mjs", {}, sandbox).code, 2, "new diff: gate fires again");
  });

  test("never blocks while Claude is already continuing from a Stop hook", () => {
    writeFileSync(join(sandbox, "src/worker/processor.ts"), "export const changed = 3;\n");
    assert.equal(runHook("stop-gate.mjs", { stop_hook_active: true }, sandbox).code, 0);
  });

  test("blocks when an integration test isn't cited in the docs", () => {
    writeFileSync(join(sandbox, "test/integration/newScenario.test.ts"), "");
    const r = runHook("stop-gate.mjs", {}, sandbox);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /newScenario\.test\.ts isn't cited/);
    rmSync(join(sandbox, "test/integration/newScenario.test.ts"));
  });

  test("reports docs drift and the review gate together in one block", () => {
    writeFileSync(join(sandbox, "src/worker/processor.ts"), "export const changed = 4;\n");
    writeFileSync(join(sandbox, "test/integration/another.test.ts"), "");
    const r = runHook("stop-gate.mjs", {}, sandbox);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /another\.test\.ts isn't cited/);
    assert.match(r.stderr, /reliability-reviewer/);
    rmSync(join(sandbox, "test/integration/another.test.ts"));
  });
});

describe("check-after-edit (PostToolUse)", () => {
  test("skips non-TypeScript files without running anything", () => {
    assert.equal(runHook("check-after-edit.mjs", edit("README.md")).code, 0);
  });
});

describe("session-context (SessionStart)", () => {
  test("prints context and never fails the session", () => {
    const r = runHook("session-context.mjs", { hook_event_name: "SessionStart" });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /JobRelay session context/);
    assert.match(r.stdout, /Docker|Postgres/);
  });
});
