/**
 * 郵便番号 → 住所（zipcloud）の応答の解釈と、通信の失敗の扱い。
 * 外部 API は呼ばない（fetch をモックに差し替える）。住所はすべて架空の値
 */
import { describe, expect, it, vi } from "vitest";

import {
  ADDRESS_LOOKUP_MESSAGES,
  ADDRESS_LOOKUP_TIMEOUT_MS,
  lookupAddress,
  parseZipcloudResponse,
  ZIPCLOUD_ENDPOINT,
} from "./address-lookup";

/** zipcloud の正常な応答（使わない項目 kana・prefcode も含めた実際の形） */
function zipcloudBody(
  results: { address1: string; address2: string; address3: string }[] | null,
  zipcode = "0000001",
) {
  return {
    message: null,
    results:
      results?.map((r) => ({
        ...r,
        kana1: "ﾃﾞﾓｹﾝ",
        kana2: "ｻﾝﾌﾟﾙｼ",
        kana3: "ﾁｭｳｵｳ",
        prefcode: "1",
        zipcode,
      })) ?? null,
    status: 200,
  };
}

const DEMO = { address1: "デモ県", address2: "サンプル市", address3: "中央" };

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

/** fetch のモック（呼ばれた URL・オプションを確かめられる） */
function mockFetch(
  impl: (url: string, init?: RequestInit) => Promise<Response>,
) {
  return vi.fn<typeof fetch>(async (input, init) => impl(String(input), init));
}

/** signal が中断されるまで応答しない fetch（タイムアウトの確認用） */
const hangingFetch = mockFetch(
  (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(init.signal!.reason),
      );
    }),
);

describe("parseZipcloudResponse（応答の解釈）", () => {
  it("都道府県・市区町村・町域をつないだ住所を返す", () => {
    expect(parseZipcloudResponse("0000001", zipcloudBody([DEMO]))).toEqual({
      ok: true,
      postalCode: "0000001",
      addresses: ["デモ県サンプル市中央"],
    });
  });

  it("候補が複数あればすべて返す（同じ住所は 1 つにまとめる）", () => {
    const body = zipcloudBody([DEMO, { ...DEMO, address3: "東" }, { ...DEMO }]);
    expect(parseZipcloudResponse("0000001", body)).toMatchObject({
      ok: true,
      addresses: ["デモ県サンプル市中央", "デモ県サンプル市東"],
    });
  });

  it("町域が空（市区町村まで）の住所も使える", () => {
    expect(
      parseZipcloudResponse(
        "0000001",
        zipcloudBody([{ ...DEMO, address3: "" }]),
      ),
    ).toMatchObject({ ok: true, addresses: ["デモ県サンプル市"] });
  });

  it("該当なし（results が null・空配列）は not_found", () => {
    expect(parseZipcloudResponse("0000001", zipcloudBody(null))).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(
      parseZipcloudResponse("0000001", { ...zipcloudBody(null), results: [] }),
    ).toEqual({ ok: false, reason: "not_found" });
  });

  it("zipcloud のエラー応答（本文の status が 200 以外）は unavailable", () => {
    expect(
      parseZipcloudResponse("0000001", {
        message: "パラメータ「郵便番号」の桁数が不正です。",
        results: null,
        status: 400,
      }),
    ).toEqual({ ok: false, reason: "unavailable" });
  });

  it.each([
    ["null", null],
    ["文字列", "OK"],
    ["status がない", { results: null }],
    ["results が配列でない", { status: 200, results: { address1: "デモ県" } }],
    [
      "住所が文字列でない",
      zipcloudBody([{ ...DEMO, address2: 123 as unknown as string }]),
    ],
    [
      "住所の項目が欠けている",
      { status: 200, results: [{ zipcode: "0000001" }] },
    ],
    [
      "住所に改行が入っている",
      zipcloudBody([{ ...DEMO, address3: "中央\n<script>" }]),
    ],
    ["住所が長すぎる", zipcloudBody([{ ...DEMO, address3: "あ".repeat(201) }])],
    ["別の郵便番号の結果", zipcloudBody([DEMO], "9999999")],
  ])("想定と違う応答（%s）は invalid_response", (_label, body) => {
    expect(parseZipcloudResponse("0000001", body)).toEqual({
      ok: false,
      reason: "invalid_response",
    });
  });
});

describe("lookupAddress（通信）", () => {
  it("タイムアウトは 3 秒（spec §6）", () => {
    expect(ADDRESS_LOOKUP_TIMEOUT_MS).toBe(3_000);
  });

  it("正常: ハイフンを除いた 7 桁で zipcloud を GET し、住所の候補を返す", async () => {
    const fetch = mockFetch(async () => jsonResponse(zipcloudBody([DEMO])));
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    try {
      await expect(lookupAddress("000-0001", { fetch })).resolves.toEqual({
        ok: true,
        postalCode: "0000001",
        addresses: ["デモ県サンプル市中央"],
      });
      expect(timeoutSpy).toHaveBeenCalledWith(3_000);
    } finally {
      timeoutSpy.mockRestore();
    }
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`${ZIPCLOUD_ENDPOINT}?zipcode=0000001`);
    expect(init?.method).toBe("GET");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("全角の数字・ハイフンも受け付ける", async () => {
    const fetch = mockFetch(async () => jsonResponse(zipcloudBody([DEMO])));
    await expect(
      lookupAddress("０００－０００１", { fetch }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("該当なしは not_found", async () => {
    const fetch = mockFetch(async () => jsonResponse(zipcloudBody(null)));
    await expect(lookupAddress("0000001", { fetch })).resolves.toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  it.each(["", "123", "12345678", "123-45678", "abc-defg", "1234-567"])(
    "形式が違う郵便番号（%j）は外部 API を呼ばずに invalid_postal_code",
    async (input) => {
      const fetch = mockFetch(async () => jsonResponse(zipcloudBody([DEMO])));
      await expect(lookupAddress(input, { fetch })).resolves.toEqual({
        ok: false,
        reason: "invalid_postal_code",
      });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("タイムアウト（応答がない）は timeout。待ち続けない", async () => {
    const started = Date.now();
    await expect(
      lookupAddress("0000001", { fetch: hangingFetch, timeoutMs: 30 }),
    ).resolves.toEqual({ ok: false, reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("本文の読み取り中にタイムアウトしても timeout", async () => {
    const fetch = mockFetch(
      async (_url, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              // 本文を送り始めて止まる
              controller.enqueue(new TextEncoder().encode('{"status":'));
              init?.signal?.addEventListener("abort", () =>
                controller.error(init.signal!.reason),
              );
            },
          }),
          { status: 200 },
        ),
    );
    await expect(
      lookupAddress("0000001", { fetch, timeoutMs: 30 }),
    ).resolves.toEqual({ ok: false, reason: "timeout" });
  });

  it.each([500, 503, 404, 429])(
    "HTTP エラー（%i）は unavailable",
    async (status) => {
      const fetch = mockFetch(async () =>
        jsonResponse({ message: "error" }, { status }),
      );
      await expect(lookupAddress("0000001", { fetch })).resolves.toEqual({
        ok: false,
        reason: "unavailable",
      });
    },
  );

  it("通信エラー（DNS・接続拒否など）は unavailable", async () => {
    const fetch = mockFetch(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(lookupAddress("0000001", { fetch })).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  it("JSON でない応答（HTML のエラーページなど）は invalid_response", async () => {
    const fetch = mockFetch(
      async () =>
        new Response("<html>maintenance</html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
    );
    await expect(lookupAddress("0000001", { fetch })).resolves.toEqual({
      ok: false,
      reason: "invalid_response",
    });
  });

  it("型が違う応答は invalid_response", async () => {
    const fetch = mockFetch(async () =>
      jsonResponse({ status: "200", results: "デモ県" }),
    );
    await expect(lookupAddress("0000001", { fetch })).resolves.toEqual({
      ok: false,
      reason: "invalid_response",
    });
  });
});

describe("ADDRESS_LOOKUP_MESSAGES", () => {
  it("どの失敗でも「住所を手入力してください」と示す", () => {
    for (const message of Object.values(ADDRESS_LOOKUP_MESSAGES)) {
      expect(message).toContain("住所を手入力してください");
    }
  });
});
