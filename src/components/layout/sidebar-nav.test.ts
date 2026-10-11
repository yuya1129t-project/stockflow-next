import { describe, expect, it } from "vitest";

import { isNavItemActive } from "./sidebar-nav";

describe("isNavItemActive（サイドバーの強調）", () => {
  it("配下の画面でも強調する", () => {
    expect(isNavItemActive("/products", "/products")).toBe(true);
    expect(isNavItemActive("/products/123", "/products")).toBe(true);
    expect(isNavItemActive("/products/123/edit", "/products")).toBe(true);
  });

  it("名前が前方一致するだけの別の画面・トップは対象外", () => {
    expect(isNavItemActive("/products-x", "/products")).toBe(false);
    expect(isNavItemActive("/products", "/")).toBe(false);
    expect(isNavItemActive("/", "/")).toBe(true);
  });
});
