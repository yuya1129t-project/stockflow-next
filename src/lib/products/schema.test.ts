import { describe, expect, it } from "vitest";

import {
  EMPTY_PRODUCT_FORM,
  productFieldErrors,
  productInputSchema,
  toProductFormValues,
  type ProductFormValues,
} from "./schema";

const VALID: ProductFormValues = {
  code: "P-0101",
  name: "テスト用ボールペン 黒",
  category: "文具",
  unit: "本",
  salesPrice: "120",
  purchasePrice: "80",
  reorderPoint: "10",
};

function errorsOf(values: Partial<ProductFormValues>) {
  const result = productInputSchema.safeParse({ ...VALID, ...values });
  if (result.success) throw new Error("検証が通ってしまいました");
  return productFieldErrors(result.error);
}

describe("productInputSchema", () => {
  it("正しい入力は数値に変換される（前後の空白は除く）", () => {
    expect(
      productInputSchema.parse({ ...VALID, name: "  テスト用ボールペン 黒 " }),
    ).toEqual({
      code: "P-0101",
      name: "テスト用ボールペン 黒",
      category: "文具",
      unit: "本",
      salesPrice: 120,
      purchasePrice: 80,
      reorderPoint: 10,
    });
  });

  it("全角数字と 3 桁区切りのカンマを受け付ける", () => {
    const result = productInputSchema.parse({
      ...VALID,
      salesPrice: "１，２００",
      purchasePrice: "1,200",
      reorderPoint: "0",
    });
    expect(result).toMatchObject({
      salesPrice: 1200,
      purchasePrice: 1200,
      reorderPoint: 0,
    });
  });

  it("空の必須項目は日本語のエラー", () => {
    const result = productInputSchema.safeParse(EMPTY_PRODUCT_FORM);
    expect(result.success).toBe(false);
    expect(productFieldErrors(result.error!)).toEqual({
      code: ["商品コードを入力してください"],
      name: ["商品名を入力してください"],
      category: ["カテゴリを入力してください"],
      unit: ["単位を入力してください"],
      salesPrice: ["売価を入力してください"],
      purchasePrice: ["仕入単価を入力してください"],
      reorderPoint: ["発注点を入力してください"],
    });
  });

  it.each(["-1", "1.5", "abc", "1e3", "1,2", "12,00"])(
    "価格・発注点が 0 以上の整数でない（%j）とエラー",
    (value) => {
      expect(errorsOf({ salesPrice: value }).salesPrice).toEqual([
        "売価は0以上の整数で入力してください",
      ]);
    },
  );

  it("上限を超える値はエラー", () => {
    expect(errorsOf({ purchasePrice: "100000000" }).purchasePrice).toEqual([
      "仕入単価は99,999,999以下で入力してください",
    ]);
    expect(errorsOf({ reorderPoint: "10000000" }).reorderPoint).toEqual([
      "発注点は9,999,999以下で入力してください",
    ]);
  });

  it.each(["P 0001", "-P1", "商品1", "P/1"])(
    "商品コードの形式が不正（%j）だとエラー",
    (code) => {
      expect(errorsOf({ code }).code?.[0]).toContain("商品コードは半角英数字");
    },
  );

  it("商品コードは大文字に揃える", () => {
    expect(productInputSchema.parse({ ...VALID, code: " p-0101 " }).code).toBe(
      "P-0101",
    );
  });

  it.each(["名前\n2行目", "名前\r2行目", "タブ\t入り", "\u0000"])(
    "1 行で入力する項目に改行・制御文字（%j）があるとエラー",
    (name) => {
      expect(errorsOf({ name }).name).toEqual([
        "商品名に改行・タブなどの制御文字は使えません",
      ]);
    },
  );

  it.each([
    "名前\u2028次の行",
    "名前\u2029次の段落",
    "名前\u202e反転",
    "名前\u2066隔離",
    "名前\u200f方向",
    "名\ufeff前",
    "名前\u0085次",
    "名前\u009f",
  ])("行区切り・表示方向の制御・BOM・C1 制御（%j）もエラー", (name) => {
    for (const field of ["name", "category", "unit"] as const) {
      expect(errorsOf({ [field]: name })[field]).toEqual([
        `${field === "name" ? "商品名" : field === "category" ? "カテゴリ" : "単位"}に改行・タブなどの制御文字は使えません`,
      ]);
    }
  });

  it("日本語・記号・絵文字は通る", () => {
    const name = "ペン（黒）#1 〜限定〜 😀";
    expect(productInputSchema.parse({ ...VALID, name }).name).toBe(name);
  });

  it("文字数の上限", () => {
    expect(errorsOf({ code: "P".repeat(21) }).code).toEqual([
      "商品コードは20文字以内で入力してください",
    ]);
    expect(errorsOf({ name: "あ".repeat(101) }).name).toEqual([
      "商品名は100文字以内で入力してください",
    ]);
    expect(errorsOf({ unit: "x".repeat(11) }).unit).toEqual([
      "単位は10文字以内で入力してください",
    ]);
  });

  it("文字列以外（数値・未定義）を受け取ってもエラーで返す（例外にしない）", () => {
    const result = productInputSchema.safeParse({ ...VALID, salesPrice: 100 });
    expect(result.success).toBe(false);
    expect(productInputSchema.safeParse(null).success).toBe(false);
  });

  it("toProductFormValues で編集画面の初期値（文字列）にでき、検証すると元に戻る", () => {
    const input = productInputSchema.parse(VALID);
    expect(productInputSchema.parse(toProductFormValues(input))).toEqual(input);
  });
});
