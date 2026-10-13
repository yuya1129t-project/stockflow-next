import { describe, expect, it } from "vitest";

import {
  stockAdjustFieldErrors,
  stockAdjustSchema,
  type StockAdjustFormValues,
} from "./schema";

const VALID: StockAdjustFormValues = {
  actualQuantity: "12",
  reason: "定期棚卸",
};

function errorsOf(values: Partial<StockAdjustFormValues>) {
  const result = stockAdjustSchema.safeParse({ ...VALID, ...values });
  if (result.success) throw new Error("検証が通ってしまいました");
  return stockAdjustFieldErrors(result.error);
}

describe("stockAdjustSchema（棚卸調整の入力）", () => {
  it("実数は数値に、理由は前後の空白を除いて受け付ける", () => {
    expect(
      stockAdjustSchema.parse({
        actualQuantity: " 12 ",
        reason: "  定期棚卸 ",
      }),
    ).toEqual({ actualQuantity: 12, reason: "定期棚卸" });
  });

  it("実数は 0 を受け付ける（在庫をすべて失った場合）", () => {
    expect(stockAdjustSchema.parse({ ...VALID, actualQuantity: "0" })).toEqual({
      actualQuantity: 0,
      reason: "定期棚卸",
    });
  });

  it("全角数字・3 桁区切りのカンマを受け付ける", () => {
    expect(
      stockAdjustSchema.parse({ ...VALID, actualQuantity: "１２" })
        .actualQuantity,
    ).toBe(12);
    expect(
      stockAdjustSchema.parse({ ...VALID, actualQuantity: "1,200" })
        .actualQuantity,
    ).toBe(1200);
  });

  it("実数は必須で、0 以上の整数・上限以下", () => {
    expect(errorsOf({ actualQuantity: "" }).actualQuantity).toEqual([
      "実数を入力してください",
    ]);
    expect(errorsOf({ actualQuantity: "-1" }).actualQuantity).toEqual([
      "実数は0以上の整数で入力してください",
    ]);
    expect(errorsOf({ actualQuantity: "1.5" }).actualQuantity).toEqual([
      "実数は0以上の整数で入力してください",
    ]);
    expect(errorsOf({ actualQuantity: "abc" }).actualQuantity).toEqual([
      "実数は0以上の整数で入力してください",
    ]);
    expect(errorsOf({ actualQuantity: "10000000" }).actualQuantity).toEqual([
      "実数は9,999,999以下で入力してください",
    ]);
  });

  it("理由は必須（空白だけも不可）・200 文字以内・制御文字は不可", () => {
    expect(errorsOf({ reason: "" }).reason).toEqual(["理由を入力してください"]);
    expect(errorsOf({ reason: "   " }).reason).toEqual([
      "理由を入力してください",
    ]);
    expect(errorsOf({ reason: "あ".repeat(201) }).reason).toEqual([
      "理由は200文字以内で入力してください",
    ]);
    expect(
      stockAdjustSchema.safeParse({ ...VALID, reason: "あ".repeat(200) })
        .success,
    ).toBe(true);
    expect(errorsOf({ reason: "破損\n廃棄" }).reason).toEqual([
      "理由に改行・タブなどの制御文字は使えません",
    ]);
    expect(errorsOf({ reason: "破損\u2028廃棄" }).reason).toEqual([
      "理由に改行・タブなどの制御文字は使えません",
    ]);
  });

  it("文字列以外は受け付けない", () => {
    expect(
      stockAdjustSchema.safeParse({ actualQuantity: 12, reason: "x" }).success,
    ).toBe(false);
    expect(stockAdjustSchema.safeParse({}).success).toBe(false);
  });
});
