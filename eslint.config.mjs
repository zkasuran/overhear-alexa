// Flat ESLint config. `npm run lint` runs `eslint .`; the gate runs `eslint . --max-warnings 0`.
// Type-level rules (unused, strictness) are enforced by tsc; ESLint covers correctness and style.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/*.tsbuildinfo",
      "packages/sim-web/dist/**",
      "fixtures/**",
      "docs/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
      "no-console": ["error", { allow: ["error", "warn"] }],
      eqeqeq: ["error", "always"],
      "no-var": "error",
      "prefer-const": "error",
    },
  },
  // Browser code in the simulator UI.
  {
    files: ["packages/sim-web/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser } },
  },
  // Plain JS/MJS config and gate scripts run on Node and may log.
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node, fetch: "readonly", AbortSignal: "readonly" },
    },
    rules: { "no-console": "off" },
  },
  // Scripts and tests may log and are not shipped as library code.
  {
    files: ["scripts/**/*.{ts,mts,mjs}", "**/*.test.ts", "**/test/**/*.ts"],
    rules: { "no-console": "off" },
  },
);
