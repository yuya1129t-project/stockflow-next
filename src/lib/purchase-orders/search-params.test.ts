import { describe, expect, it } from "vitest";

import {
  DEFAULT_PURCHASE_ORDER_LIST_PARAMS,
  parsePurchaseOrderListParams,
  toPurchaseOrderListQuery,
} from "./search-params";

describe("parsePurchaseOrderListParams", () => {
  it("正しい値はそのまま使う", () => {
    expect(
      parsePurchaseOrderListParams({
        q: " PO-2026 ",
        supplier: "3",
        status: "ordered",
        from: "2026-10-01",
        to: "2026-10-31",
        sort: "total",
        order: "asc",
        page: "2",
      }),
    ).toEqual({
      q: "PO-2026",
      supplierId: 3,
      status: "ordered",
      from: "2026-10-01",
      to: "2026-10-31",
      sort: "total",
      order: "asc",
      page: 2,
    });
  });

  it("不正な値は既定値に置き換える（エラーにしない）", () => {
    expect(
      parsePurchaseOrderListParams({
        supplier: "abc",
        status: "shipped",
        from: "2026-02-30",
        to: "yesterday",
        sort: "password",
        order: "up",
        page: "-1",
      }),
    ).toEqual(DEFAULT_PURCHASE_ORDER_LIST_PARAMS);
    expect(
      parsePurchaseOrderListParams(new URLSearchParams("supplier=0"))
        .supplierId,
    ).toBeNull();
  });

  it("配列で来たら先頭の値を使う", () => {
    expect(
      parsePurchaseOrderListParams({ status: ["draft", "ordered"] }).status,
    ).toBe("draft");
  });
});

describe("toPurchaseOrderListQuery", () => {
  it("既定値の項目は省き、往復で同じ条件に戻る", () => {
    expect(toPurchaseOrderListQuery({})).toBe("");
    const params = {
      ...DEFAULT_PURCHASE_ORDER_LIST_PARAMS,
      q: "PO",
      supplierId: 5,
      status: "received" as const,
      from: "2026-10-01",
      to: "2026-10-13",
      sort: "supplier" as const,
      page: 3,
    };
    const query = toPurchaseOrderListQuery(params);
    expect(query).toBe(
      "q=PO&supplier=5&status=received&from=2026-10-01&to=2026-10-13&sort=supplier&order=desc&page=3",
    );
    expect(parsePurchaseOrderListParams(new URLSearchParams(query))).toEqual(
      params,
    );
  });
});
