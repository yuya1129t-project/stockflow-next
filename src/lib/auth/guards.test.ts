import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Role } from "./permissions";

// Next.js のリクエストと Better Auth をテスト用に置き換える
const getSession = vi.fn();
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("./auth", () => ({ getAuth: () => ({ api: { getSession } }) }));

const { checkActionPermission } = await import("./guards");

function sessionOf(role: Role) {
  return {
    session: { token: "t" },
    user: {
      id: `demo_${role}`,
      name: "デモ",
      email: `${role}@example.com`,
      role,
      isActive: true,
    },
  };
}

describe("checkActionPermission（Server Action 用。画面遷移せず結果を返す）", () => {
  beforeEach(() => getSession.mockReset());

  it("未ログインは { ok: false, error }", async () => {
    getSession.mockResolvedValue(null);
    expect(await checkActionPermission("view")).toEqual({
      ok: false,
      error: "ログインが必要です",
    });
  });

  it("権限外は { ok: false, error }（redirect も forbidden もしない）", async () => {
    getSession.mockResolvedValue(sessionOf("viewer"));
    expect(await checkActionPermission("order:edit")).toEqual({
      ok: false,
      error: "この操作を行う権限がありません",
    });
  });

  it("権限があれば { ok: true, user }", async () => {
    getSession.mockResolvedValue(sessionOf("staff"));
    expect(await checkActionPermission("order:edit")).toEqual({
      ok: true,
      user: {
        id: "demo_staff",
        name: "デモ",
        email: "staff@example.com",
        role: "staff",
      },
    });
  });
});
