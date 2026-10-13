/**
 * Vercel Cron からの呼び出しかを確かめる。
 *
 * Vercel は環境変数 CRON_SECRET が設定されていると、Cron の呼び出しに
 * `Authorization: Bearer <CRON_SECRET>` を付ける。CRON_SECRET が未設定・空なら常に拒否する
 * （秘密なしでデモデータを消せる状態にしない）。比較は定数時間で行う（SHA-256 にそろえてから
 * timingSafeEqual で比べるので、長さの違いでも時間が変わらない）
 */
import { createHash, timingSafeEqual } from "node:crypto";

export function isAuthorizedCronRequest(
  request: Request,
  secret: string | undefined,
): boolean {
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  return safeEqual(header, `Bearer ${secret}`);
}

function safeEqual(a: string, b: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
}
