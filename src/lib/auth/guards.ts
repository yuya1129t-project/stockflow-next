/**
 * サーバー側のガード関数（Server Components・Server Actions・Route Handlers から使う）。
 *
 * 画面（Server Components・Server Actions）:
 *   - requireUser(): 未ログインならログイン画面へ（ログイン後に元の画面へ戻る）
 *   - requirePermission(action): 上に加えて、権限外なら 403 ページへ
 * API（Route Handlers）:
 *   - requireApiPermission(request, action): 未ログインは 401、権限外は 403 の JSON 応答を返す
 *
 * 権限の定義は src/lib/auth/permissions.ts の 1 か所だけ
 */
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

import { getAuth } from "./auth";
import { PATHNAME_HEADER } from "./constants";
import { can, type Action } from "./permissions";
import {
  authorizeRequest,
  getSessionUser,
  safeCallbackPath,
  type SessionUser,
} from "./session";

/** ログイン中のユーザー（未ログイン・無効ユーザーは null）。同じリクエスト内では 1 回だけ DB を読む */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  // 先に headers() を読む（リクエスト時に描画する画面になり、ビルド時の事前描画で DB に接続しない）
  const requestHeaders = await headers();
  return getSessionUser(getAuth(), requestHeaders);
});

/** ログイン画面の URL（表示中の画面に戻れるよう callbackUrl を付ける） */
async function loginUrl(): Promise<string> {
  const from = safeCallbackPath((await headers()).get(PATHNAME_HEADER));
  return from === "/"
    ? "/login"
    : `/login?callbackUrl=${encodeURIComponent(from)}`;
}

/** 画面用: ログインを必須にする */
export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect(await loginUrl());
  return user;
}

/** 画面用: 権限を必須にする（権限外は 403 ページへ） */
export async function requirePermission(action: Action): Promise<SessionUser> {
  const user = await requireUser();
  if (!can(user.role, action)) redirect("/forbidden");
  return user;
}

/**
 * API 用: 許可されれば { ok: true, user }、そうでなければ { ok: false, response }（401／403 の JSON）。
 *
 * @example
 * const auth = await requireApiPermission(request, "csv:export");
 * if (!auth.ok) return auth.response;
 */
export async function requireApiPermission(request: Request, action: Action) {
  return authorizeRequest(getAuth(), request.headers, action);
}
