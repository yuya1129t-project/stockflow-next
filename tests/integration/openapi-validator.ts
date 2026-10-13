/**
 * 実際の応答を OpenAPI の定義（docs/openapi.json。src/lib/api/v1/openapi.ts のスナップショット）で検証する（テスト用）。
 *
 * 定義と実装の食い違い（項目の過不足・型・null の可否・定義にないステータスコードや Content-Type）を検出する。
 * スキーマの検証は Zod ではなく ajv（JSON Schema 2020-12 の実装）で行う（公開する JSON の定義そのものを、
 * Zod から独立した実装で確かめるため。② Laravel・③ FastAPI 版が読むのはこの JSON）
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";

type JsonObject = Record<string, unknown>;

const DOC_ID = "https://stockflow.test/openapi.json";

export const openApiDocument = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../docs/openapi.json", import.meta.url)),
    "utf8",
  ),
) as JsonObject & {
  paths: Record<string, Record<string, JsonObject>>;
  components: JsonObject & { responses: Record<string, JsonObject> };
};

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
// components.schemas を 1 つのスキーマ（$id = DOC_ID）の下に登録し、#/components/schemas/… の参照をその中で解決させる。
// OpenAPI のほかの項目（paths など）は JSON Schema ではないので入れない
ajv.addKeyword("components");
ajv.addSchema({
  $id: DOC_ID,
  components: { schemas: openApiDocument.components.schemas },
});

/** 検証した「メソッド パス ステータス」（定義した応答をすべて確かめたかの確認に使う） */
export const checkedResponses = new Set<string>();

/** 定義にある「メソッド パス ステータス」の一覧 */
export function documentedResponses(): string[] {
  return Object.entries(openApiDocument.paths).flatMap(([path, operations]) =>
    Object.entries(operations).flatMap(([method, operation]) =>
      Object.keys(operation.responses as JsonObject).map(
        (status) => `${method} ${path} ${status}`,
      ),
    ),
  );
}

function resolveResponse(response: JsonObject): JsonObject {
  const ref = response.$ref;
  if (typeof ref !== "string") return response;
  const name = ref.replace("#/components/responses/", "");
  const resolved = openApiDocument.components.responses[name];
  if (!resolved) throw new Error(`応答の参照を解決できません: ${ref}`);
  return resolved;
}

/** 定義にある応答のスキーマで、実際の応答（ステータス・Content-Type・本文）を検証する。本文（JSON）を返す */
export async function expectMatchesSpec(
  method: "get" | "post",
  pathTemplate: string,
  response: Response,
): Promise<unknown> {
  const operation = openApiDocument.paths[pathTemplate]?.[method];
  if (!operation) {
    throw new Error(
      `定義にない操作です: ${method.toUpperCase()} ${pathTemplate}`,
    );
  }
  const responses = operation.responses as Record<string, JsonObject>;
  const documented = responses[String(response.status)];
  if (!documented) {
    throw new Error(
      `定義にないステータスです: ${method.toUpperCase()} ${pathTemplate} → ${response.status}（定義: ${Object.keys(responses).join(", ")}）`,
    );
  }
  const spec = resolveResponse(documented);
  const contentType = (response.headers.get("content-type") ?? "")
    .split(";")[0]
    .trim();
  const content = spec.content as Record<string, { schema: JsonObject }>;
  const media = content?.[contentType];
  if (!media) {
    throw new Error(
      `定義にない Content-Type です: ${contentType}（定義: ${Object.keys(content ?? {}).join(", ")}）`,
    );
  }
  for (const header of Object.keys((spec.headers as JsonObject) ?? {})) {
    if (response.headers.get(header) === null) {
      throw new Error(`定義にあるヘッダーがありません: ${header}`);
    }
  }
  const body: unknown = await response.json();
  const schema = media.schema.$ref
    ? { $ref: `${DOC_ID}${String(media.schema.$ref)}` }
    : media.schema;
  const validate = ajv.compile(schema);
  if (!validate(body)) {
    throw new Error(
      `応答が定義のスキーマに合いません: ${method.toUpperCase()} ${pathTemplate} → ${response.status}\n${JSON.stringify(validate.errors, null, 2)}\n本文: ${JSON.stringify(body)}`,
    );
  }
  checkedResponses.add(`${method} ${pathTemplate} ${response.status}`);
  return body;
}
