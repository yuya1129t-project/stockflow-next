/**
 * 在庫の規則（純粋な関数と型）。docs/spec.md §3「StockMovement」・§4・§6-3。
 *
 * - 現在庫 = 入出庫（符号付きの quantity）の合計。記録後の在庫は 0 以上でなければならない
 * - 入出庫の数量の符号: in は正、out は負、adjust は 0 以外（DB の CHECK 制約と同じ）
 * - 「発注点割れ」は有効な商品で 現在庫 < 発注点（商品一覧の強調表示と同じ定義）
 *
 * DB やフレームワークに依存しない（クライアントからも import できる）
 */

export const STOCK_MOVEMENT_TYPES = ["in", "out", "adjust"] as const;
export type StockMovementKind = (typeof STOCK_MOVEMENT_TYPES)[number];

/** 画面に出す種別名 */
export const STOCK_MOVEMENT_TYPE_LABELS: Record<StockMovementKind, string> = {
  in: "入庫",
  out: "出庫",
  adjust: "棚卸調整",
};

/** 記録する入出庫 1 件（quantity は符号付き） */
export interface StockMovementEntry {
  productId: number;
  type: StockMovementKind;
  quantity: number;
  reason?: string | null;
  refType?: "sales_order" | "purchase_order" | null;
  refId?: number | null;
}

/** 記録の前に読む商品の状態（行ロックを取った時点の値） */
export interface StockProductState {
  id: number;
  code: string;
  name: string;
  unit: string;
  reorderPoint: number;
  isActive: boolean;
  /** 現在庫（入出庫の合計） */
  stock: number;
}

/** 在庫が足りない商品（出荷を中止して画面に出す） */
export interface StockShortage {
  productId: number;
  code: string;
  name: string;
  unit: string;
  /** 現在庫 */
  available: number;
  /** 必要な数（この記録で減らす数） */
  required: number;
  /** 不足する数 */
  shortage: number;
}

/** 商品ごとの記録の前後の在庫 */
export interface StockChange {
  productId: number;
  before: number;
  after: number;
}

/** 記録によって「発注点以上 → 発注点未満」に変わった商品（#12 の通知で使う） */
export interface ReorderPointCrossing {
  productId: number;
  code: string;
  name: string;
  unit: string;
  reorderPoint: number;
  before: number;
  after: number;
}

export type StockPlan =
  | {
      ok: true;
      changes: StockChange[];
      fellBelowReorderPoint: ReorderPointCrossing[];
    }
  | { ok: false; shortages: StockShortage[] };

/** 入出庫の数量が種別の符号の規則に合うか（整数で、in > 0・out < 0・adjust ≠ 0） */
export function isValidMovementQuantity(
  type: StockMovementKind,
  quantity: number,
): boolean {
  if (!Number.isSafeInteger(quantity)) return false;
  switch (type) {
    case "in":
      return quantity > 0;
    case "out":
      return quantity < 0;
    case "adjust":
      return quantity !== 0;
  }
}

/** 発注点割れ（有効な商品で 現在庫 < 発注点） */
export function isBelowReorderPoint(
  product: Pick<StockProductState, "isActive" | "reorderPoint">,
  stock: number,
): boolean {
  return product.isActive && stock < product.reorderPoint;
}

/**
 * 入出庫をまとめて記録したときの結果を求める（DB には書かない）。
 *
 * 同じ商品の入出庫が複数あれば合計して判定する。記録後に在庫が負になる商品が 1 つでもあれば、
 * 不足する商品の一覧を返す（全体を記録しない）。products は対象の全商品を含むこと
 */
export function planStockMovements(
  products: readonly StockProductState[],
  entries: readonly StockMovementEntry[],
): StockPlan {
  const byId = new Map(products.map((p) => [p.id, p]));
  const net = new Map<number, number>();
  for (const entry of entries) {
    if (!byId.has(entry.productId)) {
      throw new Error(`商品 ${entry.productId} の在庫を読んでいません`);
    }
    net.set(entry.productId, (net.get(entry.productId) ?? 0) + entry.quantity);
  }

  const changes: StockChange[] = [];
  const shortages: StockShortage[] = [];
  const fellBelowReorderPoint: ReorderPointCrossing[] = [];
  // 商品 ID の順にする（結果の順番を入力の順番によらず一定にする）
  for (const productId of [...net.keys()].sort((a, b) => a - b)) {
    const product = byId.get(productId)!;
    const delta = net.get(productId)!;
    const before = product.stock;
    const after = before + delta;
    if (after < 0) {
      shortages.push({
        productId,
        code: product.code,
        name: product.name,
        unit: product.unit,
        available: before,
        required: -delta,
        shortage: -after,
      });
      continue;
    }
    changes.push({ productId, before, after });
    if (
      !isBelowReorderPoint(product, before) &&
      isBelowReorderPoint(product, after)
    ) {
      fellBelowReorderPoint.push({
        productId,
        code: product.code,
        name: product.name,
        unit: product.unit,
        reorderPoint: product.reorderPoint,
        before,
        after,
      });
    }
  }
  return shortages.length > 0
    ? { ok: false, shortages }
    : { ok: true, changes, fellBelowReorderPoint };
}

/** 棚卸調整で記録する差分（実数 − 現在庫）。0 なら記録しない */
export function adjustmentDelta(currentStock: number, actual: number): number {
  return actual - currentStock;
}

/**
 * 在庫不足で入出庫を記録できなかったときの例外。
 * トランザクションの中で投げるので、同じトランザクションのほかの書き込み（受注のステータス更新など）も取り消される
 */
export class InsufficientStockError extends Error {
  readonly shortages: StockShortage[];

  constructor(shortages: StockShortage[]) {
    super(
      `在庫が足りません: ${shortages
        .map(
          (s) =>
            `${s.code}「${s.name}」（必要 ${s.required}${s.unit}・在庫 ${s.available}${s.unit}・不足 ${s.shortage}${s.unit}）`,
        )
        .join("、")}`,
    );
    this.name = "InsufficientStockError";
    this.shortages = shortages;
  }
}
