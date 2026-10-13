import { describe, expect, it } from "vitest";

import {
  adjustmentDelta,
  InsufficientStockError,
  isBelowReorderPoint,
  isValidMovementQuantity,
  planStockMovements,
  type StockProductState,
} from "./rules";

function product(
  id: number,
  stock: number,
  overrides: Partial<StockProductState> = {},
): StockProductState {
  return {
    id,
    code: `P-${String(id).padStart(4, "0")}`,
    name: `商品 ${id}`,
    unit: "個",
    reorderPoint: 5,
    isActive: true,
    stock,
    ...overrides,
  };
}

describe("adjustmentDelta（棚卸調整の差分）", () => {
  it("実数 − 現在庫", () => {
    expect(adjustmentDelta(10, 8)).toBe(-2);
    expect(adjustmentDelta(10, 13)).toBe(3);
    expect(adjustmentDelta(0, 0)).toBe(0);
    expect(adjustmentDelta(7, 0)).toBe(-7);
  });
});

describe("isValidMovementQuantity（数量の符号）", () => {
  it("in は正、out は負、adjust は 0 以外の整数", () => {
    expect(isValidMovementQuantity("in", 1)).toBe(true);
    expect(isValidMovementQuantity("in", 0)).toBe(false);
    expect(isValidMovementQuantity("in", -1)).toBe(false);
    expect(isValidMovementQuantity("out", -1)).toBe(true);
    expect(isValidMovementQuantity("out", 1)).toBe(false);
    expect(isValidMovementQuantity("adjust", -3)).toBe(true);
    expect(isValidMovementQuantity("adjust", 3)).toBe(true);
    expect(isValidMovementQuantity("adjust", 0)).toBe(false);
    expect(isValidMovementQuantity("in", 1.5)).toBe(false);
    expect(isValidMovementQuantity("in", Number.NaN)).toBe(false);
  });
});

describe("isBelowReorderPoint（発注点割れ）", () => {
  it("有効な商品で 現在庫 < 発注点。発注点ちょうどは割れていない。無効な商品は対象外", () => {
    expect(isBelowReorderPoint({ isActive: true, reorderPoint: 5 }, 4)).toBe(
      true,
    );
    expect(isBelowReorderPoint({ isActive: true, reorderPoint: 5 }, 5)).toBe(
      false,
    );
    expect(isBelowReorderPoint({ isActive: false, reorderPoint: 5 }, 0)).toBe(
      false,
    );
    expect(isBelowReorderPoint({ isActive: true, reorderPoint: 0 }, 0)).toBe(
      false,
    );
  });
});

describe("planStockMovements", () => {
  it("記録の前後の在庫を商品 ID の順に返す（同じ商品は合計する）", () => {
    const plan = planStockMovements(
      [product(2, 10), product(1, 20)],
      [
        { productId: 2, type: "out", quantity: -3 },
        { productId: 1, type: "in", quantity: 5 },
        { productId: 2, type: "out", quantity: -1 },
      ],
    );
    expect(plan).toEqual({
      ok: true,
      changes: [
        { productId: 1, before: 20, after: 25 },
        { productId: 2, before: 10, after: 6 },
      ],
      fellBelowReorderPoint: [],
    });
  });

  it("在庫がちょうど 0 になるのは記録できる", () => {
    const plan = planStockMovements(
      [product(1, 3)],
      [{ productId: 1, type: "out", quantity: -3 }],
    );
    expect(plan.ok).toBe(true);
  });

  it("1 商品でも在庫が負になるなら、不足する商品と数量を返す（合計で判定する）", () => {
    const plan = planStockMovements(
      [product(1, 10), product(2, 4), product(3, 1)],
      [
        { productId: 1, type: "out", quantity: -5 },
        { productId: 2, type: "out", quantity: -3 },
        { productId: 2, type: "out", quantity: -3 },
        { productId: 3, type: "out", quantity: -2 },
      ],
    );
    expect(plan).toEqual({
      ok: false,
      shortages: [
        {
          productId: 2,
          code: "P-0002",
          name: "商品 2",
          unit: "個",
          available: 4,
          required: 6,
          shortage: 2,
        },
        {
          productId: 3,
          code: "P-0003",
          name: "商品 3",
          unit: "個",
          available: 1,
          required: 2,
          shortage: 1,
        },
      ],
    });
  });

  it("発注点以上 → 発注点未満に変わった有効な商品だけを返す", () => {
    const plan = planStockMovements(
      [
        product(1, 6), // 6 → 4: 割れた
        product(2, 6), // 6 → 5: 発注点ちょうど（割れていない）
        product(3, 4), // 4 → 3: もともと割れている
        product(4, 6, { isActive: false }), // 無効な商品は対象外
        product(5, 3), // 3 → 8: 回復
      ],
      [
        { productId: 1, type: "out", quantity: -2 },
        { productId: 2, type: "out", quantity: -1 },
        { productId: 3, type: "out", quantity: -1 },
        { productId: 4, type: "out", quantity: -5 },
        { productId: 5, type: "in", quantity: 5 },
      ],
    );
    expect(plan.ok && plan.fellBelowReorderPoint).toEqual([
      {
        productId: 1,
        code: "P-0001",
        name: "商品 1",
        unit: "個",
        reorderPoint: 5,
        before: 6,
        after: 4,
      },
    ]);
  });

  it("読んでいない商品を指定したらプログラムの誤りとして例外", () => {
    expect(() =>
      planStockMovements(
        [product(1, 1)],
        [{ productId: 2, type: "in", quantity: 1 }],
      ),
    ).toThrow();
  });
});

describe("InsufficientStockError", () => {
  it("不足の内容を持ち、メッセージに商品と数量を含む", () => {
    const error = new InsufficientStockError([
      {
        productId: 1,
        code: "P-0001",
        name: "ボールペン",
        unit: "本",
        available: 2,
        required: 5,
        shortage: 3,
      },
    ]);
    expect(error).toBeInstanceOf(Error);
    expect(error.shortages).toHaveLength(1);
    expect(error.message).toContain("P-0001「ボールペン」");
    expect(error.message).toContain("不足 3本");
  });
});
