import { describe, expect, it } from "vitest";

import { USER_INACTIVE_CODE } from "./constants";
import {
  authErrorResponse,
  loginErrorMessage,
  safeCallbackPath,
} from "./session";

describe("safeCallbackPath（ログイン後に戻る先）", () => {
  it.each(["/", "/products", "/sales-orders?status=draft", "/users/1"])(
    "サイト内のパス %s はそのまま使う",
    (path) => {
      expect(safeCallbackPath(path)).toBe(path);
    },
  );

  it.each([
    undefined,
    null,
    ["/products"],
    "",
    "products",
    "https://evil.example.com/",
    "//evil.example.com",
    "/\\evil.example.com",
    "/\t/evil.example.com",
    "javascript:alert(1)",
    "/login",
    "/login?callbackUrl=%2F",
  ])("外部・不正な値 %j はトップ（/）にする", (value) => {
    expect(safeCallbackPath(value)).toBe("/");
  });
});

describe("loginErrorMessage", () => {
  const apiError = (code: string) => ({ body: { code } });

  it("パスワード違い・存在しないユーザーは同じメッセージ（どちらか分からないようにする）", () => {
    expect(loginErrorMessage(apiError("INVALID_EMAIL_OR_PASSWORD"))).toBe(
      "メールアドレスまたはパスワードが正しくありません",
    );
    expect(loginErrorMessage(apiError("INVALID_EMAIL"))).toBe(
      "メールアドレスまたはパスワードが正しくありません",
    );
  });

  it("無効ユーザー", () => {
    expect(loginErrorMessage(apiError(USER_INACTIVE_CODE))).toBe(
      "このアカウントは無効になっています。管理者に連絡してください",
    );
  });

  it("想定外のエラー", () => {
    expect(loginErrorMessage(new Error("boom"))).toBe(
      "ログインできませんでした。時間をおいてもう一度お試しください",
    );
    expect(loginErrorMessage(null)).toBe(
      "ログインできませんでした。時間をおいてもう一度お試しください",
    );
  });
});

describe("authErrorResponse", () => {
  it("401 / 403 を JSON で返す", async () => {
    const unauthorized = authErrorResponse(401);
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("content-type")).toContain(
      "application/json",
    );
    expect(await unauthorized.json()).toEqual({ error: "ログインが必要です" });

    const forbidden = authErrorResponse(403);
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({
      error: "この操作を行う権限がありません",
    });
  });
});
