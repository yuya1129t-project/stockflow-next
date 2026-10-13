import { describe, expect, it } from "vitest";

import { orderFieldErrors } from "@/lib/orders/schema";

import {
  checkDueDate,
  emptySalesOrderForm,
  salesOrderInputSchema,
  toSalesOrderFormValues,
} from "./schema";

describe("salesOrderInputSchema（受注の入力）", () => {
  it("検証後は数値・日付・null になる。金額の項目は受け取らない", () => {
    const parsed = salesOrderInputSchema.parse({
      customerId: "3",
      dueDate: "2026-10-20",
      note: "",
      lines: [{ productId: "5", quantity: "10", unitPrice: "120" }],
      // 画面から合計を送っても使わない（スキーマで落とす）
      total: "1",
      subtotal: "1",
    });
    expect(parsed).toEqual({
      customerId: 3,
      dueDate: new Date("2026-10-20T00:00:00Z"),
      note: null,
      lines: [{ productId: 5, quantity: 10, unitPrice: 120 }],
    });
  });

  it("顧客が未選択・明細の誤りは項目ごとのエラー（明細は lines.行.項目）", () => {
    const result = salesOrderInputSchema.safeParse({
      customerId: "",
      dueDate: "",
      note: "",
      lines: [{ productId: "1", quantity: "0", unitPrice: "10" }],
    });
    expect(result.success).toBe(false);
    expect(!result.success && orderFieldErrors(result.error)).toEqual({
      customerId: ["顧客を選択してください"],
      "lines.0.quantity": ["数量は1以上の整数で入力してください"],
    });
  });

  it("新規フォームの初期値は空の明細 1 行。保存済みの値をフォームの値に戻せる", () => {
    expect(emptySalesOrderForm().lines).toHaveLength(1);
    const values = toSalesOrderFormValues({
      customerId: 3,
      dueDate: new Date("2026-10-20T00:00:00Z"),
      note: null,
      lines: [{ productId: 5, quantity: 10, unitPrice: 120 }],
    });
    expect(values).toEqual({
      customerId: "3",
      dueDate: "2026-10-20",
      note: "",
      lines: [{ productId: "5", quantity: "10", unitPrice: "120" }],
    });
    expect(salesOrderInputSchema.parse(values).lines).toEqual([
      { productId: 5, quantity: 10, unitPrice: 120 },
    ]);
  });
});

describe("checkDueDate（納期は受注日以降）", () => {
  const orderDate = new Date("2026-10-13T00:00:00Z");
  it("受注日と同じ日・後の日・未入力は OK、前の日はエラー", () => {
    expect(checkDueDate(orderDate, null)).toBeNull();
    expect(checkDueDate(orderDate, orderDate)).toBeNull();
    expect(
      checkDueDate(orderDate, new Date("2026-10-14T00:00:00Z")),
    ).toBeNull();
    expect(checkDueDate(orderDate, new Date("2026-10-12T00:00:00Z"))).toBe(
      "納期は受注日（2026-10-13）以降の日付にしてください",
    );
  });
});
