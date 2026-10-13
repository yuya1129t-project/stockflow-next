/**
 * Proxy（src/proxy.ts）の単体テスト: ログインなしで開ける画面と、ログイン画面への転送
 */
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { proxy } from "./proxy";

const request = (path: string, cookie?: string) =>
  new NextRequest(`http://localhost:3000${path}`, {
    headers: cookie ? { cookie } : {},
  });

describe("proxy", () => {
  it.each(["/login", "/api-docs"])(
    "%s はセッション Cookie がなくても開ける",
    (path) => {
      const response = proxy(request(path));
      expect(response.headers.get("location")).toBeNull();
    },
  );

  it("ほかの画面はセッション Cookie がなければログイン画面へ（戻る先を付ける）", () => {
    const response = proxy(request("/products?page=2"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/login?callbackUrl=%2Fproducts%3Fpage%3D2",
    );
    // /api-docs で始まる別のパスは対象外にしない
    expect(proxy(request("/api-docs-x")).headers.get("location")).toContain(
      "/login",
    );
  });
});
