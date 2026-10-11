/**
 * CSV 出力の Route Handler（認可・DB はモックし、応答の形だけを確認する）。
 * 権限の判定そのものは src/lib/auth と結合テストで、CSV の中身は src/lib/products/csv.test.ts で確認している
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { authErrorResponse } from "@/lib/auth/session";
import { listProductsForCsv } from "@/lib/products/queries";

import { GET } from "./route";

const auth = vi.hoisted(() => ({ result: undefined as unknown }));

vi.mock("@/lib/auth/guards", () => ({
  requireApiPermission: vi.fn(async () => auth.result),
}));
vi.mock("@/lib/db", () => ({ getPrisma: vi.fn(() => ({})) }));
vi.mock("@/lib/products/queries", () => ({
  listProductsForCsv: vi.fn(async () => [
    {
      id: 1,
      code: "P-0001",
      name: "@テスト",
      category: "文具",
      unit: "個",
      salesPrice: 100,
      purchasePrice: 60,
      reorderPoint: 5,
      isActive: true,
      stock: 3,
    },
  ]),
}));

const VIEWER = {
  id: "u",
  name: "閲覧者",
  email: "viewer@example.com",
  role: "viewer",
};

beforeEach(() => {
  vi.mocked(listProductsForCsv).mockClear();
});

describe("GET /api/products/export", () => {
  it("未ログインは 401（DB を読まない）", async () => {
    auth.result = { ok: false, response: authErrorResponse(401) };
    const response = await GET(
      new Request("http://localhost:3000/api/products/export"),
    );
    expect(response.status).toBe(401);
    expect(listProductsForCsv).not.toHaveBeenCalled();
  });

  it("BOM 付き UTF-8 の CSV を添付ファイルで返し、検索条件を反映する", async () => {
    auth.result = { ok: true, user: VIEWER };
    const response = await GET(
      new Request(
        "http://localhost:3000/api/products/export?q=%E3%83%9A%E3%83%B3&status=all&sort=stock&order=desc&page=3",
      ),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/csv; charset=utf-8",
    );
    expect(response.headers.get("content-disposition")).toMatch(
      /^attachment; filename="products_\d{8}\.csv"$/,
    );
    expect(response.headers.get("cache-control")).toBe("no-store");

    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(bytes);
    expect(text.split("\r\n")).toEqual([
      "商品コード,商品名,カテゴリ,単位,売価,仕入単価,発注点,現在庫,状態",
      "P-0001,'@テスト,文具,個,100,60,5,3,有効",
      "",
    ]);
    expect(listProductsForCsv).toHaveBeenCalledWith(
      {},
      {
        q: "ペン",
        category: "",
        status: "all",
        sort: "stock",
        order: "desc",
        page: 3,
      },
    );
  });
});
