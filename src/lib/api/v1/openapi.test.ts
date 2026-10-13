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

import { buildOpenApiDocument, serializeOpenApiDocument } from "./openapi";

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
            /export (?:const|function|async function) (GET|POST|PUT|PATCH|DELETE)\b/g,
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
