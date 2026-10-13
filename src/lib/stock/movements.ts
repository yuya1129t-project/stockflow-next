/**
 * 在庫の共通モジュール（現在庫の取得・入出庫の記録）。サーバー側でだけ使う。
 *
 * 棚卸調整（#6）・発注の入荷（#7）・受注の出荷（#8）・発注点割れの通知（#12）から使う土台。
 *
 * 同時実行の考え方:
 * - 現在庫は入出庫の合計で、在庫数の列は持たない（spec §3）。READ COMMITTED のまま
 *   「合計を確認 → 出庫を INSERT」すると、同時に出庫した 2 つのトランザクションが両方とも確認を通り、在庫が負になる
 * - そこで記録の前に、対象商品の product 行を id の順に SELECT … FOR NO KEY UPDATE でロックしてから合計を読む。
 *   同じ商品を扱うトランザクションはここで順番待ちになり、後のトランザクションは先の記録を含めた合計で判定する
 * - FOR UPDATE ではなく FOR NO KEY UPDATE にするのは、明細（sales_order_line など）の INSERT の外部キー検査が取る
 *   FOR KEY SHARE と競合させないため（明細の INSERT は入力の順番で商品を参照するので、競合すると順番が逆になり
 *   デッドロックし得る）。FOR NO KEY UPDATE 同士・商品の UPDATE とは競合するので、在庫の記録は直列になる
 * - デッドロックしないのは、商品行をロックする処理がすべて「対象の全商品を一度に id 順でロックする」場合に限る。
 *   在庫の記録同士と商品 CSV 取込（src/lib/products/service.ts）はこの順番にそろえている
 *
 * 呼び出しの契約:
 * - 記録は withStockTransaction の中で、渡された tx（StockTransaction）を使って行う。伝票の更新など、
 *   同じトランザクションで行うほかの書き込みもこの tx で書く（不足の例外で全体が取り消される）
 * - 対象の全商品を一度に渡す。同じトランザクションの中で、別の商品のロックをあとから追加しない
 *   （同じ商品を再びロックするのは問題ない）
 */
import { Prisma, type PrismaClient } from "@/generated/prisma/client";

import {
  InsufficientStockError,
  isValidMovementQuantity,
  planStockMovements,
  type ReorderPointCrossing,
  type StockChange,
  type StockMovementEntry,
  type StockProductState,
} from "./rules";

/** PrismaClient またはトランザクションの中のクライアント */
export type DbClient = PrismaClient | Prisma.TransactionClient;

declare const stockTransactionBrand: unique symbol;

/**
 * 在庫を記録するためのトランザクション（withStockTransaction からだけ渡される）。
 * 通常の PrismaClient はこの型に代入できないので、トランザクションの外から記録関数を呼ぶと型エラーになる
 */
export type StockTransaction = Prisma.TransactionClient & {
  readonly [stockTransactionBrand]: true;
};

/** 実行時の確認用: withStockTransaction の実行中の tx だけを入れる */
const activeStockTransactions = new WeakSet<object>();

/**
 * 在庫を記録するトランザクションを開始する（READ COMMITTED の対話型トランザクション）。
 * fn の中で tx を使って、入出庫の記録と伝票の更新などを同じトランザクションで書く。
 * fn が例外を投げたら（InsufficientStockError を含む）全体を取り消し、その例外をそのまま投げる
 *
 * @example
 * const result = await withStockTransaction(db, async (tx) => {
 *   await tx.salesOrder.update(...);
 *   return recordStockMovements(tx, user.id, entries);
 * });
 */
export async function withStockTransaction<T>(
  db: PrismaClient,
  fn: (tx: StockTransaction) => Promise<T>,
  options: { timeout?: number; maxWait?: number } = {},
): Promise<T> {
  return db.$transaction(
    async (tx) => {
      activeStockTransactions.add(tx);
      try {
        return await fn(tx as StockTransaction);
      } finally {
        activeStockTransactions.delete(tx);
      }
    },
    {
      ...options,
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    },
  );
}

/** withStockTransaction の実行中の tx でなければ例外（型を外して呼ばれた場合の実行時の確認） */
function assertStockTransaction(tx: StockTransaction): void {
  if (!activeStockTransactions.has(tx)) {
    throw new Error(
      "在庫の記録は withStockTransaction の中で、渡された tx を使って行ってください（トランザクションの外ではロックが効きません）",
    );
  }
}

/** 商品ごとの現在庫（入出庫の合計）。入出庫のない商品・存在しない商品は 0 */
export async function getStocks(
  db: DbClient,
  productIds: readonly number[],
): Promise<Map<number, number>> {
  const ids = [...new Set(productIds)];
  const stocks = new Map(ids.map((id) => [id, 0]));
  if (ids.length === 0) return stocks;
  const rows = await db.$queryRaw<{ productId: number; stock: number }[]>`
    SELECT "productId", SUM("quantity")::int AS "stock"
    FROM "stock_movement"
    WHERE "productId" IN (${Prisma.join(ids)})
    GROUP BY "productId"`;
  for (const row of rows) stocks.set(row.productId, row.stock);
  return stocks;
}

/** 1 商品の現在庫 */
export async function getStock(
  db: DbClient,
  productId: number,
): Promise<number> {
  return (await getStocks(db, [productId])).get(productId) ?? 0;
}

/**
 * 対象商品の product 行を id の順に行ロック（FOR NO KEY UPDATE）し、ロックを取った後の現在庫を読む。
 * ロックはトランザクションの終わりまで続く。対象の全商品を一度に渡すこと。存在しない商品は結果に含まれない
 */
export async function lockProductsForStock(
  tx: StockTransaction,
  productIds: readonly number[],
): Promise<StockProductState[]> {
  assertStockTransaction(tx);
  const ids = [...new Set(productIds)].sort((a, b) => a - b);
  if (ids.length === 0) return [];
  const products = await tx.$queryRaw<Omit<StockProductState, "stock">[]>`
    SELECT "id", "code", "name", "unit", "reorderPoint", "isActive"
    FROM "product"
    WHERE "id" IN (${Prisma.join(ids)})
    ORDER BY "id"
    FOR NO KEY UPDATE`;
  // ロックを取った後の文で読むので、先に記録して確定したトランザクションの入出庫も合計に含まれる
  const stocks = await getStocks(
    tx,
    products.map((p) => p.id),
  );
  return products.map((p) => ({ ...p, stock: stocks.get(p.id) ?? 0 }));
}

export interface RecordStockMovementsResult {
  /** 記録した入出庫 */
  movements: { id: number; productId: number; quantity: number }[];
  /** 商品ごとの記録の前後の在庫（商品 ID の順） */
  changes: StockChange[];
  /** 「発注点以上 → 発注点未満」に変わった有効な商品。通知（#12）はトランザクション確定後に呼び出し側で送る */
  fellBelowReorderPoint: ReorderPointCrossing[];
}

/**
 * 入出庫をまとめて記録する（受注の出荷のように複数明細を一括で記録できる）。
 *
 * 1. 対象商品の行をロックして現在庫を読む
 * 2. 記録後に在庫が負になる商品が 1 つでもあれば InsufficientStockError を投げる（何も記録しない。
 *    呼び出し側のトランザクションごと取り消される）
 * 3. 入出庫を INSERT する
 *
 * 数量の符号が種別に合わない・refType と refId の片方だけを指定した・存在しない商品を指定した、は
 * プログラムの誤りなので Error を投げる
 */
export async function recordStockMovements(
  tx: StockTransaction,
  userId: string | null,
  entries: readonly StockMovementEntry[],
): Promise<RecordStockMovementsResult> {
  assertStockTransaction(tx);
  if (entries.length === 0) {
    return { movements: [], changes: [], fellBelowReorderPoint: [] };
  }
  for (const entry of entries) {
    if (!isValidMovementQuantity(entry.type, entry.quantity)) {
      throw new Error(
        `入出庫の数量が種別（${entry.type}）に合いません: ${entry.quantity}`,
      );
    }
    if ((entry.refType == null) !== (entry.refId == null)) {
      throw new Error(
        `入出庫の参照元は refType と refId を両方指定してください: ${entry.refType ?? "null"} / ${entry.refId ?? "null"}`,
      );
    }
  }
  const productIds = entries.map((e) => e.productId);
  const products = await lockProductsForStock(tx, productIds);
  const found = new Set(products.map((p) => p.id));
  const missing = [...new Set(productIds)].filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new Error(`商品が見つかりません: ${missing.join(", ")}`);
  }

  const plan = planStockMovements(products, entries);
  if (!plan.ok) throw new InsufficientStockError(plan.shortages);

  const created = await tx.stockMovement.createManyAndReturn({
    data: entries.map((e) => ({
      productId: e.productId,
      type: e.type,
      quantity: e.quantity,
      reason: e.reason ?? null,
      refType: e.refType ?? null,
      refId: e.refId ?? null,
      userId,
    })),
    select: { id: true, productId: true, quantity: true },
  });
  return {
    movements: created,
    changes: plan.changes,
    fellBelowReorderPoint: plan.fellBelowReorderPoint,
  };
}
