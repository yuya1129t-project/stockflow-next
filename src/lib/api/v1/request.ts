/**
 * REST API（/api/v1）のリクエストの読み取り（JSON の本文・クエリのパラメーター）。
 *
 * 本文:
 * - Content-Type は application/json（または application/*+json）だけ。それ以外・なしは 415（Accept-Post を付ける）。
 *   charset は utf-8 だけ（JSON は UTF-8。RFC 8259）
 * - 大きさの上限は API_BODY_MAX_BYTES。Content-Length が上限を超えていれば読まずに 413。Content-Length がなくても
 *   読みながら数え、超えたらその時点で読むのをやめて 413
 * - UTF-8 として正しくない・JSON として正しくない・空の本文は 400
 *
 * クエリ:
 * - 画面の一覧（不正な値は既定値に置き換える）と違い、API では不正な値を 400 にする（呼び出し側の誤りに気づけるように）
 * - 同じパラメーターを 2 回以上指定したときも 400。知らないパラメーターは無視する
 */
import type { ZodError } from "zod";

import { parseDateOnly } from "@/lib/orders/dates";

import { problem, validationProblem } from "./responses";
import {
  API_PAGE_MAX,
  API_PER_PAGE_DEFAULT,
  API_PER_PAGE_MAX,
  type ProblemFieldError,
} from "./schemas";

/** 本文の大きさの上限（明細 100 行・備考 500 文字でも十分に収まる） */
export const API_BODY_MAX_BYTES = 64 * 1024;

export type ReadResult<T> =
  { ok: true; value: T } | { ok: false; response: Response };

function isJsonMediaType(contentType: string | null): boolean {
  if (!contentType) return false;
  const [mediaType, ...params] = contentType.split(";");
  const type = mediaType.trim().toLowerCase();
  if (
    type !== "application/json" &&
    !/^application\/[\w.-]+\+json$/.test(type)
  ) {
    return false;
  }
  return params.every((param) => {
    const [name, value = ""] = param.split("=");
    if (name.trim().toLowerCase() !== "charset") return true;
    return value.trim().replace(/^"|"$/g, "").toLowerCase() === "utf-8";
  });
}

function tooLarge(): Response {
  return problem(
    413,
    `本文が大きすぎます（上限 ${API_BODY_MAX_BYTES.toLocaleString("ja-JP")} バイト）`,
  );
}

/** 本文を上限まで読む（超えたら null） */
async function readLimited(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** JSON の本文を読む（Content-Type・大きさ・UTF-8・JSON の構文を検査する。中身の検証は呼び出し側） */
export async function readJsonBody(
  request: Request,
  maxBytes: number = API_BODY_MAX_BYTES,
): Promise<ReadResult<unknown>> {
  if (!isJsonMediaType(request.headers.get("content-type"))) {
    return {
      ok: false,
      response: problem(
        415,
        "本文は JSON（Content-Type: application/json、UTF-8）で送ってください",
        { headers: { "Accept-Post": "application/json" } },
      ),
    };
  }
  const length = request.headers.get("content-length");
  if (length !== null && /^\d+$/.test(length) && Number(length) > maxBytes) {
    return { ok: false, response: tooLarge() };
  }
  const bytes = request.body
    ? await readLimited(request.body, maxBytes)
    : new Uint8Array();
  if (bytes === null) return { ok: false, response: tooLarge() };

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return {
      ok: false,
      response: problem(400, "本文が UTF-8 として正しくありません"),
    };
  }
  if (text.trim() === "") {
    return { ok: false, response: problem(400, "本文が空です") };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return {
      ok: false,
      response: problem(400, "本文が JSON として正しくありません"),
    };
  }
}

/** JSON Pointer（RFC 6901）の URI フラグメント表記（例 #/lines/0/quantity） */
export function toJsonPointer(path: readonly PropertyKey[]): string {
  return `#${path
    .map((key) => `/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`)
    .join("")}`;
}

function sizeLabel(origin: string): string {
  return origin === "array" ? "件" : origin === "string" ? "文字" : "";
}

/** input の path の位置にある値（なければ undefined） */
function valueAt(input: unknown, path: readonly PropertyKey[]): unknown {
  let node = input;
  for (const key of path) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<PropertyKey, unknown>)[key];
  }
  return node;
}

/**
 * Zod の検証エラーを項目ごとのエラー（日本語）にする。余分な項目は 1 項目ずつのエラーにする。
 * input は検証した値（項目がないのか型が違うのかを見分けるのに使う）
 */
export function zodFieldErrors(
  error: ZodError,
  input: unknown,
): ProblemFieldError[] {
  const errors: ProblemFieldError[] = [];
  for (const issue of error.issues) {
    switch (issue.code) {
      case "unrecognized_keys":
        for (const key of issue.keys) {
          errors.push({
            pointer: toJsonPointer([...issue.path, key]),
            detail: "この項目は指定できません",
          });
        }
        continue;
      case "invalid_type": {
        const expected: Record<string, string> = {
          string: "文字列",
          int: "整数",
          number: "数値",
          array: "配列",
          object: "オブジェクト",
        };
        errors.push({
          pointer: toJsonPointer(issue.path),
          detail:
            valueAt(input, issue.path) === undefined
              ? "必須の項目です"
              : `${expected[issue.expected] ?? issue.expected}で指定してください`,
        });
        continue;
      }
      case "too_small":
        errors.push({
          pointer: toJsonPointer(issue.path),
          detail:
            issue.origin === "number" || issue.origin === "int"
              ? `${String(issue.minimum)} 以上で指定してください`
              : `${String(issue.minimum)} ${sizeLabel(issue.origin)}以上で指定してください`,
        });
        continue;
      case "too_big":
        errors.push({
          pointer: toJsonPointer(issue.path),
          detail:
            issue.origin === "number" || issue.origin === "int"
              ? `${Number(issue.maximum).toLocaleString("ja-JP")} 以下で指定してください`
              : `${String(issue.maximum)} ${sizeLabel(issue.origin)}以内で指定してください`,
        });
        continue;
      case "invalid_format":
        errors.push({
          pointer: toJsonPointer(issue.path),
          detail:
            issue.format === "date"
              ? "YYYY-MM-DD の形式の実在する日付で指定してください"
              : "形式が正しくありません",
        });
        continue;
      default:
        errors.push({
          pointer: toJsonPointer(issue.path),
          detail: "値が正しくありません",
        });
    }
  }
  return errors;
}

/** クエリのパラメーターを読む（不正な値は項目ごとのエラーにためる） */
export class QueryReader {
  readonly errors: ProblemFieldError[] = [];

  constructor(private readonly params: URLSearchParams) {}

  private single(name: string): string | undefined {
    const values = this.params.getAll(name);
    if (values.length > 1) {
      this.errors.push({ parameter: name, detail: "1 回だけ指定してください" });
      return undefined;
    }
    return values[0];
  }

  /** 文字列（前後の空白を除く。空なら ""） */
  string(name: string, maxLength: number): string {
    const value = (this.single(name) ?? "").trim();
    if (value.length > maxLength) {
      this.errors.push({
        parameter: name,
        detail: `${maxLength} 文字以内で指定してください`,
      });
      return "";
    }
    return value;
  }

  /** min 以上 max 以下の整数（省略時は fallback） */
  integer(name: string, min: number, max: number, fallback: number): number {
    const value = this.single(name);
    if (value === undefined) return fallback;
    if (
      !/^\d{1,9}$/.test(value) ||
      Number(value) < min ||
      Number(value) > max
    ) {
      this.errors.push({
        parameter: name,
        detail: `${min}〜${max.toLocaleString("ja-JP")} の整数で指定してください`,
      });
      return fallback;
    }
    return Number(value);
  }

  /** 選択肢のどれか（省略・空なら ""） */
  oneOf<T extends string>(name: string, options: readonly T[]): T | "" {
    const value = this.single(name);
    if (value === undefined || value === "") return "";
    if (!(options as readonly string[]).includes(value)) {
      this.errors.push({
        parameter: name,
        detail: `${options.join("・")} のどれかで指定してください`,
      });
      return "";
    }
    return value as T;
  }

  /** 日付（YYYY-MM-DD。省略・空なら ""） */
  date(name: string): string {
    const value = this.single(name);
    if (value === undefined || value === "") return "";
    if (!parseDateOnly(value)) {
      this.errors.push({
        parameter: name,
        detail:
          "YYYY-MM-DD の形式の実在する日付（2000〜2099 年）で指定してください",
      });
      return "";
    }
    return value;
  }

  /** page・perPage（spec §6-2: perPage は既定 20・上限 100） */
  paging(): { page: number; perPage: number } {
    return {
      page: this.integer("page", 1, API_PAGE_MAX, 1),
      perPage: this.integer(
        "perPage",
        1,
        API_PER_PAGE_MAX,
        API_PER_PAGE_DEFAULT,
      ),
    };
  }

  /** エラーがあれば 400 の応答 */
  problem(): Response | null {
    return this.errors.length > 0 ? validationProblem(this.errors) : null;
  }
}
