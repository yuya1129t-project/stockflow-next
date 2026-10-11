/**
 * テスト用 DB（DATABASE_URL_TEST）に向けてコマンドを実行する。
 * 例: tsx scripts/with-test-db.ts prisma migrate deploy
 *
 * 開発用 DB などを誤って書き換えないよう、scripts/db-guard.ts の checkTestDbTarget で接続先を検査する。
 */
import "dotenv/config";

import { spawnSync } from "node:child_process";

import { checkTestDbTarget, formatDbTarget } from "./db-guard";

const [command, ...args] = process.argv.slice(2);

if (!command) {
  console.error("使い方: tsx scripts/with-test-db.ts <コマンド> [引数...]");
  process.exit(2);
}
const testUrl = process.env.DATABASE_URL_TEST;
const guard = checkTestDbTarget(testUrl, process.env.DATABASE_URL);
if (!guard.ok) {
  console.error(`中止しました: ${guard.reason}`);
  process.exit(1);
}
console.log(`テスト用 DB: ${formatDbTarget(guard.target)}`);

const result = spawnSync(command, args, {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, DATABASE_URL: testUrl },
});
process.exit(result.status ?? 1);
