// Shared helpers for the Claude Code hooks in this directory.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

export async function readEvent() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  try {
    return JSON.parse(input);
  } catch {
    return {}; // malformed event: callers treat this as "nothing to do"
  }
}

export const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

/** Repo-relative, forward-slash path for a tool's file_path (absolute or relative). */
export function repoPath(filePath) {
  return relative(projectDir, filePath).replaceAll("\\", "/");
}

/** Runs a shell command in the project dir with color off; returns { status, output }. */
export function sh(command, timeoutMs = 120_000) {
  const result = spawnSync(command, {
    cwd: projectDir,
    encoding: "utf8",
    shell: true,
    timeout: timeoutMs,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

export const tail = (text, lines = 40) => text.split("\n").slice(-lines).join("\n");

/** Fingerprint of uncommitted changes (tracked diff + untracked files) under the given paths. */
export function diffFingerprint(paths) {
  const spec = paths.map((p) => `"${p}"`).join(" ");
  const diff = sh(`git diff HEAD -- ${spec}`).output;
  const untracked = sh(`git ls-files --others --exclude-standard -- ${spec}`).output;
  if (!diff && !untracked) return null;
  const files = untracked.split("\n").filter(Boolean);
  const hash = createHash("sha256").update(diff).update(untracked);
  for (const f of files) {
    try { hash.update(readFileSync(join(projectDir, f))); } catch {}
  }
  return hash.digest("hex").slice(0, 16);
}

// Per-checkout state (gitignored) so a gate fires once per distinct change set.
const stateFile = join(projectDir, ".claude/state/gates.json");
export function readState() {
  try { return JSON.parse(readFileSync(stateFile, "utf8")); } catch { return {}; }
}
export function writeState(state) {
  mkdirSync(join(projectDir, ".claude/state"), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

// Credentials that should never be written into a tracked file.
export const SECRET_PATTERNS = [
  [/sk-ant-[A-Za-z0-9_-]{20,}/, "an Anthropic API key"],
  [/AKIA[0-9A-Z]{16}/, "an AWS access key ID"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/gh[pousr]_[A-Za-z0-9]{36,}/, "a GitHub token"],
];

/** The text a Write/Edit/MultiEdit call is about to put into a file. */
export function incomingText(toolInput = {}) {
  if (typeof toolInput.content === "string") return toolInput.content;
  if (typeof toolInput.new_string === "string") return toolInput.new_string;
  if (Array.isArray(toolInput.edits)) return toolInput.edits.map((e) => e.new_string ?? "").join("\n");
  return "";
}

export function block(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}
