import path from "node:path";
import { fileURLToPath } from "node:url";

import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import globals from "globals";
import tseslint from "typescript-eslint";

const dirname = path.dirname(fileURLToPath(import.meta.url));

const sharedSortRules = {
  "simple-import-sort/exports": "error",
  "simple-import-sort/imports": "error",
};

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      ".grove-home/**",
      "bridge/.venv/**",
      "bridge/.pytest_cache/**",
      // Dashboard plugins ship their own self-contained build/lint (see
      // plugins/*/dashboard); keep them out of the root TS check.
      "plugins/**",
      // The cockpit web SPA has its own self-contained build/lint (see web/).
      "web/**",
    ],
  },
  {
    ...js.configs.recommended,
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      globals: {
        ...globals.es2023,
        ...globals.node,
      },
      sourceType: "module",
    },
    plugins: {
      "simple-import-sort": simpleImportSort,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...sharedSortRules,
    },
  },
  {
    files: ["**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      globals: {
        ...globals.es2023,
        ...globals.node,
      },
      parserOptions: {
        projectService: {
          allowDefaultProject: ["tsup.config.ts", "vitest.config.ts"],
        },
        tsconfigRootDir: dirname,
      },
    },
    plugins: {
      "simple-import-sort": simpleImportSort,
    },
    rules: {
      ...sharedSortRules,
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          fixStyle: "separate-type-imports",
          prefer: "type-imports",
        },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/require-await": "off",
    },
  },
  prettier,
);
