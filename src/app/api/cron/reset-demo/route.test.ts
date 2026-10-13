/**
 * 日次リセットの Route Handler（リセットの処理はモック）。認証と応答の形を確かめる。
 * 実 DB でのリセット・ガードは tests/integration/reset-demo.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DemoResetRefusedError,
  resetDemoData,
} from "../../../../../prisma/reset-demo-data";
import { GET } from "./route";

vi.mock("../../../../../prisma/reset-demo-data", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../../../prisma/reset-demo-data")
    >();
  return { ...actual, resetDemoData: vi.fn() };
});

const SECRET = "test-cron-secret-0123456789abcdef";
const DB_URL = "postgresql://u:p@db.example.com:5432/neondb";
const RESULT = {
  target: "db.example.com:5432/neondb",
  counts: {
    users: 3,
    partners: 20,
    products: 50,
    salesOrders: 80,
    purchaseOrders: 40,
    stockMovements: 100,
  },
};

function request(authorization?: string) {
  return new Request("http://localhost:3000/api/cron/reset-demo", {
    headers: authorization ? { authorization } : {},
  });
}

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", SECRET);
  vi.stubEnv("DATABASE_URL", DB_URL);
  vi.mocked(resetDemoData).mockReset();
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GET /api/cron/reset-demo", () => {
  it("Bearer が CRON_SECRET と一致しなければ 401 で、リセットしない", async () => {
    for (const header of [undefined, "Bearer wrong", SECRET]) {
      const res = await GET(request(header));
      expect(res.status).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(resetDemoData).not.toHaveBeenCalled();
  });

  it("CRON_SECRET が未設定なら 401", async () => {
    vi.stubEnv("CRON_SECRET", "");
    const res = await GET(request("Bearer "));
    expect(res.status).toBe(401);
    expect(resetDemoData).not.toHaveBeenCalled();
  });

  it("認証に通れば DATABASE_URL に対してリセットし、件数と所要時間を返す", async () => {
    vi.mocked(resetDemoData).mockResolvedValue(RESULT);
    const res = await GET(request(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect(resetDemoData).toHaveBeenCalledWith({ url: DB_URL });
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, ...RESULT });
    expect(body.durationMs).toBeTypeOf("number");
  });

  it("ガードで拒否されたら 500 で理由を返す", async () => {
    vi.mocked(resetDemoData).mockRejectedValue(
      new DemoResetRefusedError("ローカル以外の DB のデータは消去しません"),
    );
    const res = await GET(request(`Bearer ${SECRET}`));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      ok: false,
      error: "シードを中止しました: ローカル以外の DB のデータは消去しません",
    });
  });

  it("それ以外の失敗は 500 で、詳細は応答に含めない", async () => {
    vi.mocked(resetDemoData).mockRejectedValue(
      new Error("connect ECONNREFUSED secret-host"),
    );
    const res = await GET(request(`Bearer ${SECRET}`));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({
      ok: false,
      error: "デモデータのリセットに失敗しました",
    });
  });
});
