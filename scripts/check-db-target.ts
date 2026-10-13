/**
 * DATABASE_URL の接続先を表示し、データを消去する操作をしてよいか検査する。
 * `pnpm db:reset` で migrate reset の前に実行する（拒否なら終了コード 1）。
 *
 * Prisma CLI（migrate reset）は DIRECT_URL があればそちらに接続する（prisma.config.ts）ので、
 * DIRECT_URL が設定されていればそれも検査する
 */
import "dotenv/config";

import { checkDestructiveTarget, formatDbTarget } from "./db-guard";

const urls = [
  ["DATABASE_URL", process.env.DATABASE_URL],
  ...(process.env.DIRECT_URL
    ? [["DIRECT_URL", process.env.DIRECT_URL] as const]
    : []),
] as const;

for (const [name, url] of urls) {
  const result = checkDestructiveTarget(url);
  if (!result.ok) {
    console.error(`中止しました（${name}）: ${result.reason}`);
    process.exit(1);
  }
  console.log(
    `接続先（${name}）: ${formatDbTarget(result.target)}（データを消去して作り直します）`,
  );
}
