import { defineConfig, globalIgnores } from "eslint/config";
import typescript from "@typescript-eslint/eslint-plugin";
import parser from "@typescript-eslint/parser";
import reactHooks from "eslint-plugin-react-hooks";

export default defineConfig([
  globalIgnores(["dist/**", "dist-pc/**", "node_modules/**", "data-pc/**", "backups/**"]),
  {
    files: ["**/*.{ts,tsx,mjs}"],
    languageOptions: {
      parser,
      parserOptions: { ecmaVersion: "latest", sourceType: "module", ecmaFeatures: { jsx: true } },
    },
    plugins: { "@typescript-eslint": typescript, "react-hooks": reactHooks },
    rules: {
      ...typescript.configs.recommended.rules,
      ...reactHooks.configs.flat.recommended.rules,
      "no-undef": "off",
    },
  },
]);
