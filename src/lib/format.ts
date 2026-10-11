/** 画面表示の書式（純粋な関数） */

/** 整数を 3 桁区切りで表示する（例 1200 → "1,200"） */
export function formatNumber(value: number): string {
  return value.toLocaleString("ja-JP");
}
