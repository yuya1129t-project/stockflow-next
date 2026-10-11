import { describe, expect, it } from "vitest";

import {
  CSV_BOM,
  decodeUtf8,
  parseCsv,
  sanitizeCsvCell,
  toCsv,
  unsanitizeCsvCell,
} from "./csv";

describe("sanitizeCsvCell（CSV インジェクション対策）", () => {
  it.each(["=SUM(A1:A2)", "+81", "-1+1", "@cmd", "\tx", "\rx"])(
    "%j は先頭に ' を付ける",
    (value) => {
      expect(sanitizeCsvCell(value)).toBe(`'${value}`);
    },
  );

  it.each(["P-0001", "コピー用紙 A4", "", "1=1", "a-b"])(
    "%j はそのまま",
    (value) => {
      expect(sanitizeCsvCell(value)).toBe(value);
    },
  );

  it("unsanitizeCsvCell で元に戻る（' の後が危険な文字のときだけ外す）", () => {
    expect(unsanitizeCsvCell(sanitizeCsvCell("=1+2"))).toBe("=1+2");
    expect(unsanitizeCsvCell("'abc")).toBe("'abc");
    expect(unsanitizeCsvCell("abc")).toBe("abc");
  });
});

describe("toCsv", () => {
  it("カンマ区切り・CRLF。カンマ・ダブルクォート・改行・前後の空白を含む項目は囲む", () => {
    expect(
      toCsv([
        ["a", "b,c", 'say "hi"', "line1\nline2", " pad", 12, null],
        ["x", "", 0, undefined, "y", "z", "w"],
      ]),
    ).toBe('a,"b,c","say ""hi""","line1\nline2"," pad",12,\r\nx,,0,,y,z,w\r\n');
  });

  it("数式になる文字列は無害化し、数値はそのまま出力する", () => {
    expect(toCsv([["=1+1", -5, "@x,y"]])).toBe(`'=1+1,-5,"'@x,y"\r\n`);
  });
});

describe("parseCsv", () => {
  it("基本の形（末尾の改行あり・なし）", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual({
      ok: true,
      records: [
        { line: 1, cells: ["a", "b"] },
        { line: 2, cells: ["1", "2"] },
      ],
    });
    expect(parseCsv("a,b\n1,2")).toEqual({
      ok: true,
      records: [
        { line: 1, cells: ["a", "b"] },
        { line: 2, cells: ["1", "2"] },
      ],
    });
  });

  it("先頭の BOM を取り除く", () => {
    const result = parseCsv(`${CSV_BOM}商品コード,商品名\n`);
    expect(result.ok && result.records[0].cells).toEqual([
      "商品コード",
      "商品名",
    ]);
  });

  it('囲みの中のカンマ・""・改行を扱い、レコードの開始行を返す', () => {
    const result = parseCsv('h1,h2\n"a,b","x\r\ny ""z"""\nlast,"")\n');
    expect(result).toEqual({
      ok: true,
      records: [
        { line: 1, cells: ["h1", "h2"] },
        { line: 2, cells: ["a,b", 'x\r\ny "z"'] },
        { line: 4, cells: ["last", ")"] },
      ],
    });
  });

  it("空の項目・空行も 1 レコードとして返す（空行の扱いは呼び出し側で決める）", () => {
    expect(parseCsv("a,,c\n\nd")).toEqual({
      ok: true,
      records: [
        { line: 1, cells: ["a", "", "c"] },
        { line: 2, cells: [""] },
        { line: 3, cells: ["d"] },
      ],
    });
  });

  it("閉じていないダブルクォートはエラー（開始行を返す）", () => {
    expect(parseCsv('a,b\n1,"open\n2,3\n')).toEqual({
      ok: false,
      line: 2,
      message: expect.stringContaining("閉じられていません"),
    });
  });

  it("toCsv の出力を読むと元の値に戻る", () => {
    const rows = [
      ["code", "name"],
      ["P-1", 'カンマ,と"引用符"と\n改行'],
    ];
    const result = parseCsv(toCsv(rows));
    expect(result.ok && result.records.map((r) => r.cells)).toEqual(rows);
  });
});

describe("decodeUtf8", () => {
  it("UTF-8（BOM あり・なし）を読む", () => {
    const bytes = new TextEncoder().encode("商品");
    expect(decodeUtf8(bytes)).toBe("商品");
    expect(decodeUtf8(new Uint8Array([0xef, 0xbb, 0xbf, ...bytes]))).toBe(
      "商品",
    );
  });

  it("UTF-8 として不正なバイト列（Shift_JIS の「商品」）は null", () => {
    expect(decodeUtf8(new Uint8Array([0x8f, 0xa4, 0x95, 0x69]))).toBeNull();
  });
});
