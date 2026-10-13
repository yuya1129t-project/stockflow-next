/**
 * 在庫の結合テスト（実 DB = DATABASE_URL_TEST）。docs/spec.md §2・§3・§4・§6-3
 * 前提: pnpm db:test:reset でテスト用 DB にマイグレーションとシードを適用済み
 *
 * シードの商品と入出庫は書き換えない。このファイル専用の商品（コードが ZS- で始まる）を作って使い、
 * 終了時に 入出庫 → 操作履歴 → 商品 の順で削除する（入出庫は商品を Restrict で参照しているため）
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";
import type { SessionUser } from "@/lib/auth/session";
import { PRODUCT_TARGET_TYPE } from "@/lib/products/service";
import {
  getStock,
  getStocks,
  recordStockMovements,
} from "@/lib/stock/movements";
import {
  listStock,
  listStockMovements,
  STOCK_MOVEMENTS_PER_PAGE,
} from "@/lib/stock/queries";
import { InsufficientStockError } from "@/lib/stock/rules";
import { parseStockListParams } from "@/lib/stock/search-params";
import { adjustStock, STOCK_ADJUST_ACTION } from "@/lib/stock/service";

import { DEMO_USERS } from "../../prisma/seed-data";
import { connectTestDb, SETUP_HINT } from "./test-db";

let prisma: PrismaClient;

const [ADMIN, STAFF, VIEWER] = DEMO_USERS.map(
  ({ id, name, email, role }): SessionUser => ({ id, name, email, role }),
);

/** このファイルで作る商品のコードの接頭辞 */
const PREFIX = "ZS-";
let sequence = 0;

async function cleanUp() {
  const ids = (
    await prisma.product.findMany({
      where: { code: { startsWith: PREFIX } },
      select: { id: true },
    })
  ).map((p) => p.id);
  await prisma.stockMovement.deleteMany({ where: { productId: { in: ids } } });
  await prisma.auditLog.deleteMany({
    where: {
      targetType: PRODUCT_TARGET_TYPE,
      targetId: { in: ids.map(String) },
    },
  });
  await prisma.product.deleteMany({ where: { id: { in: ids } } });
}

beforeAll(async () => {
  prisma = await connectTestDb();
  if ((await prisma.product.count()) === 0) {
    throw new Error(`テスト用 DB にシードが入っていません。${SETUP_HINT}`);
  }
  await cleanUp();
});

afterAll(async () => {
  if (!prisma) return;
  try {
    await cleanUp();
  } finally {
    await prisma.$disconnect();
  }
});

/** テスト用の商品を作り、初期在庫を棚卸調整で入れる（0 なら入出庫なし） */
async function createProduct({
  stock = 0,
  reorderPoint = 5,
  isActive = true,
}: { stock?: number; reorderPoint?: number; isActive?: boolean } = {}) {
  sequence++;
  const code = `${PREFIX}${String(sequence).padStart(4, "0")}`;
  const product = await prisma.product.create({
    data: {
      code,
      name: `在庫テスト商品 ${code}`,
      category: "在庫テスト",
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
        userId: ADMIN.id,
      },
    });
  }
  return product;
}

function movementsOf(productId: number) {
  return prisma.stockMovement.findMany({
    where: { productId },
    orderBy: { id: "asc" },
  });
}

function auditLogsOf(productId: number) {
  return prisma.auditLog.findMany({
    where: { targetType: PRODUCT_TARGET_TYPE, targetId: String(productId) },
    orderBy: { id: "asc" },
  });
}

function out(productId: number, quantity: number) {
  return { productId, type: "out" as const, quantity: -quantity };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** 失敗も値として受け取る（未処理の reject にしない） */
function settle<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

describe("現在庫の取得", () => {
  it("入出庫の合計（シードの全商品で groupBy と一致）", async () => {
    const sums = await prisma.stockMovement.groupBy({
      by: ["productId"],
      _sum: { quantity: true },
    });
    const products = await prisma.product.findMany({ select: { id: true } });
    const stocks = await getStocks(
      prisma,
      products.map((p) => p.id),
    );
    for (const s of sums) {
      expect(stocks.get(s.productId)).toBe(s._sum.quantity);
    }
    expect(await getStock(prisma, sums[0].productId)).toBe(
      sums[0]._sum.quantity,
    );
  });

  it("入出庫のない商品・存在しない商品は 0", async () => {
    const product = await createProduct();
    expect(await getStock(prisma, product.id)).toBe(0);
    expect(await getStock(prisma, 999_999_999)).toBe(0);
    expect((await getStocks(prisma, [])).size).toBe(0);
  });
});

describe("現在庫一覧（/stock）", () => {
  it("発注点割れのみ: 有効で 現在庫 < 発注点 の商品だけ（件数も一致）", async () => {
    const low = await createProduct({ stock: 2, reorderPoint: 5 });
    const exact = await createProduct({ stock: 5, reorderPoint: 5 });
    const inactiveLow = await createProduct({
      stock: 0,
      reorderPoint: 5,
      isActive: false,
    });

    const result = await listStock(
      prisma,
      parseStockListParams({ q: PREFIX, level: "low", status: "all" }),
    );
    const ids = result.items.map((p) => p.id);
    expect(ids).toContain(low.id);
    expect(ids).not.toContain(exact.id);
    expect(ids).not.toContain(inactiveLow.id);
    expect(
      result.items.every((p) => p.isActive && p.stock < p.reorderPoint),
    ).toBe(true);
    expect(result.total).toBe(result.items.length);

    // シード全体でも、発注点割れのみの件数は全件から数えた数と一致する
    const all = await listStock(
      prisma,
      parseStockListParams({ status: "all" }),
    );
    const lowAll = await listStock(
      prisma,
      parseStockListParams({ level: "low" }),
    );
    const stocks = await getStocks(
      prisma,
      (await prisma.product.findMany({ select: { id: true } })).map(
        (p) => p.id,
      ),
    );
    const products = await prisma.product.findMany();
    expect(lowAll.total).toBe(
      products.filter(
        (p) => p.isActive && (stocks.get(p.id) ?? 0) < p.reorderPoint,
      ).length,
    );
    expect(lowAll.total).toBeGreaterThan(0);
    expect(all.total).toBe(products.length);
  });
});

describe("入出庫の記録（共通モジュール）", () => {
  it("複数商品をまとめて記録し、前後の在庫を返す", async () => {
    const a = await createProduct({ stock: 10 });
    const b = await createProduct({ stock: 3 });
    const result = await prisma.$transaction((tx) =>
      recordStockMovements(tx, STAFF.id, [
        out(a.id, 4),
        { productId: b.id, type: "in", quantity: 7, reason: "入荷" },
        out(a.id, 1),
      ]),
    );
    expect(result.movements).toHaveLength(3);
    expect(result.changes).toEqual([
      { productId: a.id, before: 10, after: 5 },
      { productId: b.id, before: 3, after: 10 },
    ]);
    expect(await getStock(prisma, a.id)).toBe(5);
    expect(await getStock(prisma, b.id)).toBe(10);
    const [, movement] = await movementsOf(b.id);
    expect(movement).toMatchObject({
      type: "in",
      quantity: 7,
      reason: "入荷",
      userId: STAFF.id,
      refType: null,
      refId: null,
    });
  });

  it("1 商品でも不足すれば例外で全体を中止し、同じトランザクションのほかの書き込みも取り消される", async () => {
    const a = await createProduct({ stock: 10 });
    const b = await createProduct({ stock: 2 });
    const error = await prisma
      .$transaction(async (tx) => {
        // 受注のステータス更新などに相当する先行の書き込み
        await tx.product.update({
          where: { id: a.id },
          data: { name: "書き換え（取り消されるはず）" },
        });
        await recordStockMovements(tx, STAFF.id, [out(a.id, 3), out(b.id, 5)]);
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InsufficientStockError);
    expect((error as InsufficientStockError).shortages).toEqual([
      {
        productId: b.id,
        code: b.code,
        name: b.name,
        unit: "個",
        available: 2,
        required: 5,
        shortage: 3,
      },
    ]);
    expect(await movementsOf(a.id)).toHaveLength(1); // 初期在庫だけ
    expect(await movementsOf(b.id)).toHaveLength(1);
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: a.id } })).name,
    ).toBe(a.name);
  });

  it("数量の符号が種別に合わない・存在しない商品はプログラムの誤りとして例外（何も記録しない）", async () => {
    const a = await createProduct({ stock: 10 });
    await expect(
      prisma.$transaction((tx) =>
        recordStockMovements(tx, STAFF.id, [
          { productId: a.id, type: "out", quantity: 3 },
        ]),
      ),
    ).rejects.toThrow("種別");
    await expect(
      prisma.$transaction((tx) =>
        recordStockMovements(tx, STAFF.id, [out(a.id, 1), out(999_999_999, 1)]),
      ),
    ).rejects.toThrow("商品が見つかりません");
    expect(await getStock(prisma, a.id)).toBe(10);
  });

  it("発注点以上 → 発注点未満に変わった商品を返す（もともと割れている商品・無効な商品は含めない）", async () => {
    const crossing = await createProduct({ stock: 6, reorderPoint: 5 });
    const alreadyLow = await createProduct({ stock: 4, reorderPoint: 5 });
    const toExact = await createProduct({ stock: 6, reorderPoint: 5 });
    const inactive = await createProduct({
      stock: 6,
      reorderPoint: 5,
      isActive: false,
    });
    const result = await prisma.$transaction((tx) =>
      recordStockMovements(tx, STAFF.id, [
        out(crossing.id, 2),
        out(alreadyLow.id, 1),
        out(toExact.id, 1),
        out(inactive.id, 3),
      ]),
    );
    expect(result.fellBelowReorderPoint).toEqual([
      {
        productId: crossing.id,
        code: crossing.code,
        name: crossing.name,
        unit: "個",
        reorderPoint: 5,
        before: 6,
        after: 4,
      },
    ]);

    // もう一度減らしても、すでに割れているので含めない
    const again = await prisma.$transaction((tx) =>
      recordStockMovements(tx, STAFF.id, [out(crossing.id, 1)]),
    );
    expect(again.fellBelowReorderPoint).toEqual([]);
  });
});

describe("同時実行（商品の行ロック）", () => {
  it("2 つのトランザクションから同じ商品を同時に出庫しても在庫は負にならない（後のほうは先の出庫を含めて判定）", async () => {
    const product = await createProduct({ stock: 5 });
    const firstRecorded = deferred();
    const releaseFirst = deferred();

    // 1 つ目: 出庫を記録した後、確定（COMMIT）を待たせてロックを持ち続ける
    const first = settle(
      prisma.$transaction(async (tx) => {
        await recordStockMovements(tx, STAFF.id, [out(product.id, 3)]);
        firstRecorded.resolve();
        await releaseFirst.promise;
      }),
    );
    await firstRecorded.promise;

    // 2 つ目: 1 つ目が未確定のうちに開始する。ロックがなければ在庫 5 を読んで通ってしまう
    const second = settle(
      prisma.$transaction((tx) =>
        recordStockMovements(tx, STAFF.id, [out(product.id, 3)]),
      ),
    );
    // 1 つ目がロックを持っている間は、2 つ目は行ロックの順番待ちで終わらない
    const state = await Promise.race([
      second.then(() => "finished"),
      sleep(500).then(() => "waiting"),
    ]);
    expect(state).toBe("waiting");

    releaseFirst.resolve();
    expect((await first).ok).toBe(true);
    const secondResult = await second;
    expect(secondResult.ok).toBe(false);
    expect(!secondResult.ok && secondResult.error).toBeInstanceOf(
      InsufficientStockError,
    );
    expect(await getStock(prisma, product.id)).toBe(2);
  });

  it("同時に 5 件出庫しても、在庫の範囲で成功した分だけ記録される", async () => {
    const product = await createProduct({ stock: 5 });
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        settle(
          prisma.$transaction((tx) =>
            recordStockMovements(tx, STAFF.id, [out(product.id, 2)]),
          ),
        ),
      ),
    );
    const succeeded = results.filter((r) => r.ok).length;
    expect(succeeded).toBe(2);
    expect(
      results
        .filter((r) => !r.ok)
        .every((r) => !r.ok && r.error instanceof InsufficientStockError),
    ).toBe(true);
    expect(await getStock(prisma, product.id)).toBe(1);
  });

  it("複数商品を逆の順番で同時に記録してもデッドロックしない（ロックは id 順）", async () => {
    const a = await createProduct({ stock: 100 });
    const b = await createProduct({ stock: 100 });
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        settle(
          prisma.$transaction((tx) =>
            recordStockMovements(
              tx,
              STAFF.id,
              i % 2 === 0
                ? [out(a.id, 1), out(b.id, 1)]
                : [out(b.id, 1), out(a.id, 1)],
            ),
          ),
        ),
      ),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(await getStock(prisma, a.id)).toBe(94);
    expect(await getStock(prisma, b.id)).toBe(94);
  });
});

describe("棚卸調整", () => {
  it("実数との差分を adjust で記録し、操作履歴を残す", async () => {
    const product = await createProduct({ stock: 10, reorderPoint: 5 });
    const result = await adjustStock(prisma, STAFF, product.id, {
      actualQuantity: "8",
      reason: "  定期棚卸  ",
    });
    expect(result).toEqual({
      ok: true,
      data: {
        recorded: true,
        before: 10,
        after: 8,
        delta: -2,
        fellBelowReorderPoint: [],
      },
    });
    expect(await getStock(prisma, product.id)).toBe(8);
    const movements = await movementsOf(product.id);
    expect(movements.at(-1)).toMatchObject({
      type: "adjust",
      quantity: -2,
      reason: "定期棚卸",
      userId: STAFF.id,
      refType: null,
      refId: null,
    });
    const logs = await auditLogsOf(product.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      userId: STAFF.id,
      action: STOCK_ADJUST_ACTION,
      targetType: PRODUCT_TARGET_TYPE,
      targetId: String(product.id),
    });
    expect(logs[0].summary).toContain(product.code);
    expect(logs[0].summary).toContain("10 → 8個");
    expect(logs[0].summary).toContain("差分 -2");
    expect(logs[0].summary).toContain("定期棚卸");
  });

  it("増やす調整・0 への調整もできる。発注点割れへの変化を返す", async () => {
    const product = await createProduct({ stock: 6, reorderPoint: 5 });
    const up = await adjustStock(prisma, ADMIN, product.id, {
      actualQuantity: "9",
      reason: "数え直し",
    });
    expect(up.ok && up.data.delta).toBe(3);
    const zero = await adjustStock(prisma, ADMIN, product.id, {
      actualQuantity: "0",
      reason: "破損による廃棄",
    });
    expect(zero.ok && zero.data).toMatchObject({
      recorded: true,
      before: 9,
      after: 0,
      delta: -9,
      fellBelowReorderPoint: [
        { productId: product.id, before: 9, after: 0, reorderPoint: 5 },
      ],
    });
    expect(await getStock(prisma, product.id)).toBe(0);
  });

  it("差分が 0 なら記録しない（入出庫も操作履歴も増えない）", async () => {
    const product = await createProduct({ stock: 7 });
    const result = await adjustStock(prisma, STAFF, product.id, {
      actualQuantity: "7",
      reason: "定期棚卸",
    });
    expect(result).toEqual({
      ok: true,
      data: {
        recorded: false,
        before: 7,
        after: 7,
        delta: 0,
        fellBelowReorderPoint: [],
      },
    });
    expect(await movementsOf(product.id)).toHaveLength(1);
    expect(await auditLogsOf(product.id)).toHaveLength(0);
  });

  it("理由は必須・実数は 0 以上の整数（エラーなら何も記録しない）", async () => {
    const product = await createProduct({ stock: 7 });
    const noReason = await adjustStock(prisma, STAFF, product.id, {
      actualQuantity: "5",
      reason: "   ",
    });
    expect(noReason.ok).toBe(false);
    expect(!noReason.ok && noReason.fieldErrors?.reason).toEqual([
      "理由を入力してください",
    ]);
    const negative = await adjustStock(prisma, STAFF, product.id, {
      actualQuantity: "-1",
      reason: "定期棚卸",
    });
    expect(!negative.ok && negative.fieldErrors?.actualQuantity).toEqual([
      "実数は0以上の整数で入力してください",
    ]);
    expect(await movementsOf(product.id)).toHaveLength(1);
    expect(await auditLogsOf(product.id)).toHaveLength(0);
  });

  it("viewer・未ログインは調整できない（サーバー側で検査）", async () => {
    const product = await createProduct({ stock: 7 });
    const input = { actualQuantity: "1", reason: "定期棚卸" };
    expect(await adjustStock(prisma, VIEWER, product.id, input)).toEqual({
      ok: false,
      error: "この操作を行う権限がありません",
    });
    expect(await adjustStock(prisma, null, product.id, input)).toEqual({
      ok: false,
      error: "ログインが必要です",
    });
    expect(await getStock(prisma, product.id)).toBe(7);
    expect(await auditLogsOf(product.id)).toHaveLength(0);
  });

  it("存在しない商品はエラー", async () => {
    expect(
      await adjustStock(prisma, STAFF, 999_999_999, {
        actualQuantity: "1",
        reason: "定期棚卸",
      }),
    ).toEqual({ ok: false, error: "商品が見つかりません" });
  });

  it("同時に調整しても、記録後の在庫は後から確定した実数になる（差分はロック後の現在庫から求める）", async () => {
    const product = await createProduct({ stock: 10 });
    const [r1, r2] = await Promise.all([
      adjustStock(prisma, STAFF, product.id, {
        actualQuantity: "8",
        reason: "棚卸 A",
      }),
      adjustStock(prisma, ADMIN, product.id, {
        actualQuantity: "3",
        reason: "棚卸 B",
      }),
    ]);
    expect(r1.ok && r2.ok).toBe(true);
    const last = (await movementsOf(product.id)).at(-1)!;
    const expected = last.reason === "棚卸 A" ? 8 : 3;
    expect(await getStock(prisma, product.id)).toBe(expected);
  });
});

describe("入出庫履歴", () => {
  it("新しい順に 20 件ずつ。参照元の伝票番号と担当者を返す", async () => {
    const product = await createProduct({ stock: 100 });
    const order = await prisma.purchaseOrder.findFirstOrThrow({
      where: { status: "received" },
    });
    await prisma.$transaction((tx) =>
      recordStockMovements(tx, STAFF.id, [
        {
          productId: product.id,
          type: "in",
          quantity: 5,
          reason: "発注の入荷",
          refType: "purchase_order",
          refId: order.id,
        },
      ]),
    );
    for (let i = 0; i < STOCK_MOVEMENTS_PER_PAGE + 2; i++) {
      await prisma.$transaction((tx) =>
        recordStockMovements(tx, STAFF.id, [out(product.id, 1)]),
      );
    }
    const total = STOCK_MOVEMENTS_PER_PAGE + 4; // 初期在庫・入荷・出庫 22 件

    const page1 = await listStockMovements(prisma, product.id, 1);
    expect(page1.total).toBe(total);
    expect(page1.totalPages).toBe(2);
    expect(page1.items).toHaveLength(STOCK_MOVEMENTS_PER_PAGE);
    expect(page1.items[0]).toMatchObject({
      type: "out",
      quantity: -1,
      ref: null,
      userName: STAFF.name,
    });
    const ids = page1.items.map((m) => m.id);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));

    // 範囲外のページは最終ページに丸める
    const page2 = await listStockMovements(prisma, product.id, 99);
    expect(page2.page).toBe(2);
    expect(page2.items).toHaveLength(total - STOCK_MOVEMENTS_PER_PAGE);
    expect(page2.items.at(-1)).toMatchObject({
      type: "adjust",
      quantity: 100,
      userName: ADMIN.name,
    });
    expect(page2.items.at(-2)).toMatchObject({
      type: "in",
      quantity: 5,
      ref: { type: "purchase_order", id: order.id, number: order.number },
    });
  });

  it("入出庫のない商品は 0 件・1 ページ", async () => {
    const product = await createProduct();
    expect(await listStockMovements(prisma, product.id, 1)).toMatchObject({
      items: [],
      total: 0,
      page: 1,
      totalPages: 1,
    });
  });
});
