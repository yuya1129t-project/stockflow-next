/**
 * 外部向け REST API（/api/v1。docs/spec.md §6-2）の入出力スキーマ（Zod）。API 仕様の定義はこのファイルが 1 か所。
 *
 * - OpenAPI 3.1 の定義（src/lib/api/v1/openapi.ts → /api/v1/openapi.json・docs/openapi.json）は、
 *   ここのスキーマを z.toJSONSchema で JSON Schema にして組み立てる（手書きの JSON Schema と食い違わない）
 * - 応答の形は serialize.ts がこの型（z.output）に合わせて作る。実際の応答が OpenAPI のスキーマに合うことは
 *   結合テスト（tests/integration/rest-api.test.ts）で ajv を使って検証する
 * - 受注の登録の本文（salesOrderCreateSchema）は型・必須・余分な項目だけをここで検査する。業務の検証
 *   （顧客の種別・商品の有効・数量・納期・合計の上限など）は画面と同じ受注の service（src/lib/sales-orders/service.ts）で行う
 * - スキーマには transform を使わない（JSON Schema で表せないため。コードの大文字化などは呼び出し側で行う）
 */
import { z } from "zod";

import { ORDER_TOTAL_MAX } from "@/lib/orders/amounts";
import { ORDER_DATE_MAX_YEAR, ORDER_DATE_MIN_YEAR } from "@/lib/orders/dates";
import { ORDER_LINE_LIMITS } from "@/lib/orders/schema";
import { PARTNER_LIMITS } from "@/lib/partners/schema";
import { PRODUCT_LIMITS } from "@/lib/products/schema";
import { SALES_ORDER_STATUSES } from "@/lib/sales-orders/status";

/** OpenAPI の components.schemas に載せるスキーマ（id が名前） */
export const apiSchemaRegistry = z.registry<{ id: string }>();

function component<T extends z.ZodType>(
  id: string,
  description: string,
  schema: T,
): T {
  // 説明は describe（z.globalRegistry）に入れる（JSON Schema の description になる）
  const described = schema.describe(description);
  apiSchemaRegistry.add(described, { id });
  return described;
}

/** 一覧の 1 ページの件数（spec §6-2: 既定 20・上限 100） */
export const API_PER_PAGE_DEFAULT = 20;
export const API_PER_PAGE_MAX = 100;
/** ページ番号の上限（極端な OFFSET を避ける） */
export const API_PAGE_MAX = 1_000_000;
/** 検索語（q）の最大長（画面の検索と同じ） */
export const API_QUERY_MAX_LENGTH = 100;

/**
 * 日付が受け付けられる範囲（parseDateOnly と同じ 2000〜2099 年）。OpenAPI では日付の項目・パラメーターに
 * この pattern と説明を付ける（② Laravel・③ FastAPI 版と 400 になる範囲を揃えるため。src/lib/api/v1/openapi.ts）
 */
export const API_DATE_RANGE_TEXT = `${ORDER_DATE_MIN_YEAR}〜${ORDER_DATE_MAX_YEAR} 年`;
export const API_DATE_PATTERN = "^20[0-9]{2}-[0-9]{2}-[0-9]{2}$";

const date = () => z.iso.date();
const dateTime = () => z.iso.datetime();
const yen = (description: string) =>
  z.int().min(0).max(ORDER_TOTAL_MAX).describe(`${description}（円）`);

export const pageMetaSchema = component(
  "PageMeta",
  "一覧のページ情報",
  z.object({
    page: z.int().min(1).max(API_PAGE_MAX).describe("ページ番号（1 始まり）"),
    perPage: z.int().min(1).max(API_PER_PAGE_MAX).describe("1 ページの件数"),
    total: z.int().min(0).describe("条件に合う全件数"),
  }),
);

export const productSchema = component(
  "Product",
  "商品（現在庫を含む）",
  z.object({
    code: z.string().describe("商品コード（例 P-0001）"),
    name: z.string().describe("商品名"),
    category: z.string().describe("カテゴリ"),
    unit: z.string().describe("単位"),
    salesPrice: z.int().min(0).max(PRODUCT_LIMITS.price).describe("売価（円）"),
    purchasePrice: z
      .int()
      .min(0)
      .max(PRODUCT_LIMITS.price)
      .describe("仕入単価（円）"),
    reorderPoint: z
      .int()
      .min(0)
      .max(PRODUCT_LIMITS.reorderPoint)
      .describe("発注点"),
    isActive: z
      .boolean()
      .describe("有効か（無効な商品は新規の受注で指定できない）"),
    stock: z.int().describe("現在庫（入出庫の合計）"),
    belowReorderPoint: z
      .boolean()
      .describe("発注点割れか（有効な商品で 現在庫 < 発注点）"),
  }),
);

export const productListSchema = component(
  "ProductList",
  "商品一覧",
  z.object({ data: z.array(productSchema), meta: pageMetaSchema }),
);

export const productStockSchema = component(
  "ProductStock",
  "商品の現在庫と発注点",
  z.object({
    code: z.string().describe("商品コード"),
    name: z.string().describe("商品名"),
    unit: z.string().describe("単位"),
    isActive: z.boolean().describe("有効か"),
    stock: z.int().describe("現在庫（入出庫の合計）"),
    reorderPoint: z
      .int()
      .min(0)
      .max(PRODUCT_LIMITS.reorderPoint)
      .describe("発注点"),
    belowReorderPoint: z
      .boolean()
      .describe("発注点割れか（有効な商品で 現在庫 < 発注点）"),
  }),
);

export const salesOrderStatusSchema = component(
  "SalesOrderStatus",
  "受注のステータス（draft 下書き／confirmed 確定／shipped 出荷済／cancelled 取消）",
  z.enum(SALES_ORDER_STATUSES),
);

export const customerRefSchema = component(
  "CustomerRef",
  "顧客",
  z.object({
    code: z.string().describe("取引先コード（例 C-0001）"),
    name: z.string().describe("取引先名"),
  }),
);

export const productRefSchema = component(
  "ProductRef",
  "明細の商品",
  z.object({
    code: z.string().describe("商品コード"),
    name: z.string().describe("商品名"),
    unit: z.string().describe("単位"),
  }),
);

export const salesOrderSummarySchema = component(
  "SalesOrderSummary",
  "受注（一覧の 1 件。明細は含まない）",
  z.object({
    number: z.string().describe("受注番号（SO-YYYYMMDD-NNN）"),
    orderDate: date().describe(`受注日（YYYY-MM-DD。${API_DATE_RANGE_TEXT}）`),
    dueDate: date()
      .nullable()
      .describe(`納期（YYYY-MM-DD。${API_DATE_RANGE_TEXT}。未設定は null）`),
    status: salesOrderStatusSchema,
    customer: customerRefSchema,
    subtotal: yen("小計"),
    tax: yen("消費税（10%、1 円未満切り捨て）"),
    total: yen("合計"),
    note: z.string().nullable().describe("備考（未設定は null）"),
    lineCount: z
      .int()
      .min(0)
      .max(ORDER_LINE_LIMITS.lines)
      .describe("明細の行数"),
  }),
);

export const salesOrderListSchema = component(
  "SalesOrderList",
  "受注一覧",
  z.object({ data: z.array(salesOrderSummarySchema), meta: pageMetaSchema }),
);

export const salesOrderLineSchema = component(
  "SalesOrderLine",
  "受注の明細",
  z.object({
    product: productRefSchema,
    quantity: z.int().min(1).max(ORDER_LINE_LIMITS.quantity).describe("数量"),
    unitPrice: z
      .int()
      .min(0)
      .max(ORDER_LINE_LIMITS.unitPrice)
      .describe("単価（円。受注時点の値）"),
    amount: yen("金額（数量 × 単価）"),
  }),
);

export const salesOrderSchema = component(
  "SalesOrder",
  "受注（明細を含む）",
  z.object({
    number: z.string().describe("受注番号（SO-YYYYMMDD-NNN）"),
    orderDate: date().describe(`受注日（YYYY-MM-DD。${API_DATE_RANGE_TEXT}）`),
    dueDate: date()
      .nullable()
      .describe(`納期（YYYY-MM-DD。${API_DATE_RANGE_TEXT}。未設定は null）`),
    status: salesOrderStatusSchema,
    customer: customerRefSchema,
    note: z.string().nullable().describe("備考（未設定は null）"),
    subtotal: yen("小計"),
    tax: yen("消費税（10%、1 円未満切り捨て）"),
    total: yen("合計"),
    lines: z.array(salesOrderLineSchema).describe("明細（登録した順）"),
    createdAt: dateTime().describe("作成日時（ISO 8601、UTC）"),
    updatedAt: dateTime().describe("更新日時（ISO 8601、UTC）"),
  }),
);

export const salesOrderCreateLineSchema = component(
  "SalesOrderCreateLine",
  "受注の登録の明細（単価は商品マスタの売価）",
  z.strictObject({
    productCode: z
      .string()
      .min(1)
      .max(PRODUCT_LIMITS.code)
      .describe("商品コード（大文字・小文字は区別しない）"),
    quantity: z.int().min(1).max(ORDER_LINE_LIMITS.quantity).describe("数量"),
  }),
);

export const salesOrderCreateSchema = component(
  "SalesOrderCreate",
  "受注の登録（draft で作成。受注日は登録した日（Asia/Tokyo））",
  z.strictObject({
    customerCode: z
      .string()
      .min(1)
      .max(PARTNER_LIMITS.code)
      .describe(
        "顧客の取引先コード（大文字・小文字は区別しない。種別が顧客か顧客・仕入先で、有効なもの）",
      ),
    dueDate: date()
      .nullable()
      .optional()
      .describe(
        `納期（YYYY-MM-DD。${API_DATE_RANGE_TEXT}で、受注日以降。省略・null は未設定）`,
      ),
    note: z
      .string()
      .max(ORDER_LINE_LIMITS.note)
      .nullable()
      .optional()
      .describe(
        `備考（${ORDER_LINE_LIMITS.note} 文字以内。改行以外の制御文字は不可。省略・null は未設定）`,
      ),
    lines: z
      .array(salesOrderCreateLineSchema)
      .min(1)
      .max(ORDER_LINE_LIMITS.lines)
      .describe(
        `明細（1〜${ORDER_LINE_LIMITS.lines} 行。同じ商品は 1 行にまとめる。有効な商品のみ）`,
      ),
  }),
);

export type SalesOrderCreateBody = z.output<typeof salesOrderCreateSchema>;

export const problemFieldErrorSchema = component(
  "ProblemFieldError",
  "項目ごとのエラー（本文の項目は pointer、クエリ・パスのパラメーターは parameter で示す）",
  z.object({
    pointer: z
      .string()
      .optional()
      .describe("本文の項目の JSON Pointer（例 #/lines/0/quantity）"),
    parameter: z
      .string()
      .optional()
      .describe("クエリ・パスのパラメーター名（例 perPage）"),
    detail: z.string().describe("エラーの内容（日本語）"),
  }),
);

export const problemSchema = component(
  "Problem",
  "エラー（RFC 9457 Problem Details。Content-Type は application/problem+json）",
  z.object({
    type: z
      .string()
      .describe(
        "問題の種類の URI。この API では about:blank（HTTP のステータスどおりの意味）",
      ),
    title: z.string().describe("HTTP のステータスの説明（英語）"),
    status: z.int().min(400).max(599).describe("HTTP のステータスコード"),
    detail: z.string().describe("エラーの内容（日本語）"),
    errors: z
      .array(problemFieldErrorSchema)
      .optional()
      .describe("項目ごとのエラー（400 の検証エラーのとき）"),
  }),
);

export type Problem = z.output<typeof problemSchema>;
export type ProblemFieldError = z.output<typeof problemFieldErrorSchema>;
