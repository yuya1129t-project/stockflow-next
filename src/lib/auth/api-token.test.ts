import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  API_TOKEN_PREFIX,
  generateApiToken,
  hashApiToken,
  isApiTokenFormat,
  parseBearerToken,
} from "./api-token";

describe("generateApiToken", () => {
  it("sf_ + 32 バイトの base64url（43 文字）で、ハッシュは SHA-256 の 16 進", () => {
    const { token, tokenHash } = generateApiToken();
    expect(token.startsWith(API_TOKEN_PREFIX)).toBe(true);
    expect(token).toMatch(/^sf_[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token.slice(3), "base64url")).toHaveLength(32);
    expect(isApiTokenFormat(token)).toBe(true);
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
    // ハッシュに平文は含まれない
    expect(tokenHash).not.toContain(token.slice(3));
  });

  it("毎回違う値になる", () => {
    const tokens = new Set(
      Array.from({ length: 100 }, () => generateApiToken().token),
    );
    expect(tokens.size).toBe(100);
  });
});

describe("hashApiToken", () => {
  it("同じ入力なら同じハッシュ（DB の一意索引で引ける）", () => {
    expect(hashApiToken("sf_abc")).toBe(hashApiToken("sf_abc"));
    expect(hashApiToken("sf_abc")).not.toBe(hashApiToken("sf_abd"));
  });
});

describe("isApiTokenFormat", () => {
  it.each([
    "",
    "sf_",
    `sf_${"a".repeat(42)}`,
    `sf_${"a".repeat(44)}`,
    `xx_${"a".repeat(43)}`,
    `sf_${"a".repeat(42)}=`,
    `sf_${"a".repeat(42)}+`,
    ` sf_${"a".repeat(43)}`,
  ])("形式の違う値 %j は弾く", (value) => {
    expect(isApiTokenFormat(value)).toBe(false);
  });
});

describe("parseBearerToken", () => {
  it("Bearer の値を取り出す（スキーム名の大文字・小文字は問わない）", () => {
    expect(parseBearerToken("Bearer sf_abc")).toBe("sf_abc");
    expect(parseBearerToken("bearer sf_abc")).toBe("sf_abc");
    expect(parseBearerToken("BEARER  sf_abc ")).toBe("sf_abc");
  });

  it.each([
    null,
    "",
    "Bearer",
    "Bearer ",
    "Basic dXNlcjpwYXNz",
    "sf_abc",
    "Bearer a b",
  ])("Bearer でない・値のない %j は null", (value) => {
    expect(parseBearerToken(value)).toBeNull();
  });
});
