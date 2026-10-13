/** 画面表示の書式（純粋な関数） */

/** 整数を 3 桁区切りで表示する（例 1200 → "1,200"） */
export function formatNumber(value: number): string {
  return value.toLocaleString("ja-JP");
}

const DATE_TIME_FORMAT = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

/** 日時を Asia/Tokyo で表示する（例 "2026/10/13 09:05"）。docs/spec.md §1 */
export function formatDateTime(value: Date): string {
  return DATE_TIME_FORMAT.format(value);
}

/** 符号付きの数（正は "+" を付ける。例 5 → "+5"、-3 → "-3"） */
export function formatSignedNumber(value: number): string {
  return value > 0 ? `+${formatNumber(value)}` : formatNumber(value);
}
