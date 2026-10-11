/**
 * デモ用シードの投入（`pnpm db:seed` ＝ `prisma db seed` から実行される）。
 *
 * 接続先 DB のアプリのテーブルを**すべて空にしてから**投入し直す（何度実行しても同じ状態になる）。
 * データの中身は prisma/seed-data.ts を参照。
 */
import "dotenv/config";

import { hashPassword } from "better-auth/crypto";

import { createPrismaClient } from "../src/lib/db";
import { buildSeedData, DEMO_PASSWORD } from "./seed-data";

/** 明示した ID で投入したテーブル（投入後に連番を進める） */
const TABLES_WITH_EXPLICIT_ID = [
  "partner",
  "product",
  "sales_order",
  "purchase_order",
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "環境変数 DATABASE_URL が設定されていません（.env.example を参照）",
    );
  }

  const data = buildSeedData(new Date());
  // Better Auth のメール＋パスワード認証と同じ方式（better-auth/crypto の hashPassword）でハッシュ化する
  const passwordHashes = await Promise.all(
    data.users.map(() => hashPassword(DEMO_PASSWORD)),
  );

  const prisma = createPrismaClient(url);
  try {
    await prisma.$transaction(
      async (tx) => {
        // マイグレーション履歴以外のテーブルを空にする
        const tables = await tx.$queryRaw<{ tablename: string }[]>`
          SELECT tablename FROM pg_tables
          WHERE schemaname = current_schema() AND tablename <> '_prisma_migrations'`;
        if (tables.length > 0) {
          const list = tables.map((t) => `"${t.tablename}"`).join(", ");
          await tx.$executeRawUnsafe(
            `TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`,
          );
        }

        await tx.user.createMany({
          data: data.users.map((u) => ({
            ...u,
            emailVerified: true,
            isActive: true,
          })),
        });
        // Better Auth の credential アカウント（サインアップ時と同じく accountId = userId）
        await tx.account.createMany({
          data: data.users.map((u, i) => ({
            id: `${u.id}_credential`,
            accountId: u.id,
            providerId: "credential",
            userId: u.id,
            password: passwordHashes[i],
          })),
        });

        await tx.partner.createMany({ data: data.partners });
        await tx.product.createMany({ data: data.products });

        await tx.purchaseOrder.createMany({
          data: data.purchaseOrders.map(withoutLines),
        });
        await tx.purchaseOrderLine.createMany({
          data: data.purchaseOrders.flatMap((o) =>
            o.lines.map((line) => ({ ...line, purchaseOrderId: o.id })),
          ),
        });
        await tx.salesOrder.createMany({
          data: data.salesOrders.map(withoutLines),
        });
        await tx.salesOrderLine.createMany({
          data: data.salesOrders.flatMap((o) =>
            o.lines.map((line) => ({ ...line, salesOrderId: o.id })),
          ),
        });

        await tx.stockMovement.createMany({ data: data.stockMovements });
        await tx.documentSequence.createMany({ data: data.documentSequences });

        for (const table of TABLES_WITH_EXPLICIT_ID) {
          await tx.$executeRawUnsafe(
            `SELECT setval(pg_get_serial_sequence('"${table}"', 'id'), (SELECT MAX("id") FROM "${table}"))`,
          );
        }
      },
      { timeout: 60_000 },
    );
  } finally {
    await prisma.$disconnect();
  }

  console.log(
    [
      "シードを投入しました:",
      `ユーザー ${data.users.length}`,
      `取引先 ${data.partners.length}`,
      `商品 ${data.products.length}`,
      `受注 ${data.salesOrders.length}`,
      `発注 ${data.purchaseOrders.length}`,
      `入出庫 ${data.stockMovements.length}`,
    ].join(" "),
  );
}

function withoutLines<T extends { lines: unknown }>(
  order: T,
): Omit<T, "lines"> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { lines, ...rest } = order;
  return rest;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
