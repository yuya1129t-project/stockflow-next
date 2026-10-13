import { describe, expect, it } from "vitest";

import { parseStockListParams, toStockListQuery } from "./search-params";

describe("在庫一覧の検索条件（URL のクエリ）", () => {
  it("既定は全件・有効のみ・商品コード順", () => {
    expect(parseStockListParams({})).toEqual({
      q: "",
      category: "",
      status: "active",
      sort: "code",
      order: "asc",
      page: 1,
      level: "all",
    });
  });

  it("level=low で発注点割れのみ。不正な値は既定に戻す", () => {
    expect(parseStockListParams({ level: "low" }).level).toBe("low");
    expect(parseStockListParams({ level: "LOW" }).level).toBe("all");
    expect(parseStockListParams({ level: ["low", "all"] }).level).toBe("low");
  });

  it("商品一覧と同じ項目（検索語・並べ替え・ページ）を解釈する", () => {
    const params = parseStockListParams(
      new URLSearchParams("q=ペン&sort=stock&order=desc&page=3&level=low"),
    );
    expect(params).toMatchObject({
      q: "ペン",
      sort: "stock",
      order: "desc",
      page: 3,
      level: "low",
    });
  });

  it("URL のクエリに戻せる（既定値は省く）", () => {
    expect(toStockListQuery({})).toBe("");
    expect(toStockListQuery({ level: "all", page: 1 })).toBe("");
    const query = toStockListQuery({ level: "low", sort: "stock", page: 2 });
    expect(parseStockListParams(new URLSearchParams(query))).toMatchObject({
      level: "low",
      sort: "stock",
      order: "asc",
      page: 2,
    });
  });
});
