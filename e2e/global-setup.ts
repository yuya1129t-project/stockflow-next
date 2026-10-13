/**
 * E2E の前に E2E 用 DB（DATABASE_URL_TEST）を初期化する（マイグレーション → シード）。
 * `pnpm db:test:reset` と同じ。接続先がテスト用 DB であること（名前が _test で終わる・ローカル等）は
 * scripts/with-test-db.ts が検査する。シードは rate_limit も空にするので、続けて実行しても試行回数制限に当たらない
 */
import { execFileSync } from "node:child_process";

export default function globalSetup() {
  execFileSync("pnpm", ["db:test:reset"], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
}
