import { describe, expect, it } from "vitest";

import { formatDateTime, formatNumber, formatSignedNumber } from "./format";

describe("表示の書式", () => {
  it("3 桁区切り", () => {
    expect(formatNumber(1200)).toBe("1,200");
  });

  it("符号付きの数（正は + を付ける）", () => {
    expect(formatSignedNumber(1200)).toBe("+1,200");
    expect(formatSignedNumber(-3)).toBe("-3");
    expect(formatSignedNumber(0)).toBe("0");
  });

  it("日時は Asia/Tokyo で表示する", () => {
    expect(formatDateTime(new Date("2026-10-12T15:05:00Z"))).toBe(
      "2026/10/13 00:05",
    );
  });
});
