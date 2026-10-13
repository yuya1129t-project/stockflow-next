/**
 * 受注・発注の金額計算（spec §1・§3）。純粋なモジュール（クライアントからも import できる）。
 *
 * - 小計 = Σ 数量 × 単価、税 = calcTax(小計)（10%・1 件ごとに 1 円未満切り捨て）、合計 = 小計 + 税
 * - 金額は必ずサーバーで明細から計算して保存する（画面から送られた小計・合計は使わない）。画面の表示にも同じ関数を使う
 * - 途中の計算は BigInt で行い、合計が上限（ORDER_TOTAL_MAX。DB の int の範囲に収める）を超えたら null
 */
import { calcTax } from "@/lib/tax";

/** 伝票 1 件の合計の上限（10 億円未満。DB の列は int） */
export const ORDER_TOTAL_MAX = 999_999_999;

export interface OrderAmounts {
  subtotal: number;
  tax: number;
  total: number;
}

export interface AmountLine {
  quantity: number;
  unitPrice: number;
}

/** 明細 1 行の金額（数量 × 単価） */
export function lineAmount(line: AmountLine): number {
  return line.quantity * line.unitPrice;
}

/**
 * 明細から小計・税・合計を求める。数量・単価は 0 以上の整数であること（検証済みの値）。
 * 合計が ORDER_TOTAL_MAX を超えるときは null
 */
export function calcOrderAmounts(
  lines: readonly AmountLine[],
): OrderAmounts | null {
  let subtotal = BigInt(0);
  for (const line of lines) {
    if (
      !Number.isSafeInteger(line.quantity) ||
      !Number.isSafeInteger(line.unitPrice) ||
      line.quantity < 0 ||
      line.unitPrice < 0
    ) {
      throw new RangeError(
        `数量・単価は 0 以上の整数で指定してください: ${line.quantity} × ${line.unitPrice}`,
      );
    }
    subtotal += BigInt(line.quantity) * BigInt(line.unitPrice);
  }
  if (subtotal > BigInt(ORDER_TOTAL_MAX)) return null;
  const tax = calcTax(Number(subtotal));
  const total = Number(subtotal) + tax;
  if (total > ORDER_TOTAL_MAX) return null;
  return { subtotal: Number(subtotal), tax, total };
}
