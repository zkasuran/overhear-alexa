import { defineConfig } from "vitest/config";

// One root config for every workspace package. Node environment; browser UI is
// exercised by the headless-Chrome gate (scripts/ui-gates.mjs), not by vitest.
export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    exclude: ["**/dist/**", "**/node_modules/**"],
    environment: "node",
    hookTimeout: 30000,
    testTimeout: 30000,
    reporters: ["dot"],
  },
});
