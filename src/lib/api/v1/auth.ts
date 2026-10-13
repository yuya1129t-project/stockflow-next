/**
 * REST API（/api/v1）の認証・認可。サーバー専用。
 *
 * - 認証は `Authorization: Bearer <token>` だけ（authenticateApiToken）。Cookie のセッションは見ない
 *   （ブラウザが自動で送る Cookie で API を動かせないようにして、CSRF の余地をなくす）
 * - 失敗の理由（ヘッダーなし・形式違い・存在しない・失効済み・ユーザー無効）は区別せず、同じ 401 を返す。
 *   WWW-Authenticate は RFC 6750 のとおり Bearer。理由を区別しないため error 属性は付けない
 * - 権限はトークンの持ち主の「いまの」ロールで判定する（spec §2・§6-2。src/lib/auth/permissions.ts の表）
 */
import { authenticateApiToken } from "@/lib/auth/api-token-auth";
import { can, type Action } from "@/lib/auth/permissions";
import { authErrorMessage, type SessionUser } from "@/lib/auth/session";

import { problem, WWW_AUTHENTICATE } from "./responses";

export type ApiAuthResult =
  | { ok: true; user: SessionUser; tokenId: number }
  | { ok: false; response: Response };

export function unauthorizedProblem(): Response {
  return problem(
    401,
    "認証が必要です。有効な API トークンを Authorization: Bearer で指定してください",
    { headers: { "WWW-Authenticate": WWW_AUTHENTICATE } },
  );
}

export function forbiddenProblem(): Response {
  return problem(403, authErrorMessage(403));
}

/** トークンを検証し、action の権限を確かめる */
export async function authenticateApiRequest(
  request: Request,
  action: Action,
): Promise<ApiAuthResult> {
  const auth = await authenticateApiToken(request);
  if (!auth.ok) return { ok: false, response: unauthorizedProblem() };
  if (!can(auth.user.role, action)) {
    return { ok: false, response: forbiddenProblem() };
  }
  return auth;
}
