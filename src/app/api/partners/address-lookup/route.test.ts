/**
 * 住所検索の Route Handler（認可はモックし、外部 API は fetch のモックに差し替える）。
 * 応答の解釈そのものは src/lib/partners/address-lookup.test.ts で確認している。実 API は呼ばない
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { requireApiPermission } from "@/lib/auth/guards";
import { authErrorResponse } from "@/lib/auth/session";
import {
  addressCache,
  addressLookupRateLimiter,
} from "@/lib/partners/address-lookup-limits";

import { GET } from "./route";

const auth = vi.hoisted(() => ({ result: undefined as unknown }));

vi.mock("@/lib/auth/guards", () => ({
  requireApiPermission: vi.fn(async () => auth.result),
}));

const STAFF = {
  id: "u",
  name: "担当者",
  email: "staff@example.com",
  role: "staff",
};

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  auth.result = { ok: true, user: STAFF };
  fetchMock.mockReset();
  vi.mocked(requireApiPermission).mockClear();
  vi.stubGlobal("fetch", fetchMock);
  // プロセス内のキャッシュ・回数制限はテストごとに空にする
  addressCache.clear();
  addressLookupRateLimiter.clear();
  // 失敗時のサーバー側のログは出力しない
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function request(postalCode?: string) {
  const query =
    postalCode === undefined
      ? ""
      : `?postalCode=${encodeURIComponent(postalCode)}`;
  return new Request(
    `http://localhost:3000/api/partners/address-lookup${query}`,
  );
}

function zipcloud(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("GET /api/partners/address-lookup", () => {
  it("未ログインは 401、権限外は 403（外部 API を呼ばない）", async () => {
    auth.result = { ok: false, response: authErrorResponse(401) };
    expect((await GET(request("0000001"))).status).toBe(401);
    auth.result = { ok: false, response: authErrorResponse(403) };
    expect((await GET(request("0000001"))).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("権限は master:edit（取引先の登録・編集ができるロール）で検査する", async () => {
    fetchMock.mockResolvedValue(
      zipcloud({ status: 200, message: null, results: null }),
    );
    const req = request("0000001");
    await GET(req);
    expect(requireApiPermission).toHaveBeenCalledTimes(1);
    expect(requireApiPermission).toHaveBeenCalledWith(req, "master:edit");
  });

  it("同じ郵便番号の 2 回目はキャッシュから返し、外部 API を呼ばない", async () => {
    fetchMock.mockImplementation(async () =>
      zipcloud({
        status: 200,
        message: null,
        results: [
          {
            zipcode: "0000001",
            address1: "デモ県",
            address2: "サンプル市",
            address3: "中央",
          },
        ],
      }),
    );
    expect((await GET(request("0000001"))).status).toBe(200);
    const second = await GET(request("000-0001"));
    expect(second.status).toBe(200);
    expect((await second.json()).addresses).toEqual(["デモ県サンプル市中央"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ユーザーごとに 1 分 30 回まで。超えたら 429 と日本語のメッセージ（外部 API を呼ばない）", async () => {
    // 形式エラー（外部 API を呼ばない）で回数だけ使う
    for (let i = 0; i < 30; i++) {
      expect((await GET(request("12"))).status).toBe(400);
    }
    const response = await GET(request("0000001"));
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toMatch(/^\d+$/);
    expect(await response.json()).toEqual({
      error:
        "住所の検索回数が多すぎます。しばらくしてからもう一度お試しいただくか、住所を手入力してください",
      reason: "rate_limited",
    });
    expect(fetchMock).not.toHaveBeenCalled();

    // 別のユーザーは数えない
    auth.result = { ok: true, user: { ...STAFF, id: "other" } };
    fetchMock.mockResolvedValue(
      zipcloud({ status: 200, message: null, results: null }),
    );
    expect((await GET(request("0000001"))).status).toBe(404);
  });

  it("正常: 200 と住所の候補（キャッシュさせない）", async () => {
    fetchMock.mockResolvedValue(
      zipcloud({
        status: 200,
        message: null,
        results: [
          {
            zipcode: "0000001",
            address1: "デモ県",
            address2: "サンプル市",
            address3: "中央",
          },
        ],
      }),
    );
    const response = await GET(request("000-0001"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      postalCode: "0000001",
      addresses: ["デモ県サンプル市中央"],
    });
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://zipcloud.ibsnet.co.jp/api/search?zipcode=0000001",
    );
  });

  it("形式エラーは 400（外部 API を呼ばない）", async () => {
    for (const code of [undefined, "", "12345", "abc&zipcode=1234567"]) {
      const response = await GET(request(code));
      expect(response.status).toBe(400);
      expect((await response.json()).reason).toBe("invalid_postal_code");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("該当なしは 404 と「住所を手入力してください」", async () => {
    fetchMock.mockResolvedValue(
      zipcloud({ status: 200, message: null, results: null }),
    );
    const response = await GET(request("0000001"));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "該当する住所が見つかりませんでした。住所を手入力してください",
      reason: "not_found",
    });
  });

  it("タイムアウトは 504", async () => {
    fetchMock.mockRejectedValue(
      new DOMException(
        "The operation was aborted due to timeout",
        "TimeoutError",
      ),
    );
    const response = await GET(request("0000001"));
    expect(response.status).toBe(504);
    expect((await response.json()).reason).toBe("timeout");
  });

  it("HTTP エラー・不正な応答は 502", async () => {
    fetchMock.mockResolvedValueOnce(new Response("error", { status: 500 }));
    expect((await GET(request("0000001"))).status).toBe(502);
    fetchMock.mockResolvedValueOnce(zipcloud({ unexpected: true }));
    const response = await GET(request("0000001"));
    expect(response.status).toBe(502);
    expect((await response.json()).reason).toBe("invalid_response");
  });
});
