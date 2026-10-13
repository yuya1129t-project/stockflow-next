/**
 * 外部向け REST API（/api/v1）の結合テスト（実 DB = DATABASE_URL_TEST）。docs/spec.md §6-2
 * 前提: pnpm db:test:reset でテスト用 DB にマイグレーションとシードを適用済み
 *
 * Route Handler を、getPrisma だけテスト用 DB に差し替えて呼ぶ（トークンの検証・権限・受注の service は本物）。
 * 応答はすべて OpenAPI の定義（docs/openapi.json）で検証し（openapi-validator.ts）、最後に定義した応答を
 * すべて確かめたことを確認する（実装と定義の食い違いの検出）。
 *
 * シードのデータは書き換えない。このファイル専用の取引先・商品（コードが ZA- で始まる）・ユーザー（id が za_ で始まる）・
 * トークン（名前が za-api-test で始まる）を作り、開始時と終了時に削除する。採番テーブル（SO）は残っている受注に合わせる
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";
import { createAuth } from "@/lib/auth/auth";
import { generateApiToken } from "@/lib/auth/api-token";
import { getSessionUser, type SessionUser } from "@/lib/auth/session";
import { calcOrderAmounts } from "@/lib/orders/amounts";
import { todayInTokyo } from "@/lib/orders/dates";
import { PARTNER_TARGET_TYPE } from "@/lib/partners/service";
import {
  createSalesOrder,
  SALES_ORDER_TARGET_TYPE,
} from "@/lib/sales-orders/service";

import { DEMO_PASSWORD, DEMO_USERS } from "../../prisma/seed-data";
import {
  checkedResponses,
  documentedResponses,
  expectMatchesSpec,
} from "./openapi-validator";
import { connectTestDb, SETUP_HINT } from "./test-db";

const mocks = vi.hoisted(() => ({ prisma: null as PrismaClient | null }));

vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  getPrisma: () => mocks.prisma!,
}));

// モックの後で読み込む
const productsRoute = await import("@/app/api/v1/products/route");
const productStockRoute =
  await import("@/app/api/v1/products/[code]/stock/route");
const salesOrdersRoute = await import("@/app/api/v1/sales-orders/route");
const salesOrderRoute =
  await import("@/app/api/v1/sales-orders/[number]/route");
const notFoundRoute = await import("@/app/api/v1/[...path]/route");

let prisma: PrismaClient;
const startedAt = new Date();

const [ADMIN, STAFF, VIEWER] = DEMO_USERS.map(
  ({ id, name, email, role }): SessionUser => ({ id, name, email, role }),
);

const PREFIX = "ZA-";
const TOKEN_NAME = "za-api-test";
const INACTIVE_USER = {
  id: "za_api_inactive",
  name: "API テスト用（無効）",
  email: "za-api-inactive@example.com",
  role: "staff" as const,
};

const BASE = "http://localhost:3000";

/** テストで使うトークン（平文はテストの中だけ。ログには出さない） */
const tokens = {} as Record<
  "admin" | "staff" | "viewer" | "revoked" | "inactive",
  { token: string; id: number }
>;

/** 作ったデータ */
const data = {} as {
  customer: { id: number; code: string };
  supplier: { code: string };
  inactiveCustomer: { code: string };
  product: { id: number; code: string; salesPrice: number };
  inactiveProduct: { code: string };
  lowProduct: { id: number; code: string; salesPrice: number };
};

async function cleanUp() {
  const [partners, products] = await Promise.all([
    prisma.partner.findMany({
      where: { code: { startsWith: PREFIX } },
      select: { id: true },
    }),
    prisma.product.findMany({
      where: { code: { startsWith: PREFIX } },
      select: { id: true },
    }),
  ]);
  const partnerIds = partners.map((p) => p.id);
  const productIds = products.map((p) => p.id);
  const orderIds = (
    await prisma.salesOrder.findMany({
      where: { customerId: { in: partnerIds } },
      select: { id: true },
    })
  ).map((o) => o.id);
  await prisma.salesOrder.deleteMany({ where: { id: { in: orderIds } } });
  await prisma.stockMovement.deleteMany({
    where: { productId: { in: productIds } },
  });
  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        {
          targetType: SALES_ORDER_TARGET_TYPE,
          targetId: { in: orderIds.map(String) },
        },
        {
          targetType: PARTNER_TARGET_TYPE,
          targetId: { in: partnerIds.map(String) },
        },
        { userId: INACTIVE_USER.id },
      ],
    },
  });
  await prisma.product.deleteMany({ where: { id: { in: productIds } } });
  await prisma.partner.deleteMany({ where: { id: { in: partnerIds } } });
  await prisma.apiToken.deleteMany({
    where: { name: { startsWith: TOKEN_NAME } },
  });
  await prisma.user.deleteMany({ where: { id: INACTIVE_USER.id } });
}

/** 採番テーブル（SO）を残っている受注の番号に合わせる（tests/integration/sales-orders.test.ts と同じ） */
async function syncSoSequences() {
  await prisma.$executeRaw`
    DELETE FROM "document_sequence" ds
    WHERE ds."kind" = 'SO'
      AND NOT EXISTS (
        SELECT 1 FROM "sales_order" so WHERE so."orderDate" = ds."date"
      )`;
  await prisma.$executeRaw`
    UPDATE "document_sequence" ds
    SET "lastNumber" = m."last"
    FROM (
      SELECT "orderDate", MAX(split_part("number", '-', 3)::int) AS "last"
      FROM "sales_order"
      GROUP BY "orderDate"
    ) m
    WHERE ds."kind" = 'SO' AND ds."date" = m."orderDate"
      AND ds."lastNumber" <> m."last"`;
}

async function createToken(userId: string, revoked = false) {
  const { token, tokenHash } = generateApiToken();
  const row = await prisma.apiToken.create({
    data: {
      userId,
      name: `${TOKEN_NAME} ${userId}`,
      tokenHash,
      revokedAt: revoked ? new Date() : null,
    },
  });
  return { token, id: row.id };
}

async function createProduct(
  code: string,
  {
    salesPrice,
    reorderPoint,
    stock,
    isActive = true,
  }: {
    salesPrice: number;
    reorderPoint: number;
    stock: number;
    isActive?: boolean;
  },
) {
  const product = await prisma.product.create({
    data: {
      code,
      name: `API テスト商品 ${code}`,
      category: "API テスト",
      unit: "個",
      salesPrice,
      purchasePrice: 50,
      reorderPoint,
      isActive,
    },
  });
  if (stock > 0) {
    await prisma.stockMovement.create({
      data: {
        productId: product.id,
        type: "adjust",
        quantity: stock,
        reason: "初期在庫（テスト）",
      },
    });
  }
  return product;
}

beforeAll(async () => {
  prisma = await connectTestDb();
  mocks.prisma = prisma;
  if ((await prisma.product.count()) === 0) {
    throw new Error(`テスト用 DB にシードが入っていません。${SETUP_HINT}`);
  }
  await cleanUp();
  await syncSoSequences();

  const partner = (
    code: string,
    kind: "customer" | "supplier",
    isActive = true,
  ) =>
    prisma.partner.create({
      data: { code, name: `API テスト取引先 ${code}`, kind, isActive },
    });
  data.customer = await partner("ZA-C001", "customer");
  data.supplier = await partner("ZA-S001", "supplier");
  data.inactiveCustomer = await partner("ZA-C002", "customer", false);
  data.product = await createProduct("ZA-P001", {
    salesPrice: 1200,
    reorderPoint: 5,
    stock: 10,
  });
  data.inactiveProduct = await createProduct("ZA-P002", {
    salesPrice: 333,
    reorderPoint: 0,
    stock: 0,
    isActive: false,
  });
  data.lowProduct = await createProduct("ZA-P003", {
    salesPrice: 455,
    reorderPoint: 10,
    stock: 3,
  });

  tokens.admin = await createToken(ADMIN.id);
  tokens.staff = await createToken(STAFF.id);
  tokens.viewer = await createToken(VIEWER.id);
  tokens.revoked = await createToken(STAFF.id, true);
  await prisma.user.create({
    data: { ...INACTIVE_USER, emailVerified: true, isActive: true },
  });
  tokens.inactive = await createToken(INACTIVE_USER.id);
  // トークンを発行した後に無効にする（ユーザー無効の確認は authenticateApiToken でも行う）
  await prisma.user.update({
    where: { id: INACTIVE_USER.id },
    data: { isActive: false },
  });
});

afterAll(async () => {
  if (!prisma) return;
  try {
    await cleanUp();
    await syncSoSequences();
    // Cookie のテストで作ったセッションとログインの操作履歴
    await prisma.session.deleteMany({
      where: { userId: STAFF.id, createdAt: { gte: startedAt } },
    });
    await prisma.auditLog.deleteMany({
      where: {
        userId: STAFF.id,
        action: "login",
        createdAt: { gte: startedAt },
      },
    });
  } finally {
    await prisma.$disconnect();
  }
});

// ---- リクエストの組み立て ----

interface CallOptions {
  token?: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** 本文をそのまま送る（JSON にしない） */
  rawBody?: string;
}

function request(
  method: "GET" | "POST",
  path: string,
  options: CallOptions = {},
) {
  const headers = new Headers(options.headers);
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  let body: string | undefined = options.rawBody;
  if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
  }
  return new Request(`${BASE}${path}`, { method, headers, body });
}

const listProducts = (query = "", options?: CallOptions) =>
  productsRoute.GET(request("GET", `/api/v1/products${query}`, options));

const getStock = (code: string, options?: CallOptions) =>
  productStockRoute.GET(
    request(
      "GET",
      `/api/v1/products/${encodeURIComponent(code)}/stock`,
      options,
    ),
    { params: Promise.resolve({ code }) },
  );

const listOrders = (query = "", options?: CallOptions) =>
  salesOrdersRoute.GET(request("GET", `/api/v1/sales-orders${query}`, options));

const getOrder = (number: string, options?: CallOptions) =>
  salesOrderRoute.GET(
    request(
      "GET",
      `/api/v1/sales-orders/${encodeURIComponent(number)}`,
      options,
    ),
    { params: Promise.resolve({ number }) },
  );

const postOrder = (options: CallOptions) =>
  salesOrdersRoute.POST(request("POST", "/api/v1/sales-orders", options));

const PRODUCTS = "/api/v1/products";
const STOCK = "/api/v1/products/{code}/stock";
const ORDERS = "/api/v1/sales-orders";
const ORDER = "/api/v1/sales-orders/{number}";

interface ProblemBody {
  type: string;
  title: string;
  status: number;
  detail: string;
  errors?: { pointer?: string; parameter?: string; detail: string }[];
}

async function expectProblem(
  method: "get" | "post",
  path: string,
  response: Response,
  status: number,
): Promise<ProblemBody> {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toBe("application/problem+json");
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = (await expectMatchesSpec(method, path, response)) as ProblemBody;
  expect(body.status).toBe(status);
  expect(body.type).toBe("about:blank");
  return body;
}

const fieldsOf = (body: ProblemBody) =>
  (body.errors ?? []).map((e) => e.pointer ?? e.parameter);

const salesOrderCount = () =>
  prisma.salesOrder.count({ where: { customerId: data.customer.id } });

// ---- テスト ----

describe("認証（Bearer トークンのみ。失敗は理由を区別しない 401）", () => {
  const endpoints: [
    string,
    "get" | "post",
    string,
    (o: CallOptions) => Promise<Response>,
  ][] = [
    ["GET 商品一覧", "get", PRODUCTS, (o) => listProducts("", o)],
    ["GET 現在庫", "get", STOCK, (o) => getStock("ZA-P001", o)],
    ["GET 受注一覧", "get", ORDERS, (o) => listOrders("", o)],
    ["GET 受注詳細", "get", ORDER, (o) => getOrder("SO-20000101-001", o)],
    ["POST 受注の登録", "post", ORDERS, (o) => postOrder({ ...o, body: {} })],
  ];

  it.each(endpoints)(
    "%s: Authorization ヘッダーがなければ 401（WWW-Authenticate: Bearer）",
    async (_label, method, path, call) => {
      const response = await call({});
      expect(response.headers.get("www-authenticate")).toBe(
        'Bearer realm="StockFlow API"',
      );
      const body = await expectProblem(method, path, response, 401);
      expect(body.title).toBe("Unauthorized");
    },
  );

  it("形式違い・存在しない・失効済み・無効ユーザーのトークンは、すべて同じ 401（理由を区別しない）", async () => {
    const variants = [
      { authorization: "Basic dXNlcjpwYXNz" },
      { authorization: "Bearer" },
      { authorization: "Bearer not-a-token" },
      { authorization: `Bearer ${generateApiToken().token}` }, // 形式は正しいが存在しない
      { authorization: `Bearer ${tokens.revoked.token}` },
      { authorization: `Bearer ${tokens.inactive.token}` },
      { authorization: `bearer ${tokens.staff.token}x` },
    ];
    const bodies = [];
    for (const headers of variants) {
      const response = await listProducts("", { headers });
      expect(response.headers.get("www-authenticate")).toBe(
        'Bearer realm="StockFlow API"',
      );
      bodies.push(await expectProblem("get", PRODUCTS, response, 401));
    }
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
  });

  it("スキーム名は大文字・小文字を区別しない（RFC 6750）", async () => {
    const response = await listProducts("?perPage=1", {
      headers: { authorization: `bearer ${tokens.viewer.token}` },
    });
    expect(response.status).toBe(200);
  });

  it("画面のログイン（Cookie）だけでは 401。Cookie があっても Bearer トークンで認証する", async () => {
    const auth = createAuth(prisma);
    const { headers } = await auth.api.signInEmail({
      body: { email: STAFF.email, password: DEMO_PASSWORD },
      returnHeaders: true,
    });
    const cookie = headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    // 画面ではこの Cookie でログインできている
    expect(await getSessionUser(auth, new Headers({ cookie }))).toMatchObject({
      id: STAFF.id,
    });

    const countBefore = await salesOrderCount();
    await expectProblem(
      "get",
      PRODUCTS,
      await listProducts("", { headers: { cookie } }),
      401,
    );
    await expectProblem(
      "post",
      ORDERS,
      await postOrder({
        headers: { cookie },
        body: {
          customerCode: data.customer.code,
          lines: [{ productCode: data.product.code, quantity: 1 }],
        },
      }),
      401,
    );
    expect(await salesOrderCount()).toBe(countBefore);

    // Cookie はあっても無視し、Bearer トークン（viewer）の権限で判定する
    await expectProblem(
      "post",
      ORDERS,
      await postOrder({
        token: tokens.viewer.token,
        headers: { cookie },
        body: {
          customerCode: data.customer.code,
          lines: [{ productCode: data.product.code, quantity: 1 }],
        },
      }),
      403,
    );
  });

  it("認証の前に本文を読まない（トークンなしの不正な JSON は 400 ではなく 401）", async () => {
    const response = await postOrder({
      headers: { "content-type": "application/json" },
      rawBody: "{not json",
    });
    await expectProblem("post", ORDERS, response, 401);
  });
});

describe("GET /api/v1/products", () => {
  it("既定は 1 ページ目・20 件。全件数を返し、商品コードの昇順。全ロールが参照できる", async () => {
    const total = await prisma.product.count();
    for (const token of [tokens.admin, tokens.staff, tokens.viewer]) {
      const response = await listProducts("", { token: token.token });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = (await expectMatchesSpec("get", PRODUCTS, response)) as {
        data: { code: string }[];
        meta: unknown;
      };
      expect(body.meta).toEqual({ page: 1, perPage: 20, total });
      expect(body.data).toHaveLength(Math.min(20, total));
      const codes = body.data.map((p) => p.code);
      expect(codes).toEqual([...codes].sort());
    }
  });

  it("q は商品コード・名前・カテゴリの部分一致（大文字・小文字を区別しない）。無効な商品・現在庫・発注点割れを含む", async () => {
    const response = await listProducts("?q=za-p", {
      token: tokens.viewer.token,
    });
    const body = (await expectMatchesSpec("get", PRODUCTS, response)) as {
      data: unknown[];
      meta: unknown;
    };
    expect(body.meta).toEqual({ page: 1, perPage: 20, total: 3 });
    expect(body.data).toEqual([
      {
        code: "ZA-P001",
        name: "API テスト商品 ZA-P001",
        category: "API テスト",
        unit: "個",
        salesPrice: 1200,
        purchasePrice: 50,
        reorderPoint: 5,
        isActive: true,
        stock: 10,
        belowReorderPoint: false,
      },
      expect.objectContaining({
        code: "ZA-P002",
        isActive: false,
        stock: 0,
        // 無効な商品は発注点割れにしない（在庫一覧・通知と同じ定義）
        belowReorderPoint: false,
      }),
      expect.objectContaining({
        code: "ZA-P003",
        stock: 3,
        reorderPoint: 10,
        belowReorderPoint: true,
      }),
    ]);
  });

  it("ページ送りの境界: 最後のページは端数、全件数を超えるページは空（丸めない）", async () => {
    const page = async (query: string) =>
      (await expectMatchesSpec(
        "get",
        PRODUCTS,
        await listProducts(query, { token: tokens.viewer.token }),
      )) as { data: { code: string }[]; meta: unknown };

    const second = await page("?q=ZA-P&perPage=2&page=2");
    expect(second.data.map((p) => p.code)).toEqual(["ZA-P003"]);
    expect(second.meta).toEqual({ page: 2, perPage: 2, total: 3 });

    const beyond = await page("?q=ZA-P&perPage=2&page=3");
    expect(beyond.data).toEqual([]);
    expect(beyond.meta).toEqual({ page: 3, perPage: 2, total: 3 });

    const max = await page("?perPage=100");
    expect(max.meta).toMatchObject({ page: 1, perPage: 100 });

    const none = await page("?q=該当なしの検索語");
    expect(none).toEqual({
      data: [],
      meta: { page: 1, perPage: 20, total: 0 },
    });
  });

  it.each([
    ["?perPage=101", "perPage"],
    ["?perPage=0", "perPage"],
    ["?perPage=abc", "perPage"],
    ["?perPage=1.5", "perPage"],
    ["?perPage=-1", "perPage"],
    ["?page=0", "page"],
    ["?page=1000001", "page"],
    ["?page=1&page=2", "page"],
    [`?q=${"a".repeat(101)}`, "q"],
    // NUL は PostgreSQL に渡すと 500 になる（レビューの再現例 GET /api/v1/products?q=%00）
    ["?q=%00", "q"],
  ])("不正なクエリ %s は 400（parameter = %s）", async (query, parameter) => {
    const body = await expectProblem(
      "get",
      PRODUCTS,
      await listProducts(query, { token: tokens.viewer.token }),
      400,
    );
    expect(body.title).toBe("Bad Request");
    expect(fieldsOf(body)).toEqual([parameter]);
  });
});

describe("GET /api/v1/products/{code}/stock", () => {
  it("現在庫と発注点を返す（商品コードの大文字・小文字は区別しない）", async () => {
    for (const code of ["ZA-P003", "za-p003"]) {
      const response = await getStock(code, { token: tokens.viewer.token });
      expect(response.status).toBe(200);
      expect(await expectMatchesSpec("get", STOCK, response)).toEqual({
        code: "ZA-P003",
        name: "API テスト商品 ZA-P003",
        unit: "個",
        isActive: true,
        stock: 3,
        reorderPoint: 10,
        belowReorderPoint: true,
      });
    }
  });

  it("パスに NUL があれば 400（レビューの再現例 GET /api/v1/products/%00/stock。DB には渡さない）", async () => {
    const body = await expectProblem(
      "get",
      STOCK,
      await getStock("\u0000", { token: tokens.viewer.token }),
      400,
    );
    expect(body.errors).toEqual([
      { parameter: "code", detail: "NUL 文字（U+0000）は使えません" },
    ]);
  });

  it("存在しない商品は 404", async () => {
    const body = await expectProblem(
      "get",
      STOCK,
      await getStock("ZA-NOPE", { token: tokens.viewer.token }),
      404,
    );
    expect(body.detail).toBe("商品「ZA-NOPE」が見つかりません");
  });
});

describe("GET /api/v1/sales-orders", () => {
  it("既定は受注日の新しい順・20 件", async () => {
    const all = (await expectMatchesSpec(
      "get",
      ORDERS,
      await listOrders("", { token: tokens.viewer.token }),
    )) as {
      data: { orderDate: string; number: string }[];
      meta: { total: number };
    };
    expect(all.meta).toEqual({
      page: 1,
      perPage: 20,
      total: await prisma.salesOrder.count(),
    });
    const keys = all.data.map((o) => `${o.orderDate} ${o.number}`);
    expect(keys).toEqual([...keys].sort().reverse());
  });

  it("from・to・status で絞り込める（両端を含む）。from・to のどちらを無視しても件数が合わなくなる期間で確かめる", async () => {
    // 期間の境界は、受注日の一覧の 1/3 と 2/3 の位置の日（どちらの側にも期間外の受注がある）
    const dates = (
      await prisma.salesOrder.findMany({
        distinct: ["orderDate"],
        select: { orderDate: true },
        orderBy: { orderDate: "asc" },
      })
    ).map((o) => o.orderDate.toISOString().slice(0, 10));
    expect(dates.length).toBeGreaterThanOrEqual(6);
    const from = dates[Math.floor(dates.length / 3)];
    const to = dates[Math.floor((dates.length * 2) / 3)];
    const day = (value: string) => new Date(`${value}T00:00:00Z`);
    const all = await prisma.salesOrder.count();
    const cases = [
      { query: `from=${from}`, where: { orderDate: { gte: day(from) } } },
      { query: `to=${to}`, where: { orderDate: { lte: day(to) } } },
      {
        query: `from=${from}&to=${to}`,
        where: { orderDate: { gte: day(from), lte: day(to) } },
      },
      {
        query: `from=${to}&to=${to}`,
        where: { orderDate: { gte: day(to), lte: day(to) } },
      },
      {
        query: `status=shipped&from=${from}&to=${to}`,
        where: {
          status: "shipped" as const,
          orderDate: { gte: day(from), lte: day(to) },
        },
      },
    ];
    for (const { query, where } of cases) {
      const expected = await prisma.salesOrder.count({ where });
      // 0 件や全件の条件では、絞り込みを無視する誤りを検出できないので先に確かめる
      expect(expected, query).toBeGreaterThan(0);
      expect(expected, query).toBeLessThan(all);
      const body = (await expectMatchesSpec(
        "get",
        ORDERS,
        await listOrders(`?${query}&perPage=100`, {
          token: tokens.viewer.token,
        }),
      )) as {
        data: { orderDate: string; status: string }[];
        meta: { total: number };
      };
      expect(body.meta.total, query).toBe(expected);
      expect(body.data.length, query).toBeGreaterThan(0);
      expect(body.data, query).toHaveLength(Math.min(100, expected));
      const params = new URLSearchParams(query);
      for (const order of body.data) {
        if (params.has("from")) {
          expect(order.orderDate >= params.get("from")!, query).toBe(true);
        }
        if (params.has("to")) {
          expect(order.orderDate <= params.get("to")!, query).toBe(true);
        }
        if (params.has("status")) {
          expect(order.status, query).toBe(params.get("status"));
        }
      }
    }
  });

  it.each([
    ["?status=open", "status"],
    ["?status=%00", "status"],
    ["?from=1999-12-31", "from"],
    ["?to=2100-01-01", "to"],
    ["?from=2026-02-30", "from"],
    ["?to=20261013", "to"],
    ["?from=2026-10-13&to=2026-10-12", "to"],
    ["?perPage=101", "perPage"],
  ])("不正なクエリ %s は 400（parameter = %s）", async (query, parameter) => {
    const body = await expectProblem(
      "get",
      ORDERS,
      await listOrders(query, { token: tokens.viewer.token }),
      400,
    );
    expect(fieldsOf(body)).toEqual([parameter]);
  });
});

describe("GET /api/v1/sales-orders/{number}", () => {
  it("明細を含む詳細を返す（受注番号の大文字・小文字は区別しない）", async () => {
    const seed = await prisma.salesOrder.findFirstOrThrow({
      where: { lines: { some: {} } },
      orderBy: { number: "asc" },
      include: {
        customer: true,
        lines: { orderBy: { id: "asc" }, include: { product: true } },
      },
    });
    for (const number of [seed.number, seed.number.toLowerCase()]) {
      const response = await getOrder(number, { token: tokens.viewer.token });
      expect(response.status).toBe(200);
      const body = (await expectMatchesSpec("get", ORDER, response)) as Record<
        string,
        unknown
      >;
      expect(body).toEqual({
        number: seed.number,
        orderDate: seed.orderDate.toISOString().slice(0, 10),
        dueDate: seed.dueDate ? seed.dueDate.toISOString().slice(0, 10) : null,
        status: seed.status,
        customer: { code: seed.customer.code, name: seed.customer.name },
        note: seed.note,
        subtotal: seed.subtotal,
        tax: seed.tax,
        total: seed.total,
        lines: seed.lines.map((line) => ({
          product: {
            code: line.product.code,
            name: line.product.name,
            unit: line.product.unit,
          },
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          amount: line.quantity * line.unitPrice,
        })),
        createdAt: seed.createdAt.toISOString(),
        updatedAt: seed.updatedAt.toISOString(),
      });
    }
  });

  it("パスに NUL があれば 400（レビューの再現例 GET /api/v1/sales-orders/%00）", async () => {
    const body = await expectProblem(
      "get",
      ORDER,
      await getOrder("\u0000", { token: tokens.viewer.token }),
      400,
    );
    expect(body.errors).toEqual([
      { parameter: "number", detail: "NUL 文字（U+0000）は使えません" },
    ]);
  });

  it("存在しない受注は 404", async () => {
    const body = await expectProblem(
      "get",
      ORDER,
      await getOrder("SO-20000101-999", { token: tokens.viewer.token }),
      404,
    );
    expect(body.detail).toBe("受注「SO-20000101-999」が見つかりません");
  });
});

describe("POST /api/v1/sales-orders", () => {
  const validBody = () => ({
    customerCode: "za-c001",
    dueDate: null,
    note: "API からの登録",
    lines: [
      { productCode: "ZA-P001", quantity: 3 },
      { productCode: "za-p003", quantity: 2 },
    ],
  });

  it("staff は draft で登録できる。画面と同じ規則（採番・単価は売価・金額の計算・操作履歴）で作られる", async () => {
    const today = todayInTokyo();
    // 画面と同じ service で 1 件作り、その次の番号で採番されることを確かめる
    const viaScreen = await createSalesOrder(prisma, STAFF, {
      customerId: String(data.customer.id),
      dueDate: "",
      note: "",
      lines: [
        {
          productId: String(data.product.id),
          quantity: "1",
          unitPrice: String(data.product.salesPrice),
        },
      ],
    });
    if (!viaScreen.ok) throw new Error(JSON.stringify(viaScreen));
    const screenSeq = Number(viaScreen.data.number.split("-")[2]);

    const response = await postOrder({
      token: tokens.staff.token,
      body: { ...validBody(), dueDate: today },
    });
    expect(response.status).toBe(201);
    const body = (await expectMatchesSpec("post", ORDERS, response)) as {
      number: string;
    } & Record<string, unknown>;
    const expectedNumber = `SO-${today.replaceAll("-", "")}-${String(screenSeq + 1).padStart(3, "0")}`;
    expect(body.number).toBe(expectedNumber);
    expect(response.headers.get("location")).toBe(
      `/api/v1/sales-orders/${expectedNumber}`,
    );

    const amounts = calcOrderAmounts([
      { quantity: 3, unitPrice: 1200 },
      { quantity: 2, unitPrice: 455 },
    ])!;
    expect(body).toMatchObject({
      orderDate: today,
      dueDate: today,
      status: "draft",
      customer: { code: "ZA-C001", name: "API テスト取引先 ZA-C001" },
      note: "API からの登録",
      ...amounts,
      lines: [
        {
          product: {
            code: "ZA-P001",
            name: "API テスト商品 ZA-P001",
            unit: "個",
          },
          quantity: 3,
          unitPrice: 1200,
          amount: 3600,
        },
        {
          product: {
            code: "ZA-P003",
            name: "API テスト商品 ZA-P003",
            unit: "個",
          },
          quantity: 2,
          unitPrice: 455,
          amount: 910,
        },
      ],
    });
    // 3600 + 910 = 4510、税 451、合計 4961
    expect(amounts).toEqual({ subtotal: 4510, tax: 451, total: 4961 });

    const saved = await prisma.salesOrder.findUniqueOrThrow({
      where: { number: expectedNumber },
      include: { lines: { orderBy: { id: "asc" } } },
    });
    expect(saved).toMatchObject({
      status: "draft",
      customerId: data.customer.id,
      ...amounts,
    });
    expect(
      saved.lines.map((l) => [l.productId, l.quantity, l.unitPrice]),
    ).toEqual([
      [data.product.id, 3, 1200],
      [data.lowProduct.id, 2, 455],
    ]);
    // 操作履歴: トークンの持ち主が作成し、REST API から作成したことが分かる
    const logs = await prisma.auditLog.findMany({
      where: {
        targetType: SALES_ORDER_TARGET_TYPE,
        targetId: String(saved.id),
      },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ userId: STAFF.id, action: "create" });
    expect(logs[0].summary).toBe(
      `受注 ${expectedNumber} を作成しました（顧客 ZA-C001「API テスト取引先 ZA-C001」・明細 2 行・合計 4,961 円・REST API（トークン #${tokens.staff.id}）から作成）`,
    );
    // 作成した受注は詳細の API でも同じ内容で読める
    const detail = await expectMatchesSpec(
      "get",
      ORDER,
      await getOrder(expectedNumber, { token: tokens.viewer.token }),
    );
    expect(detail).toEqual(body);
  });

  it("admin も登録できる。dueDate・note は省略できる", async () => {
    const response = await postOrder({
      token: tokens.admin.token,
      body: {
        customerCode: "ZA-C001",
        lines: [{ productCode: "ZA-P001", quantity: 1 }],
      },
    });
    expect(response.status).toBe(201);
    expect(await expectMatchesSpec("post", ORDERS, response)).toMatchObject({
      dueDate: null,
      note: null,
      subtotal: 1200,
      tax: 120,
      total: 1320,
    });
  });

  it("viewer は 403（作成されない）", async () => {
    const before = await salesOrderCount();
    const body = await expectProblem(
      "post",
      ORDERS,
      await postOrder({ token: tokens.viewer.token, body: validBody() }),
      403,
    );
    expect(body.detail).toBe("この操作を行う権限がありません");
    expect(await salesOrderCount()).toBe(before);
  });

  const yesterday = () => {
    const d = new Date(`${todayInTokyo()}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  };

  it.each<[string, () => unknown, string[]]>([
    [
      "余分な項目（トップレベル）",
      () => ({ ...validBody(), total: 1 }),
      ["#/total"],
    ],
    [
      "余分な項目（明細の単価は指定できない）",
      () => ({
        ...validBody(),
        lines: [{ productCode: "ZA-P001", quantity: 1, unitPrice: 1 }],
      }),
      ["#/lines/0/unitPrice"],
    ],
    [
      "数量が文字列（型違い）",
      () => ({
        ...validBody(),
        lines: [{ productCode: "ZA-P001", quantity: "3" }],
      }),
      ["#/lines/0/quantity"],
    ],
    [
      "数量が小数",
      () => ({
        ...validBody(),
        lines: [{ productCode: "ZA-P001", quantity: 1.5 }],
      }),
      ["#/lines/0/quantity"],
    ],
    [
      "数量が 0",
      () => ({
        ...validBody(),
        lines: [{ productCode: "ZA-P001", quantity: 0 }],
      }),
      ["#/lines/0/quantity"],
    ],
    [
      "数量が上限を超える",
      () => ({
        ...validBody(),
        lines: [{ productCode: "ZA-P001", quantity: 10_000_000 }],
      }),
      ["#/lines/0/quantity"],
    ],
    ["明細が空", () => ({ ...validBody(), lines: [] }), ["#/lines"]],
    ["必須の項目がない", () => ({ note: "x" }), ["#/customerCode", "#/lines"]],
    ["本文が配列", () => [validBody()], ["#"]],
    [
      "納期が存在しない日付",
      () => ({ ...validBody(), dueDate: "2026-02-30" }),
      ["#/dueDate"],
    ],
    [
      "納期が受注日より前（service の検証）",
      () => ({ ...validBody(), dueDate: yesterday() }),
      ["#/dueDate"],
    ],
    // NUL（レビューの再現例。PostgreSQL に渡すと 500 になる）
    [
      "顧客コードに NUL",
      () => ({ ...validBody(), customerCode: "C\u0000" }),
      ["#/customerCode"],
    ],
    [
      "商品コードに NUL",
      () => ({
        ...validBody(),
        lines: [{ productCode: "P\u0000", quantity: 1 }],
      }),
      ["#/lines/0/productCode"],
    ],
    [
      "存在しない顧客",
      () => ({ ...validBody(), customerCode: "ZA-C999" }),
      ["#/customerCode"],
    ],
    [
      "仕入先を顧客に指定（service の検証）",
      () => ({ ...validBody(), customerCode: "ZA-S001" }),
      ["#/customerCode"],
    ],
    [
      "無効な顧客（service の検証）",
      () => ({ ...validBody(), customerCode: "ZA-C002" }),
      ["#/customerCode"],
    ],
    [
      "存在しない商品",
      () => ({
        ...validBody(),
        lines: [
          { productCode: "ZA-P001", quantity: 1 },
          { productCode: "ZA-P999", quantity: 1 },
        ],
      }),
      ["#/lines/1/productCode"],
    ],
    [
      "無効な商品（service の検証）",
      () => ({
        ...validBody(),
        lines: [{ productCode: "ZA-P002", quantity: 1 }],
      }),
      ["#/lines/0/productCode"],
    ],
    [
      "同じ商品が 2 行（service の検証）",
      () => ({
        ...validBody(),
        lines: [
          { productCode: "ZA-P001", quantity: 1 },
          { productCode: "za-p001", quantity: 2 },
        ],
      }),
      ["#/lines/1/productCode"],
    ],
    [
      "備考にタブ（service の検証）",
      () => ({ ...validBody(), note: "a\tb" }),
      ["#/note"],
    ],
    [
      "合計が上限を超える（service の検証）",
      () => ({
        ...validBody(),
        lines: [{ productCode: "ZA-P001", quantity: 9_999_999 }],
      }),
      ["#/lines"],
    ],
  ])(
    "%s は 400 で、項目ごとのエラーを返す（作成しない）",
    async (_label, makeBody, pointers) => {
      const before = await salesOrderCount();
      const body = await expectProblem(
        "post",
        ORDERS,
        await postOrder({ token: tokens.staff.token, body: makeBody() }),
        400,
      );
      expect(body.detail).toBe(
        "入力内容に誤りがあります。errors の各項目を確認してください",
      );
      expect(fieldsOf(body)).toEqual(pointers);
      for (const error of body.errors ?? []) {
        // エラー文は日本語
        expect(error.detail).toMatch(/[ぁ-んァ-ヶ一-龠]/);
      }
      expect(await salesOrderCount()).toBe(before);
    },
  );

  it.each([
    [
      "JSON として正しくない",
      '{"customerCode": ',
      "本文が JSON として正しくありません",
    ],
    ["空の本文", "", "本文が空です"],
  ])("%s本文は 400", async (_label, rawBody, detail) => {
    const body = await expectProblem(
      "post",
      ORDERS,
      await postOrder({
        token: tokens.staff.token,
        headers: { "content-type": "application/json" },
        rawBody,
      }),
      400,
    );
    expect(body.detail).toBe(detail);
    expect(body.errors).toBeUndefined();
  });

  it.each([
    ["text/plain", { "content-type": "text/plain" }],
    [
      "application/x-www-form-urlencoded",
      {
        "content-type": "application/x-www-form-urlencoded",
      },
    ],
    [
      "charset が UTF-8 でない",
      { "content-type": "application/json; charset=shift_jis" },
    ],
  ])(
    "Content-Type が %s なら 415（Accept-Post: application/json）",
    async (_label, headers) => {
      const response = await postOrder({
        token: tokens.staff.token,
        headers,
        rawBody: JSON.stringify(validBody()),
      });
      expect(response.headers.get("accept-post")).toBe("application/json");
      await expectProblem("post", ORDERS, response, 415);
    },
  );

  it("本文が上限（64KB）を超えると 413", async () => {
    const before = await salesOrderCount();
    const response = await postOrder({
      token: tokens.staff.token,
      body: { ...validBody(), note: "あ".repeat(30_000) },
    });
    const body = await expectProblem("post", ORDERS, response, 413);
    expect(body.title).toBe("Content Too Large");
    expect(await salesOrderCount()).toBe(before);
  });
});

describe("未定義のパス", () => {
  it("/api/v1 の下の未定義のパスは RFC 9457 の 404", async () => {
    const response = await notFoundRoute.GET();
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe(
      "application/problem+json",
    );
    expect(await response.json()).toMatchObject({
      status: 404,
      type: "about:blank",
    });
  });
});

describe("OpenAPI の定義との対応", () => {
  it("定義した応答（パス × メソッド × ステータス）を、すべてこのファイルで実際に返して検証した", () => {
    // GET の 403 は、いまのロールはすべて参照（view）できるため起こらない（権限の検査はしている）。openapi.json は単体テストで確認
    const unreachable = new Set([
      `get ${PRODUCTS} 403`,
      `get ${STOCK} 403`,
      `get ${ORDERS} 403`,
      `get ${ORDER} 403`,
      "get /api/v1/openapi.json 200",
    ]);
    const missing = documentedResponses().filter(
      (key) => !unreachable.has(key) && !checkedResponses.has(key),
    );
    expect(missing).toEqual([]);
  });
});
