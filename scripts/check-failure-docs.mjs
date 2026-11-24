// Keeps docs/FAILURE_SCENARIOS.md honest: every test file it cites must
// exist, and every integration test must be cited somewhere in it. The doc's
// promise is "nothing here is aspirational", so a renamed test or an
// undocumented scenario is drift worth failing on.
//
// Used by CI (`npm run check:docs`) and by the Claude Code Stop hook.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function checkFailureDocs(projectDir) {
  const doc = readFileSync(join(projectDir, "docs/FAILURE_SCENARIOS.md"), "utf8");
  const cited = new Set(doc.match(/[A-Za-z0-9_-]+\.test\.ts/g) ?? []);
  const integrationDir = join(projectDir, "test/integration");
  const integrationTests = readdirSync(integrationDir).filter((f) => f.endsWith(".test.ts"));

  const problems = [];
  for (const file of cited) {
    if (!existsSync(join(integrationDir, file)) && !existsSync(join(projectDir, "test/unit", file))) {
      problems.push(`docs/FAILURE_SCENARIOS.md cites ${file}, which doesn't exist`);
    }
  }
  for (const file of integrationTests) {
    if (!cited.has(file)) {
      problems.push(`test/integration/${file} isn't cited in docs/FAILURE_SCENARIOS.md`);
    }
  }
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const problems = checkFailureDocs(process.cwd());
  if (problems.length > 0) {
    console.error(`Failure-scenario docs are out of sync:\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
  console.log("docs/FAILURE_SCENARIOS.md matches the test suite.");
}
