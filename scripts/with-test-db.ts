/**
 * テスト用 DB（DATABASE_URL_TEST）に向けてコマンドを実行する。
 * 例: tsx scripts/with-test-db.ts prisma migrate deploy
 *
 * 開発 DB を誤って書き換えないよう、DB 名に "test" を含まない URL や DATABASE_URL と同じ URL は拒否する。
 */
import "dotenv/config";

import { spawnSync } from "node:child_process";

const testUrl = process.env.DATABASE_URL_TEST;
const [command, ...args] = process.argv.slice(2);

if (!command) {
  console.error("使い方: tsx scripts/with-test-db.ts <コマンド> [引数...]");
  process.exit(2);
}
if (!testUrl) {
  console.error(
    "環境変数 DATABASE_URL_TEST が設定されていません（.env.example を参照）",
  );
  process.exit(1);
}
const dbName = new URL(testUrl).pathname.replace(/^\//, "");
if (!dbName.includes("test") || testUrl === process.env.DATABASE_URL) {
  console.error(`テスト用ではない DB には実行しません（DB 名: ${dbName}）`);
  process.exit(1);
}

const result = spawnSync(command, args, {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, DATABASE_URL: testUrl },
});
process.exit(result.status ?? 1);
