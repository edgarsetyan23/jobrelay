#!/usr/bin/env node
// PreToolUse hook (Edit|Write|MultiEdit): refuses edits that are never right
// in this repo, before they happen. Exit 2 blocks the tool call and tells
// Claude why.
//
//   1. Committed migrations are immutable. migrate.ts skips any filename
//      already in schema_migrations, so editing an applied file silently
//      does nothing on existing databases. Schema changes go in a new file.
//   2. .env is the developer's local config; .env.example is the template.
//   3. No credentials in any file.
import { block, incomingText, readEvent, repoPath, sh, SECRET_PATTERNS } from "./lib.mjs";

const event = await readEvent();
const filePath = event.tool_input?.file_path;
if (!filePath) process.exit(0);
const rel = repoPath(filePath);

if (/^src\/db\/migrations\/.+\.sql$/.test(rel) && sh(`git cat-file -e "HEAD:${rel}"`).status === 0) {
  block(
    `Blocked: ${rel} is already committed, and migrations are immutable once committed. ` +
      `migrate.ts records each filename in schema_migrations and never re-runs it, so this edit ` +
      `would never reach existing databases. Put the change in a new numbered migration instead ` +
      `(see the /add-migration skill).`,
  );
}

if (rel === ".env") {
  block("Blocked: .env is the developer's local config. Change .env.example (and src/config.ts) instead.");
}

const text = incomingText(event.tool_input);
for (const [pattern, what] of SECRET_PATTERNS) {
  if (pattern.test(text)) {
    block(`Blocked: this edit to ${rel} contains what looks like ${what}. Read secrets from the environment instead.`);
  }
}
