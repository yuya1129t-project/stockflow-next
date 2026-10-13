/**
 * 受注の CSV 出力の Route Handler（認可・DB はモックし、応答の形と要求する権限を確認する）。
 * CSV の中身は src/lib/sales-orders/csv.test.ts、上限の判定は結合テストで確認している
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireApiPermission } from "@/lib/auth/guards";
import { authErrorResponse } from "@/lib/auth/session";
import { listSalesOrdersForCsv } from "@/lib/sales-orders/queries";

import { GET } from "./route";

const auth = vi.hoisted(() => ({ result: undefined as unknown }));

vi.mock("@/lib/auth/guards", () => ({
  requireApiPermission: vi.fn(async () => auth.result),
}));
vi.mock("@/lib/db", () => ({ getPrisma: vi.fn(() => ({})) }));
vi.mock("@/lib/sales-orders/queries", () => ({
  SALES_ORDER_EXPORT_MAX_ROWS: 2,
  listSalesOrdersForCsv: vi.fn(async () => ({
    overLimit: false,
    items: [
      {
        id: 1,
        number: "SO-20261013-001",
        orderDate: new Date("2026-10-13T00:00:00Z"),
        dueDate: new Date("2026-10-20T00:00:00Z"),
        status: "draft",
        subtotal: 1000,
        tax: 100,
        total: 1100,
        note: null,
        customer: { id: 3, code: "C-0001", name: "+サンプル" },
        lineCount: 1,
      },
    ],
  })),
}));

const VIEWER = {
  id: "u",
  name: "閲覧者",
  email: "viewer@example.com",
  role: "viewer",
};

beforeEach(() => {
  vi.mocked(listSalesOrdersForCsv).mockClear();
  vi.mocked(requireApiPermission).mockClear();
});

describe("GET /api/sales-orders/export", () => {
  it("権限は csv:export をそのリクエストで検査する。未ログインは 401（DB を読まない）", async () => {
    auth.result = { ok: false, response: authErrorResponse(401) };
    const request = new Request(
      "http://localhost:3000/api/sales-orders/export",
    );
    const response = await GET(request);
    expect(response.status).toBe(401);
    expect(requireApiPermission).toHaveBeenCalledTimes(1);
    expect(requireApiPermission).toHaveBeenCalledWith(request, "csv:export");
    expect(listSalesOrdersForCsv).not.toHaveBeenCalled();
  });

  it("BOM 付き UTF-8 の CSV を添付ファイルで返し、検索条件を反映する", async () => {
    auth.result = { ok: true, user: VIEWER };
    const response = await GET(
      new Request(
        "http://localhost:3000/api/sales-orders/export?q=SO-2026&customer=3&status=draft&from=2026-10-01&to=2026-10-31&sort=total&order=asc&page=4",
      ),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/csv; charset=utf-8",
    );
    expect(response.headers.get("content-disposition")).toMatch(
      /^attachment; filename="sales_orders_\d{8}\.csv"$/,
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(bytes).split("\r\n")).toEqual([
      "受注番号,受注日,納期,顧客コード,顧客名,ステータス,明細数,小計,消費税,合計,備考",
      "SO-20261013-001,2026-10-13,2026-10-20,C-0001,'+サンプル,下書き,1,1000,100,1100,",
      "",
    ]);
    expect(listSalesOrdersForCsv).toHaveBeenCalledWith(
      {},
      {
        q: "SO-2026",
        customerId: 3,
        status: "draft",
        from: "2026-10-01",
        to: "2026-10-31",
        sort: "total",
        order: "asc",
        page: 4,
      },
    );
  });

  it("上限を超えるときは出力せず 413 と日本語のメッセージ", async () => {
    auth.result = { ok: true, user: VIEWER };
    vi.mocked(listSalesOrdersForCsv).mockResolvedValueOnce({
      items: [],
      overLimit: true,
    });
    const response = await GET(
      new Request("http://localhost:3000/api/sales-orders/export"),
    );
    expect(response.status).toBe(413);
    expect(response.headers.get("content-type")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(await response.text()).toBe(
      "件数が多すぎます。絞り込んでから出力してください（上限 2 件）",
    );
  });
});
