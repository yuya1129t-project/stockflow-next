import { describe, expect, it } from "vitest";

import {
  addMonths,
  jstDateString,
  jstYearMonth,
  monthOverMonth,
  monthRange,
  recentMonthRanges,
} from "./period";

describe("JST の暦日・暦月", () => {
  it("UTC では前日でも JST の日付になる（0 時〜9 時の境界）", () => {
    // 2026-10-31T15:00Z = JST 11/1 0:00
    expect(jstDateString(new Date("2026-10-31T15:00:00Z"))).toBe("2026-11-01");
    expect(jstYearMonth(new Date("2026-10-31T15:00:00Z"))).toEqual({
      year: 2026,
      month: 11,
    });
    // 1 ミリ秒前は JST でも 10/31
    expect(jstDateString(new Date("2026-10-31T14:59:59.999Z"))).toBe(
      "2026-10-31",
    );
  });

  it("年またぎ（UTC 12/31 15:00 = JST 1/1 0:00）", () => {
    expect(jstYearMonth(new Date("2026-12-31T15:00:00Z"))).toEqual({
      year: 2027,
      month: 1,
    });
    expect(jstYearMonth(new Date("2026-12-31T14:59:59Z"))).toEqual({
      year: 2026,
      month: 12,
    });
  });
});

describe("月の範囲", () => {
  it("1 日から翌月 1 日まで（翌月 1 日は含まない）", () => {
    expect(monthRange({ year: 2026, month: 10 })).toEqual({
      year: 2026,
      month: 10,
      key: "2026-10",
      start: "2026-10-01",
      end: "2026-11-01",
    });
  });

  it("12 月の終わりは翌年 1 月 1 日", () => {
    const range = monthRange({ year: 2026, month: 12 });
    expect(range.start).toBe("2026-12-01");
    expect(range.end).toBe("2027-01-01");
  });

  it("2 月（うるう年も月末の日付を持たないので同じ扱い）", () => {
    expect(monthRange({ year: 2028, month: 2 }).end).toBe("2028-03-01");
    expect(monthRange({ year: 2027, month: 2 }).end).toBe("2027-03-01");
  });

  it("月をずらす（年をまたぐ・負の数）", () => {
    expect(addMonths({ year: 2027, month: 1 }, -1)).toEqual({
      year: 2026,
      month: 12,
    });
    expect(addMonths({ year: 2026, month: 3 }, -5)).toEqual({
      year: 2025,
      month: 10,
    });
    expect(addMonths({ year: 2026, month: 12 }, 1)).toEqual({
      year: 2027,
      month: 1,
    });
    expect(addMonths({ year: 2026, month: 5 }, -17)).toEqual({
      year: 2024,
      month: 12,
    });
  });

  it("直近 6 か月（古い順。最後が JST の今月）", () => {
    // UTC ではまだ 2026-12-31 だが JST では 2027-01-01
    const months = recentMonthRanges(new Date("2026-12-31T15:30:00Z"), 6);
    expect(months.map((m) => m.key)).toEqual([
      "2026-08",
      "2026-09",
      "2026-10",
      "2026-11",
      "2026-12",
      "2027-01",
    ]);
    expect(months[0].start).toBe("2026-08-01");
    expect(months[5].end).toBe("2027-02-01");
  });
});

describe("前月比", () => {
  it("増加・減少・同じ", () => {
    expect(monthOverMonth(1500, 1000)).toEqual({ diff: 500, rate: 50 });
    expect(monthOverMonth(750, 1000)).toEqual({ diff: -250, rate: -25 });
    expect(monthOverMonth(1000, 1000)).toEqual({ diff: 0, rate: 0 });
    expect(monthOverMonth(0, 1000)).toEqual({ diff: -1000, rate: -100 });
  });

  it("前月が 0 なら増減率は出さない（null）", () => {
    expect(monthOverMonth(1200, 0)).toEqual({ diff: 1200, rate: null });
    expect(monthOverMonth(0, 0)).toEqual({ diff: 0, rate: null });
  });
});
