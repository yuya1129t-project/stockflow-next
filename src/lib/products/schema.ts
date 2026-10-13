/**
 * 商品の入力検証（Zod）。docs/spec.md §3「Product」・§8。
 *
 * 画面（React Hook Form）・Server Action・CSV 取込で同じスキーマを使う。
 * 入力はすべて文字列（フォームの値・CSV のセル）で受け取り、検証後に数値へ変換する。
 * DB やフレームワークに依存しない純粋なモジュール（クライアントからも import できる）
 */
import { z } from "zod";
import { SINGLE_LINE, singleLineMessage } from "@/lib/validation/text";

/** 項目名（画面のラベル・CSV の見出し・エラー文で共通） */
export const PRODUCT_FIELD_LABELS = {
  code: "商品コード",
  name: "商品名",
  category: "カテゴリ",
  unit: "単位",
  salesPrice: "売価",
  purchasePrice: "仕入単価",
  reorderPoint: "発注点",
} as const;

export type ProductField = keyof typeof PRODUCT_FIELD_LABELS;

export const PRODUCT_FIELDS = Object.keys(
  PRODUCT_FIELD_LABELS,
) as ProductField[];

/** 文字数・値の上限 */
export const PRODUCT_LIMITS = {
  code: 20,
  name: 100,
  category: 50,
  unit: 10,
  /** 価格の上限（1 億円未満） */
  price: 99_999_999,
  reorderPoint: 9_999_999,
} as const;

function requiredText(field: ProductField, max: number) {
  const label = PRODUCT_FIELD_LABELS[field];
  return (
    z
      .string({ error: `${label}を入力してください` })
      .trim()
      // 空のときは形式のエラーを重ねて出さない
      .min(1, { error: `${label}を入力してください`, abort: true })
      .max(max, `${label}は${max}文字以内で入力してください`)
      // 1 行で入力する項目（CSV の引用の中の改行・タブなども受け付けない）
      .regex(SINGLE_LINE, singleLineMessage(label))
  );
}

/** 全角数字・全角カンマを半角にし、桁区切りのカンマを取り除く（Excel で編集した CSV・日本語入力を想定） */
export function normalizeDigits(value: string): string {
  const halfWidth = value
    .trim()
    .replace(/[０-９，]/g, (c) =>
      String.fromCharCode(c.charCodeAt(0) - 0xfee0),
    );
  // 3 桁ごとの区切り（1,200 など）だけを許す
  return /^\d{1,3}(,\d{3})+$/.test(halfWidth)
    ? halfWidth.replace(/,/g, "")
    : halfWidth;
}

/** 0 以上の整数（文字列で受け取って数値にする） */
function nonNegativeInt(field: ProductField, max: number) {
  const label = PRODUCT_FIELD_LABELS[field];
  return z
    .string({ error: `${label}を入力してください` })
    .transform((value, ctx) => {
      const normalized = normalizeDigits(value);
      if (normalized === "") {
        ctx.addIssue({ code: "custom", message: `${label}を入力してください` });
        return z.NEVER;
      }
      if (!/^\d+$/.test(normalized)) {
        ctx.addIssue({
          code: "custom",
          message: `${label}は0以上の整数で入力してください`,
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

export const productInputSchema = z.object({
  code: requiredText("code", PRODUCT_LIMITS.code)
    .regex(
      /^[A-Za-z0-9][A-Za-z0-9_-]*$/,
      "商品コードは半角英数字・ハイフン（-）・アンダースコア（_）で入力してください（先頭は英数字）",
    )
    // 大文字に揃える（p-0001 と P-0001 を別の商品にしない。CSV 取込の照合も大文字で行う）
    .toUpperCase(),
  name: requiredText("name", PRODUCT_LIMITS.name),
  category: requiredText("category", PRODUCT_LIMITS.category),
  unit: requiredText("unit", PRODUCT_LIMITS.unit),
  salesPrice: nonNegativeInt("salesPrice", PRODUCT_LIMITS.price),
  purchasePrice: nonNegativeInt("purchasePrice", PRODUCT_LIMITS.price),
  reorderPoint: nonNegativeInt("reorderPoint", PRODUCT_LIMITS.reorderPoint),
});

/** フォーム・CSV から受け取る値（すべて文字列） */
export type ProductFormValues = z.input<typeof productInputSchema>;
/** 検証後の値（価格・発注点は数値） */
export type ProductInput = z.output<typeof productInputSchema>;

/** 項目ごとのエラー（Server Action から画面へ返す） */
export type ProductFieldErrors = Partial<Record<ProductField, string[]>>;

/** 検証エラーを項目ごとのメッセージにする */
export function productFieldErrors(error: z.ZodError): ProductFieldErrors {
  return z.flattenError(error).fieldErrors as ProductFieldErrors;
}

/** 新規登録フォームの初期値 */
export const EMPTY_PRODUCT_FORM: ProductFormValues = {
  code: "",
  name: "",
  category: "",
  unit: "",
  salesPrice: "",
  purchasePrice: "",
  reorderPoint: "",
};

/** 保存済みの商品をフォームの値にする（編集画面の初期値） */
export function toProductFormValues(product: ProductInput): ProductFormValues {
  return {
    code: product.code,
    name: product.name,
    category: product.category,
    unit: product.unit,
    salesPrice: String(product.salesPrice),
    purchasePrice: String(product.purchasePrice),
    reorderPoint: String(product.reorderPoint),
  };
}
