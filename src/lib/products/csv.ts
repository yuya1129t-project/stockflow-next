/**
 * 商品の CSV（docs/spec.md §7）。出力する行の組み立てと、取込ファイルの検証（DB に触れない純粋な関数）。
 *
 * 取込のルール:
 * - 文字コードは UTF-8（BOM の有無は問わない）。1 行目は見出し行（列の順番は問わない）
 * - 商品コード・商品名・カテゴリ・単位・売価・仕入単価・発注点の列が必須。それ以外の列（出力 CSV の
 *   現在庫・状態など）は読み飛ばす（有効／無効は CSV では変えない。無効化は admin だけの操作のため）
 * - データ行は 1,000 行まで。ファイルは 512KB まで
 * - データ行の列数は見出し行と同じであること（列ずれのまま取り込まない）
 * - 1 行でもエラーがあれば全体を取り込まない（エラーは行番号付きで返す）
 */
import { decodeUtf8, parseCsv, toCsv, unsanitizeCsvCell } from "@/lib/csv";

import {
  PRODUCT_FIELD_LABELS,
  PRODUCT_FIELDS,
  productInputSchema,
  type ProductField,
  type ProductInput,
} from "./schema";

/** 取込できるデータ行の上限（spec §7） */
export const PRODUCT_IMPORT_MAX_ROWS = 1_000;
/**
 * 取込ファイルの上限（バイト）。Server Action の本文の上限（既定 1MB）に収まる大きさにしている。
 * 1,000 行 × 1 行あたり 200〜400 バイト程度を想定
 */
export const PRODUCT_IMPORT_MAX_BYTES = 512 * 1024;
/** 画面に返すエラーの最大件数（これを超えた分は件数だけ返す） */
export const PRODUCT_IMPORT_MAX_REPORTED_ERRORS = 100;

/** 出力 CSV の見出し（取込で使う 7 列＋読み取り専用の 2 列） */
const STOCK_HEADER = "現在庫";
const STATUS_HEADER = "状態";
export const PRODUCT_CSV_HEADERS = [
  ...PRODUCT_FIELDS.map((field) => PRODUCT_FIELD_LABELS[field]),
  STOCK_HEADER,
  STATUS_HEADER,
];

export interface ProductCsvRow extends ProductInput {
  stock: number;
  isActive: boolean;
}

/** 出力する CSV（BOM なし。BOM は Route Handler で付ける） */
export function buildProductCsv(products: readonly ProductCsvRow[]): string {
  return toCsv([
    PRODUCT_CSV_HEADERS,
    ...products.map((p) => [
      p.code,
      p.name,
      p.category,
      p.unit,
      p.salesPrice,
      p.purchasePrice,
      p.reorderPoint,
      p.stock,
      p.isActive ? "有効" : "無効",
    ]),
  ]);
}

export interface ProductImportError {
  /** ファイルの行番号（1 始まり。見出し行が 1）。ファイル全体のエラーは null */
  line: number | null;
  /** 項目名（項目に関係しないエラーは null） */
  field: string | null;
  message: string;
}

export interface ProductImportRow {
  line: number;
  data: ProductInput;
}

export type ProductImportParseResult =
  | { ok: true; rows: ProductImportRow[] }
  | { ok: false; errors: ProductImportError[]; totalErrors: number };

function fileError(message: string): ProductImportParseResult {
  return {
    ok: false,
    errors: [{ line: null, field: null, message }],
    totalErrors: 1,
  };
}

/**
 * 取込ファイル（バイト列）を検証し、取り込む行の一覧を返す。1 件でもエラーがあれば ok: false
 */
export function parseProductImport(
  bytes: Uint8Array,
): ProductImportParseResult {
  if (bytes.byteLength === 0) return fileError("ファイルが空です");
  if (bytes.byteLength > PRODUCT_IMPORT_MAX_BYTES) {
    return fileError(
      `ファイルが大きすぎます（上限 ${PRODUCT_IMPORT_MAX_BYTES / 1024}KB）`,
    );
  }

  const text = decodeUtf8(bytes);
  if (text === null) {
    return fileError(
      "文字コードが UTF-8 ではありません。UTF-8 で保存し直してください（Excel では「CSV UTF-8（コンマ区切り）」）",
    );
  }

  const parsed = parseCsv(text);
  if (!parsed.ok) {
    return {
      ok: false,
      errors: [{ line: parsed.line, field: null, message: parsed.message }],
      totalErrors: 1,
    };
  }
  // 空行（すべてのセルが空）は読み飛ばす（末尾の空行や Excel が出力する ",,,," の行）
  const records = parsed.records.filter((r) =>
    r.cells.some((cell) => cell.trim() !== ""),
  );
  const [header, ...dataRecords] = records;
  if (!header) return fileError("ファイルが空です");

  // 見出し → 列番号
  const columnOf = new Map<ProductField, number>();
  const headerErrors: ProductImportError[] = [];
  header.cells.forEach((cell, index) => {
    const name = cell.trim();
    const field = PRODUCT_FIELDS.find((f) => PRODUCT_FIELD_LABELS[f] === name);
    if (!field) return;
    if (columnOf.has(field)) {
      headerErrors.push({
        line: header.line,
        field: name,
        message: `見出し「${name}」が重複しています`,
      });
      return;
    }
    columnOf.set(field, index);
  });
  for (const field of PRODUCT_FIELDS) {
    if (!columnOf.has(field)) {
      headerErrors.push({
        line: header.line,
        field: PRODUCT_FIELD_LABELS[field],
        message: `見出し行に「${PRODUCT_FIELD_LABELS[field]}」の列がありません`,
      });
    }
  }
  if (headerErrors.length > 0) {
    return {
      ok: false,
      errors: headerErrors,
      totalErrors: headerErrors.length,
    };
  }

  if (dataRecords.length === 0) {
    return fileError("取り込むデータ行がありません（見出し行だけです）");
  }
  if (dataRecords.length > PRODUCT_IMPORT_MAX_ROWS) {
    return fileError(
      `データ行が上限（${PRODUCT_IMPORT_MAX_ROWS.toLocaleString("ja-JP")} 行）を超えています（${dataRecords.length.toLocaleString("ja-JP")} 行）。ファイルを分けて取り込んでください`,
    );
  }

  const errors: ProductImportError[] = [];
  const rows: ProductImportRow[] = [];
  const lineOfCode = new Map<string, number>();

  const columnCount = header.cells.length;
  for (const record of dataRecords) {
    // 列数が見出しと違う行は、値が別の列にずれている（囲んでいない 1,200 など）ので 1 件のエラーにする
    if (record.cells.length !== columnCount) {
      errors.push({
        line: record.line,
        field: null,
        message: `列の数が見出し行と違います（見出し ${columnCount} 列・この行 ${record.cells.length} 列）。カンマを含む値は "" で囲んでください`,
      });
      continue;
    }
    const raw = Object.fromEntries(
      PRODUCT_FIELDS.map((field) => [
        field,
        unsanitizeCsvCell(record.cells[columnOf.get(field)!] ?? ""),
      ]),
    );
    const result = productInputSchema.safeParse(raw);
    if (!result.success) {
      for (const issue of result.error.issues) {
        const field = issue.path[0] as ProductField | undefined;
        errors.push({
          line: record.line,
          field: field ? PRODUCT_FIELD_LABELS[field] : null,
          message: issue.message,
        });
      }
      continue;
    }
    const { code } = result.data;
    const firstLine = lineOfCode.get(code);
    if (firstLine !== undefined) {
      errors.push({
        line: record.line,
        field: PRODUCT_FIELD_LABELS.code,
        message: `商品コード「${code}」が ${firstLine} 行目と重複しています`,
      });
      continue;
    }
    lineOfCode.set(code, record.line);
    rows.push({ line: record.line, data: result.data });
  }

  if (errors.length > 0) {
    return {
      ok: false,
      errors: errors.slice(0, PRODUCT_IMPORT_MAX_REPORTED_ERRORS),
      totalErrors: errors.length,
    };
  }
  return { ok: true, rows };
}
