import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.js";

// Scratch adversarial tests written by the failure-hunter subagent
// (.claude/agents/failure-hunter.md). Kept out of the normal suites and out
// of git until someone promotes one to test/integration/.
export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: ["test/integration/hunt/**/*.hunt.test.ts"],
      exclude: ["dist/**", "node_modules/**"],
      fileParallelism: false,
      testTimeout: 60_000,
    },
  }),
);
