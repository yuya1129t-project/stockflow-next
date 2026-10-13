import { describe, expect, it } from "vitest";

import { orderFieldErrors } from "@/lib/orders/schema";

import {
  checkExpectedDate,
  emptyPurchaseOrderForm,
  purchaseOrderInputSchema,
  toPurchaseOrderFormValues,
} from "./schema";

describe("purchaseOrderInputSchema（発注の入力）", () => {
  it("検証後は数値・日付・null になる。金額の項目は受け取らない", () => {
    const parsed = purchaseOrderInputSchema.parse({
      supplierId: "3",
      expectedDate: "2026-10-20",
      note: "",
      lines: [{ productId: "5", quantity: "10", unitPrice: "120" }],
      // 画面から合計を送っても使わない（スキーマで落とす）
      total: "1",
      subtotal: "1",
    });
    expect(parsed).toEqual({
      supplierId: 3,
      expectedDate: new Date("2026-10-20T00:00:00Z"),
      note: null,
      lines: [{ productId: 5, quantity: 10, unitPrice: 120 }],
    });
  });

  it("仕入先が未選択・明細の誤りは項目ごとのエラー（明細は lines.行.項目）", () => {
    const result = purchaseOrderInputSchema.safeParse({
      supplierId: "",
      expectedDate: "",
      note: "",
      lines: [{ productId: "1", quantity: "0", unitPrice: "10" }],
    });
    expect(result.success).toBe(false);
    expect(!result.success && orderFieldErrors(result.error)).toEqual({
      supplierId: ["仕入先を選択してください"],
      "lines.0.quantity": ["数量は1以上の整数で入力してください"],
    });
  });

  it("新規フォームの初期値は空の明細 1 行。保存済みの値をフォームの値に戻せる", () => {
    expect(emptyPurchaseOrderForm().lines).toHaveLength(1);
    const values = toPurchaseOrderFormValues({
      supplierId: 3,
      expectedDate: new Date("2026-10-20T00:00:00Z"),
      note: null,
      lines: [{ productId: 5, quantity: 10, unitPrice: 120 }],
    });
    expect(values).toEqual({
      supplierId: "3",
      expectedDate: "2026-10-20",
      note: "",
      lines: [{ productId: "5", quantity: "10", unitPrice: "120" }],
    });
    expect(purchaseOrderInputSchema.parse(values).lines).toEqual([
      { productId: 5, quantity: 10, unitPrice: 120 },
    ]);
  });
});

describe("checkExpectedDate（入荷予定日は発注日以降）", () => {
  const orderDate = new Date("2026-10-13T00:00:00Z");
  it("発注日と同じ日・後の日・未入力は OK、前の日はエラー", () => {
    expect(checkExpectedDate(orderDate, null)).toBeNull();
    expect(checkExpectedDate(orderDate, orderDate)).toBeNull();
    expect(
      checkExpectedDate(orderDate, new Date("2026-10-14T00:00:00Z")),
    ).toBeNull();
    expect(checkExpectedDate(orderDate, new Date("2026-10-12T00:00:00Z"))).toBe(
      "入荷予定日は発注日（2026-10-13）以降の日付にしてください",
    );
  });
});
