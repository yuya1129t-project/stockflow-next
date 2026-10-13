import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier/flat";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Prettier と競合する整形系ルールを無効化（最後に置く）
  prettier,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Prisma Client の生成物（pnpm db:generate で作る）
    "src/generated/**",
    // E2E（Playwright）のレポート・結果
    "playwright-report/**",
    "test-results/**",
  ]),
]);

export default eslintConfig;
