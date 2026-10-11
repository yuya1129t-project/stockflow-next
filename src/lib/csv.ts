/**
 * CSV の読み書き（RFC 4180）。docs/spec.md §7。DB やフレームワークに依存しない純粋な関数だけを置く。
 *
 * - 出力: 区切りはカンマ、改行は CRLF。Excel で文字化けしないよう先頭に BOM を付けるのは呼び出し側
 *   （CSV_BOM）。数式として解釈される文字（= + - @ など）で始まる文字列は先頭に ' を付けて無害化する
 * - 読み込み: ダブルクォートで囲んだ項目（カンマ・改行・"" を含む）に対応。各レコードの開始行番号を返す
 */

export const CSV_BOM = "﻿";

/** 表計算ソフトで数式として解釈されうる先頭文字（CSV インジェクション対策。OWASP の推奨） */
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

/**
 * 数式として解釈されないよう、危険な文字で始まる文字列の先頭に ' を付ける。
 * 数値のセル（number）はそのまま出力するので、この関数は文字列のセルにだけ使う
 */
export function sanitizeCsvCell(value: string): string {
  return FORMULA_PREFIX.test(value) ? `'${value}` : value;
}

/**
 * sanitizeCsvCell で付けた ' を取り除く（このアプリで出力した CSV を取り込み直したとき元の値に戻す）。
 * ' の直後が危険な文字のときだけ外す
 */
export function unsanitizeCsvCell(value: string): string {
  return value.startsWith("'") && FORMULA_PREFIX.test(value.slice(1))
    ? value.slice(1)
    : value;
}

export type CsvCell = string | number | null | undefined;

function formatCell(cell: CsvCell): string {
  if (cell === null || cell === undefined) return "";
  if (typeof cell === "number") return String(cell);
  const text = sanitizeCsvCell(cell);
  return /[",\r\n]/.test(text) || text !== text.trim()
    ? `"${text.replace(/"/g, '""')}"`
    : text;
}

/** 行の配列を CSV の文字列にする（BOM は付けない。末尾に改行を付ける） */
export function toCsv(rows: readonly (readonly CsvCell[])[]): string {
  return rows.map((row) => row.map(formatCell).join(",") + "\r\n").join("");
}

export interface CsvRecord {
  /** このレコードが始まる行番号（1 始まり。項目内の改行があっても開始行を指す） */
  line: number;
  cells: string[];
}

export type ParseCsvResult =
  | { ok: true; records: CsvRecord[] }
  | { ok: false; line: number; message: string };

/**
 * CSV の文字列をレコードの配列にする。先頭の BOM は取り除く。
 * 末尾の改行の有無は問わない。囲みのダブルクォートが閉じていなければエラー
 */
export function parseCsv(input: string): ParseCsvResult {
  const text = input.startsWith(CSV_BOM) ? input.slice(1) : input;
  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let cell = "";
  let line = 1;
  let recordLine = 1;
  let quoteStartLine = 1;
  let inQuotes = false;
  // 現在のレコードに何か（文字・区切り）が出てきたか
  let started = false;

  const endCell = () => {
    cells.push(cell);
    cell = "";
  };
  const endRecord = () => {
    endCell();
    records.push({ line: recordLine, cells });
    cells = [];
    started = false;
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (c === "\n" || (c === "\r" && text[i + 1] !== "\n")) line++;
        cell += c;
      }
      continue;
    }

    if (!started) {
      recordLine = line;
      started = true;
    }
    if (c === '"' && cell === "") {
      inQuotes = true;
      quoteStartLine = line;
    } else if (c === ",") {
      endCell();
    } else if (c === "\r" || c === "\n") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      endRecord();
      line++;
    } else {
      cell += c;
    }
  }

  if (inQuotes) {
    return {
      ok: false,
      line: quoteStartLine,
      message: 'ダブルクォート（"）で始まる項目が閉じられていません',
    };
  }
  if (started) endRecord();
  return { ok: true, records };
}

/**
 * バイト列を UTF-8 として読む（BOM の有無は問わない）。UTF-8 として不正なら null（Shift_JIS など）
 */
export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    // ignoreBOM: false（既定）で先頭の BOM は取り除かれる
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
