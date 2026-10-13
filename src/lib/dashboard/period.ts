/**
 * ダッシュボードの期間と前月比（純粋な関数）。docs/spec.md §1・§5-2
 *
 * - 「今月」「今日」は Asia/Tokyo の暦で決める（サーバーの TZ によらない）
 * - 受注日（orderDate）・納期（dueDate）・入荷予定日（expectedDate）は DB の date 型。
 *   比較の値は日付の文字列（YYYY-MM-DD）で持ち、SQL では ::date にキャストして渡す
 *   （Date を渡すと timestamptz として送られ、DB セッションの TimeZone 次第で 1 日ずれ得るため）
 *
 * DB やフレームワークに依存しない
 */

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 暦月（month は 1〜12） */
export interface YearMonth {
  year: number;
  month: number;
}

/** 暦月の範囲。start 以上 end 未満（どちらも YYYY-MM-DD。end は翌月 1 日） */
export interface MonthRange extends YearMonth {
  /** "YYYY-MM"（集計結果と突き合わせるキー） */
  key: string;
  start: string;
  end: string;
}

/** 日時を JST の暦日（YYYY-MM-DD）にする */
export function jstDateString(now: Date): string {
  return new Date(now.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 日時が属する JST の暦月 */
export function jstYearMonth(now: Date): YearMonth {
  const ymd = jstDateString(now);
  return { year: Number(ymd.slice(0, 4)), month: Number(ymd.slice(5, 7)) };
}

/** 暦月を n か月ずらす（n は負でもよい。年をまたぐ） */
export function addMonths({ year, month }: YearMonth, n: number): YearMonth {
  const index = year * 12 + (month - 1) + n;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** "YYYY-MM" */
export function monthKey({ year, month }: YearMonth): string {
  return `${String(year).padStart(4, "0")}-${pad2(month)}`;
}

/** 暦月の範囲（1 日 〜 翌月 1 日の前日） */
export function monthRange(ym: YearMonth): MonthRange {
  const key = monthKey(ym);
  return {
    ...ym,
    key,
    start: `${key}-01`,
    end: `${monthKey(addMonths(ym, 1))}-01`,
  };
}

/** 今月を最後にした直近 count か月（古い順） */
export function recentMonthRanges(now: Date, count: number): MonthRange[] {
  const current = jstYearMonth(now);
  return Array.from({ length: count }, (_, i) =>
    monthRange(addMonths(current, i - (count - 1))),
  );
}

/** 前月比 */
export interface MonthOverMonth {
  /** 今月 − 前月 */
  diff: number;
  /** 増減率（%。0.1 は 0.1%）。前月が 0 のときは計算できないので null */
  rate: number | null;
}

export function monthOverMonth(
  current: number,
  previous: number,
): MonthOverMonth {
  const diff = current - previous;
  return {
    diff,
    rate: previous === 0 ? null : (diff / previous) * 100,
  };
}
