import { describe, expect, it } from "vitest";

import { MULTI_LINE, SINGLE_LINE, singleLineMessage } from "./text";

/** 拒否する文字（改行・タブを除く） */
const FORBIDDEN: [string, string][] = [
  ["U+0000", "\u0000"],
  ["U+001F", "\u001f"],
  ["U+007F（DEL）", "\u007f"],
  ["U+0080（C1）", "\u0080"],
  ["U+0085（NEL）", "\u0085"],
  ["U+009F（C1）", "\u009f"],
  ["U+200E（LRM）", "\u200e"],
  ["U+200F（RLM）", "\u200f"],
  ["U+2028（行区切り）", "\u2028"],
  ["U+2029（段落区切り）", "\u2029"],
  ["U+202A（LRE）", "\u202a"],
  ["U+202B（RLE）", "\u202b"],
  ["U+202C（PDF）", "\u202c"],
  ["U+202D（LRO）", "\u202d"],
  ["U+202E（RLO）", "\u202e"],
  ["U+2066（LRI）", "\u2066"],
  ["U+2067（RLI）", "\u2067"],
  ["U+2068（FSI）", "\u2068"],
  ["U+2069（PDI）", "\u2069"],
  ["U+FEFF（BOM）", "\ufeff"],
];

const ALLOWED = [
  "",
  "ボールペン（黒）",
  "ABC-123_x",
  "東京都千代田区1-1-1\u3000ビル２階",
  "記号 !\"#$%&'()*+,-./:;<=>?@[]^_`{|}~ ・「」〜",
  "絵文字 😀👨‍👩‍👧‍👦🇯🇵",
  "العربية（右から左の文字そのものは可）",
  "\u00a0\u3000", // 空白類（NBSP・全角空白）
];

describe.each([
  ["SINGLE_LINE", SINGLE_LINE],
  ["MULTI_LINE", MULTI_LINE],
])("%s", (_name, pattern) => {
  it.each(FORBIDDEN)("%s を含むと拒否する", (_label, char) => {
    expect(pattern.test(`前${char}後`)).toBe(false);
    expect(pattern.test(char)).toBe(false);
  });

  it.each(ALLOWED)("通常の文字（%j）は通す", (value) => {
    expect(pattern.test(value)).toBe(true);
  });
});

describe("改行・タブの扱い", () => {
  it("1 行の項目は \\n・\\r・\\t も拒否する", () => {
    for (const char of ["\n", "\r", "\t"]) {
      expect(SINGLE_LINE.test(`a${char}b`)).toBe(false);
    }
  });

  it("複数行の項目は \\n だけ通す（\\t・\\r は拒否）", () => {
    expect(MULTI_LINE.test("1 行目\n2 行目")).toBe(true);
    expect(MULTI_LINE.test("a\tb")).toBe(false);
    expect(MULTI_LINE.test("a\rb")).toBe(false);
  });
});

describe("singleLineMessage", () => {
  it("項目名つきの日本語メッセージ", () => {
    expect(singleLineMessage("商品名")).toBe(
      "商品名に改行・タブなどの制御文字は使えません",
    );
  });
});
