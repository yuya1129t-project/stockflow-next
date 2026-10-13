import { describe, expect, it } from "vitest";

import { buildSalesOrderCsv } from "./csv";
import type { SalesOrderListItem } from "./queries";

const order: SalesOrderListItem = {
  id: 1,
  number: "SO-20261013-001",
  orderDate: new Date("2026-10-13T00:00:00Z"),
  dueDate: null,
  status: "confirmed",
  subtotal: 1005,
  tax: 100,
  total: 1105,
  note: "=急ぎ, 午前中\n着",
  customer: { id: 3, code: "C-0001", name: "@サンプル商事" },
  lineCount: 2,
};

describe("buildSalesOrderCsv", () => {
  it("見出し行＋1 行 = 受注 1 件。数式になる値は無害化し、改行・カンマを含む値は囲む", () => {
    expect(buildSalesOrderCsv([order])).toBe(
      "受注番号,受注日,納期,顧客コード,顧客名,ステータス,明細数,小計,消費税,合計,備考\r\n" +
        `SO-20261013-001,2026-10-13,,C-0001,'@サンプル商事,確定,2,1005,100,1105,"'=急ぎ, 午前中\n着"\r\n`,
    );
  });

  it("0 件なら見出し行だけ", () => {
    expect(buildSalesOrderCsv([])).toBe(
      "受注番号,受注日,納期,顧客コード,顧客名,ステータス,明細数,小計,消費税,合計,備考\r\n",
    );
  });
});
