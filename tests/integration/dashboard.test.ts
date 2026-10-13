/**
 * ダッシュボードの集計の結合テスト（実 DB = DATABASE_URL_TEST）。docs/spec.md §5-2
 * 前提: pnpm db:test:reset でテスト用 DB にマイグレーションとシードを適用済み
 *
 * 基準日時を 2000-03-01 00:30（JST。UTC ではまだ 2/29）に固定する。シードの伝票は実行時の日付の前後
 * 90 日にあるので、1999〜2000 年の受注額・納期切れ・予定日超過はこのファイルのデータだけになり、値を厳密に比べられる。
 * 件数（未出荷・発注点割れ・入荷待ち）はシードも含むので、データを作る前後の差で確かめる。
 *
 * このファイル専用の伝票（番号が ZD- で始まる）と商品（コードが ZD- で始まる）を作り、終了時に削除する
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";
import { getDashboardData, type DashboardData } from "@/lib/dashboard/queries";
import { listStock } from "@/lib/stock/queries";
import { parseStockListParams } from "@/lib/stock/search-params";

import { connectTestDb, SETUP_HINT } from "./test-db";

let prisma: PrismaClient;

const PREFIX = "ZD-";
/** 基準日時（JST 2000-03-01 00:30 = UTC 2000-02-29 15:30） */
const NOW = new Date("2000-03-01T00:30:00+09:00");
/** 一覧の件数（シードの伝票も含めて全件を見るときに使う） */
const ALL = 10_000;

let sequence = 0;
let customerId: number;
let supplierId: number;

function nextCode() {
  sequence++;
  return `${PREFIX}${String(sequence).padStart(4, "0")}`;
}

/** DATE 列の値（UTC 0 時） */
function day(ymd: string): Date {
  return new Date(`${ymd}T00:00:00.000Z`);
}

async function cleanUp() {
  const ids = (
    await prisma.product.findMany({
      where: { code: { startsWith: PREFIX } },
      select: { id: true },
    })
  ).map((p) => p.id);
  await prisma.salesOrder.deleteMany({
    where: { number: { startsWith: PREFIX } },
  });
  await prisma.purchaseOrder.deleteMany({
    where: { number: { startsWith: PREFIX } },
  });
  await prisma.stockMovement.deleteMany({ where: { productId: { in: ids } } });
  await prisma.product.deleteMany({ where: { id: { in: ids } } });
}

async function createSalesOrder(
  status: "draft" | "confirmed" | "shipped" | "cancelled",
  orderDate: string,
  subtotal: number,
  dueDate: string | null = null,
) {
  // 税 10%（受注額は税込の total で集計するので、subtotal と total が違う値になるようにする）
  const tax = Math.floor(subtotal / 10);
  return prisma.salesOrder.create({
    data: {
      number: nextCode(),
      customerId,
      status,
      orderDate: day(orderDate),
      dueDate: dueDate ? day(dueDate) : null,
      subtotal,
      tax,
      total: subtotal + tax,
    },
  });
}

async function createPurchaseOrder(
  status: "draft" | "ordered" | "received" | "cancelled",
  expectedDate: string | null,
) {
  return prisma.purchaseOrder.create({
    data: {
      number: nextCode(),
      supplierId,
      status,
      orderDate: day("2000-02-01"),
      expectedDate: expectedDate ? day(expectedDate) : null,
      subtotal: 1000,
      tax: 100,
      total: 1100,
    },
  });
}

async function createProduct({
  stock,
  reorderPoint,
  isActive = true,
}: {
  stock: number;
  reorderPoint: number;
  isActive?: boolean;
}) {
  const code = nextCode();
  const product = await prisma.product.create({
    data: {
      code,
      name: `ダッシュボードテスト商品 ${code}`,
      category: "ダッシュボードテスト",
      unit: "個",
      salesPrice: 100,
      purchasePrice: 60,
      reorderPoint,
      isActive,
    },
  });
  if (stock !== 0) {
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
  if ((await prisma.product.count()) === 0) {
    throw new Error(`テスト用 DB にシードが入っていません。${SETUP_HINT}`);
  }
  await cleanUp();
  customerId = (
    await prisma.partner.findFirstOrThrow({
      where: { kind: { in: ["customer", "both"] } },
      orderBy: { id: "asc" },
    })
  ).id;
  supplierId = (
    await prisma.partner.findFirstOrThrow({
      where: { kind: { in: ["supplier", "both"] } },
      orderBy: { id: "asc" },
    })
  ).id;
});

afterAll(async () => {
  if (!prisma) return;
  try {
    await cleanUp();
  } finally {
    await prisma.$disconnect();
  }
});

describe("今月の受注額・前月比・月別", () => {
  // 金額は税抜（subtotal）。集計は税込（total = subtotal + 10%）
  beforeAll(async () => {
    // 今月（2000-03）: 月初と月末
    await createSalesOrder("shipped", "2000-03-01", 2000);
    await createSalesOrder("confirmed", "2000-03-31", 400);
    // 今月の下書き・取消は含めない
    await createSalesOrder("draft", "2000-03-15", 50_000);
    await createSalesOrder("cancelled", "2000-03-15", 70_000);
    // 前月（2000-02）の月末（うるう日）
    await createSalesOrder("confirmed", "2000-02-29", 1000);
    await createSalesOrder("cancelled", "2000-02-10", 90_000);
    // 翌月の 1 日は含めない
    await createSalesOrder("confirmed", "2000-04-01", 8000);
    // 6 か月の最初の月（1999-10）の月初と、その前日（範囲外）
    await createSalesOrder("shipped", "1999-10-01", 300);
    await createSalesOrder("confirmed", "1999-09-30", 900);
  });

  it("JST の暦月・受注日基準で confirmed と shipped の税込 total を合計する", async () => {
    const data = await getDashboardData(prisma, { now: NOW });
    expect(data.today).toBe("2000-03-01");
    // 2200 + 440（税抜の合計 2400 ではない）
    expect(data.sales.current).toMatchObject({
      key: "2000-03",
      total: 2640,
    });
    expect(data.sales.previous).toMatchObject({
      key: "2000-02",
      total: 1100,
    });
    expect(data.sales.change.diff).toBe(1540);
    expect(data.sales.change.rate).toBeCloseTo(140);
    expect(data.sales.trend.map((m) => [m.key, m.total])).toEqual([
      ["1999-10", 330],
      ["1999-11", 0],
      ["1999-12", 0],
      ["2000-01", 0],
      ["2000-02", 1100],
      ["2000-03", 2640],
    ]);
  });

  it("前月が 0 円なら増減率は null", async () => {
    // 1999-12 を今月とすると、今月・前月（1999-11）とも受注なし
    const data = await getDashboardData(prisma, {
      now: new Date("1999-12-15T12:00:00+09:00"),
    });
    expect(data.sales.current.total).toBe(0);
    expect(data.sales.previous.total).toBe(0);
    expect(data.sales.change).toEqual({ diff: 0, rate: null });
  });

  it("今月が 0 円・前月に受注があれば -100%", async () => {
    // 1999-11 を今月とすると、前月（1999-10）は 330
    const data = await getDashboardData(prisma, {
      now: new Date("1999-11-01T00:00:00+09:00"),
    });
    expect(data.sales.current).toMatchObject({ key: "1999-11", total: 0 });
    expect(data.sales.change).toEqual({ diff: -330, rate: -100 });
  });
});

describe("未出荷の受注・入荷待ちの発注・発注点割れ", () => {
  let before: DashboardData;
  let after: DashboardData;
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    before = await getDashboardData(prisma, { now: NOW, limit: ALL });

    // 受注（未出荷 = confirmed）。今日は JST 2000-03-01
    ids.soOverdueOld = (
      await createSalesOrder("confirmed", "2000-02-01", 100, "2000-02-20")
    ).id;
    ids.soOverdue = (
      await createSalesOrder("confirmed", "2000-02-01", 100, "2000-02-29")
    ).id;
    ids.soDueToday = (
      await createSalesOrder("confirmed", "2000-02-01", 100, "2000-03-01")
    ).id;
    ids.soNoDue = (await createSalesOrder("confirmed", "2000-02-01", 100)).id;
    await createSalesOrder("draft", "2000-02-01", 100, "2000-02-01");
    await createSalesOrder("shipped", "2000-02-01", 100, "2000-02-01");
    await createSalesOrder("cancelled", "2000-02-01", 100, "2000-02-01");

    // 発注（入荷待ち = ordered）
    ids.poOverdue = (await createPurchaseOrder("ordered", "2000-02-29")).id;
    ids.poToday = (await createPurchaseOrder("ordered", "2000-03-01")).id;
    ids.poNoDate = (await createPurchaseOrder("ordered", null)).id;
    await createPurchaseOrder("draft", "2000-02-01");
    await createPurchaseOrder("received", "2000-02-01");
    await createPurchaseOrder("cancelled", "2000-02-01");

    // 商品（発注点割れ = 有効で 現在庫 < 発注点）
    ids.lowLarge = (
      await createProduct({ stock: 1, reorderPoint: 1_000_000 })
    ).id;
    ids.lowSmall = (await createProduct({ stock: 2, reorderPoint: 10 })).id;
    ids.lowNoMovement = (await createProduct({ stock: 0, reorderPoint: 3 })).id;
    ids.equal = (await createProduct({ stock: 10, reorderPoint: 10 })).id;
    ids.zeroPoint = (await createProduct({ stock: 0, reorderPoint: 0 })).id;
    ids.inactive = (
      await createProduct({
        stock: 0,
        reorderPoint: 2_000_000,
        isActive: false,
      })
    ).id;

    after = await getDashboardData(prisma, { now: NOW, limit: ALL });
  });

  it("未出荷は confirmed の件数。納期切れは JST の今日より前の納期（今日・納期なしは含めない）", () => {
    expect(after.unshipped.count - before.unshipped.count).toBe(4);
    // シードの納期は 2000 年より後なので、納期切れはこのテストのデータだけ
    expect(before.unshipped.overdueCount).toBe(0);
    expect(after.unshipped.overdueCount).toBe(2);
    expect(after.unshipped.overdue.map((o) => o.id)).toEqual([
      ids.soOverdueOld,
      ids.soOverdue,
    ]);
    expect(after.unshipped.overdue[1]).toMatchObject({
      date: "2000-02-29",
      overdue: true,
    });
  });

  it("入荷待ちは ordered の件数。入荷予定日の近い順で、予定日を過ぎたものに印を付ける", () => {
    expect(after.awaitingReceipt.count - before.awaitingReceipt.count).toBe(3);
    expect(before.awaitingReceipt.overdueCount).toBe(0);
    expect(after.awaitingReceipt.overdueCount).toBe(1);

    const items = after.awaitingReceipt.items;
    expect(items.length).toBe(after.awaitingReceipt.count);
    expect(items[0]).toMatchObject({
      id: ids.poOverdue,
      date: "2000-02-29",
      overdue: true,
    });
    expect(items[1]).toMatchObject({
      id: ids.poToday,
      date: "2000-03-01",
      overdue: false,
    });
    // 予定日なしは最後
    expect(items[items.length - 1]).toMatchObject({
      id: ids.poNoDate,
      date: null,
      overdue: false,
    });
    const dates = items.map((o) => o.date).filter((d) => d !== null);
    expect(dates).toEqual([...dates].sort());
  });

  it("既定の件数（5 件）では予定日の近いものから出す", async () => {
    const data = await getDashboardData(prisma, { now: NOW });
    expect(data.awaitingReceipt.items).toHaveLength(
      Math.min(5, data.awaitingReceipt.count),
    );
    expect(data.awaitingReceipt.items[0].id).toBe(ids.poOverdue);
    expect(data.awaitingReceipt.count).toBe(after.awaitingReceipt.count);
  });

  it("発注点割れは有効な商品だけ。不足の大きい順で、件数は在庫一覧の「発注点割れのみ」と一致する", async () => {
    expect(after.lowStock.count - before.lowStock.count).toBe(3);
    const stockPage = await listStock(
      prisma,
      parseStockListParams({ level: "low" }),
    );
    expect(after.lowStock.count).toBe(stockPage.total);

    const found = after.lowStock.items.map((p) => p.id);
    expect(found).toEqual(
      expect.arrayContaining([ids.lowLarge, ids.lowSmall, ids.lowNoMovement]),
    );
    expect(found).not.toContain(ids.inactive);
    expect(found).not.toContain(ids.equal);
    expect(found).not.toContain(ids.zeroPoint);

    // 不足が最も大きいので先頭
    expect(after.lowStock.items[0]).toMatchObject({
      id: ids.lowLarge,
      stock: 1,
      reorderPoint: 1_000_000,
      shortage: 999_999,
    });
    expect(
      after.lowStock.items.find((p) => p.id === ids.lowNoMovement),
    ).toMatchObject({ stock: 0, shortage: 3 });
    const shortages = after.lowStock.items.map((p) => p.shortage);
    expect(shortages).toEqual([...shortages].sort((a, b) => b - a));
  });

  it("受注額の集計には未出荷の確認用データ（2000-02 の受注日）も confirmed / shipped だけが入る", () => {
    // confirmed 4 件 × 110 ＋ shipped 1 件 × 110（税込）が前月に加わる（draft・cancelled は入らない）
    expect(after.sales.previous.total - before.sales.previous.total).toBe(550);
  });
});
