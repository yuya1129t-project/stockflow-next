/**
 * 受注・発注で共通の入力検証（Zod）。docs/spec.md §3・§8。純粋なモジュール（クライアントからも import できる）。
 *
 * 画面（React Hook Form）と Server Action で同じスキーマを使う。入力はすべて文字列（フォームの値）で受け取り、
 * 検証後に数値・日付へ変換する。伝票ごとのスキーマ（src/lib/purchase-orders/schema.ts など）はここの部品を組み合わせる。
 *
 * 明細:
 * - 商品 ID（選択）・数量（1 以上の整数）・単価（0 以上の整数）
 * - 同じ伝票に同じ商品の明細は 1 行だけ（重複は検証エラー。DB の一意制約でも守る）
 * - 行数の上限 ORDER_LINE_LIMITS.lines、合計の上限 ORDER_TOTAL_MAX
 */
import { z } from "zod";

import { normalizeDigits, PRODUCT_LIMITS } from "@/lib/products/schema";

import { calcOrderAmounts, ORDER_TOTAL_MAX } from "./amounts";
import { parseDateOnly } from "./dates";

export const ORDER_LINE_FIELD_LABELS = {
  productId: "商品",
  quantity: "数量",
  unitPrice: "単価",
} as const;

export type OrderLineField = keyof typeof ORDER_LINE_FIELD_LABELS;

export const ORDER_LINE_LIMITS = {
  /** 1 伝票の明細の行数の上限 */
  lines: 100,
  quantity: 9_999_999,
  unitPrice: PRODUCT_LIMITS.price,
  /** 備考の文字数 */
  note: 500,
} as const;

/** ID（選択式の項目。正の整数の文字列） */
export function idSchema(requiredMessage: string) {
  return z.string({ error: requiredMessage }).transform((value, ctx) => {
    const trimmed = value.trim();
    if (!/^\d{1,9}$/.test(trimmed) || Number(trimmed) < 1) {
      ctx.addIssue({ code: "custom", message: requiredMessage });
      return z.NEVER;
    }
    return Number(trimmed);
  });
}

/** min 以上 max 以下の整数（文字列で受け取って数値にする。全角数字・3 桁区切りも受け付ける） */
function integerSchema(label: string, min: 0 | 1, max: number) {
  return z
    .string({ error: `${label}を入力してください` })
    .transform((value, ctx) => {
      const normalized = normalizeDigits(value);
      if (normalized === "") {
        ctx.addIssue({ code: "custom", message: `${label}を入力してください` });
        return z.NEVER;
      }
      if (!/^\d+$/.test(normalized) || Number(normalized) < min) {
        ctx.addIssue({
          code: "custom",
          message: `${label}は${min}以上の整数で入力してください`,
        });
        return z.NEVER;
      }
      const number = Number(normalized);
      if (number > max) {
        ctx.addIssue({
          code: "custom",
          message: `${label}は${max.toLocaleString("ja-JP")}以下で入力してください`,
        });
        return z.NEVER;
      }
      return number;
    });
}

export const orderLineSchema = z.object({
  productId: idSchema("商品を選択してください"),
  quantity: integerSchema("数量", 1, ORDER_LINE_LIMITS.quantity),
  unitPrice: integerSchema("単価", 0, ORDER_LINE_LIMITS.unitPrice),
});

/** 明細の一覧（行数の上限・同じ商品の重複・合計の上限） */
export const orderLinesSchema = z
  .array(orderLineSchema, { error: "明細の形式が正しくありません" })
  .max(ORDER_LINE_LIMITS.lines, `明細は${ORDER_LINE_LIMITS.lines}行までです`)
  .superRefine((lines, ctx) => {
    const firstRow = new Map<number, number>();
    lines.forEach((line, index) => {
      const first = firstRow.get(line.productId);
      if (first === undefined) {
        firstRow.set(line.productId, index);
        return;
      }
      ctx.addIssue({
        code: "custom",
        path: [index, "productId"],
        message: `同じ商品の明細が ${first + 1} 行目にあります（数量は 1 行にまとめてください）`,
      });
    });
    if (calcOrderAmounts(lines) === null) {
      ctx.addIssue({
        code: "custom",
        message: `合計金額が上限（${ORDER_TOTAL_MAX.toLocaleString("ja-JP")} 円）を超えています`,
      });
    }
  });

/** 明細の商品の選択肢（画面の明細編集に渡す） */
export interface LineProductOption {
  id: number;
  code: string;
  name: string;
  unit: string;
  /** 単価の初期値（発注は仕入単価、受注は売価） */
  price: number;
  isActive: boolean;
}

export type OrderLineFormValues = z.input<typeof orderLineSchema>;
export type OrderLineInput = z.output<typeof orderLineSchema>;

export const EMPTY_ORDER_LINE: OrderLineFormValues = {
  productId: "",
  quantity: "1",
  unitPrice: "",
};

/** 保存済みの明細をフォームの値にする */
export function toOrderLineFormValues(
  line: OrderLineInput,
): OrderLineFormValues {
  return {
    productId: String(line.productId),
    quantity: String(line.quantity),
    unitPrice: String(line.unitPrice),
  };
}

/** 日付（必須。"YYYY-MM-DD" → UTC 0 時の Date） */
export function requiredDateSchema(label: string) {
  return z
    .string({ error: `${label}を入力してください` })
    .transform((value, ctx) => {
      const trimmed = value.trim();
      if (trimmed === "") {
        ctx.addIssue({ code: "custom", message: `${label}を入力してください` });
        return z.NEVER;
      }
      const date = parseDateOnly(trimmed);
      if (!date) {
        ctx.addIssue({
          code: "custom",
          message: `${label}は正しい日付で入力してください（例 2026-10-13）`,
        });
        return z.NEVER;
      }
      return date;
    });
}

/** 日付（任意。空なら null） */
export function optionalDateSchema(label: string) {
  return z
    .string({ error: `${label}の形式が正しくありません` })
    .transform((value, ctx) => {
      const trimmed = value.trim();
      if (trimmed === "") return null;
      const date = parseDateOnly(trimmed);
      if (!date) {
        ctx.addIssue({
          code: "custom",
          message: `${label}は正しい日付で入力してください（例 2026-10-13）`,
        });
        return z.NEVER;
      }
      return date;
    });
}

/** 備考（任意。改行は使える。ほかの制御文字は不可。空なら null） */
export const orderNoteSchema = z
  .string({ error: "備考の形式が正しくありません" })
  .transform((value) => value.replace(/\r\n?/g, "\n").trim())
  .pipe(
    z
      .string()
      .max(
        ORDER_LINE_LIMITS.note,
        `備考は${ORDER_LINE_LIMITS.note}文字以内で入力してください`,
      )
      .regex(
        /^[^\u0000-\u0009\u000b-\u001f\u007f]*$/,
        "備考にタブなどの制御文字は使えません",
      ),
  )
  .transform((value) => (value === "" ? null : value));

/**
 * 検証エラーを「項目のパス → メッセージ」にする（例 "supplierId"、"lines.0.quantity"、明細全体は "lines"）。
 * 画面では react-hook-form の setError にそのまま渡せる
 */
export type OrderFieldErrors = Record<string, string[]>;

export function orderFieldErrors(error: z.ZodError): OrderFieldErrors {
  const result: OrderFieldErrors = {};
  for (const issue of error.issues) {
    const key = issue.path.map(String).join(".") || "_form";
    (result[key] ??= []).push(issue.message);
  }
  return result;
}
