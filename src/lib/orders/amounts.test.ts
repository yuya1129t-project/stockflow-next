import { describe, expect, it } from "vitest";

import { calcOrderAmounts, lineAmount, ORDER_TOTAL_MAX } from "./amounts";

describe("lineAmount（明細 1 行の金額）", () => {
  it("数量 × 単価", () => {
    expect(lineAmount({ quantity: 3, unitPrice: 120 })).toBe(360);
    expect(lineAmount({ quantity: 5, unitPrice: 0 })).toBe(0);
  });
});

describe("calcOrderAmounts（小計・税・合計）", () => {
  it("小計 = Σ 数量 × 単価、税は小計の 10% を 1 件ごとに切り捨て、合計 = 小計 + 税", () => {
    expect(
      calcOrderAmounts([
        { quantity: 3, unitPrice: 333 }, // 999
        { quantity: 1, unitPrice: 6 }, // 6
      ]),
    ).toEqual({ subtotal: 1005, tax: 100, total: 1105 });
  });

  it("税は明細ごとではなく伝票の小計に対して切り捨てる（行ごとに切り捨てると 0 円になる例）", () => {
    // 各行 9 円 → 行ごとの税は 0.9 円で切り捨てると 0 円。小計 18 円 → 1.8 円 → 1 円
    expect(
      calcOrderAmounts([
        { quantity: 1, unitPrice: 9 },
        { quantity: 1, unitPrice: 9 },
      ]),
    ).toEqual({ subtotal: 18, tax: 1, total: 19 });
  });

  it("明細がなければ 0 円", () => {
    expect(calcOrderAmounts([])).toEqual({ subtotal: 0, tax: 0, total: 0 });
  });

  it("合計が上限ちょうどまでは計算し、超えたら null", () => {
    // 小計 909,090,909 → 税 90,909,090 → 合計 999,999,999
    expect(calcOrderAmounts([{ quantity: 1, unitPrice: 909_090_909 }])).toEqual(
      { subtotal: 909_090_909, tax: 90_909_090, total: ORDER_TOTAL_MAX },
    );
    expect(
      calcOrderAmounts([{ quantity: 1, unitPrice: 909_090_910 }]),
    ).toBeNull();
  });

  it("途中の計算が Number の安全な範囲を超えても誤差なく上限超過と判定する", () => {
    const huge = Array.from({ length: 100 }, () => ({
      quantity: 9_999_999,
      unitPrice: 99_999_999,
    }));
    expect(calcOrderAmounts(huge)).toBeNull();
  });

  it("数量・単価が負・小数ならプログラムの誤りとして例外", () => {
    expect(() => calcOrderAmounts([{ quantity: -1, unitPrice: 10 }])).toThrow(
      RangeError,
    );
    expect(() => calcOrderAmounts([{ quantity: 1, unitPrice: 1.5 }])).toThrow(
      RangeError,
    );
  });
});
