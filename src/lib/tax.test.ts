import { describe, expect, it } from "vitest";

import { calcTax } from "@/lib/tax";

describe("calcTax", () => {
  it("小計 0 円なら税額 0 円", () => {
    expect(calcTax(0)).toBe(0);
  });

  it("10 円未満は税額 0 円（切り捨て）", () => {
    expect(calcTax(1)).toBe(0);
    expect(calcTax(9)).toBe(0);
  });

  it("10 円ちょうどで税額 1 円", () => {
    expect(calcTax(10)).toBe(1);
  });

  it("1 円未満は切り捨てる（四捨五入しない）", () => {
    expect(calcTax(19)).toBe(1);
    expect(calcTax(1999)).toBe(199);
  });

  it("割り切れる金額はそのまま 10%", () => {
    expect(calcTax(1000)).toBe(100);
    expect(calcTax(123450)).toBe(12345);
  });

  it("0〜10,000 円の全件で「小計を 10 で割った商」と一致する", () => {
    for (let subtotal = 0; subtotal <= 10000; subtotal++) {
      expect(calcTax(subtotal)).toBe(Math.trunc(subtotal / 10));
    }
  });

  it("負の値・小数は RangeError", () => {
    expect(() => calcTax(-1)).toThrow(RangeError);
    expect(() => calcTax(100.5)).toThrow(RangeError);
    expect(() => calcTax(Number.NaN)).toThrow(RangeError);
  });
});
