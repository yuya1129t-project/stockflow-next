/**
 * デモ用シードの投入（`pnpm db:seed` ＝ `prisma db seed` から実行される）。
 *
 * このアプリのテーブル（prisma/app-tables.ts）を**空にしてから**投入し直す（何度実行しても同じ状態になる）。
 * ローカル以外の DB には STOCKFLOW_ALLOW_DESTRUCTIVE_SEED=1 がない限り実行しない（scripts/db-guard.ts）。
 * 処理の本体は prisma/reset-demo-data.ts（日次リセットの Cron と共通）、データの中身は prisma/seed-data.ts。
 */
import "dotenv/config";

import { resetDemoData } from "./reset-demo-data";

async function main() {
  const { counts } = await resetDemoData({
    url: process.env.DATABASE_URL,
    onTarget: (target) =>
      console.log(
        `接続先: ${target}（アプリのテーブルを空にしてから投入します）`,
      ),
  });

  console.log(
    [
      "シードを投入しました:",
      `ユーザー ${counts.users}`,
      `取引先 ${counts.partners}`,
      `商品 ${counts.products}`,
      `受注 ${counts.salesOrders}`,
      `発注 ${counts.purchaseOrders}`,
      `入出庫 ${counts.stockMovements}`,
    ].join(" "),
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
