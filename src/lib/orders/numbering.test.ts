import { describe, expect, it } from "vitest";

import { formatDocumentNumber } from "./numbering";

describe("formatDocumentNumber（伝票番号の書式）", () => {
  it("種別-YYYYMMDD-NNN（連番は 3 桁にゼロ埋め）", () => {
    expect(formatDocumentNumber("PO", "2026-10-13", 1)).toBe("PO-20261013-001");
    expect(formatDocumentNumber("SO", "2026-01-05", 42)).toBe(
      "SO-20260105-042",
    );
    expect(formatDocumentNumber("PO", "2026-10-13", 999)).toBe(
      "PO-20261013-999",
    );
  });

  it("1 日に 999 件を超えたら桁を増やす（エラーにしない）", () => {
    expect(formatDocumentNumber("PO", "2026-10-13", 1000)).toBe(
      "PO-20261013-1000",
    );
  });

  it("日付・連番の形式が違えばプログラムの誤りとして例外", () => {
    expect(() => formatDocumentNumber("PO", "20261013", 1)).toThrow(RangeError);
    expect(() => formatDocumentNumber("PO", "2026-10-13", 0)).toThrow(
      RangeError,
    );
    expect(() => formatDocumentNumber("PO", "2026-10-13", 1.5)).toThrow(
      RangeError,
    );
  });
});
