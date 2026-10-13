/**
 * REST API（/api/v1）の OpenAPI 3.1 の定義を組み立てる。純粋なモジュール（DB を使わない）。
 *
 * - スキーマ（components.schemas）は schemas.ts の Zod スキーマから z.toJSONSchema（JSON Schema 2020-12。OpenAPI 3.1 の
 *   スキーマと同じ方言）で作る。パス・パラメーター・応答の対応はここに書く
 * - GET /api/v1/openapi.json がこれを返す。リポジトリの docs/openapi.json はそのスナップショット
 *   （② Laravel・③ FastAPI 版で同じ API 仕様を使うため。更新は `pnpm openapi:generate`。一致は単体テストで確認）
 * - 実装と定義の食い違いは、結合テスト（tests/integration/rest-api.test.ts）で実際の応答をこの定義で検証して検出する
 */
import { z } from "zod";

import { SALES_ORDER_STATUSES } from "@/lib/sales-orders/status";

import { API_BODY_MAX_BYTES } from "./request";
import {
  JSON_CONTENT_TYPE,
  PROBLEM_CONTENT_TYPE,
  WWW_AUTHENTICATE,
} from "./responses";
import {
  API_PAGE_MAX,
  API_PER_PAGE_DEFAULT,
  API_PER_PAGE_MAX,
  API_QUERY_MAX_LENGTH,
  apiSchemaRegistry,
} from "./schemas";

type JsonObject = Record<string, unknown>;

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

/**
 * JSON Schema を読みやすくする: 日付・日時は format で表し、Zod が付ける長い正規表現（pattern）は外す。
 * 整数の既定の範囲（±Number.MAX_SAFE_INTEGER）も外す
 */
function tidy(schema: JsonObject): void {
  if (schema.format === "date" || schema.format === "date-time") {
    delete schema.pattern;
  }
  if (schema.maximum === Number.MAX_SAFE_INTEGER) delete schema.maximum;
  if (schema.minimum === Number.MIN_SAFE_INTEGER) delete schema.minimum;
}

function componentSchemas(): Record<string, JsonObject> {
  const { schemas } = z.toJSONSchema(apiSchemaRegistry, {
    target: "draft-2020-12",
    io: "output",
    unrepresentable: "throw",
    uri: (id) => `#/components/schemas/${id}`,
    override: (ctx) => tidy(ctx.jsonSchema as JsonObject),
  });
  return Object.fromEntries(
    Object.entries(schemas).map(([name, schema]) => {
      // コンポーネントの中では $schema（方言は OpenAPI 3.1 の既定 = JSON Schema 2020-12 ベース）と $id（参照は #/components/schemas/…）は不要
      const rest: JsonObject = { ...schema };
      delete rest.$schema;
      delete rest.$id;
      return [name, rest];
    }),
  );
}

const problemContent = { [PROBLEM_CONTENT_TYPE]: { schema: ref("Problem") } };

const responseRef = (name: string) => ({
  $ref: `#/components/responses/${name}`,
});

const RESPONSES = {
  BadRequest: {
    description:
      "リクエストの誤り。検証エラーは errors に項目ごとの内容（本文の項目は pointer、クエリ・パスは parameter）",
    content: problemContent,
  },
  Unauthorized: {
    description:
      "認証の失敗（Authorization ヘッダーがない・形式が違う・トークンが存在しない・失効済み・ユーザーが無効。理由は区別しない）",
    headers: {
      "WWW-Authenticate": {
        description: `常に ${WWW_AUTHENTICATE}`,
        schema: { type: "string" },
      },
    },
    content: problemContent,
  },
  Forbidden: {
    description: "トークンの持ち主のロールに、この操作の権限がない",
    content: problemContent,
  },
  NotFound: {
    description: "対象が見つからない",
    content: problemContent,
  },
  ContentTooLarge: {
    description: `本文が大きすぎる（上限 ${API_BODY_MAX_BYTES} バイト）`,
    content: problemContent,
  },
  UnsupportedMediaType: {
    description:
      "本文が JSON（Content-Type: application/json、UTF-8）でない。Accept-Post: application/json を返す",
    headers: {
      "Accept-Post": {
        description: "受け付ける Content-Type",
        schema: { type: "string" },
      },
    },
    content: problemContent,
  },
};

const PARAMETERS = {
  page: {
    name: "page",
    in: "query",
    description:
      "ページ番号（1 始まり）。全件数を超えるページは data が空になる",
    schema: { type: "integer", minimum: 1, maximum: API_PAGE_MAX, default: 1 },
  },
  perPage: {
    name: "perPage",
    in: "query",
    description: `1 ページの件数（既定 ${API_PER_PAGE_DEFAULT}・上限 ${API_PER_PAGE_MAX}）`,
    schema: {
      type: "integer",
      minimum: 1,
      maximum: API_PER_PAGE_MAX,
      default: API_PER_PAGE_DEFAULT,
    },
  },
};

const json = (schemaName: string) => ({
  [JSON_CONTENT_TYPE]: { schema: ref(schemaName) },
});

const INFO_DESCRIPTION = `StockFlow（受発注・在庫管理のデモ）の外部向け REST API です。データはすべて架空です。

## 認証
\`Authorization: Bearer <token>\` でトークンを送ります。トークンは admin がユーザー管理画面（ユーザーの詳細）で発行します（表示は発行時の 1 回のみ）。
画面のログイン（Cookie）では API を使えません。

## 権限
トークンの持ち主の現在のロールに従います。参照（GET）は admin／staff／viewer、受注の登録（POST）は admin／staff。

## 形式
- 一覧は \`{ data, meta: { page, perPage, total } }\`。perPage は既定 ${API_PER_PAGE_DEFAULT}・上限 ${API_PER_PAGE_MAX}
- 金額（円）・数量は整数、日付は YYYY-MM-DD、日時は ISO 8601（UTC）
- 商品・取引先・受注はコード・番号で表します（内部の ID は出しません）
- エラーは RFC 9457（application/problem+json）。detail は日本語`;

/** OpenAPI 3.1 の定義 */
export function buildOpenApiDocument(): JsonObject {
  return {
    openapi: "3.1.0",
    info: {
      title: "StockFlow API",
      version: "1.0.0",
      description: INFO_DESCRIPTION,
    },
    tags: [
      { name: "products", description: "商品・在庫" },
      { name: "sales-orders", description: "受注" },
      { name: "meta", description: "API の定義" },
    ],
    security: [{ bearerAuth: [] }],
    paths: {
      "/api/v1/products": {
        get: {
          tags: ["products"],
          operationId: "listProducts",
          summary: "商品一覧（現在庫を含む）",
          description:
            "商品コードの昇順。無効な商品も含みます（isActive で区別）",
          parameters: [
            {
              name: "q",
              in: "query",
              description:
                "商品コード・商品名・カテゴリの部分一致（大文字・小文字は区別しない）",
              schema: { type: "string", maxLength: API_QUERY_MAX_LENGTH },
            },
            { $ref: "#/components/parameters/page" },
            { $ref: "#/components/parameters/perPage" },
          ],
          responses: {
            "200": { description: "商品一覧", content: json("ProductList") },
            "400": responseRef("BadRequest"),
            "401": responseRef("Unauthorized"),
            "403": responseRef("Forbidden"),
          },
        },
      },
      "/api/v1/products/{code}/stock": {
        get: {
          tags: ["products"],
          operationId: "getProductStock",
          summary: "商品の現在庫と発注点",
          parameters: [
            {
              name: "code",
              in: "path",
              required: true,
              description: "商品コード（大文字・小文字は区別しない）",
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "現在庫と発注点",
              content: json("ProductStock"),
            },
            "401": responseRef("Unauthorized"),
            "403": responseRef("Forbidden"),
            "404": responseRef("NotFound"),
          },
        },
      },
      "/api/v1/sales-orders": {
        get: {
          tags: ["sales-orders"],
          operationId: "listSalesOrders",
          summary: "受注一覧",
          description: "受注日の新しい順（同じ日は受注番号の降順）",
          parameters: [
            {
              name: "status",
              in: "query",
              description: "ステータスで絞り込む",
              schema: { type: "string", enum: [...SALES_ORDER_STATUSES] },
            },
            {
              name: "from",
              in: "query",
              description: "受注日がこの日以降（YYYY-MM-DD。この日を含む）",
              schema: { type: "string", format: "date" },
            },
            {
              name: "to",
              in: "query",
              description:
                "受注日がこの日以前（YYYY-MM-DD。この日を含む）。from より前は 400",
              schema: { type: "string", format: "date" },
            },
            { $ref: "#/components/parameters/page" },
            { $ref: "#/components/parameters/perPage" },
          ],
          responses: {
            "200": { description: "受注一覧", content: json("SalesOrderList") },
            "400": responseRef("BadRequest"),
            "401": responseRef("Unauthorized"),
            "403": responseRef("Forbidden"),
          },
        },
        post: {
          tags: ["sales-orders"],
          operationId: "createSalesOrder",
          summary: "受注の登録（下書き）",
          description:
            "draft（下書き）で作成します。受注日は登録した日（Asia/Tokyo）、受注番号は SO-YYYYMMDD-NNN で採番、単価は商品マスタの売価、金額（小計・消費税・合計）はサーバーで計算します。画面と同じ検証を行い、操作履歴に REST API からの作成として記録します",
          requestBody: {
            required: true,
            content: json("SalesOrderCreate"),
          },
          responses: {
            "201": {
              description: "作成した受注（明細を含む）",
              headers: {
                Location: {
                  description:
                    "作成した受注の URL（/api/v1/sales-orders/{number}）",
                  schema: { type: "string" },
                },
              },
              content: json("SalesOrder"),
            },
            "400": responseRef("BadRequest"),
            "401": responseRef("Unauthorized"),
            "403": responseRef("Forbidden"),
            "413": responseRef("ContentTooLarge"),
            "415": responseRef("UnsupportedMediaType"),
          },
        },
      },
      "/api/v1/sales-orders/{number}": {
        get: {
          tags: ["sales-orders"],
          operationId: "getSalesOrder",
          summary: "受注詳細（明細を含む）",
          parameters: [
            {
              name: "number",
              in: "path",
              required: true,
              description:
                "受注番号（例 SO-20261013-001。大文字・小文字は区別しない）",
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": { description: "受注詳細", content: json("SalesOrder") },
            "401": responseRef("Unauthorized"),
            "403": responseRef("Forbidden"),
            "404": responseRef("NotFound"),
          },
        },
      },
      "/api/v1/openapi.json": {
        get: {
          tags: ["meta"],
          operationId: "getOpenApiDocument",
          summary: "この API の OpenAPI 3.1 の定義（認証不要）",
          security: [],
          responses: {
            "200": {
              description: "OpenAPI 3.1 の定義",
              content: { [JSON_CONTENT_TYPE]: { schema: { type: "object" } } },
            },
          },
        },
      },
    },
    components: {
      schemas: componentSchemas(),
      responses: RESPONSES,
      parameters: PARAMETERS,
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description:
            "API トークン（sf_ で始まる文字列）。admin がユーザー管理画面で発行する",
        },
      },
    },
  };
}

/** docs/openapi.json に書く内容（2 スペースのインデント・末尾に改行） */
export function serializeOpenApiDocument(): string {
  return `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`;
}
