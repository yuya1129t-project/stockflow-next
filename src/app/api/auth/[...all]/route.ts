/**
 * Better Auth の HTTP エンドポイント（/api/auth/*）。
 *
 * ログイン・ログアウトは画面の Server Action から auth.api を呼ぶので、HTTP で公開するのは
 * 下の一覧だけにする（パスワード変更・プロフィール更新など、使わない機能は 404）。
 * 公開のサインアップは Better Auth の設定でも無効にしている（src/lib/auth/auth.ts）
 */
import { getAuth } from "@/lib/auth/auth";

const PUBLIC_ENDPOINTS = new Set([
  "/api/auth/sign-in/email",
  "/api/auth/sign-out",
  "/api/auth/get-session",
]);

function handler(request: Request): Promise<Response> | Response {
  if (!PUBLIC_ENDPOINTS.has(new URL(request.url).pathname)) {
    return Response.json({ error: "見つかりません" }, { status: 404 });
  }
  return getAuth().handler(request);
}

export { handler as GET, handler as POST };
