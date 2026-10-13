/**
 * 受注・発注の日付（発注日・入荷予定日など、DB では DATE の列）の扱い。純粋なモジュール（クライアントからも import できる）。
 *
 * - 画面・URL では "YYYY-MM-DD" の文字列で受け渡す
 * - DB（@db.Date）には UTC の 0 時の Date で渡す。読み出した値も UTC の 0 時なので、UTC の年月日がその日付
 * - 「今日」は Asia/Tokyo の日付（spec §1）
 */

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 受け付ける年の範囲（入力の誤り・極端な値を弾く） */
export const ORDER_DATE_MIN_YEAR = 2000;
export const ORDER_DATE_MAX_YEAR = 2099;

/** "YYYY-MM-DD" が実在する日付なら、その日の UTC 0 時の Date。そうでなければ null */
export function parseDateOnly(value: string): Date | null {
  const match = DATE_PATTERN.exec(value);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  if (year < ORDER_DATE_MIN_YEAR || year > ORDER_DATE_MAX_YEAR) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  // 2026-02-30 のような存在しない日付は繰り上がるので弾く
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? date
    : null;
}

/** DATE の列の値（UTC 0 時の Date）を "YYYY-MM-DD" にする */
export function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** DATE の列の値を画面に表示する（例 "2026/10/13"） */
export function displayDateOnly(date: Date | null): string {
  return date ? formatDateOnly(date).replaceAll("-", "/") : "—";
}

/** その時刻の Asia/Tokyo の日付（"YYYY-MM-DD"） */
export function todayInTokyo(now: Date = new Date()): string {
  return now.toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
}
