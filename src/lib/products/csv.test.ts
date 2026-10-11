import { describe, expect, it } from "vitest";

import { CSV_BOM, toCsv } from "@/lib/csv";

import {
  buildProductCsv,
  parseProductImport,
  PRODUCT_CSV_HEADERS,
  PRODUCT_IMPORT_MAX_BYTES,
  PRODUCT_IMPORT_MAX_REPORTED_ERRORS,
  PRODUCT_IMPORT_MAX_ROWS,
} from "./csv";

const HEADER = [
  "商品コード",
  "商品名",
  "カテゴリ",
  "単位",
  "売価",
  "仕入単価",
  "発注点",
];

function row(code: string, overrides: Partial<Record<string, string>> = {}) {
  const values: Record<string, string> = {
    商品コード: code,
    商品名: `テスト商品 ${code}`,
    カテゴリ: "文具",
    単位: "個",
    売価: "150",
    仕入単価: "100",
    発注点: "5",
    ...overrides,
  };
  return HEADER.map((h) => values[h]);
}

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function parse(rows: string[][], { bom = false } = {}) {
  return parseProductImport(bytesOf((bom ? CSV_BOM : "") + toCsv(rows)));
}

describe("buildProductCsv（出力）", () => {
  it("見出し行と各商品の行を出力し、数式になるセルは無害化する", () => {
    const csv = buildProductCsv([
      {
        code: "P-1",
        name: '=HYPERLINK("x")',
        category: "文具",
        unit: "個",
        salesPrice: 1200,
        purchasePrice: 800,
        reorderPoint: 3,
        stock: 0,
        isActive: false,
      },
    ]);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe(PRODUCT_CSV_HEADERS.join(","));
    expect(lines[0]).toBe(
      "商品コード,商品名,カテゴリ,単位,売価,仕入単価,発注点,現在庫,状態",
    );
    expect(lines[1]).toBe(`P-1,"'=HYPERLINK(""x"")",文具,個,1200,800,3,0,無効`);
  });

  it("出力した CSV はそのまま取り込める（現在庫・状態の列は読み飛ばす。無害化の ' は外す）", () => {
    const csv = buildProductCsv([
      {
        code: "P-1",
        name: "-マイナスで始まる名前",
        category: "文具",
        unit: "個",
        salesPrice: 100,
        purchasePrice: 50,
        reorderPoint: 0,
        stock: 12,
        isActive: true,
      },
    ]);
    const result = parseProductImport(bytesOf(CSV_BOM + csv));
    expect(result).toEqual({
      ok: true,
      rows: [
        {
          line: 2,
          data: {
            code: "P-1",
            name: "-マイナスで始まる名前",
            category: "文具",
            unit: "個",
            salesPrice: 100,
            purchasePrice: 50,
            reorderPoint: 0,
          },
        },
      ],
    });
  });
});

describe("parseProductImport（取込の検証）", () => {
  it("正しいファイル（BOM あり・なし）は全行を返す", () => {
    for (const bom of [true, false]) {
      const result = parse([HEADER, row("T-1"), row("T-2")], { bom });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.rows.map((r) => [r.line, r.data.code])).toEqual([
          [2, "T-1"],
          [3, "T-2"],
        ]);
      }
    }
  });

  it("列の順番は問わず、知らない列は読み飛ばす。空行は無視する", () => {
    const header = ["メモ", ...HEADER.slice().reverse()];
    const data = ["無視される", ...row("T-1").slice().reverse()];
    const text = toCsv([header, data]) + "\r\n,,,,,,,,\r\n";
    const result = parseProductImport(bytesOf(text));
    expect(result.ok && result.rows[0].data).toMatchObject({
      code: "T-1",
      salesPrice: 150,
    });
  });

  it("1 行でもエラーがあれば ok: false で、行番号・項目・内容を返す", () => {
    const result = parse([
      HEADER,
      row("T-1"),
      row("T-2", { 売価: "-1", 商品名: "" }),
      row("T-3"),
      row("", { 発注点: "abc" }),
    ]);
    expect(result).toEqual({
      ok: false,
      totalErrors: 4,
      errors: [
        { line: 3, field: "商品名", message: "商品名を入力してください" },
        {
          line: 3,
          field: "売価",
          message: "売価は0以上の整数で入力してください",
        },
        {
          line: 5,
          field: "商品コード",
          message: "商品コードを入力してください",
        },
        {
          line: 5,
          field: "発注点",
          message: "発注点は0以上の整数で入力してください",
        },
      ],
    });
  });

  it("ファイル内で商品コードが重複していればエラー", () => {
    const result = parse([HEADER, row("T-1"), row("T-2"), row("T-1")]);
    expect(result).toEqual({
      ok: false,
      totalErrors: 1,
      errors: [
        {
          line: 4,
          field: "商品コード",
          message: "商品コード「T-1」が 2 行目と重複しています",
        },
      ],
    });
  });

  it("行番号は、項目内の改行があってもファイルの行を指す", () => {
    const result = parse([
      HEADER,
      row("T-1", { 商品名: "1行目\n2行目" }),
      row("T-2", { 売価: "x" }),
    ]);
    expect(!result.ok && result.errors[0].line).toBe(4);
  });

  it("必須の見出しが無い・重複しているとエラー", () => {
    const result = parse([
      [
        "商品コード",
        "商品名",
        "商品名",
        "カテゴリ",
        "単位",
        "売価",
        "仕入単価",
      ],
      ["T-1", "a", "a", "文具", "個", "1", "1"],
    ]);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors.map((e) => e.message)).toEqual([
      "見出し「商品名」が重複しています",
      "見出し行に「発注点」の列がありません",
    ]);
  });

  it(`データ行の上限（${PRODUCT_IMPORT_MAX_ROWS} 行）ちょうどは通り、超えるとエラー`, () => {
    const rows = (n: number) =>
      Array.from({ length: n }, (_, i) => row(`T-${i + 1}`));
    expect(parse([HEADER, ...rows(PRODUCT_IMPORT_MAX_ROWS)]).ok).toBe(true);
    const over = parse([HEADER, ...rows(PRODUCT_IMPORT_MAX_ROWS + 1)]);
    expect(over).toEqual({
      ok: false,
      totalErrors: 1,
      errors: [
        {
          line: null,
          field: null,
          message: expect.stringContaining(
            "上限（1,000 行）を超えています（1,001 行）",
          ),
        },
      ],
    });
  });

  it("ファイルサイズの上限を超えるとエラー", () => {
    const result = parseProductImport(
      new Uint8Array(PRODUCT_IMPORT_MAX_BYTES + 1).fill(0x61),
    );
    expect(!result.ok && result.errors[0].message).toContain(
      "ファイルが大きすぎます",
    );
  });

  it("UTF-8 でない（Shift_JIS など）とエラー", () => {
    const result = parseProductImport(new Uint8Array([0x8f, 0xa4, 0x95, 0x69]));
    expect(!result.ok && result.errors[0].message).toContain("UTF-8");
  });

  it("空のファイル・見出しだけのファイルはエラー", () => {
    expect(parseProductImport(new Uint8Array()).ok).toBe(false);
    expect(parseProductImport(bytesOf("\r\n\r\n")).ok).toBe(false);
    const headerOnly = parse([HEADER]);
    expect(!headerOnly.ok && headerOnly.errors[0].message).toContain(
      "見出し行だけ",
    );
  });

  it("閉じていないダブルクォートは行番号付きのエラー", () => {
    const text = toCsv([HEADER, row("T-1")]) + '"T-2,x\r\n';
    const result = parseProductImport(bytesOf(text));
    expect(!result.ok && result.errors[0]).toMatchObject({ line: 3 });
  });

  it(`画面に返すエラーは ${PRODUCT_IMPORT_MAX_REPORTED_ERRORS} 件まで（総数は totalErrors）`, () => {
    const rows = Array.from({ length: 150 }, (_, i) =>
      row(`T-${i + 1}`, { 売価: "x" }),
    );
    const result = parse([HEADER, ...rows]);
    expect(!result.ok && result.errors).toHaveLength(
      PRODUCT_IMPORT_MAX_REPORTED_ERRORS,
    );
    expect(!result.ok && result.totalErrors).toBe(150);
  });
});
