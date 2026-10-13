import { describe, expect, it } from "vitest";

import type { StockShortage } from "@/lib/stock/rules";

import { shortageMessage, toShortageRows } from "./shortages";

const shortage = (
  code: string,
  available: number,
  required: number,
  unit = "個",
): StockShortage => ({
  productId: Number(code.slice(-1)),
  code,
  name: `商品 ${code}`,
  unit,
  available,
  required,
  shortage: required - available,
});

describe("出荷で在庫が足りないときの表示用データ", () => {
  it("商品ごとに 商品・必要数・現在庫・不足数（単位付き・3 桁区切り）を、商品コードの順に並べる", () => {
    expect(
      toShortageRows([
        shortage("P-0002", 3, 1200, "箱"),
        shortage("P-0001", 0, 5),
      ]),
    ).toEqual([
      {
        productId: 1,
        product: "P-0001 商品 P-0001",
        required: "5 個",
        available: "0 個",
        shortage: "5 個",
      },
      {
        productId: 2,
        product: "P-0002 商品 P-0002",
        required: "1,200 箱",
        available: "3 箱",
        shortage: "1,197 箱",
      },
    ]);
  });

  it("メッセージに品目数と、何も変えていないことを含める", () => {
    expect(shortageMessage([shortage("P-0001", 1, 2)])).toBe(
      "在庫が足りない商品が 1 品目あるため、出荷しませんでした（在庫・ステータスは変わっていません）",
    );
  });

  it("不足がなければ行は空", () => {
    expect(toShortageRows([])).toEqual([]);
  });
});
