/**
 * 郵便番号 → 住所（zipcloud）。docs/spec.md §6。lookupAddress はサーバー側でだけ使う（Route Handler から呼ぶ。
 * 画面からは /api/partners/address-lookup 経由）。メッセージの定数は画面からも import する。
 *
 * - API: https://zipcloud.ibsnet.co.jp/doc/api （GET /api/search?zipcode=…。読み取りのみ）
 * - タイムアウト 3 秒（AbortSignal.timeout）。失敗・該当なし・形式エラーは理由付きの { ok: false } を返し、
 *   例外にしない（画面では「住所を手入力してください」と表示して入力を続けられるようにする）
 * - 外部の応答は Zod で型を検証してから使う（想定外の形・長すぎる値・制御文字は「不正な応答」）
 * - fetch は引数で差し替えられる（テストでは外部 API を呼ばない）
 */
import { z } from "zod";

import { normalizePostalCode, PARTNER_LIMITS } from "./schema";

export const ZIPCLOUD_ENDPOINT = "https://zipcloud.ibsnet.co.jp/api/search";

/** 外部 API のタイムアウト（spec §6） */
export const ADDRESS_LOOKUP_TIMEOUT_MS = 3_000;

export type AddressLookupFailure =
  /** 郵便番号の形式が違う（外部 API は呼ばない） */
  | "invalid_postal_code"
  /** 該当する住所がない */
  | "not_found"
  /** 3 秒以内に応答がない */
  | "timeout"
  /** 通信エラー・HTTP エラー・zipcloud のエラー応答 */
  | "unavailable"
  /** 応答の形が想定と違う */
  | "invalid_response";

export type AddressLookupResult =
  | {
      ok: true;
      postalCode: string;
      /** 候補（1 つの郵便番号に複数の町域があることがある）。都道府県＋市区町村＋町域 */
      addresses: string[];
    }
  | { ok: false; reason: AddressLookupFailure };

const SINGLE_LINE = /^[^\u0000-\u001f\u007f]*$/;

const addressPart = z.string().max(PARTNER_LIMITS.address).regex(SINGLE_LINE);

/** zipcloud の応答（使う項目だけ。ほかの項目は無視する） */
const zipcloudResponseSchema = z.object({
  status: z.number().int(),
  message: z.string().nullable().optional(),
  results: z
    .array(
      z.object({
        zipcode: z.string(),
        address1: addressPart,
        address2: addressPart,
        address3: addressPart,
      }),
    )
    .max(100)
    .nullable(),
});

/**
 * zipcloud の応答（JSON を parse した値）を解釈する。純粋な関数。
 * status が 200 以外（zipcloud は HTTP 200 のまま本文の status でエラーを返す）は unavailable
 */
export function parseZipcloudResponse(
  postalCode: string,
  body: unknown,
): AddressLookupResult {
  const parsed = zipcloudResponseSchema.safeParse(body);
  if (!parsed.success) return { ok: false, reason: "invalid_response" };
  const { status, results } = parsed.data;
  if (status !== 200) return { ok: false, reason: "unavailable" };
  if (!results || results.length === 0)
    return { ok: false, reason: "not_found" };
  // 問い合わせた郵便番号と違う結果は使わない
  if (results.some((r) => r.zipcode !== postalCode)) {
    return { ok: false, reason: "invalid_response" };
  }
  const addresses = [
    ...new Set(
      results
        .map((r) => `${r.address1}${r.address2}${r.address3}`)
        .filter((a) => a !== "" && a.length <= PARTNER_LIMITS.address),
    ),
  ];
  return addresses.length > 0
    ? { ok: true, postalCode, addresses }
    : { ok: false, reason: "invalid_response" };
}

/** AbortSignal.timeout による中断（DOMException の TimeoutError。実装によっては AbortError） */
function isTimeout(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

/**
 * 失敗の原因をサーバー側のログに残す（zipcloud の障害・仕様変更に気付くため）。
 * 郵便番号・利用者の情報は含めない。利用者への表示は決まった文言だけ（ADDRESS_LOOKUP_MESSAGES）
 */
function fail(
  reason: AddressLookupFailure,
  detail?: string,
): AddressLookupResult {
  console.warn(
    `[address-lookup] zipcloud の呼び出しに失敗しました: ${reason}${detail ? `（${detail}）` : ""}`,
  );
  return { ok: false, reason };
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error.cause as { code?: unknown } | undefined)?.code;
  return `${error.name}: ${error.message}${cause ? ` [${String(cause)}]` : ""}`;
}

/** 郵便番号（ハイフン有無どちらでも）から住所の候補を得る */
export async function lookupAddress(
  input: string,
  options: {
    fetch?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<AddressLookupResult> {
  const postalCode = normalizePostalCode(input);
  if (!postalCode) return { ok: false, reason: "invalid_postal_code" };
  const fetchFn = options.fetch ?? fetch;
  const url = `${ZIPCLOUD_ENDPOINT}?zipcode=${postalCode}`;
  try {
    // 本文の読み取りまでを 3 秒に含める（同じ signal で中断される）
    const response = await fetchFn(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(
        options.timeoutMs ?? ADDRESS_LOOKUP_TIMEOUT_MS,
      ),
      cache: "no-store",
      // 宛先は固定。リダイレクトはたどらずエラーにする
      redirect: "error",
    });
    if (!response.ok) return fail("unavailable", `HTTP ${response.status}`);
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      return fail(
        isTimeout(error) ? "timeout" : "invalid_response",
        describeError(error),
      );
    }
    const result = parseZipcloudResponse(postalCode, body);
    if (!result.ok && result.reason !== "not_found") {
      const status = (body as { status?: unknown } | null)?.status;
      return fail(result.reason, `応答の status: ${String(status)}`);
    }
    return result;
  } catch (error) {
    return fail(
      isTimeout(error) ? "timeout" : "unavailable",
      describeError(error),
    );
  }
}

/**
 * 画面側: 住所検索の応答を使ってよいか。検索を始めた後に別の検索が始まった（識別子が変わった）、
 * または郵便番号・住所の入力が変わったときは、古い結果で入力を上書きしないよう捨てる
 */
export function isLookupResultCurrent(
  started: { requestId: number; postalCode: string; address: string },
  current: { requestId: number; postalCode: string; address: string },
): boolean {
  return (
    started.requestId === current.requestId &&
    normalizePostalCode(started.postalCode) ===
      normalizePostalCode(current.postalCode) &&
    started.address === current.address
  );
}

/** 画面に出すメッセージ（どの失敗でも手入力を続けられることを示す） */
export const ADDRESS_LOOKUP_MESSAGES: Record<AddressLookupFailure, string> = {
  invalid_postal_code:
    "郵便番号は7桁の数字で入力してください（例 123-4567）。住所を手入力してください",
  not_found: "該当する住所が見つかりませんでした。住所を手入力してください",
  timeout: "住所の検索がタイムアウトしました。住所を手入力してください",
  unavailable: "住所の検索に失敗しました。住所を手入力してください",
  invalid_response: "住所の検索に失敗しました。住所を手入力してください",
};
