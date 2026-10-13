import { describe, expect, it } from "vitest";

import {
  checkSalesOrderTransition,
  isSalesOrderEditable,
  nextSalesOrderStatuses,
  SALES_ORDER_STATUSES,
  type SalesOrderStatus,
} from "./status";

describe("受注のステータス遷移（spec §4）", () => {
  // 許可される遷移の一覧（これ以外はすべて不可）
  const allowed: [SalesOrderStatus, SalesOrderStatus][] = [
    ["draft", "confirmed"],
    ["draft", "cancelled"],
    ["confirmed", "shipped"],
    ["confirmed", "cancelled"],
  ];

  it("全ての組み合わせで、許可される遷移だけが通る（明細 1 行以上）", () => {
    for (const from of SALES_ORDER_STATUSES) {
      for (const to of SALES_ORDER_STATUSES) {
        const expected = allowed.some(([f, t]) => f === from && t === to);
        expect(
          checkSalesOrderTransition(from, to, 1).ok,
          `${from} → ${to}`,
        ).toBe(expected);
      }
    }
  });

  it("ordered には明細が 1 行以上必要", () => {
    expect(checkSalesOrderTransition("draft", "confirmed", 0)).toEqual({
      ok: false,
      message: "明細が 1 行もないため、確定にできません",
    });
    // 取消は明細がなくてもできる
    expect(checkSalesOrderTransition("draft", "cancelled", 0).ok).toBe(true);
  });

  it("received と cancelled は最終状態（理由のメッセージ）", () => {
    expect(checkSalesOrderTransition("shipped", "cancelled", 1)).toEqual({
      ok: false,
      message: "この受注は「出荷済」のため、ステータスを変更できません",
    });
    expect(checkSalesOrderTransition("cancelled", "confirmed", 1)).toEqual({
      ok: false,
      message: "この受注は「取消」のため、ステータスを変更できません",
    });
    expect(nextSalesOrderStatuses("shipped")).toEqual([]);
    expect(nextSalesOrderStatuses("cancelled")).toEqual([]);
  });

  it("飛び越し・後戻りは不可", () => {
    expect(checkSalesOrderTransition("draft", "shipped", 1)).toEqual({
      ok: false,
      message: "「下書き」から「出荷済」には変更できません",
    });
    expect(checkSalesOrderTransition("confirmed", "draft", 1).ok).toBe(false);
  });

  it("明細の編集は draft のときだけ", () => {
    expect(SALES_ORDER_STATUSES.filter(isSalesOrderEditable)).toEqual([
      "draft",
    ]);
  });
});
