/**
 * 出荷で在庫が足りなかったときの表示用データ（spec §4「不足する商品と数量を表示」）。純粋なモジュール。
 *
 * 不足の判定は在庫の記録（src/lib/stock/movements.ts の recordStockMovements → InsufficientStockError）が行う。
 * ここでは、その結果を画面に出す形（商品・必要数・現在庫・不足数）とメッセージにする
 */
import { formatNumber } from "@/lib/format";
import type { StockShortage } from "@/lib/stock/rules";

/** 画面の不足の表の 1 行 */
export interface ShortageRow {
  productId: number;
  /** 商品（コードと名前。例「P-0001 サンプル品」） */
  product: string;
  /** 必要数（例「10 個」） */
  required: string;
  /** 現在庫 */
  available: string;
  /** 不足数 */
  shortage: string;
}

/** 出荷を中止したときのメッセージ（不足する品目の数を含む） */
export function shortageMessage(shortages: readonly StockShortage[]): string {
  return `在庫が足りない商品が ${shortages.length} 品目あるため、出荷しませんでした（在庫・ステータスは変わっていません）`;
}

/** 不足の表の行（商品コードの順） */
export function toShortageRows(
  shortages: readonly StockShortage[],
): ShortageRow[] {
  const quantity = (value: number, unit: string) =>
    `${formatNumber(value)} ${unit}`;
  return [...shortages]
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((s) => ({
      productId: s.productId,
      product: `${s.code} ${s.name}`,
      required: quantity(s.required, s.unit),
      available: quantity(s.available, s.unit),
      shortage: quantity(s.shortage, s.unit),
    }));
}
