/** 消費税率（%）。docs/spec.md §1 */
export const TAX_RATE_PERCENT = 10;

/**
 * 受注・発注 1 件の小計から消費税額を求める（1 円未満は切り捨て）。
 *
 * 小計は円の整数（0 以上）。整数演算（小計 × 10 ÷ 100 を切り捨て）で計算する。
 */
export function calcTax(subtotal: number): number {
  if (!Number.isSafeInteger(subtotal) || subtotal < 0) {
    throw new RangeError(`小計は 0 以上の整数で指定してください: ${subtotal}`);
  }
  return Math.floor((subtotal * TAX_RATE_PERCENT) / 100);
}
