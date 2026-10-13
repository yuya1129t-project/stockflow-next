/**
 * 発注点割れの通知の結合テスト（実 DB = DATABASE_URL_TEST）。docs/spec.md §6-3
 * 前提: pnpm db:test:reset でテスト用 DB にマイグレーションとシードを適用済み
 *
 * Server Action（棚卸調整・受注のステータス変更）を、ログイン（checkActionPermission）・getPrisma・revalidatePath・
 * after() だけモックにして呼ぶ。after() に渡された処理は、応答の後の代わりにテストから実行する。
 * fetch はモックにするので外部へは送らない（CI から送らない）。
 *
 * シードのデータは書き換えない。このファイル専用の取引先・商品（コードが ZN- で始まる）を作って使い、
 * 開始時と終了時に 受注 → 入出庫 → 操作履歴 → 商品・取引先 の順で削除し、採番テーブル（SO）を残っている受注に合わせる
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";
import type { SessionUser } from "@/lib/auth/session";
import {
  NOTIFY_FAILED_ACTION,
  REORDER_WEBHOOK_URL_ENV,
  type SlackMessage,
} from "@/lib/notifications/reorder-point";
import { PARTNER_TARGET_TYPE } from "@/lib/partners/service";
import { PRODUCT_TARGET_TYPE } from "@/lib/products/service";
import {
  createSalesOrder,
  SALES_ORDER_TARGET_TYPE,
} from "@/lib/sales-orders/service";
import { getStock } from "@/lib/stock/movements";

import { DEMO_USERS } from "../../prisma/seed-data";
import { connectTestDb, SETUP_HINT } from "./test-db";

const mocks = vi.hoisted(() => ({
  prisma: null as PrismaClient | null,
  user: null as SessionUser | null,
  afterCallbacks: [] as (() => unknown)[],
}));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: vi.fn((callback: () => unknown) => {
    mocks.afterCallbacks.push(callback);
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  getPrisma: () => mocks.prisma!,
}));
vi.mock("@/lib/auth/guards", () => ({
  checkActionPermission: vi.fn(async () => ({ ok: true, user: mocks.user! })),
}));

// モックの後で読み込む（Server Action は上のモックを使う）
const { adjustStockAction } = await import("@/app/(app)/stock/actions");
const { changeSalesOrderStatusAction } =
  await import("@/app/(app)/sales-orders/actions");
const { after } = await import("next/server");

let prisma: PrismaClient;

const [, STAFF] = DEMO_USERS.map(({ id, name, email, role }): SessionUser => ({
  id,
  name,
  email,
  role,
}));

const WEBHOOK = "https://hooks.example.test/services/T000/B000/zn-secret";
const APP_URL = "https://stockflow.example.test";

const PREFIX = "ZN-";
let sequence = 0;
const nextCode = () => `${PREFIX}${String(++sequence).padStart(4, "0")}`;

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
          targetType: PRODUCT_TARGET_TYPE,
          targetId: { in: productIds.map(String) },
        },
        {
          targetType: PARTNER_TARGET_TYPE,
          targetId: { in: partnerIds.map(String) },
        },
      ],
    },
  });
  await prisma.product.deleteMany({ where: { id: { in: productIds } } });
  await prisma.partner.deleteMany({ where: { id: { in: partnerIds } } });
}

/** 採番テーブル（SO）を、残っている受注の番号に合わせる（sales-orders.test.ts と同じ。シードの結合テストが一致を確かめるため） */
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

beforeAll(async () => {
  prisma = await connectTestDb();
  mocks.prisma = prisma;
  mocks.user = STAFF;
  if ((await prisma.product.count()) === 0) {
    throw new Error(`テスト用 DB にシードが入っていません。${SETUP_HINT}`);
  }
  await cleanUp();
  await syncSoSequences();
});

afterAll(async () => {
  if (!prisma) return;
  try {
    await cleanUp();
    await syncSoSequences();
  } finally {
    await prisma.$disconnect();
  }
});

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mocks.afterCallbacks.length = 0;
  vi.mocked(after).mockClear();
  fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv(REORDER_WEBHOOK_URL_ENV, WEBHOOK);
  vi.stubEnv("BETTER_AUTH_URL", APP_URL);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** 応答の後に実行される処理（after() に渡されたもの）を実行する */
async function runAfterResponse() {
  const callbacks = mocks.afterCallbacks.splice(0);
  for (const callback of callbacks) await callback();
}

/** fetch に送られた Slack の本文 */
function sentMessages(): { url: string; body: SlackMessage }[] {
  return fetchMock.mock.calls.map(([url, init]) => ({
    url: String(url),
    body: JSON.parse((init as RequestInit).body as string) as SlackMessage,
  }));
}

/** 商品 1 件分の blocks（Slack の自動解析を止める verbatim 付き） */
function productBlock(text: string) {
  return { type: "section", text: { type: "mrkdwn", text, verbatim: true } };
}

async function createProduct({
  stock = 0,
  reorderPoint = 5,
  isActive = true,
}: { stock?: number; reorderPoint?: number; isActive?: boolean } = {}) {
  const code = nextCode();
  const product = await prisma.product.create({
    data: {
      code,
      name: `通知テスト商品 ${code}`,
      category: "通知テスト",
      unit: "個",
      salesPrice: 100,
      purchasePrice: 60,
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

async function createCustomer() {
  const code = nextCode();
  return prisma.partner.create({
    data: { code, name: `通知テスト取引先 ${code}`, kind: "customer" },
  });
}

/** 確定（confirmed）の受注を作る */
async function createConfirmedOrder(lines: [number, number][]) {
  const customer = await createCustomer();
  const created = await createSalesOrder(prisma, STAFF, {
    customerId: String(customer.id),
    dueDate: "",
    note: "",
    lines: lines.map(([productId, quantity]) => ({
      productId: String(productId),
      quantity: String(quantity),
      unitPrice: "100",
    })),
  });
  if (!created.ok) throw new Error(`作成に失敗: ${JSON.stringify(created)}`);
  await prisma.salesOrder.update({
    where: { id: created.data.id },
    data: { status: "confirmed" },
  });
  return created.data;
}

async function ship(id: number) {
  const order = await prisma.salesOrder.findUniqueOrThrow({
    where: { id },
    select: { updatedAt: true },
  });
  return changeSalesOrderStatusAction(
    id,
    "shipped",
    order.updatedAt.toISOString(),
  );
}

function notifyFailures(targetType: string, targetId: number) {
  return prisma.auditLog.findMany({
    where: {
      action: NOTIFY_FAILED_ACTION,
      targetType,
      targetId: String(targetId),
    },
  });
}

describe("受注の出荷", () => {
  it("発注点を跨いだ商品を 1 通にまとめて、トランザクション確定後に送る", async () => {
    const a = await createProduct({ stock: 10, reorderPoint: 5 });
    const b = await createProduct({ stock: 8, reorderPoint: 8 });
    const c = await createProduct({ stock: 30, reorderPoint: 5 });
    const order = await createConfirmedOrder([
      [a.id, 7],
      [b.id, 1],
      [c.id, 10],
    ]);
    // 送信の時点で、出荷が確定して別の接続から見えていること
    let stocksWhenSent: number[] = [];
    fetchMock.mockImplementation(async () => {
      stocksWhenSent = await Promise.all(
        [a, b, c].map((p) => getStock(prisma, p.id)),
      );
      return new Response("ok", { status: 200 });
    });

    expect(await ship(order.id)).toEqual({ ok: true });
    // 応答を返すまでは送らない（after() に 1 回だけ登録される）
    expect(after).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();

    await runAfterResponse();

    expect(stocksWhenSent).toEqual([3, 7, 20]);
    const sent = sentMessages();
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(WEBHOOK);
    // a（10 → 3）と b（8 → 7）が発注点を下回った。c（30 → 20）は発注点以上のまま
    expect(sent[0].body.text).toBe(
      `発注点を下回った商品が 2 件あります（受注 ${order.number} の出荷）`,
    );
    expect(sent[0].body.blocks.slice(1)).toEqual([
      productBlock(
        `<${APP_URL}/stock/${a.id}|${a.code} ${a.name}>\n現在庫 3個（発注点 5個・変更前 10個）`,
      ),
      productBlock(
        `<${APP_URL}/stock/${b.id}|${b.code} ${b.name}>\n現在庫 7個（発注点 8個・変更前 8個）`,
      ),
    ]);
    expect(sent[0].body.blocks).toHaveLength(3);
    expect(await notifyFailures(SALES_ORDER_TARGET_TYPE, order.id)).toEqual([]);
  });

  it("発注点を跨がないとき（もとから発注点割れ・発注点以上のまま）は送らない", async () => {
    const already = await createProduct({ stock: 4, reorderPoint: 5 });
    const stays = await createProduct({ stock: 20, reorderPoint: 5 });
    const order = await createConfirmedOrder([
      [already.id, 1],
      [stays.id, 15],
    ]);
    expect(await ship(order.id)).toEqual({ ok: true });
    await runAfterResponse();
    expect(after).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("無効な商品は発注点を跨いでも送らない（受注の後に無効にした商品の出荷）", async () => {
    const inactive = await createProduct({ stock: 10, reorderPoint: 5 });
    const order = await createConfirmedOrder([[inactive.id, 8]]);
    await prisma.product.update({
      where: { id: inactive.id },
      data: { isActive: false },
    });
    expect(await ship(order.id)).toEqual({ ok: true });
    expect(await getStock(prisma, inactive.id)).toBe(2);
    await runAfterResponse();
    expect(after).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("送信に失敗しても出荷は取り消されず、操作履歴に失敗が残る（URL・応答本文は残さない）", async () => {
    const product = await createProduct({ stock: 10, reorderPoint: 5 });
    const order = await createConfirmedOrder([[product.id, 6]]);
    fetchMock.mockImplementation(
      async () => new Response("no_service zn-secret", { status: 404 }),
    );

    expect(await ship(order.id)).toEqual({ ok: true });
    await runAfterResponse();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const saved = await prisma.salesOrder.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(saved.status).toBe("shipped");
    expect(await getStock(prisma, product.id)).toBe(4);
    const failures = await notifyFailures(SALES_ORDER_TARGET_TYPE, order.id);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      userId: STAFF.id,
      action: NOTIFY_FAILED_ACTION,
      summary: `発注点割れの通知を送信できませんでした（受注 ${order.number} の出荷・商品 ${product.code}）。原因: HTTP エラー（404）`,
    });
    expect(failures[0].summary).not.toContain("zn-secret");
    expect(failures[0].summary).not.toContain("hooks.example.test");
  });
});

describe("棚卸調整", () => {
  it("発注点を跨いだら送る（きっかけは棚卸調整）", async () => {
    const product = await createProduct({ stock: 10, reorderPoint: 5 });
    const result = await adjustStockAction(product.id, {
      actualQuantity: "2",
      reason: "破損",
    });
    expect(result).toMatchObject({ ok: true, recorded: true });
    expect(after).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();

    await runAfterResponse();

    const sent = sentMessages();
    expect(sent).toHaveLength(1);
    expect(sent[0].body.text).toBe(
      "発注点を下回った商品が 1 件あります（棚卸調整）",
    );
    expect(sent[0].body.blocks.slice(1)).toEqual([
      productBlock(
        `<${APP_URL}/stock/${product.id}|${product.code} ${product.name}>\n現在庫 2個（発注点 5個・変更前 10個）`,
      ),
    ]);
  });

  it("跨がないとき（発注点以上のまま・発注点割れのまま・差分 0）は送らない", async () => {
    const product = await createProduct({ stock: 10, reorderPoint: 5 });
    for (const actualQuantity of ["6", "10", "4", "3", "3"]) {
      const result = await adjustStockAction(product.id, {
        actualQuantity,
        reason: "棚卸",
      });
      expect(result.ok).toBe(true);
      await runAfterResponse();
    }
    // 10 → 6 → 10 は発注点以上、→ 4 で 1 回だけ跨ぐ。4 → 3 は割れのまま、3 → 3 は記録しない
    expect(after).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("無効な商品は送らない", async () => {
    const product = await createProduct({
      stock: 10,
      reorderPoint: 5,
      isActive: false,
    });
    const result = await adjustStockAction(product.id, {
      actualQuantity: "1",
      reason: "棚卸",
    });
    expect(result).toMatchObject({ ok: true, recorded: true });
    await runAfterResponse();
    expect(after).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("タイムアウト・通信エラーでも棚卸調整は取り消されず、操作履歴に失敗が残る", async () => {
    const product = await createProduct({ stock: 10, reorderPoint: 5 });
    fetchMock.mockImplementation(async () => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }),
      });
    });
    const result = await adjustStockAction(product.id, {
      actualQuantity: "0",
      reason: "紛失",
    });
    expect(result).toMatchObject({ ok: true, recorded: true });
    await runAfterResponse();

    expect(await getStock(prisma, product.id)).toBe(0);
    const failures = await notifyFailures(PRODUCT_TARGET_TYPE, product.id);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      userId: STAFF.id,
      summary: `発注点割れの通知を送信できませんでした（棚卸調整・商品 ${product.code}）。原因: 通信エラー（接続できない・リダイレクトなど）`,
    });
    // 棚卸調整の操作履歴も残っている
    const adjustLogs = await prisma.auditLog.count({
      where: {
        action: "stock_adjust",
        targetType: PRODUCT_TARGET_TYPE,
        targetId: String(product.id),
      },
    });
    expect(adjustLogs).toBe(1);
  });

  it("Webhook URL が未設定なら送らない（操作履歴にも残さない）", async () => {
    vi.stubEnv(REORDER_WEBHOOK_URL_ENV, "");
    const product = await createProduct({ stock: 10, reorderPoint: 5 });
    const result = await adjustStockAction(product.id, {
      actualQuantity: "1",
      reason: "棚卸",
    });
    expect(result).toMatchObject({ ok: true, recorded: true });
    await runAfterResponse();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await notifyFailures(PRODUCT_TARGET_TYPE, product.id)).toEqual([]);
  });

  it("https でない Webhook URL には送らず、操作履歴に設定の誤りを残す", async () => {
    vi.stubEnv(REORDER_WEBHOOK_URL_ENV, "http://hooks.example.test/plain");
    const product = await createProduct({ stock: 10, reorderPoint: 5 });
    await adjustStockAction(product.id, {
      actualQuantity: "1",
      reason: "棚卸",
    });
    await runAfterResponse();
    expect(fetchMock).not.toHaveBeenCalled();
    const failures = await notifyFailures(PRODUCT_TARGET_TYPE, product.id);
    expect(failures.map((f) => f.summary)).toEqual([
      `発注点割れの通知を送信できませんでした（棚卸調整・商品 ${product.code}）。原因: Webhook URL の設定が不正（https の URL ではない）`,
    ]);
  });
});
