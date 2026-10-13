import { describe, expect, it } from "vitest";

import {
  displayDateOnly,
  formatDateOnly,
  parseDateOnly,
  todayInTokyo,
} from "./dates";

describe("parseDateOnly", () => {
  it("YYYY-MM-DD を UTC 0 時の Date にする", () => {
    expect(parseDateOnly("2026-10-13")?.toISOString()).toBe(
      "2026-10-13T00:00:00.000Z",
    );
    expect(parseDateOnly("2028-02-29")?.toISOString()).toBe(
      "2028-02-29T00:00:00.000Z",
    );
  });

  it("存在しない日付・形式違い・範囲外は null", () => {
    for (const value of [
      "2026-02-29",
      "2026-13-01",
      "2026-10-32",
      "2026/10/13",
      "20261013",
      "2026-1-1",
      "",
      "1999-12-31",
      "2100-01-01",
    ]) {
      expect(parseDateOnly(value), value).toBeNull();
    }
  });
});

describe("formatDateOnly・displayDateOnly", () => {
  it("DATE の列の値を文字列にする", () => {
    const date = new Date("2026-10-13T00:00:00Z");
    expect(formatDateOnly(date)).toBe("2026-10-13");
    expect(displayDateOnly(date)).toBe("2026/10/13");
    expect(displayDateOnly(null)).toBe("—");
  });
});

describe("todayInTokyo", () => {
  it("Asia/Tokyo の日付（UTC では前日の 15 時以降は翌日）", () => {
    expect(todayInTokyo(new Date("2026-10-12T14:59:59Z"))).toBe("2026-10-12");
    expect(todayInTokyo(new Date("2026-10-12T15:00:00Z"))).toBe("2026-10-13");
  });
});
