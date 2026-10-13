import { describe, expect, it } from "vitest";

import {
  DEFAULT_PARTNER_LIST_PARAMS,
  parsePartnerListParams,
  toPartnerListQuery,
} from "./search-params";

describe("parsePartnerListParams", () => {
  it("空のクエリは既定値", () => {
    expect(parsePartnerListParams({})).toEqual(DEFAULT_PARTNER_LIST_PARAMS);
  });

  it("正しい値はそのまま使う（検索語は前後の空白を除く）", () => {
    expect(
      parsePartnerListParams(
        new URLSearchParams(
          "q=+デモ+&kind=supplier&status=all&sort=name&order=desc&page=2",
        ),
      ),
    ).toEqual({
      q: "デモ",
      kind: "supplier",
      status: "all",
      sort: "name",
      order: "desc",
      page: 2,
    });
  });

  it("不正な値は既定値に置き換える", () => {
    expect(
      parsePartnerListParams({
        kind: "admin",
        status: "x",
        sort: "email; DROP TABLE",
        order: "up",
        page: "-1",
      }),
    ).toEqual(DEFAULT_PARTNER_LIST_PARAMS);
    expect(parsePartnerListParams({ page: "1.5" }).page).toBe(1);
    expect(parsePartnerListParams({ q: "あ".repeat(150) }).q).toHaveLength(100);
  });

  it("同じキーが複数あれば最初の値", () => {
    expect(parsePartnerListParams({ kind: ["both", "customer"] }).kind).toBe(
      "both",
    );
  });
});

describe("toPartnerListQuery", () => {
  it("既定値の項目は省く", () => {
    expect(toPartnerListQuery({})).toBe("");
    expect(toPartnerListQuery({ page: 1, status: "active" })).toBe("");
  });

  it("指定した条件をクエリにし、parse で同じ条件に戻る", () => {
    const params = {
      q: "サンプル",
      kind: "both" as const,
      status: "inactive" as const,
      sort: "kind" as const,
      order: "asc" as const,
      page: 3,
    };
    const query = toPartnerListQuery(params);
    expect(query).toBe(
      "q=%E3%82%B5%E3%83%B3%E3%83%97%E3%83%AB&kind=both&status=inactive&sort=kind&order=asc&page=3",
    );
    expect(parsePartnerListParams(new URLSearchParams(query))).toEqual(params);
  });
});
