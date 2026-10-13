/**
 * REST API の閲覧画面（/api-docs）の単体テスト: CDN の版の固定・SRI・CSP
 */
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { GET } from "@/app/api-docs/route";

import {
  API_DOCS_CSP,
  INIT_SCRIPT,
  SWAGGER_UI_ASSETS,
  SWAGGER_UI_VERSION,
} from "./docs-page";

describe("/api-docs", () => {
  it("Swagger UI を版を固定した URL から SRI 付きで読み込み、/api/v1/openapi.json を表示する", async () => {
    const response = GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    const html = await response.text();
    expect(SWAGGER_UI_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    for (const asset of Object.values(SWAGGER_UI_ASSETS)) {
      expect(asset.url).toContain(`/swagger-ui-dist@${SWAGGER_UI_VERSION}/`);
      expect(asset.integrity).toMatch(/^sha384-[A-Za-z0-9+/]{64}$/);
      expect(html).toContain(
        `"${asset.url}" integrity="${asset.integrity}" crossorigin="anonymous"`,
      );
    }
    expect(html).toContain(`<script>${INIT_SCRIPT}</script>`);
    expect(INIT_SCRIPT).toContain('url: "/api/v1/openapi.json"');
  });

  it("CSP はこの画面だけに付け、インラインのスクリプトはハッシュで許可する。通信は同じオリジンだけ", () => {
    const response = GET();
    expect(response.headers.get("content-security-policy")).toBe(API_DOCS_CSP);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const hash = createHash("sha256").update(INIT_SCRIPT).digest("base64");
    const directives = Object.fromEntries(
      API_DOCS_CSP.split("; ").map((d) => {
        const [name, ...values] = d.split(" ");
        return [name, values];
      }),
    );
    expect(directives["default-src"]).toEqual(["'none'"]);
    expect(directives["script-src"]).toEqual([
      `https://cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER_UI_VERSION}/`,
      `'sha256-${hash}'`,
    ]);
    expect(directives["connect-src"]).toEqual(["'self'"]);
    expect(directives["frame-ancestors"]).toEqual(["'none'"]);
  });
});
