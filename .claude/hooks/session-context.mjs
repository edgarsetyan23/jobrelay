#!/usr/bin/env node
// SessionStart hook: anything printed to stdout becomes context for Claude.
// Tells it up front whether the real-infrastructure tests can run, so it
// doesn't burn a minute discovering Docker is down (or skip integration
// tests it could have run).
import { sh } from "./lib.mjs";

const lines = ["## JobRelay session context"];

const branch = sh("git branch --show-current").output || "(detached)";
const dirty = sh("git status --porcelain").output.split("\n").filter(Boolean).length;
lines.push(`- Branch: ${branch}; ${dirty} uncommitted file(s).`);

const docker = sh('docker ps --format "{{.Names}}"', 8_000);
if (docker.status !== 0) {
  lines.push(
    "- Docker is NOT running. Integration tests (`npm run test:integration`) and the dev API/worker can't run. " +
      "Use typecheck + unit tests, and tell the user integration tests were not run.",
  );
} else {
  const names = docker.output.split("\n");
  const pg = names.some((n) => n.includes("postgres"));
  const redis = names.some((n) => n.includes("redis"));
  lines.push(
    pg && redis
      ? "- Postgres and Redis containers are up: `npm run test:integration` can run."
      : `- Docker is running but ${[!pg && "Postgres", !redis && "Redis"].filter(Boolean).join(" and ")} ` +
          "isn't up. Run `docker compose up -d` before integration tests.",
  );
}

console.log(lines.join("\n"));
