/**
 * REST API の閲覧画面（GET /api-docs、src/app/api-docs/route.ts）の HTML と応答ヘッダー。Swagger UI で /api/v1/openapi.json を表示する。docs/spec.md §6-2。
 *
 * - ログインなしで閲覧できる（API の形だけで秘密やデータは含まない。src/proxy.ts でログイン画面への転送の対象外にしている）
 * - Swagger UI は依存に入れず、jsDelivr（npm の swagger-ui-dist、版を固定）から読み込む。SRI（integrity）で
 *   CDN の内容が改ざん・差し替えされていたら読み込まない。版を変えるときは integrity も計算し直す
 *   （`curl -s https://cdn.jsdelivr.net/npm/swagger-ui-dist@<版>/swagger-ui-bundle.js | openssl dgst -sha384 -binary | openssl base64 -A`）
 * - この応答だけに CSP を付ける（スクリプトはその版の CDN のパスと、下の初期化スクリプト（ハッシュで許可）だけ。
 *   通信は同じオリジンだけ）。アプリのほかの画面の CSP は変えない
 * - 「Try it out」で入力したトークンはブラウザのメモリ上だけに置く（persistAuthorization は既定の false）
 */
import { createHash } from "node:crypto";

export const SWAGGER_UI_VERSION = "5.33.1";
const CDN_BASE = `https://cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER_UI_VERSION}/`;

export const SWAGGER_UI_ASSETS = {
  script: {
    url: `${CDN_BASE}swagger-ui-bundle.js`,
    integrity:
      "sha384-ZPehFMQommnnuaZ4rpxgkgTT2DKFVp4hZC/7pLit+9Lek9T1YGSo23eHFbvNkXkw",
  },
  style: {
    url: `${CDN_BASE}swagger-ui.css`,
    integrity:
      "sha384-Ov4/wv3j2bmct8cDc5X4ngJZohVPzEmc6uDPH8WeljUxO5vtoykvMEfbu9Vh6RaW",
  },
} as const;

/** 初期化スクリプト（インライン。CSP ではハッシュで許可する） */
export const INIT_SCRIPT = `window.addEventListener("load", function () {
  window.ui = SwaggerUIBundle({
    url: "/api/v1/openapi.json",
    dom_id: "#swagger-ui",
    deepLinking: true,
    validatorUrl: null,
    tryItOutEnabled: false,
    persistAuthorization: false
  });
});`;

const scriptHash = `sha256-${createHash("sha256").update(INIT_SCRIPT, "utf8").digest("base64")}`;

export const API_DOCS_CSP = [
  "default-src 'none'",
  `script-src ${CDN_BASE} '${scriptHash}'`,
  `style-src ${CDN_BASE} 'unsafe-inline'`,
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export const API_DOCS_HTML = `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>StockFlow API ドキュメント</title>
    <link rel="stylesheet" href="${SWAGGER_UI_ASSETS.style.url}" integrity="${SWAGGER_UI_ASSETS.style.integrity}" crossorigin="anonymous" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="${SWAGGER_UI_ASSETS.script.url}" integrity="${SWAGGER_UI_ASSETS.script.integrity}" crossorigin="anonymous"></script>
    <script>${INIT_SCRIPT}</script>
  </body>
</html>
`;

/** 閲覧画面の応答 */
export function apiDocsResponse(): Response {
  return new Response(API_DOCS_HTML, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": API_DOCS_CSP,
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  });
}
