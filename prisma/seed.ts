/**
 * デモ用シードの投入（`pnpm db:seed` ＝ `prisma db seed` から実行される）。
 *
 * このアプリのテーブル（prisma/app-tables.ts）を**空にしてから**投入し直す（何度実行しても同じ状態になる）。
 * ローカル以外の DB には STOCKFLOW_ALLOW_DESTRUCTIVE_SEED=1 がない限り実行しない（scripts/db-guard.ts）。
 * データの中身は prisma/seed-data.ts を参照。
 */
import "dotenv/config";

import { hashPassword } from "better-auth/crypto";

import { checkDestructiveTarget, formatDbTarget } from "../scripts/db-guard";
import { createPrismaClient } from "../src/lib/db";
import { APP_TABLES } from "./app-tables";
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
  const guard = checkDestructiveTarget(url);
  if (!guard.ok) {
    throw new Error(`シードを中止しました: ${guard.reason}`);
  }
  console.log(
    `接続先: ${formatDbTarget(guard.target)}（アプリのテーブルを空にしてから投入します）`,
  );
  // スキーマ修飾した表名（例 "public"."product"）
  const table = (name: string) =>
    `${quoteIdent(guard.target.schema)}.${quoteIdent(name)}`;

  const data = buildSeedData(new Date());
  // Better Auth のメール＋パスワード認証と同じ方式（better-auth/crypto の hashPassword）でハッシュ化する
  const passwordHashes = await Promise.all(
    data.users.map(() => hashPassword(DEMO_PASSWORD)),
  );

  const prisma = createPrismaClient(url!);
  try {
    await prisma.$transaction(
      async (tx) => {
        // このアプリのテーブルだけを空にする（CASCADE は付けない。他のテーブルから参照されていればエラーで中止）
        await tx.$executeRawUnsafe(
          `TRUNCATE TABLE ${APP_TABLES.map(table).join(", ")} RESTART IDENTITY`,
        );

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

        for (const name of TABLES_WITH_EXPLICIT_ID) {
          await tx.$executeRawUnsafe(
            `SELECT setval(pg_get_serial_sequence('${table(name)}', 'id'), (SELECT MAX("id") FROM ${table(name)}))`,
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

/** 識別子を二重引用符で囲む（SQL 識別子のエスケープ） */
function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
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
