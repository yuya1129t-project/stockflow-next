/**
 * E2E テスト（Playwright）の設定。`pnpm test:e2e` で実行する（README「E2E テスト」）。
 *
 * - アプリは本番モード（`next build` → `next start`）で起動し、E2E 用 DB（DATABASE_URL_TEST）に向ける。
 *   ログインの試行回数制限（60 秒に 5 回）が本番と同じく効く状態でテストする
 * - テストの前に E2E 用 DB をマイグレーション＋シードで初期化する（e2e/global-setup.ts）
 * - ログインはロールごとに 1 回だけ（setup プロジェクトで storageState を作り、各テストで使い回す）。
 *   ログアウトはセッションを消すので、ほかのテストがすべて終わってから実行する（logout プロジェクト）
 */
import "dotenv/config";

import { defineConfig, devices } from "@playwright/test";

const PORT = 3113;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const testDbUrl = process.env.DATABASE_URL_TEST;
if (!testDbUrl) {
  throw new Error(
    "環境変数 DATABASE_URL_TEST が設定されていません（cp .env.example .env で作成できます）",
  );
}

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // ログインの試行回数制限があるので、ログインを含むテストを何度も再実行しないよう CI でも 1 回まで
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: BASE_URL,
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    // ロールごとに 1 回ログインして storageState を保存する
    { name: "setup", testMatch: /auth\.setup\.ts$/ },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: /logout\.spec\.ts$/,
      dependencies: ["setup"],
    },
    // ログアウトは viewer のセッションを消すので、ほかのテストがすべて終わってから実行する
    {
      name: "logout",
      use: { ...devices["Desktop Chrome"] },
      testMatch: /logout\.spec\.ts$/,
      dependencies: ["chromium"],
    },
  ],
  webServer: {
    command: `pnpm build && pnpm start --hostname 127.0.0.1 --port ${PORT}`,
    url: `${BASE_URL}/login`,
    timeout: 300_000,
    reuseExistingServer: !process.env.CI,
    stdout: "ignore",
    stderr: "pipe",
    env: {
      // アプリの DB を E2E 用 DB に向ける（開発用 DB には触れない）
      DATABASE_URL: testDbUrl,
      BETTER_AUTH_URL: BASE_URL,
      BETTER_AUTH_SECRET:
        process.env.BETTER_AUTH_SECRET ??
        "e2e-dummy-secret-not-for-production-0123456789",
      // 発注点割れの通知（外部への送信）はしない
      STOCKFLOW_SLACK_WEBHOOK_URL: "",
    },
  },
});
