import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // `tsc` emits compiled copies of the tests into dist/test/, which the
    // `test/unit` and `test/integration` path filters would otherwise match.
    // test/integration/hunt/ holds scratch tests from the failure-hunter
    // subagent; they run only via `npm run test:hunt` (vitest.hunt.config.ts).
    exclude: [...configDefaults.exclude, "dist/**", "test/integration/hunt/**"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
