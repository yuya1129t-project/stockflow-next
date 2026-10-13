import { describe, expect, it } from "vitest";

import {
  DEFAULT_SALES_ORDER_LIST_PARAMS,
  parseSalesOrderListParams,
  toSalesOrderListQuery,
} from "./search-params";

describe("parseSalesOrderListParams", () => {
  it("正しい値はそのまま使う", () => {
    expect(
      parseSalesOrderListParams({
        q: " SO-2026 ",
        customer: "3",
        status: "confirmed",
        from: "2026-10-01",
        to: "2026-10-31",
        sort: "total",
        order: "asc",
        page: "2",
      }),
    ).toEqual({
      q: "SO-2026",
      customerId: 3,
      status: "confirmed",
      from: "2026-10-01",
      to: "2026-10-31",
      sort: "total",
      order: "asc",
      page: 2,
    });
  });

  it("不正な値は既定値に置き換える（エラーにしない）", () => {
    expect(
      parseSalesOrderListParams({
        customer: "abc",
        status: "received",
        from: "2026-02-30",
        to: "yesterday",
        sort: "password",
        order: "up",
        page: "-1",
      }),
    ).toEqual(DEFAULT_SALES_ORDER_LIST_PARAMS);
    expect(
      parseSalesOrderListParams(new URLSearchParams("customer=0")).customerId,
    ).toBeNull();
  });

  it("配列で来たら先頭の値を使う", () => {
    expect(
      parseSalesOrderListParams({ status: ["draft", "confirmed"] }).status,
    ).toBe("draft");
  });
});

describe("toSalesOrderListQuery", () => {
  it("既定値の項目は省き、往復で同じ条件に戻る", () => {
    expect(toSalesOrderListQuery({})).toBe("");
    const params = {
      ...DEFAULT_SALES_ORDER_LIST_PARAMS,
      q: "SO",
      customerId: 5,
      status: "shipped" as const,
      from: "2026-10-01",
      to: "2026-10-13",
      sort: "customer" as const,
      page: 3,
    };
    const query = toSalesOrderListQuery(params);
    expect(query).toBe(
      "q=SO&customer=5&status=shipped&from=2026-10-01&to=2026-10-13&sort=customer&order=desc&page=3",
    );
    expect(parseSalesOrderListParams(new URLSearchParams(query))).toEqual(
      params,
    );
  });
});
