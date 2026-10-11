/**
 * DATABASE_URL の接続先を表示し、データを消去する操作をしてよいか検査する。
 * `pnpm db:reset` で migrate reset の前に実行する（拒否なら終了コード 1）。
 */
import "dotenv/config";

import { checkDestructiveTarget, formatDbTarget } from "./db-guard";

const result = checkDestructiveTarget(process.env.DATABASE_URL);
if (!result.ok) {
  console.error(`中止しました: ${result.reason}`);
  process.exit(1);
}
console.log(
  `接続先: ${formatDbTarget(result.target)}（データを消去して作り直します）`,
);
