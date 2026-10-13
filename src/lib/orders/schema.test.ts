import { describe, expect, it } from "vitest";

import {
  DB_ID_MAX,
  isValidDbId,
  optionalDateSchema,
  orderFieldErrors,
  orderLineSchema,
  orderLinesSchema,
  orderNoteSchema,
  requiredDateSchema,
} from "./schema";

const line = (productId: string, quantity = "1", unitPrice = "100") => ({
  productId,
  quantity,
  unitPrice,
});

function errorsOf(
  schema: { safeParse: (v: unknown) => unknown },
  value: unknown,
) {
  const result = schema.safeParse(value) as
    | { success: true }
    | { success: false; error: Parameters<typeof orderFieldErrors>[0] };
  return result.success ? {} : orderFieldErrors(result.error);
}

describe("orderLineSchema（明細 1 行）", () => {
  it("文字列を数値にする（全角数字・3 桁区切りも受け付ける）", () => {
    expect(
      orderLineSchema.parse({
        productId: "12",
        quantity: "１，２００",
        unitPrice: "0",
      }),
    ).toEqual({ productId: 12, quantity: 1200, unitPrice: 0 });
  });

  it("商品は必須、数量は 1 以上、単価は 0 以上の整数", () => {
    expect(errorsOf(orderLineSchema, line("", "0", "-1"))).toEqual({
      productId: ["商品を選択してください"],
      quantity: ["数量は1以上の整数で入力してください"],
      unitPrice: ["単価は0以上の整数で入力してください"],
    });
    expect(errorsOf(orderLineSchema, line("1", "1.5", "abc"))).toEqual({
      quantity: ["数量は1以上の整数で入力してください"],
      unitPrice: ["単価は0以上の整数で入力してください"],
    });
    expect(errorsOf(orderLineSchema, line("1", "", ""))).toEqual({
      quantity: ["数量を入力してください"],
      unitPrice: ["単価を入力してください"],
    });
  });

  it("数値（JSON の number。REST API 用）も受け付ける。小数・負・範囲外はエラー", () => {
    expect(
      orderLineSchema.parse({ productId: 5, quantity: 10, unitPrice: 0 }),
    ).toEqual({ productId: 5, quantity: 10, unitPrice: 0 });
    expect(
      errorsOf(orderLineSchema, {
        productId: 2 ** 40,
        quantity: 1.5,
        unitPrice: -1,
      }),
    ).toEqual({
      productId: ["商品を選択してください"],
      quantity: ["数量は1以上の整数で入力してください"],
      unitPrice: ["単価は0以上の整数で入力してください"],
    });
    expect(
      errorsOf(orderLineSchema, {
        productId: true,
        quantity: null,
        unitPrice: {},
      }),
    ).toEqual({
      productId: ["商品を選択してください"],
      quantity: ["数量を入力してください"],
      unitPrice: ["単価を入力してください"],
    });
  });

  it("上限を超える数量・単価はエラー", () => {
    expect(
      errorsOf(orderLineSchema, line("1", "10000000", "100000000")),
    ).toEqual({
      quantity: ["数量は9,999,999以下で入力してください"],
      unitPrice: ["単価は99,999,999以下で入力してください"],
    });
  });

  it("商品 ID が正の整数でなければ「商品を選択してください」", () => {
    for (const productId of ["0", "-1", "abc", "1.5", "1234567890"]) {
      expect(errorsOf(orderLineSchema, line(productId)), productId).toEqual({
        productId: ["商品を選択してください"],
      });
    }
  });
});

describe("orderLinesSchema（明細の一覧）", () => {
  it("0 行も受け付ける（下書き）", () => {
    expect(orderLinesSchema.parse([])).toEqual([]);
  });

  it("同じ商品の明細が重複したら、2 つ目以降の行の商品のエラー", () => {
    expect(
      errorsOf(orderLinesSchema, [line("1"), line("2"), line("1"), line("1")]),
    ).toEqual({
      "2.productId": [
        "同じ商品の明細が 1 行目にあります（数量は 1 行にまとめてください）",
      ],
      "3.productId": [
        "同じ商品の明細が 1 行目にあります（数量は 1 行にまとめてください）",
      ],
    });
  });

  it("101 行以上はエラー", () => {
    const lines = Array.from({ length: 101 }, (_, i) => line(String(i + 1)));
    expect(errorsOf(orderLinesSchema, lines)).toEqual({
      _form: ["明細は100行までです"],
    });
    expect(orderLinesSchema.parse(lines.slice(0, 100))).toHaveLength(100);
  });

  it("合計が上限を超えるとエラー", () => {
    expect(
      errorsOf(orderLinesSchema, [
        line("1", "9999999", "99999999"),
        line("2", "9999999", "99999999"),
      ]),
    ).toEqual({
      _form: ["合計金額が上限（999,999,999 円）を超えています"],
    });
  });
});

describe("日付", () => {
  it("必須の日付: 空・不正な日付はエラー", () => {
    const schema = requiredDateSchema("発注日");
    expect(schema.parse("2026-10-13").toISOString()).toBe(
      "2026-10-13T00:00:00.000Z",
    );
    expect(errorsOf(schema, "")).toEqual({
      _form: ["発注日を入力してください"],
    });
    expect(errorsOf(schema, "2026-02-30")).toEqual({
      _form: ["発注日は正しい日付で入力してください（例 2026-10-13）"],
    });
  });

  it("任意の日付: 空は null", () => {
    const schema = optionalDateSchema("入荷予定日");
    expect(schema.parse("")).toBeNull();
    expect(schema.parse(" 2026-10-20 ")?.toISOString()).toBe(
      "2026-10-20T00:00:00.000Z",
    );
    expect(errorsOf(schema, "10/20")).toEqual({
      _form: ["入荷予定日は正しい日付で入力してください（例 2026-10-13）"],
    });
  });
});

describe("orderNoteSchema（備考）", () => {
  it("空は null、改行は使える（CRLF は LF にそろえる）", () => {
    expect(orderNoteSchema.parse("  ")).toBeNull();
    expect(orderNoteSchema.parse("1 行目\r\n2 行目")).toBe("1 行目\n2 行目");
  });

  it("タブなどの制御文字・501 文字以上はエラー", () => {
    expect(errorsOf(orderNoteSchema, "a\tb")).toEqual({
      _form: ["備考にタブなどの制御文字は使えません"],
    });
    for (const char of [
      "\u2028",
      "\u2029",
      "\u202e",
      "\u2066",
      "\ufeff",
      "\u0085",
    ]) {
      expect(errorsOf(orderNoteSchema, `a${char}b`)).toEqual({
        _form: ["備考にタブなどの制御文字は使えません"],
      });
    }
    expect(errorsOf(orderNoteSchema, "あ".repeat(501))).toEqual({
      _form: ["備考は500文字以内で入力してください"],
    });
    expect(orderNoteSchema.parse("あ".repeat(500))).toHaveLength(500);
  });
});

describe("isValidDbId（DB の int の範囲の ID）", () => {
  it("1 以上 2,147,483,647 以下の整数だけ", () => {
    expect(isValidDbId(1)).toBe(true);
    expect(isValidDbId(DB_ID_MAX)).toBe(true);
    for (const value of [0, -1, DB_ID_MAX + 1, 2 ** 40, 1.5, NaN, "1", null]) {
      expect(isValidDbId(value), String(value)).toBe(false);
    }
  });
});
