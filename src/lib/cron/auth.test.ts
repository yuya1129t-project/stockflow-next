import { describe, expect, it } from "vitest";

import { isAuthorizedCronRequest } from "./auth";

const SECRET = "test-cron-secret-0123456789abcdef";

function request(authorization?: string) {
  return new Request("http://localhost:3000/api/cron/reset-demo", {
    headers: authorization ? { authorization } : {},
  });
}

describe("isAuthorizedCronRequest", () => {
  it("Authorization: Bearer <CRON_SECRET> なら許可", () => {
    expect(isAuthorizedCronRequest(request(`Bearer ${SECRET}`), SECRET)).toBe(
      true,
    );
  });

  it("ヘッダーなし・値違い・形式違いは拒否", () => {
    expect(isAuthorizedCronRequest(request(), SECRET)).toBe(false);
    expect(isAuthorizedCronRequest(request("Bearer wrong"), SECRET)).toBe(
      false,
    );
    expect(isAuthorizedCronRequest(request(SECRET), SECRET)).toBe(false);
    expect(isAuthorizedCronRequest(request(`Basic ${SECRET}`), SECRET)).toBe(
      false,
    );
    expect(isAuthorizedCronRequest(request(`Bearer ${SECRET}x`), SECRET)).toBe(
      false,
    );
  });

  it("CRON_SECRET が未設定・空なら、どんなヘッダーでも拒否", () => {
    expect(isAuthorizedCronRequest(request("Bearer "), undefined)).toBe(false);
    expect(isAuthorizedCronRequest(request("Bearer "), "")).toBe(false);
    expect(
      isAuthorizedCronRequest(request("Bearer undefined"), undefined),
    ).toBe(false);
  });
});
