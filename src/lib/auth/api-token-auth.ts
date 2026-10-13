/**
 * REST API（/api/v1、#11）の Bearer トークン認証。サーバー専用。
 *
 * Route Handler からの使い方（応答の形（RFC 9457 の 401）は #11 で決める）:
 *
 * @example
 * const auth = await authenticateApiToken(request);
 * if (!auth.ok) return problem(401, ...);
 * if (!can(auth.user.role, "view")) return problem(403, ...);
 *
 * - 失敗の理由（ヘッダーなし・形式違い・存在しない・失効済み・ユーザー無効）は返さない。
 *   呼び出し側は理由を区別せず同じ 401 を返す（トークンの存在や状態を推測させない）
 * - 権限はトークンの持ち主の「いまの」ロールに従う（spec §6-2）。ロールと有効は毎回 DB から読むので、
 *   ロール変更・無効化は次のリクエストから効く
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { getPrisma } from "@/lib/db";

import { hashApiToken, isApiTokenFormat, parseBearerToken } from "./api-token";
import { isRole } from "./permissions";
import type { SessionUser } from "./session";

/** lastUsedAt を書き込む間隔（リクエストのたびに書き込まない） */
export const API_TOKEN_LAST_USED_INTERVAL_MS = 5 * 60 * 1000;

export type ApiTokenAuthResult =
  { ok: true; user: SessionUser; tokenId: number } | { ok: false };

const UNAUTHORIZED: ApiTokenAuthResult = { ok: false };

export async function authenticateApiToken(
  request: Request,
  options: { db?: PrismaClient; now?: Date } = {},
): Promise<ApiTokenAuthResult> {
  const token = parseBearerToken(request.headers.get("authorization"));
  if (!token || !isApiTokenFormat(token)) return UNAUTHORIZED;

  const db = options.db ?? getPrisma();
  const now = options.now ?? new Date();
  // 平文どうしを比べるのではなく、ハッシュを一意索引で引く。比べるのはハッシュ（攻撃者が狙った値を作れない）
  // なので、文字列比較の時間差からトークンを推測されるタイミング攻撃は問題にならない
  const found = await db.apiToken.findUnique({
    where: { tokenHash: hashApiToken(token) },
    select: {
      id: true,
      revokedAt: true,
      lastUsedAt: true,
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          isActive: true,
        },
      },
    },
  });
  if (!found || found.revokedAt !== null) return UNAUTHORIZED;
  const { user } = found;
  if (!user.isActive || !isRole(user.role)) return UNAUTHORIZED;

  const threshold = new Date(now.getTime() - API_TOKEN_LAST_USED_INTERVAL_MS);
  if (found.lastUsedAt === null || found.lastUsedAt < threshold) {
    // 同時に来たリクエストで何度も書かないよう、条件付きで更新する
    await db.apiToken.updateMany({
      where: {
        id: found.id,
        OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: threshold } }],
      },
      data: { lastUsedAt: now },
    });
  }

  return {
    ok: true,
    tokenId: found.id,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  };
}
