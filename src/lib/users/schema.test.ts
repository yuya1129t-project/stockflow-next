import { describe, expect, it } from "vitest";

import {
  apiTokenCreateSchema,
  passwordResetSchema,
  userCreateSchema,
  userFieldErrors,
  userRoleSchema,
} from "./schema";

const valid = {
  name: "  テスト 太郎 ",
  email: " Taro.Test@Example.COM ",
  role: "staff",
  password: "pass-1234",
};

function errorsOf(input: unknown) {
  const parsed = userCreateSchema.safeParse(input);
  if (parsed.success) throw new Error("検証が通ってしまいました");
  return userFieldErrors(parsed.error);
}

describe("userCreateSchema（ユーザーの登録）", () => {
  it("名前は前後の空白を除き、メールアドレスは小文字に揃える（Better Auth のログインと同じ照合）", () => {
    expect(userCreateSchema.parse(valid)).toEqual({
      name: "テスト 太郎",
      email: "taro.test@example.com",
      role: "staff",
      password: "pass-1234",
    });
  });

  it("必須の項目が空ならエラー", () => {
    const errors = errorsOf({ name: " ", email: "", role: "", password: "" });
    expect(errors.name).toEqual(["名前を入力してください"]);
    expect(errors.email).toEqual(["メールアドレスを入力してください"]);
    expect(errors.role).toEqual(["ロールを選択してください"]);
    expect(errors.password).toEqual(["初期パスワードを入力してください"]);
  });

  it("メールアドレスの形式", () => {
    expect(errorsOf({ ...valid, email: "not-an-email" }).email).toEqual([
      "メールアドレスの形式が正しくありません（例 user@example.com）",
    ]);
  });

  it("ロールは admin / staff / viewer だけ", () => {
    for (const role of ["admin", "staff", "viewer"]) {
      expect(userCreateSchema.safeParse({ ...valid, role }).success).toBe(true);
    }
    expect(errorsOf({ ...valid, role: "owner" }).role).toBeDefined();
  });

  it("パスワードは 8〜128 文字（Better Auth の既定に合わせる）。空白は削らない", () => {
    expect(errorsOf({ ...valid, password: "1234567" }).password).toEqual([
      "初期パスワードは8文字以上で入力してください",
    ]);
    expect(
      userCreateSchema.safeParse({ ...valid, password: "12345678" }).success,
    ).toBe(true);
    expect(
      userCreateSchema.safeParse({ ...valid, password: "a".repeat(128) })
        .success,
    ).toBe(true);
    expect(errorsOf({ ...valid, password: "a".repeat(129) }).password).toEqual([
      "初期パスワードは128文字以内で入力してください",
    ]);
    expect(
      userCreateSchema.parse({ ...valid, password: " pass 1234 " }),
    ).toMatchObject({ password: " pass 1234 " });
  });

  it("名前・パスワードの改行・タブは不可", () => {
    expect(errorsOf({ ...valid, name: "a\nb" }).name).toEqual([
      "名前に改行・タブなどの制御文字は使えません",
    ]);
    expect(errorsOf({ ...valid, password: "pass\t1234" }).password).toEqual([
      "初期パスワードに改行・タブなどの制御文字は使えません",
    ]);
  });

  it("名前は 100 文字まで", () => {
    expect(errorsOf({ ...valid, name: "あ".repeat(101) }).name).toEqual([
      "名前は100文字以内で入力してください",
    ]);
  });
});

describe("userRoleSchema・passwordResetSchema・apiTokenCreateSchema", () => {
  it("ロール変更", () => {
    expect(userRoleSchema.parse({ role: "viewer" })).toEqual({
      role: "viewer",
    });
    expect(userRoleSchema.safeParse({ role: "root" }).success).toBe(false);
  });

  it("パスワード再設定は 8 文字以上", () => {
    const parsed = passwordResetSchema.safeParse({ password: "short" });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0].message).toBe(
      "新しいパスワードは8文字以上で入力してください",
    );
    expect(
      passwordResetSchema.safeParse({ password: "long-enough" }).success,
    ).toBe(true);
  });

  it("トークンの名前は必須・50 文字まで・1 行", () => {
    expect(apiTokenCreateSchema.parse({ name: " 在庫連携 " })).toEqual({
      name: "在庫連携",
    });
    expect(apiTokenCreateSchema.safeParse({ name: "" }).success).toBe(false);
    expect(
      apiTokenCreateSchema.safeParse({ name: "a".repeat(51) }).success,
    ).toBe(false);
    expect(apiTokenCreateSchema.safeParse({ name: "a\nb" }).success).toBe(
      false,
    );
  });
});
