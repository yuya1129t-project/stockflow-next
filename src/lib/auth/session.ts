/**
 * セッションの取得と権限の判定（Next.js に依存しない部分）。
 * Next.js から使うガード関数は src/lib/auth/guards.ts。結合テストはこのファイルの関数を直接呼ぶ
 */
import type { Auth } from "./auth";
import { USER_INACTIVE_CODE } from "./constants";
import { can, isRole, type Action, type Role } from "./permissions";

/** ログイン中のユーザー（画面・API で使う最小限の項目） */
export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: Role;
}

/**
 * リクエストのヘッダー（Cookie）からログイン中のユーザーを得る。未ログイン・無効ユーザーは null。
 *
 * セッションは毎回 DB から読む（cookieCache を使わない）ので、無効化されたユーザーは次のリクエストから弾かれる。
 * isActive は auth.ts の /get-session のフックでも確認しているが、ガードの側でも確認する（二重の確認）
 */
export async function getSessionUser(
  auth: Auth,
  headers: Headers,
): Promise<SessionUser | null> {
  const result = await auth.api.getSession({ headers });
  if (!result) return null;
  const { user } = result;
  if (user.isActive !== true || !isRole(user.role)) return null;
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}

export type AuthorizeResult =
  { ok: true; user: SessionUser } | { ok: false; status: 401 | 403 };

/** 権限の判定: 未ログインは 401、権限外は 403 */
export function authorize(
  user: SessionUser | null,
  action: Action,
): AuthorizeResult {
  if (!user) return { ok: false, status: 401 };
  if (!can(user.role, action)) return { ok: false, status: 403 };
  return { ok: true, user };
}

/** 未ログイン（401）・権限外（403）のメッセージ */
export function authErrorMessage(status: 401 | 403): string {
  return status === 401
    ? "ログインが必要です"
    : "この操作を行う権限がありません";
}

/** API 用のエラー応答（JSON） */
export function authErrorResponse(status: 401 | 403): Response {
  return Response.json({ error: authErrorMessage(status) }, { status });
}

/**
 * Route Handler 用: リクエストを検査し、許可されれば user、そうでなければ 401／403 の応答を返す
 */
export async function authorizeRequest(
  auth: Auth,
  headers: Headers,
  action: Action,
): Promise<
  { ok: true; user: SessionUser } | { ok: false; response: Response }
> {
  const result = authorize(await getSessionUser(auth, headers), action);
  if (!result.ok)
    return { ok: false, response: authErrorResponse(result.status) };
  return result;
}

/**
 * ログイン後に戻る先として安全なパスか（オープンリダイレクト対策）。同じサイト内の絶対パスだけを許す
 */
export function safeCallbackPath(value: unknown): string {
  if (typeof value !== "string") return "/";
  // 制御文字（ブラウザは URL 中のタブ・改行を取り除く）とバックスラッシュを含むものは使わない
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return "/";
  // "/" で始まり "//"（プロトコル相対 URL）で始まらないもの
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  // ログイン画面に戻るとループするので使わない
  if (value === "/login" || value.startsWith("/login?")) return "/";
  return value;
}

/**
 * ログインの失敗を、画面に出す日本語のメッセージにする。
 * Better Auth のクライアントのエラー（{ status, code }）とサーバーの APIError（{ statusCode, body.code }）の両方を受け付ける
 */
export function loginErrorMessage(error: unknown): string {
  const e = (error ?? {}) as {
    status?: unknown;
    statusCode?: unknown;
    code?: unknown;
    body?: { code?: unknown };
  };
  if (e.status === 429 || e.statusCode === 429) {
    return "試行回数が多すぎます。しばらく待ってからもう一度お試しください";
  }
  switch (e.body?.code ?? e.code) {
    case "INVALID_EMAIL_OR_PASSWORD":
    case "INVALID_EMAIL":
      return "メールアドレスまたはパスワードが正しくありません";
    case USER_INACTIVE_CODE:
      return "このアカウントは無効になっています。管理者に連絡してください";
    default:
      return "ログインできませんでした。時間をおいてもう一度お試しください";
  }
}
