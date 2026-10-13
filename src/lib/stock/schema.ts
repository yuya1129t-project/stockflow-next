/**
 * 棚卸調整の入力検証（Zod）。docs/spec.md §4「棚卸調整」・§8。
 *
 * 画面（React Hook Form）と Server Action で同じスキーマを使う。入力は文字列で受け取り、実数は数値に変換する。
 * 純粋なモジュール（クライアントからも import できる）
 */
import { z } from "zod";

import { normalizeDigits } from "@/lib/products/schema";
import { SINGLE_LINE, singleLineMessage } from "@/lib/validation/text";

export const STOCK_ADJUST_FIELD_LABELS = {
  actualQuantity: "実数",
  reason: "理由",
} as const;

export type StockAdjustField = keyof typeof STOCK_ADJUST_FIELD_LABELS;

export const STOCK_ADJUST_LIMITS = {
  /** 実数の上限 */
  actualQuantity: 9_999_999,
  reason: 200,
} as const;

export const stockAdjustSchema = z.object({
  actualQuantity: z
    .string({ error: "実数を入力してください" })
    .transform((value, ctx) => {
      const normalized = normalizeDigits(value);
      if (normalized === "") {
        ctx.addIssue({ code: "custom", message: "実数を入力してください" });
        return z.NEVER;
      }
      if (!/^\d+$/.test(normalized)) {
        ctx.addIssue({
          code: "custom",
          message: "実数は0以上の整数で入力してください",
        });
        return z.NEVER;
      }
      const number = Number(normalized);
      if (number > STOCK_ADJUST_LIMITS.actualQuantity) {
        ctx.addIssue({
          code: "custom",
          message: `実数は${STOCK_ADJUST_LIMITS.actualQuantity.toLocaleString("ja-JP")}以下で入力してください`,
        });
        return z.NEVER;
      }
      return number;
    }),
  reason: z
    .string({ error: "理由を入力してください" })
    .trim()
    .min(1, { error: "理由を入力してください", abort: true })
    .max(
      STOCK_ADJUST_LIMITS.reason,
      `理由は${STOCK_ADJUST_LIMITS.reason}文字以内で入力してください`,
    )
    .regex(SINGLE_LINE, singleLineMessage("理由")),
});

/** フォームから受け取る値（すべて文字列） */
export type StockAdjustFormValues = z.input<typeof stockAdjustSchema>;
/** 検証後の値（実数は数値） */
export type StockAdjustInput = z.output<typeof stockAdjustSchema>;

export type StockAdjustFieldErrors = Partial<
  Record<StockAdjustField, string[]>
>;

export function stockAdjustFieldErrors(
  error: z.ZodError,
): StockAdjustFieldErrors {
  return z.flattenError(error).fieldErrors as StockAdjustFieldErrors;
}

export const EMPTY_STOCK_ADJUST_FORM: StockAdjustFormValues = {
  actualQuantity: "",
  reason: "",
};
