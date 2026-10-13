/**
 * E2E 用 DB（DATABASE_URL_TEST）のログインの試行回数のカウンター（rate_limit）を空にする。
 * e2e/auth.setup.ts がログインの前に `tsx e2e/clear-rate-limit.ts` で実行する（Playwright のプロセスで
 * Prisma Client を読み込まないよう、シードと同じく tsx の別プロセスで動かす）。
 *
 * 接続先は scripts/db-guard.ts の checkTestDbTarget で、テスト用 DB（名前が _test で終わる・ローカル・
 * 開発用 DB と別）であることを確かめてから操作する
 */
import "dotenv/config";

import { checkTestDbTarget, formatDbTarget } from "../scripts/db-guard";
import { createPrismaClient } from "../src/lib/db";

async function main() {
  const url = process.env.DATABASE_URL_TEST;
  const guard = checkTestDbTarget(url, process.env.DATABASE_URL);
  if (!guard.ok) {
    throw new Error(`rate_limit を空にするのを中止しました: ${guard.reason}`);
  }
  const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
  const prisma = createPrismaClient(url!);
  try {
    const deleted = await prisma.$executeRawUnsafe(
      `DELETE FROM ${quote(guard.target.schema)}.${quote("rate_limit")}`,
    );
    console.log(
      `ログインの試行回数のカウンターを空にしました（${formatDbTarget(guard.target)}、${deleted} 件）`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
