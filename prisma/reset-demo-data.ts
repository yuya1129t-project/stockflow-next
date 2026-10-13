/**
 * デモデータの投入（リセット）。CLI のシード（prisma/seed.ts）と日次リセットの Cron
 * （src/app/api/cron/reset-demo/route.ts）が同じこの関数を使う。
 *
 * このアプリのテーブル（prisma/app-tables.ts）を**空にしてから**投入し直す（何度実行しても同じ状態になる）。
 * セッション・API トークン・ログインの試行回数（rate_limit）・閲覧者が登録したデータもすべて消える。
 * ローカル以外の DB には STOCKFLOW_ALLOW_DESTRUCTIVE_SEED=1 がない限り実行しない（scripts/db-guard.ts）。
 * データの中身は prisma/seed-data.ts を参照。
 *
 * .env は読まない（CLI は呼び出し側で dotenv を読み込む。Next.js は環境変数を自分で読み込む）
 */
import { hashPassword } from "better-auth/crypto";

import {
  checkDestructiveTarget,
  type DbTarget,
  formatDbTarget,
} from "../scripts/db-guard";
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

/** 接続先がガード（scripts/db-guard.ts）で拒否されたときの例外 */
export class DemoResetRefusedError extends Error {
  constructor(reason: string) {
    super(`シードを中止しました: ${reason}`);
    this.name = "DemoResetRefusedError";
  }
}

export interface ResetDemoDataOptions {
  /** 接続 URL（DATABASE_URL） */
  url: string | undefined;
  /** ガードが参照する環境変数（既定 process.env） */
  env?: Record<string, string | undefined>;
  /** データの基準日時（既定 現在） */
  now?: Date;
  /** 空にする前に呼ぶ（接続先の表示用） */
  onTarget?: (target: string) => void;
}

export interface ResetDemoDataResult {
  /** 接続先の host:port/DB（パスワードは含まない） */
  target: string;
  counts: {
    users: number;
    partners: number;
    products: number;
    salesOrders: number;
    purchaseOrders: number;
    stockMovements: number;
  };
}

export async function resetDemoData({
  url,
  env = process.env,
  now = new Date(),
  onTarget,
}: ResetDemoDataOptions): Promise<ResetDemoDataResult> {
  const guard = checkDestructiveTarget(url, env);
  if (!guard.ok) {
    throw new DemoResetRefusedError(guard.reason);
  }
  onTarget?.(formatDbTarget(guard.target));

  const data = buildSeedData(now);
  // Better Auth のメール＋パスワード認証と同じ方式（better-auth/crypto の hashPassword）でハッシュ化する
  const passwordHashes = await Promise.all(
    data.users.map(() => hashPassword(DEMO_PASSWORD)),
  );

  const prisma = createPrismaClient(url!);
  try {
    await prisma.$transaction(
      async (tx) => {
        const table = (name: string) => qualifiedTable(guard.target, name);
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

  return {
    target: formatDbTarget(guard.target),
    counts: {
      users: data.users.length,
      partners: data.partners.length,
      products: data.products.length,
      salesOrders: data.salesOrders.length,
      purchaseOrders: data.purchaseOrders.length,
      stockMovements: data.stockMovements.length,
    },
  };
}

/** スキーマ修飾した表名（例 "public"."product"） */
function qualifiedTable(target: DbTarget, name: string): string {
  return `${quoteIdent(target.schema)}.${quoteIdent(name)}`;
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
