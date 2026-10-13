/**
 * 在庫の共通モジュール（現在庫の取得・入出庫の記録）。サーバー側でだけ使う。
 *
 * 棚卸調整（#6）・発注の入荷（#7）・受注の出荷（#8）・発注点割れの通知（#12）から使う土台。
 *
 * 同時実行の考え方:
 * - 現在庫は入出庫の合計で、在庫数の列は持たない（spec §3）。READ COMMITTED のまま
 *   「合計を確認 → 出庫を INSERT」すると、同時に出庫した 2 つのトランザクションが両方とも確認を通り、在庫が負になる
 * - そこで記録の前に、対象商品の product 行を id の順に SELECT … FOR UPDATE でロックしてから合計を読む。
 *   同じ商品を扱うトランザクションはここで順番待ちになり、後のトランザクションは先の記録を含めた合計で判定する。
 *   ロックの順番を id 順にそろえるので、複数商品を逆の順番で記録してもデッドロックしない
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
 * 対象商品の product 行を id の順に行ロック（FOR UPDATE）し、ロックを取った後の現在庫を読む。
 * トランザクションの中で呼ぶこと（ロックはトランザクションの終わりまで続く）。存在しない商品は結果に含まれない
 */
export async function lockProductsForStock(
  tx: Prisma.TransactionClient,
  productIds: readonly number[],
): Promise<StockProductState[]> {
  const ids = [...new Set(productIds)].sort((a, b) => a - b);
  if (ids.length === 0) return [];
  const products = await tx.$queryRaw<Omit<StockProductState, "stock">[]>`
    SELECT "id", "code", "name", "unit", "reorderPoint", "isActive"
    FROM "product"
    WHERE "id" IN (${Prisma.join(ids)})
    ORDER BY "id"
    FOR UPDATE`;
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
 * 数量の符号が種別に合わない・存在しない商品を指定した、はプログラムの誤りなので Error を投げる
 */
export async function recordStockMovements(
  tx: Prisma.TransactionClient,
  userId: string | null,
  entries: readonly StockMovementEntry[],
): Promise<RecordStockMovementsResult> {
  if (entries.length === 0) {
    return { movements: [], changes: [], fellBelowReorderPoint: [] };
  }
  for (const entry of entries) {
    if (!isValidMovementQuantity(entry.type, entry.quantity)) {
      throw new Error(
        `入出庫の数量が種別（${entry.type}）に合いません: ${entry.quantity}`,
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
