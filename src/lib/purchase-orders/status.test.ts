import { describe, expect, it } from "vitest";

import {
  checkPurchaseOrderTransition,
  isPurchaseOrderEditable,
  nextPurchaseOrderStatuses,
  PURCHASE_ORDER_STATUSES,
  type PurchaseOrderStatus,
} from "./status";

describe("発注のステータス遷移（spec §4）", () => {
  // 許可される遷移の一覧（これ以外はすべて不可）
  const allowed: [PurchaseOrderStatus, PurchaseOrderStatus][] = [
    ["draft", "ordered"],
    ["draft", "cancelled"],
    ["ordered", "received"],
    ["ordered", "cancelled"],
  ];

  it("全ての組み合わせで、許可される遷移だけが通る（明細 1 行以上）", () => {
    for (const from of PURCHASE_ORDER_STATUSES) {
      for (const to of PURCHASE_ORDER_STATUSES) {
        const expected = allowed.some(([f, t]) => f === from && t === to);
        expect(
          checkPurchaseOrderTransition(from, to, 1).ok,
          `${from} → ${to}`,
        ).toBe(expected);
      }
    }
  });

  it("ordered には明細が 1 行以上必要", () => {
    expect(checkPurchaseOrderTransition("draft", "ordered", 0)).toEqual({
      ok: false,
      message: "明細が 1 行もないため、発注済にできません",
    });
    // 取消は明細がなくてもできる
    expect(checkPurchaseOrderTransition("draft", "cancelled", 0).ok).toBe(true);
  });

  it("received と cancelled は最終状態（理由のメッセージ）", () => {
    expect(checkPurchaseOrderTransition("received", "cancelled", 1)).toEqual({
      ok: false,
      message: "この発注は「入荷済」のため、ステータスを変更できません",
    });
    expect(checkPurchaseOrderTransition("cancelled", "ordered", 1)).toEqual({
      ok: false,
      message: "この発注は「取消」のため、ステータスを変更できません",
    });
    expect(nextPurchaseOrderStatuses("received")).toEqual([]);
    expect(nextPurchaseOrderStatuses("cancelled")).toEqual([]);
  });

  it("飛び越し・後戻りは不可", () => {
    expect(checkPurchaseOrderTransition("draft", "received", 1)).toEqual({
      ok: false,
      message: "「下書き」から「入荷済」には変更できません",
    });
    expect(checkPurchaseOrderTransition("ordered", "draft", 1).ok).toBe(false);
  });

  it("明細の編集は draft のときだけ", () => {
    expect(PURCHASE_ORDER_STATUSES.filter(isPurchaseOrderEditable)).toEqual([
      "draft",
    ]);
  });
});
