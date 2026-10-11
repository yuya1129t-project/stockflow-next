import { describe, expect, it } from "vitest";

import { GET, POST } from "./route";

describe("/api/auth/*（公開するエンドポイントの制限）", () => {
  it.each([
    ["POST", "/api/auth/sign-up/email"],
    ["POST", "/api/auth/update-user"],
    ["POST", "/api/auth/change-password"],
    ["POST", "/api/auth/request-password-reset"],
    ["GET", "/api/auth/list-sessions"],
  ])("%s %s は 404（Better Auth まで届かない）", async (method, path) => {
    const handler = method === "GET" ? GET : POST;
    const response = await handler(
      new Request(`http://localhost:3000${path}`, { method }),
    );
    expect(response.status).toBe(404);
  });
});
