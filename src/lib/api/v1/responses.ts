/**
 * REST API（/api/v1）の応答の組み立て。成功は application/json、エラーは RFC 9457（application/problem+json）。
 *
 * - エラーの type は about:blank（HTTP のステータスどおりの意味）で、title は HTTP のステータスの説明（RFC 9457 §4.2.1）。
 *   内容は detail（日本語）に書き、400 の検証エラーは項目ごとの内容を拡張メンバー errors に入れる
 * - API の応答はキャッシュさせない（Cache-Control: no-store）
 */
import type { Problem, ProblemFieldError } from "./schemas";

export const JSON_CONTENT_TYPE = "application/json";
/** 401 の WWW-Authenticate（RFC 6750。理由を区別しないため error 属性は付けない） */
export const WWW_AUTHENTICATE = 'Bearer realm="StockFlow API"';
export const PROBLEM_CONTENT_TYPE = "application/problem+json";

export const PROBLEM_TITLES = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  413: "Content Too Large",
  415: "Unsupported Media Type",
  500: "Internal Server Error",
} as const;

export type ProblemStatus = keyof typeof PROBLEM_TITLES;

const NO_STORE = { "Cache-Control": "no-store" };

/** 成功の応答（JSON） */
export function apiJson(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      "Content-Type": JSON_CONTENT_TYPE,
      ...NO_STORE,
      ...init.headers,
    },
  });
}

/** エラーの応答（RFC 9457） */
export function problem(
  status: ProblemStatus,
  detail: string,
  options: {
    errors?: ProblemFieldError[];
    headers?: Record<string, string>;
  } = {},
): Response {
  const body: Problem = {
    type: "about:blank",
    title: PROBLEM_TITLES[status],
    status,
    detail,
    ...(options.errors ? { errors: options.errors } : {}),
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": PROBLEM_CONTENT_TYPE,
      ...NO_STORE,
      ...options.headers,
    },
  });
}

/** 400 検証エラー（項目ごとの内容つき） */
export function validationProblem(errors: ProblemFieldError[]): Response {
  return problem(
    400,
    "入力内容に誤りがあります。errors の各項目を確認してください",
    {
      errors,
    },
  );
}

type DefinedMethod = "GET" | "POST";

/** Allow ヘッダーの値（GET があれば Next.js が自動で応じる HEAD と、OPTIONS も含める） */
export function allowHeader(allowed: readonly DefinedMethod[]): string {
  return [
    ...allowed,
    ...(allowed.includes("GET") ? ["HEAD"] : []),
    "OPTIONS",
  ].join(", ");
}

/**
 * 定義したパスに、定義していないメソッドが来たときのハンドラー（405。RFC 9110 §15.5.6 のとおり Allow を付ける）。
 * Route Handler で、定義していないメソッド（GET・POST・PUT・PATCH・DELETE のうち）にこれを export する
 */
export function methodNotAllowed(
  allowed: readonly DefinedMethod[],
): () => Response {
  return () =>
    problem(
      405,
      `このメソッドは使えません（使えるメソッド: ${allowed.join(", ")}）`,
      { headers: { Allow: allowHeader(allowed) } },
    );
}

/**
 * OPTIONS のハンドラー（204 と Allow）。Next.js の自動の OPTIONS は export したすべてのメソッド（405 を返すものを含む）を
 * Allow に並べるので、定義したメソッドだけを返すように置き換える
 */
export function optionsHandler(
  allowed: readonly DefinedMethod[],
): () => Response {
  return () =>
    new Response(null, {
      status: 204,
      headers: { Allow: allowHeader(allowed) },
    });
}

/**
 * Route Handler を包み、想定外の例外を 500（RFC 9457）にする（例外の内容は応答に出さず、サーバーのログに残す）
 */
export function withApiErrors<A extends unknown[]>(
  handler: (...args: A) => Promise<Response>,
): (...args: A) => Promise<Response> {
  return async (...args: A) => {
    try {
      return await handler(...args);
    } catch (error) {
      console.error("REST API で想定外のエラーが発生しました", error);
      return problem(
        500,
        "サーバーでエラーが発生しました。時間をおいてもう一度お試しください",
      );
    }
  };
}
