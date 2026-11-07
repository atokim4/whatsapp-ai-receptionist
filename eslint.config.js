import globals from "globals";
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "coverage/", "node_modules/"] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { project: "./tsconfig.test.json", tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Express recognises error middleware by arity, so `_next` must stay.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  { files: ["eslint.config.js"], ...tseslint.configs.disableTypeChecked },
  {
    files: ["public/**/*.js"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: { sourceType: "script", globals: globals.browser, parserOptions: { project: false, projectService: false } },
  },
);
