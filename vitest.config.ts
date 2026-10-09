import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // `tsc` emits compiled copies of the tests into dist/test/, which the
    // `test/unit` and `test/integration` path filters would otherwise match.
    exclude: [...configDefaults.exclude, "dist/**"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
