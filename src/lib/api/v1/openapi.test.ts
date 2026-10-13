/**
 * OpenAPI 3.1 の定義（src/lib/api/v1/openapi.ts）の単体テスト。
 *
 * - リポジトリのスナップショット（docs/openapi.json）と一致すること（② Laravel・③ FastAPI 版が同じ定義を使うため）
 * - Route Handler（src/app/api/v1/**\/route.ts）のパス・メソッドと、定義のパス・メソッドが一致すること
 * - JSON Schema として正しく、参照（$ref）がすべて解決できること
 * 実際の応答が定義に合うことは結合テスト（tests/integration/rest-api.test.ts）で確かめている
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

import { GET as getOpenApiJson } from "@/app/api/v1/openapi.json/route";

import { parseDateOnly } from "@/lib/orders/dates";

import { buildOpenApiDocument, serializeOpenApiDocument } from "./openapi";
import { API_DATE_PATTERN } from "./schemas";

type JsonObject = Record<string, unknown>;

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const API_DIR = join(ROOT, "src/app/api/v1");

const doc = buildOpenApiDocument() as JsonObject & {
  paths: Record<string, Record<string, JsonObject>>;
  components: { schemas: Record<string, JsonObject> };
};

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return routeFiles(path);
    return entry.name === "route.ts" ? [path] : [];
  });
}

describe("OpenAPI の定義", () => {
  it("docs/openapi.json（スナップショット）と一致する（違うときは pnpm openapi:generate を実行してコミットする）", () => {
    const snapshot = readFileSync(join(ROOT, "docs/openapi.json"), "utf8");
    expect(snapshot).toBe(serializeOpenApiDocument());
  });

  it("GET /api/v1/openapi.json は同じ定義を JSON で返す（認証不要）", async () => {
    const response = getOpenApiJson();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual(
      JSON.parse(serializeOpenApiDocument()),
    );
  });

  it("Route Handler のパス・メソッドと、定義のパス・メソッドが一致する（未定義の 404 用の [...path] を除く）", () => {
    const implemented = routeFiles(API_DIR)
      .filter((file) => !file.includes("[..."))
      .flatMap((file) => {
        const segments = relative(API_DIR, file).split("/").slice(0, -1);
        const path = `/api/v1/${segments
          .map((s) => s.replace(/^\[(\w+)\]$/, "{$1}"))
          .join("/")}`;
        const source = readFileSync(file, "utf8");
        return [
          ...source.matchAll(
            // 405 を返すだけのメソッド（methodNotAllowed）は数えない
            /export (?:const|function|async function) (GET|POST|PUT|PATCH|DELETE)\b(?! = methodNotAllowed\()/g,
          ),
        ].map((m) => `${m[1].toLowerCase()} ${path}`);
      })
      .sort();
    const documented = Object.entries(doc.paths)
      .flatMap(([path, operations]) =>
        Object.keys(operations).map((method) => `${method} ${path}`),
      )
      .sort();
    expect(implemented).toEqual(documented);
  });

  it("定義したパスに定義していないメソッドを送ると、405（RFC 9457）と、定義したメソッドの Allow を返す。OPTIONS も同じ Allow", async () => {
    for (const file of routeFiles(API_DIR).filter((f) => !f.includes("[..."))) {
      const segments = relative(API_DIR, file).split("/").slice(0, -1);
      const path = `/api/v1/${segments
        .map((s) => s.replace(/^\[(\w+)\]$/, "{$1}"))
        .join("/")}`;
      const allowed = Object.keys(doc.paths[path]).map((m) => m.toUpperCase());
      const route = (await import(/* @vite-ignore */ file)) as Record<
        string,
        unknown
      >;
      // GET があれば Next.js が自動で応じる HEAD と、OPTIONS も Allow に含める
      const allow = [
        ...allowed,
        ...(allowed.includes("GET") ? ["HEAD"] : []),
        "OPTIONS",
      ].join(", ");
      const options = (route.OPTIONS as () => Response)();
      expect(options.status, `OPTIONS ${path}`).toBe(204);
      expect(options.headers.get("allow"), `OPTIONS ${path}`).toBe(allow);
      for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
        if (allowed.includes(method)) continue;
        const handler = route[method] as (() => Response) | undefined;
        expect(handler, `${method} ${path}`).toBeTypeOf("function");
        const response = handler!();
        expect(response.status, `${method} ${path}`).toBe(405);
        expect(response.headers.get("allow")).toBe(allow);
        expect(response.headers.get("content-type")).toBe(
          "application/problem+json",
        );
        expect(await response.json()).toMatchObject({
          type: "about:blank",
          title: "Method Not Allowed",
          status: 405,
        });
      }
    }
  });

  it("日付の pattern は受け付ける範囲（parseDateOnly の 2000〜2099 年）と一致し、日付の項目・パラメーターすべてに付いている", () => {
    const pattern = new RegExp(API_DATE_PATTERN);
    for (const ok of ["2000-01-01", "2099-12-31"]) {
      expect(pattern.test(ok) && parseDateOnly(ok) !== null, ok).toBe(true);
    }
    for (const ng of ["1999-12-31", "2100-01-01", "0001-01-01", "9999-12-31"]) {
      expect(pattern.test(ng), ng).toBe(false);
      expect(parseDateOnly(ng), ng).toBeNull();
    }
    const dates: JsonObject[] = [];
    JSON.stringify(doc, (_key, value: unknown) => {
      if ((value as JsonObject | null)?.format === "date") {
        dates.push(value as JsonObject);
      }
      return value;
    });
    // 応答の受注日・納期（2 か所ずつ）、登録の納期、一覧の from・to
    expect(dates).toHaveLength(7);
    for (const schema of dates) expect(schema.pattern).toBe(API_DATE_PATTERN);
  });

  it("認証が必要な操作は 401 を、本文を受け取る操作は 400・413・415 を定義している", () => {
    for (const [path, operations] of Object.entries(doc.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        const statuses = Object.keys(operation.responses as JsonObject);
        const label = `${method} ${path}`;
        const isPublic =
          Array.isArray(operation.security) && operation.security.length === 0;
        if (!isPublic) expect(statuses, label).toContain("401");
        if (operation.requestBody) {
          expect(statuses, label).toEqual(
            expect.arrayContaining(["400", "413", "415"]),
          );
        }
      }
    }
  });

  it("スキーマは JSON Schema 2020-12 として正しく、参照（$ref）はすべて解決できる", () => {
    const ajv = new Ajv2020({ strict: true });
    addFormats(ajv);
    ajv.addKeyword("components");
    const id = "https://stockflow.test/openapi.json";
    ajv.addSchema({ $id: id, components: { schemas: doc.components.schemas } });
    for (const name of Object.keys(doc.components.schemas)) {
      expect(() =>
        ajv.compile({ $ref: `${id}#/components/schemas/${name}` }),
      ).not.toThrow();
    }
    // パス・応答・パラメーター側の参照も、定義の中に存在する
    const text = JSON.stringify(doc);
    for (const [, ref] of text.matchAll(/"\$ref":"#\/([^"]+)"/g)) {
      const target = ref
        .split("/")
        .reduce<unknown>(
          (node, key) => (node as JsonObject | undefined)?.[key],
          doc,
        );
      expect(target, ref).toBeDefined();
    }
  });
});
