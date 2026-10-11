import { describe, expect, it } from "vitest";

import {
  DEFAULT_PRODUCT_LIST_PARAMS,
  parseProductListParams,
  toProductListQuery,
} from "./search-params";

describe("parseProductListParams", () => {
  it("空なら既定値", () => {
    expect(parseProductListParams({})).toEqual(DEFAULT_PRODUCT_LIST_PARAMS);
  });

  it("Next.js の searchParams と URLSearchParams の両方を受け付ける", () => {
    const expected = {
      q: "ペン",
      category: "文具",
      status: "all",
      sort: "stock",
      order: "desc",
      page: 3,
    };
    expect(
      parseProductListParams({
        q: " ペン ",
        category: "文具",
        status: "all",
        sort: "stock",
        order: "desc",
        page: "3",
      }),
    ).toEqual(expected);
    expect(
      parseProductListParams(
        new URLSearchParams(
          "q=%E3%83%9A%E3%83%B3&category=%E6%96%87%E5%85%B7&status=all&sort=stock&order=desc&page=3",
        ),
      ),
    ).toEqual(expected);
  });

  it("不正な値は既定値に置き換える（並べ替えの列はホワイトリスト）", () => {
    expect(
      parseProductListParams({
        status: "deleted",
        sort: 'name"; DROP TABLE product; --',
        order: "sideways",
        page: "-2",
      }),
    ).toEqual(DEFAULT_PRODUCT_LIST_PARAMS);
    expect(parseProductListParams({ page: "1.5" }).page).toBe(1);
    expect(parseProductListParams({ page: "abc" }).page).toBe(1);
  });

  it("同じキーが複数あれば最初の値を使い、長すぎる検索語は切り詰める", () => {
    expect(parseProductListParams({ q: ["a", "b"] }).q).toBe("a");
    expect(parseProductListParams({ q: "x".repeat(300) }).q).toHaveLength(100);
  });
});

describe("toProductListQuery", () => {
  it("既定値の項目は省く", () => {
    expect(toProductListQuery(DEFAULT_PRODUCT_LIST_PARAMS)).toBe("");
  });

  it("parse と往復できる", () => {
    const params = {
      q: "A&B",
      category: "飲料・食品",
      status: "inactive" as const,
      sort: "name" as const,
      order: "desc" as const,
      page: 2,
    };
    expect(
      parseProductListParams(new URLSearchParams(toProductListQuery(params))),
    ).toEqual(params);
  });
});
