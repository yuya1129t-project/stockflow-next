/**
 * 外部向け REST API のトークン（docs/spec.md §6-2）の生成・ハッシュ・形式の確認。サーバー専用（node:crypto）。
 *
 * - 形式は `sf_` + 32 バイトの乱数の base64url（43 文字）。接頭辞で StockFlow のトークンだと分かる
 *   （ログやリポジトリに紛れ込んだときに見つけやすい）
 * - DB には SHA-256 のハッシュ（16 進 64 文字）だけを保存する。平文は発行時に 1 回だけ画面に表示する
 * - パスワードと違い、トークンは 256 ビットの乱数なので、総当たり・辞書攻撃への対策（ソルト・遅いハッシュ）は不要。
 *   検索は「ハッシュの一致」なので 1 回の SHA-256 で済む
 */
import { createHash, randomBytes } from "node:crypto";

export const API_TOKEN_PREFIX = "sf_";
const API_TOKEN_RANDOM_BYTES = 32;

/** トークンの形式（接頭辞＋base64url の 43 文字） */
const API_TOKEN_PATTERN = /^sf_[A-Za-z0-9_-]{43}$/;

/** 新しいトークンを作る（平文とハッシュ） */
export function generateApiToken(): { token: string; tokenHash: string } {
  const token = `${API_TOKEN_PREFIX}${randomBytes(API_TOKEN_RANDOM_BYTES).toString("base64url")}`;
  return { token, tokenHash: hashApiToken(token) };
}

/** トークンのハッシュ（SHA-256 の 16 進） */
export function hashApiToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** トークンの形式か（DB を引く前に、明らかに違う値を弾く） */
export function isApiTokenFormat(value: string): boolean {
  return API_TOKEN_PATTERN.test(value);
}

/**
 * Authorization ヘッダーから Bearer トークンを取り出す（RFC 6750）。なければ null。
 * スキーム名は大文字・小文字を区別しない
 */
export function parseBearerToken(authorization: string | null): string | null {
  if (!authorization) return null;
  const match = /^Bearer +(\S+) *$/i.exec(authorization);
  return match ? match[1] : null;
}
