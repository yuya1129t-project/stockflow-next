import { describe, expect, it } from "vitest";

import {
  auditActionLabel,
  auditLogDateRange,
  auditTargetPath,
  DEFAULT_AUDIT_LOG_LIST_PARAMS,
  parseAuditLogListParams,
  toAuditLogListQuery,
} from "./search-params";

describe("parseAuditLogListParams", () => {
  it("正しい値はそのまま使う", () => {
    expect(
      parseAuditLogListParams({
        user: "demo_admin",
        action: "role_change",
        targetType: "user",
        from: "2026-10-01",
        to: "2026-10-13",
        page: "3",
      }),
    ).toEqual({
      userId: "demo_admin",
      action: "role_change",
      targetType: "user",
      from: "2026-10-01",
      to: "2026-10-13",
      page: 3,
    });
  });

  it("不正な値は既定値（絞り込みなし）にする", () => {
    expect(
      parseAuditLogListParams({
        user: "a b",
        action: "DROP TABLE",
        targetType: "x".repeat(51),
        from: "2026-02-30",
        to: "yesterday",
        page: "-1",
      }),
    ).toEqual(DEFAULT_AUDIT_LOG_LIST_PARAMS);
  });

  it("クエリ文字列と往復できる（既定値は省く）", () => {
    const params = parseAuditLogListParams(
      new URLSearchParams("action=login&from=2026-10-01&page=2"),
    );
    expect(toAuditLogListQuery(params)).toBe(
      "action=login&from=2026-10-01&page=2",
    );
    expect(toAuditLogListQuery(DEFAULT_AUDIT_LOG_LIST_PARAMS)).toBe("");
  });
});

describe("auditLogDateRange（JST の日付 → 日時の範囲）", () => {
  it("from の JST 0 時以上、to の翌日 JST 0 時未満", () => {
    expect(auditLogDateRange("2026-10-01", "2026-10-13")).toEqual({
      gte: new Date("2026-10-01T00:00:00+09:00"),
      lt: new Date("2026-10-14T00:00:00+09:00"),
    });
    expect(auditLogDateRange("", "")).toEqual({});
  });
});

describe("auditTargetPath（対象へのリンク）", () => {
  it.each([
    ["product", "12", "/products/12"],
    ["partner", "3", "/partners/3"],
    ["sales_order", "40", "/sales-orders/40"],
    ["purchase_order", "7", "/purchase-orders/7"],
    ["user", "demo_admin", "/users/demo_admin"],
  ])("%s #%s → %s", (type, id, path) => {
    expect(auditTargetPath(type, id)).toBe(path);
  });

  it("対象がない・リンクのない種類・不正な ID は null", () => {
    expect(auditTargetPath("product", null)).toBeNull();
    expect(auditTargetPath(null, "1")).toBeNull();
    expect(auditTargetPath("api_token", "1")).toBeNull();
    expect(auditTargetPath("product", "../x")).toBeNull();
  });
});

describe("auditActionLabel", () => {
  it("知らない操作は記録された値をそのまま出す", () => {
    expect(auditActionLabel("token_create")).toBe("API トークン発行");
    expect(auditActionLabel("notify_failed")).toBe("通知の送信失敗");
    expect(auditActionLabel("something_new")).toBe("something_new");
  });
});
