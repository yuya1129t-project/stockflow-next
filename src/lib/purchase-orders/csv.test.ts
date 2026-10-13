import { describe, expect, it } from "vitest";

import { buildPurchaseOrderCsv } from "./csv";
import type { PurchaseOrderListItem } from "./queries";

const order: PurchaseOrderListItem = {
  id: 1,
  number: "PO-20261013-001",
  orderDate: new Date("2026-10-13T00:00:00Z"),
  expectedDate: null,
  status: "ordered",
  subtotal: 1005,
  tax: 100,
  total: 1105,
  note: "=急ぎ, 午前中\n着",
  supplier: { id: 3, code: "S-0001", name: "@サンプル商事" },
  lineCount: 2,
};

describe("buildPurchaseOrderCsv", () => {
  it("見出し行＋1 行 = 発注 1 件。数式になる値は無害化し、改行・カンマを含む値は囲む", () => {
    expect(buildPurchaseOrderCsv([order])).toBe(
      "発注番号,発注日,入荷予定日,仕入先コード,仕入先名,ステータス,明細数,小計,消費税,合計,備考\r\n" +
        `PO-20261013-001,2026-10-13,,S-0001,'@サンプル商事,発注済,2,1005,100,1105,"'=急ぎ, 午前中\n着"\r\n`,
    );
  });

  it("0 件なら見出し行だけ", () => {
    expect(buildPurchaseOrderCsv([])).toBe(
      "発注番号,発注日,入荷予定日,仕入先コード,仕入先名,ステータス,明細数,小計,消費税,合計,備考\r\n",
    );
  });
});
