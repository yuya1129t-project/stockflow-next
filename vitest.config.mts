import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    projects: [
      {
        // 単体テスト（DB 不要）: pnpm test:unit
        extends: true,
        test: {
          name: "unit",
          include: [
            "src/**/*.test.ts",
            "src/**/*.test.tsx",
            "prisma/**/*.test.ts",
            "scripts/**/*.test.ts",
          ],
        },
      },
      {
        // 結合テスト（実 DB = DATABASE_URL_TEST）: pnpm test:integration
        extends: true,
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          // 同じ DB を使うのでファイル単位でも並列にしない
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
