/**
 * Proxy（Next.js 16 で Middleware から改名）。画面へのリクエストの前処理だけを行う。
 *
 * - 表示中のパスをリクエストヘッダーに付ける（未ログイン時に、ログイン後に戻る先として使う）
 * - セッション Cookie が無ければログイン画面へリダイレクトする（楽観的なチェック）。
 *   ログイン画面と REST API の閲覧画面（/api-docs。API の形だけで秘密を含まない）は対象外
 *
 * Cookie の有無しか見ないので、ここは認可の本体ではない。セッションの有効性・isActive・権限は
 * 各画面・Server Action・Route Handler のガード（src/lib/auth/guards.ts）で必ず検査する
 */
import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

import { PATHNAME_HEADER } from "@/lib/auth/constants";

/** ログインなしで開ける画面 */
const PUBLIC_PATHS: ReadonlySet<string> = new Set(["/login", "/api-docs"]);

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const path = `${pathname}${search}`;

  if (!PUBLIC_PATHS.has(pathname) && !getSessionCookie(request)) {
    const loginUrl = new URL("/login", request.url);
    if (pathname !== "/") loginUrl.searchParams.set("callbackUrl", path);
    return NextResponse.redirect(loginUrl);
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(PATHNAME_HEADER, path);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  // API（認証は各 Route Handler で検査）と静的ファイルは対象外
  matcher: ["/((?!api/|_next/static|_next/image|favicon.ico).*)"],
};
