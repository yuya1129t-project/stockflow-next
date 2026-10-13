/**
 * 発注の結合テスト（実 DB = DATABASE_URL_TEST）。docs/spec.md §2〜§4・§7
 * 前提: pnpm db:test:reset でテスト用 DB にマイグレーションとシードを適用済み
 *
 * シードのデータは書き換えない。このファイル専用の取引先・商品（コードが ZO- で始まる）を作り、発注はその仕入先で作る。
 * 開始時と終了時に 発注（明細は Cascade）→ 入出庫 → 操作履歴 → 商品・取引先 の順で削除し、
 * 採番テーブル（document_sequence の PO）を残っている発注の番号に合わせる（シードの結合テストが番号と採番表の一致を確かめるため）
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { SessionUser } from "@/lib/auth/session";
import { todayInTokyo } from "@/lib/orders/dates";
import { lockPartnerForRole, lockProductsForLines } from "@/lib/orders/locks";
import { nextDocumentNumber } from "@/lib/orders/numbering";
import { PARTNER_TARGET_TYPE, updatePartner } from "@/lib/partners/service";
import {
  getPurchaseOrder,
  listPurchaseOrders,
  listPurchaseOrdersForCsv,
} from "@/lib/purchase-orders/queries";
import { DEFAULT_PURCHASE_ORDER_LIST_PARAMS } from "@/lib/purchase-orders/search-params";
import {
  changePurchaseOrderStatus,
  CONFLICT_MESSAGE,
  createPurchaseOrder,
  PURCHASE_ORDER_STATUS_ACTION,
  PURCHASE_ORDER_TARGET_TYPE,
  STATUS_CONFLICT_MESSAGE,
  updatePurchaseOrder,
} from "@/lib/purchase-orders/service";
import {
  getStock,
  getStocks,
  recordStockMovements,
  withStockTransaction,
} from "@/lib/stock/movements";
import { listStockMovements } from "@/lib/stock/queries";

import { DEMO_USERS } from "../../prisma/seed-data";
import { connectTestDb, SETUP_HINT } from "./test-db";

let prisma: PrismaClient;

const [ADMIN, STAFF, VIEWER] = DEMO_USERS.map(
  ({ id, name, email, role }): SessionUser => ({ id, name, email, role }),
);
/** 存在しないユーザー（ロールは許可されたもの）。操作履歴・入出庫の外部キー違反で書き込みを失敗させる */
const MISSING_USER: SessionUser = {
  id: "zo-missing-user",
  name: "存在しないユーザー",
  email: "zo-missing@example.com",
  role: "staff",
};

const PREFIX = "ZO-";
let sequence = 0;
const nextCode = () => `${PREFIX}${String(++sequence).padStart(4, "0")}`;

async function testIds() {
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
  return {
    partnerIds: partners.map((p) => p.id),
    productIds: products.map((p) => p.id),
  };
}

async function cleanUp() {
  const { partnerIds, productIds } = await testIds();
  const orders = await prisma.purchaseOrder.findMany({
    where: { supplierId: { in: partnerIds } },
    select: { id: true },
  });
  const orderIds = orders.map((o) => o.id);
  await prisma.purchaseOrder.deleteMany({ where: { id: { in: orderIds } } });
  await prisma.stockMovement.deleteMany({
    where: { productId: { in: productIds } },
  });
  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        {
          targetType: PURCHASE_ORDER_TARGET_TYPE,
          targetId: { in: orderIds.map(String) },
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

/**
 * 採番テーブル（PO）を、残っている発注の番号に合わせる（日付ごとに最大の連番。発注のない日の行は消す）。
 * シードの採番と同じ状態に戻る。開始時にも実行するので、前回の実行が途中で止まって進んだままでも直る
 */
async function syncPoSequences() {
  await prisma.$executeRaw`
    DELETE FROM "document_sequence" ds
    WHERE ds."kind" = 'PO'
      AND NOT EXISTS (
        SELECT 1 FROM "purchase_order" po WHERE po."orderDate" = ds."date"
      )`;
  await prisma.$executeRaw`
    UPDATE "document_sequence" ds
    SET "lastNumber" = m."last"
    FROM (
      SELECT "orderDate", MAX(split_part("number", '-', 3)::int) AS "last"
      FROM "purchase_order"
      GROUP BY "orderDate"
    ) m
    WHERE ds."kind" = 'PO' AND ds."date" = m."orderDate"
      AND ds."lastNumber" <> m."last"`;
}

beforeAll(async () => {
  prisma = await connectTestDb();
  if ((await prisma.product.count()) === 0) {
    throw new Error(`テスト用 DB にシードが入っていません。${SETUP_HINT}`);
  }
  await cleanUp();
  await syncPoSequences();
});

afterAll(async () => {
  if (!prisma) return;
  try {
    await cleanUp();
    await syncPoSequences();
  } finally {
    await prisma.$disconnect();
  }
});

async function createPartner({
  kind = "supplier",
  isActive = true,
}: { kind?: "customer" | "supplier" | "both"; isActive?: boolean } = {}) {
  const code = nextCode();
  return prisma.partner.create({
    data: { code, name: `発注テスト取引先 ${code}`, kind, isActive },
  });
}

async function createProduct({
  purchasePrice = 60,
  isActive = true,
}: { purchasePrice?: number; isActive?: boolean } = {}) {
  const code = nextCode();
  return prisma.product.create({
    data: {
      code,
      name: `発注テスト商品 ${code}`,
      category: "発注テスト",
      unit: "個",
      salesPrice: 100,
      purchasePrice,
      reorderPoint: 5,
      isActive,
    },
  });
}

type LineSpec = [productId: number, quantity: number, unitPrice: number];

function input(
  supplierId: number,
  lines: LineSpec[],
  overrides: Record<string, unknown> = {},
) {
  return {
    supplierId: String(supplierId),
    expectedDate: "",
    note: "",
    lines: lines.map(([productId, quantity, unitPrice]) => ({
      productId: String(productId),
      quantity: String(quantity),
      unitPrice: String(unitPrice),
    })),
    ...overrides,
  };
}

async function createOk(
  supplierId: number,
  lines: LineSpec[],
  user: SessionUser = STAFF,
) {
  const result = await createPurchaseOrder(
    prisma,
    user,
    input(supplierId, lines),
  );
  if (!result.ok) throw new Error(`作成に失敗: ${JSON.stringify(result)}`);
  return result.data;
}

/** 今の updatedAt（詳細画面に表示した時点の値として送る）。発注がなければ適当な値 */
async function versionOf(id: number): Promise<string> {
  const order = await prisma.purchaseOrder.findUnique({
    where: { id },
    select: { updatedAt: true },
  });
  return (order?.updatedAt ?? new Date(0)).toISOString();
}

/** ステータス変更（version を省くと今の updatedAt を送る＝画面が最新の場合） */
async function changeStatus(
  user: SessionUser | null,
  id: number,
  to: unknown,
  version?: string,
) {
  return changePurchaseOrderStatus(
    prisma,
    user,
    id,
    to,
    version ?? (await versionOf(id)),
  );
}

async function statusOk(id: number, to: string) {
  const result = await changeStatus(STAFF, id, to);
  if (!result.ok) throw new Error(`ステータス変更に失敗: ${result.error}`);
  return result.data;
}

function auditLogsOf(orderId: number) {
  return prisma.auditLog.findMany({
    where: {
      targetType: PURCHASE_ORDER_TARGET_TYPE,
      targetId: String(orderId),
    },
    orderBy: { id: "asc" },
  });
}

async function poSequence(date: string): Promise<number> {
  const row = await prisma.documentSequence.findUnique({
    where: {
      kind_date: { kind: "PO", date: new Date(`${date}T00:00:00Z`) },
    },
  });
  return row?.lastNumber ?? 0;
}

// ---------------------------------------------------------------------------
// 同時実行の確認用（tests/integration/stock.test.ts と同じ方式。固定時間の経過を競合の証拠にしない）
// ---------------------------------------------------------------------------

const TX_TIMEOUT = 20_000;
const WAIT_LIMIT_MS = 10_000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

function settle<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

async function backendPid(tx: Prisma.TransactionClient): Promise<number> {
  const [row] = await tx.$queryRaw<{ pid: number }[]>`
    SELECT pg_backend_pid() AS "pid"`;
  return row.pid;
}

/** 観測用の接続から: holder のロックの解放を待っているセッションの数 */
async function sessionsBlockedBy(holder: number): Promise<number> {
  const [row] = await prisma.$queryRaw<{ count: number }[]>`
    SELECT COUNT(*)::int AS "count" FROM pg_stat_activity
    WHERE "datname" = current_database()
      AND ${holder}::int = ANY(pg_blocking_pids("pid"))`;
  return row.count;
}

/** 観測用の接続から: このテスト用 DB でロック待ちになっているセッションの数 */
async function blockedSessionCount(): Promise<number> {
  const [row] = await prisma.$queryRaw<{ count: number }[]>`
    SELECT COUNT(*)::int AS "count" FROM pg_stat_activity
    WHERE "datname" = current_database()
      AND cardinality(pg_blocking_pids("pid")) > 0`;
  return row.count;
}

async function waitUntil(label: string, condition: () => Promise<boolean>) {
  const deadline = Date.now() + WAIT_LIMIT_MS;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error(`「${label}」の状態になりませんでした`);
    }
    await sleep(20);
  }
}

/**
 * 別のトランザクションで work を実行してロックを持ち続ける（release で確定、rollback で取り消し）
 */
async function hold(work: (tx: Prisma.TransactionClient) => Promise<unknown>) {
  const ready = deferred();
  const finish = deferred();
  let pid = 0;
  let rollback = false;
  const done = settle(
    prisma.$transaction(
      async (tx) => {
        pid = await backendPid(tx);
        await work(tx);
        ready.resolve();
        await finish.promise;
        if (rollback) throw new Error("rollback");
      },
      { timeout: TX_TIMEOUT },
    ),
  );
  await Promise.race([
    ready.promise,
    done.then((r) => {
      if (!r.ok) throw r.error;
    }),
  ]);
  return {
    pid,
    async release() {
      finish.resolve();
      const result = await done;
      if (!result.ok) throw result.error;
    },
    async rollback() {
      rollback = true;
      finish.resolve();
      await done;
    },
  };
}

// ---------------------------------------------------------------------------

describe("作成", () => {
  it("採番（PO-今日-連番）・発注日・金額（サーバーで計算）・明細・操作履歴", async () => {
    const supplier = await createPartner();
    const a = await createProduct();
    const b = await createProduct();
    const today = todayInTokyo();
    const before = await poSequence(today);

    const result = await createPurchaseOrder(
      prisma,
      STAFF,
      input(
        supplier.id,
        [
          [a.id, 3, 333],
          [b.id, 1, 6],
        ],
        // 画面から送られた金額は使わない
        {
          subtotal: "1",
          tax: "0",
          total: "1",
          expectedDate: today,
          note: "急ぎ",
        },
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const expectedNumber = `PO-${today.replaceAll("-", "")}-${String(before + 1).padStart(3, "0")}`;
    expect(result.data.number).toBe(expectedNumber);
    expect(await poSequence(today)).toBe(before + 1);

    const order = await getPurchaseOrder(prisma, result.data.id);
    expect(order).toMatchObject({
      number: expectedNumber,
      status: "draft",
      supplierId: supplier.id,
      note: "急ぎ",
      subtotal: 1005,
      tax: 100,
      total: 1105,
    });
    expect(order!.orderDate.toISOString().slice(0, 10)).toBe(today);
    expect(order!.expectedDate!.toISOString().slice(0, 10)).toBe(today);
    expect(
      order!.lines.map((l) => [l.productId, l.quantity, l.unitPrice]),
    ).toEqual([
      [a.id, 3, 333],
      [b.id, 1, 6],
    ]);

    const logs = await auditLogsOf(result.data.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ userId: STAFF.id, action: "create" });
    expect(logs[0].summary).toContain(expectedNumber);
    expect(logs[0].summary).toContain("合計 1,105 円");
  });

  it("明細の単価は保存時の値で固定（あとで商品の仕入単価を変えても変わらない）", async () => {
    const supplier = await createPartner();
    const product = await createProduct({ purchasePrice: 60 });
    const { id } = await createOk(supplier.id, [[product.id, 2, 55]]);
    await prisma.product.update({
      where: { id: product.id },
      data: { purchasePrice: 999 },
    });
    const order = await getPurchaseOrder(prisma, id);
    expect(order!.lines[0].unitPrice).toBe(55);
    expect(order!.total).toBe(121);
  });

  it("同時に 2 件作成しても番号は重複しない（採番の行のロックで順番待ちになる）", async () => {
    const supplier = await createPartner();
    const product = await createProduct();
    const today = todayInTokyo();
    const before = await poSequence(today);

    // 1 本目: 採番だけして確定を待たせる（今日の採番の行をロックしたまま）。最後は取り消すので番号は消費しない
    const holder = await hold((tx) => nextDocumentNumber(tx, "PO", today));
    const results = [1, 2].map(() =>
      settle(
        createPurchaseOrder(
          prisma,
          STAFF,
          input(supplier.id, [[product.id, 1, 10]]),
        ),
      ),
    );
    // 2 件とも 1 本目のロックを待つ状態に入ったことを DB で確かめてから解放する
    await waitUntil(
      "2 件が採番の行のロックを待つ",
      async () => (await sessionsBlockedBy(holder.pid)) >= 2,
    );
    await holder.rollback();

    const settled = await Promise.all(results);
    const numbers = settled.map((r) => {
      if (!r.ok || !r.value.ok) throw new Error("作成に失敗");
      return r.value.data.number;
    });
    const prefix = `PO-${today.replaceAll("-", "")}-`;
    expect(new Set(numbers).size).toBe(2);
    expect(numbers.sort()).toEqual([
      `${prefix}${String(before + 1).padStart(3, "0")}`,
      `${prefix}${String(before + 2).padStart(3, "0")}`,
    ]);
    expect(await poSequence(today)).toBe(before + 2);
  });

  it("仕入先は種別が supplier か both で有効なものだけ", async () => {
    const product = await createProduct();
    const customer = await createPartner({ kind: "customer" });
    const inactive = await createPartner({ isActive: false });
    const both = await createPartner({ kind: "both" });
    const count = await prisma.purchaseOrder.count();

    const asCustomer = await createPurchaseOrder(
      prisma,
      STAFF,
      input(customer.id, [[product.id, 1, 10]]),
    );
    expect(asCustomer).toMatchObject({ ok: false });
    expect(!asCustomer.ok && asCustomer.fieldErrors?.supplierId?.[0]).toContain(
      "は仕入先ではありません",
    );
    const asInactive = await createPurchaseOrder(
      prisma,
      STAFF,
      input(inactive.id, [[product.id, 1, 10]]),
    );
    expect(!asInactive.ok && asInactive.fieldErrors?.supplierId?.[0]).toContain(
      "無効になっているため選べません",
    );
    const missing = await createPurchaseOrder(
      prisma,
      STAFF,
      input(99_999_999, [[product.id, 1, 10]]),
    );
    expect(!missing.ok && missing.fieldErrors?.supplierId).toEqual([
      "仕入先が見つかりません",
    ]);
    expect(await prisma.purchaseOrder.count()).toBe(count);

    expect(
      (
        await createPurchaseOrder(
          prisma,
          STAFF,
          input(both.id, [[product.id, 1, 10]]),
        )
      ).ok,
    ).toBe(true);
  });

  it("無効な商品・存在しない商品は選べない（行ごとのエラー）", async () => {
    const supplier = await createPartner();
    const active = await createProduct();
    const inactive = await createProduct({ isActive: false });
    const today = todayInTokyo();
    const before = await poSequence(today);
    const result = await createPurchaseOrder(
      prisma,
      STAFF,
      input(supplier.id, [
        [active.id, 1, 10],
        [inactive.id, 1, 10],
        [99_999_999, 1, 10],
      ]),
    );
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.fieldErrors).toEqual({
      "lines.1.productId": [
        `${inactive.code}「${inactive.name}」は無効になっているため選べません`,
      ],
      "lines.2.productId": ["商品が見つかりません"],
    });
    // 失敗したら採番もしない
    expect(await poSequence(today)).toBe(before);
  });

  it("同じ商品の明細の重複は検証エラー。DB の一意制約でも防ぐ", async () => {
    const supplier = await createPartner();
    const product = await createProduct();
    const result = await createPurchaseOrder(
      prisma,
      STAFF,
      input(supplier.id, [
        [product.id, 1, 10],
        [product.id, 2, 10],
      ]),
    );
    expect(!result.ok && Object.keys(result.fieldErrors ?? {})).toEqual([
      "lines.1.productId",
    ]);

    const { id } = await createOk(supplier.id, [[product.id, 1, 10]]);
    await expect(
      prisma.purchaseOrderLine.create({
        data: {
          purchaseOrderId: id,
          productId: product.id,
          quantity: 1,
          unitPrice: 1,
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("入荷予定日は発注日（今日）以降", async () => {
    const supplier = await createPartner();
    const product = await createProduct();
    const result = await createPurchaseOrder(
      prisma,
      STAFF,
      input(supplier.id, [[product.id, 1, 10]], { expectedDate: "2000-01-01" }),
    );
    expect(!result.ok && result.fieldErrors?.expectedDate?.[0]).toContain(
      "以降の日付にしてください",
    );
  });

  it("viewer・未ログインは作成できない（何も書かない）", async () => {
    const supplier = await createPartner();
    const product = await createProduct();
    const count = await prisma.purchaseOrder.count();
    expect(
      await createPurchaseOrder(
        prisma,
        VIEWER,
        input(supplier.id, [[product.id, 1, 10]]),
      ),
    ).toEqual({ ok: false, error: "この操作を行う権限がありません" });
    expect(
      await createPurchaseOrder(
        prisma,
        null,
        input(supplier.id, [[product.id, 1, 10]]),
      ),
    ).toEqual({ ok: false, error: "ログインが必要です" });
    expect(await prisma.purchaseOrder.count()).toBe(count);
  });

  it("操作履歴の保存に失敗したら、発注も採番も取り消される", async () => {
    const supplier = await createPartner();
    const product = await createProduct();
    const today = todayInTokyo();
    const before = await poSequence(today);
    const count = await prisma.purchaseOrder.count();
    await expect(
      createPurchaseOrder(
        prisma,
        MISSING_USER,
        input(supplier.id, [[product.id, 1, 10]]),
      ),
    ).rejects.toThrow();
    expect(await prisma.purchaseOrder.count()).toBe(count);
    expect(await poSequence(today)).toBe(before);
  });
});

describe("編集", () => {
  it("draft の明細・仕入先・入荷予定日を変更でき、金額を計算し直して操作履歴に残す", async () => {
    const supplier = await createPartner();
    const other = await createPartner({ kind: "both" });
    const a = await createProduct();
    const b = await createProduct();
    const { id } = await createOk(supplier.id, [[a.id, 1, 100]]);
    const before = await getPurchaseOrder(prisma, id);

    const result = await updatePurchaseOrder(
      prisma,
      ADMIN,
      id,
      input(
        other.id,
        [
          [b.id, 2, 50],
          [a.id, 3, 100],
        ],
        { expectedDate: "2099-12-31", total: "1" },
      ),
      before!.updatedAt.toISOString(),
    );
    expect(result).toEqual({ ok: true, data: null });
    const after = await getPurchaseOrder(prisma, id);
    expect(after).toMatchObject({
      supplierId: other.id,
      subtotal: 400,
      tax: 40,
      total: 440,
      number: before!.number,
    });
    expect(
      after!.lines.map((l) => [l.productId, l.quantity, l.unitPrice]),
    ).toEqual([
      [b.id, 2, 50],
      [a.id, 3, 100],
    ]);
    expect(after!.updatedAt.getTime()).toBeGreaterThan(
      before!.updatedAt.getTime(),
    );
    const logs = await auditLogsOf(id);
    expect(logs.map((l) => l.action)).toEqual(["create", "update"]);
    expect(logs[1].summary).toBe(
      `発注 ${before!.number} を更新しました（仕入先: ${supplier.code} → ${other.code}、入荷予定日: （なし） → 2099-12-31、明細: 1 行 → 2 行、合計: 110 → 440 円）`,
    );
  });

  it("画面を開いた後に他の人が更新していたら保存しない（競合）", async () => {
    const supplier = await createPartner();
    const product = await createProduct();
    const { id } = await createOk(supplier.id, [[product.id, 1, 100]]);
    const opened = (await getPurchaseOrder(
      prisma,
      id,
    ))!.updatedAt.toISOString();

    // 他の人の保存
    expect(
      (
        await updatePurchaseOrder(
          prisma,
          STAFF,
          id,
          input(supplier.id, [[product.id, 5, 100]]),
          opened,
        )
      ).ok,
    ).toBe(true);
    // 古い updatedAt のままの保存は拒否される
    const stale = await updatePurchaseOrder(
      prisma,
      STAFF,
      id,
      input(supplier.id, [[product.id, 9, 100]]),
      opened,
    );
    expect(stale).toEqual({
      ok: false,
      error: CONFLICT_MESSAGE,
      conflict: true,
    });
    expect((await getPurchaseOrder(prisma, id))!.lines[0].quantity).toBe(5);
    // 形式が違う値も競合として扱う
    expect(
      await updatePurchaseOrder(prisma, STAFF, id, input(supplier.id, []), "x"),
    ).toMatchObject({ conflict: true });
  });

  it("draft 以外は編集できない", async () => {
    const supplier = await createPartner();
    const product = await createProduct();
    const { id } = await createOk(supplier.id, [[product.id, 1, 100]]);
    await statusOk(id, "ordered");
    const order = await getPurchaseOrder(prisma, id);
    const result = await updatePurchaseOrder(
      prisma,
      STAFF,
      id,
      input(supplier.id, [[product.id, 2, 100]]),
      order!.updatedAt.toISOString(),
    );
    expect(result).toEqual({
      ok: false,
      error:
        "この発注は「発注済」のため編集できません（編集できるのは下書きだけです）",
    });
    expect((await getPurchaseOrder(prisma, id))!.lines[0].quantity).toBe(1);
  });

  it("もとからある明細の商品はその後に無効になっても残せる。新しく無効な商品は選べない", async () => {
    const supplier = await createPartner();
    const kept = await createProduct();
    const added = await createProduct({ isActive: false });
    const { id } = await createOk(supplier.id, [[kept.id, 1, 100]]);
    await prisma.product.update({
      where: { id: kept.id },
      data: { isActive: false },
    });
    const opened = (await getPurchaseOrder(
      prisma,
      id,
    ))!.updatedAt.toISOString();

    const keep = await updatePurchaseOrder(
      prisma,
      STAFF,
      id,
      input(supplier.id, [[kept.id, 4, 100]]),
      opened,
    );
    expect(keep.ok).toBe(true);
    const reopened = (await getPurchaseOrder(
      prisma,
      id,
    ))!.updatedAt.toISOString();
    const add = await updatePurchaseOrder(
      prisma,
      STAFF,
      id,
      input(supplier.id, [
        [kept.id, 4, 100],
        [added.id, 1, 100],
      ]),
      reopened,
    );
    expect(!add.ok && Object.keys(add.fieldErrors ?? {})).toEqual([
      "lines.1.productId",
    ]);
  });

  it("仕入先が無効・種別違いになったら保存できない", async () => {
    const supplier = await createPartner();
    const product = await createProduct();
    const { id } = await createOk(supplier.id, [[product.id, 1, 100]]);
    await prisma.partner.update({
      where: { id: supplier.id },
      data: { isActive: false },
    });
    const opened = (await getPurchaseOrder(
      prisma,
      id,
    ))!.updatedAt.toISOString();
    const result = await updatePurchaseOrder(
      prisma,
      STAFF,
      id,
      input(supplier.id, [[product.id, 2, 100]]),
      opened,
    );
    expect(!result.ok && result.fieldErrors?.supplierId?.[0]).toContain("無効");
  });

  it("変更がなければ何もしない（操作履歴も残さない）", async () => {
    const supplier = await createPartner();
    const product = await createProduct();
    const { id } = await createOk(supplier.id, [[product.id, 1, 100]]);
    const order = await getPurchaseOrder(prisma, id);
    expect(
      await updatePurchaseOrder(
        prisma,
        STAFF,
        id,
        input(supplier.id, [[product.id, 1, 100]]),
        order!.updatedAt.toISOString(),
      ),
    ).toEqual({ ok: true, data: null });
    expect((await getPurchaseOrder(prisma, id))!.updatedAt).toEqual(
      order!.updatedAt,
    );
    expect(await auditLogsOf(id)).toHaveLength(1);
  });

  it("viewer は編集できない。操作履歴の保存に失敗したら明細も元のまま", async () => {
    const supplier = await createPartner();
    const product = await createProduct();
    const { id } = await createOk(supplier.id, [[product.id, 1, 100]]);
    const opened = (await getPurchaseOrder(
      prisma,
      id,
    ))!.updatedAt.toISOString();
    expect(
      await updatePurchaseOrder(
        prisma,
        VIEWER,
        id,
        input(supplier.id, [[product.id, 2, 100]]),
        opened,
      ),
    ).toEqual({ ok: false, error: "この操作を行う権限がありません" });
    await expect(
      updatePurchaseOrder(
        prisma,
        MISSING_USER,
        id,
        input(supplier.id, [[product.id, 3, 100]]),
        opened,
      ),
    ).rejects.toThrow();
    const order = await getPurchaseOrder(prisma, id);
    expect(order!.lines.map((l) => l.quantity)).toEqual([1]);
    expect(order!.total).toBe(110);
    expect(await auditLogsOf(id)).toHaveLength(1);
  });
});

describe("ステータス遷移", () => {
  it("明細が 0 行の draft は ordered にできない", async () => {
    const supplier = await createPartner();
    const { id } = await createOk(supplier.id, []);
    expect(await changeStatus(STAFF, id, "ordered")).toEqual({
      ok: false,
      error: "明細が 1 行もないため、発注済にできません",
    });
    expect((await getPurchaseOrder(prisma, id))!.status).toBe("draft");
  });

  it("draft → ordered → received で全明細の在庫が増え、入出庫に発注の参照が残る", async () => {
    const supplier = await createPartner();
    const a = await createProduct();
    const b = await createProduct();
    await prisma.stockMovement.create({
      data: {
        productId: a.id,
        type: "adjust",
        quantity: 3,
        reason: "初期在庫（テスト）",
      },
    });
    const { id, number } = await createOk(supplier.id, [
      [b.id, 20, 60],
      [a.id, 10, 60],
    ]);

    expect(await statusOk(id, "ordered")).toMatchObject({
      from: "draft",
      to: "ordered",
    });
    // ordered の時点では在庫は変わらない
    expect(Object.fromEntries(await getStocks(prisma, [a.id, b.id]))).toEqual({
      [a.id]: 3,
      [b.id]: 0,
    });
    expect(await statusOk(id, "received")).toEqual({
      number,
      from: "ordered",
      to: "received",
      receivedLines: 2,
    });

    expect(await getStock(prisma, a.id)).toBe(13);
    expect(await getStock(prisma, b.id)).toBe(20);
    const movements = await prisma.stockMovement.findMany({
      where: { refType: "purchase_order", refId: id },
      orderBy: { productId: "asc" },
    });
    expect(
      movements.map((m) => ({
        productId: m.productId,
        type: m.type,
        quantity: m.quantity,
        reason: m.reason,
        userId: m.userId,
      })),
    ).toEqual(
      [
        { productId: a.id, quantity: 10 },
        { productId: b.id, quantity: 20 },
      ].map((m) => ({
        ...m,
        type: "in",
        reason: `発注 ${number} の入荷`,
        userId: STAFF.id,
      })),
    );
    // 入出庫履歴の参照に発注番号が出る（画面では発注の詳細へのリンクになる）
    const history = await listStockMovements(prisma, a.id, 1);
    expect(history.items[0].ref).toEqual({
      type: "purchase_order",
      id,
      number,
    });

    const logs = await auditLogsOf(id);
    expect(logs.map((l) => [l.action, l.summary])).toEqual([
      ["create", expect.any(String)],
      [
        PURCHASE_ORDER_STATUS_ACTION,
        `発注 ${number} のステータスを「下書き」から「発注済」に変更しました`,
      ],
      [
        PURCHASE_ORDER_STATUS_ACTION,
        `発注 ${number} のステータスを「発注済」から「入荷済」に変更しました（入庫 2 品目）`,
      ],
    ]);
  });

  it("同時に 2 回入荷しても入庫は 1 回だけ（条件付き更新で二重入荷を防ぐ）", async () => {
    const supplier = await createPartner();
    const a = await createProduct();
    const b = await createProduct();
    const { id } = await createOk(supplier.id, [
      [a.id, 7, 60],
      [b.id, 4, 60],
    ]);
    await statusOk(id, "ordered");

    // 発注の行を別のトランザクションでロックし、2 本の入荷をその後ろで待たせてから同時に走らせる
    const holder = await hold(
      (tx) =>
        tx.$queryRaw`SELECT "id" FROM "purchase_order" WHERE "id" = ${id} FOR NO KEY UPDATE`,
    );
    const results = [1, 2].map(() =>
      settle(changeStatus(STAFF, id, "received")),
    );
    // 同じ行を待つ 2 本目は、PostgreSQL では 1 本目の待ちの後ろに並ぶ（待つ相手は 1 本目になる）
    await waitUntil(
      "2 本の入荷がロック待ち",
      async () =>
        (await sessionsBlockedBy(holder.pid)) >= 1 &&
        (await blockedSessionCount()) >= 2,
    );
    await holder.release();

    const settled = await Promise.all(results);
    const values = settled.map((r) => {
      if (!r.ok) throw r.error;
      return r.value;
    });
    expect(values.filter((v) => v.ok)).toHaveLength(1);
    expect(values.filter((v) => !v.ok)).toEqual([
      {
        ok: false,
        error: "この発注は「入荷済」のため、ステータスを変更できません",
      },
    ]);
    expect(await getStock(prisma, a.id)).toBe(7);
    expect(await getStock(prisma, b.id)).toBe(4);
    expect(
      await prisma.stockMovement.count({
        where: { refType: "purchase_order", refId: id },
      }),
    ).toBe(2);
    expect(
      (await auditLogsOf(id)).filter((l) => l.summary.includes("入荷済")),
    ).toHaveLength(1);
  });

  it("draft／ordered → cancelled。cancelled・received の後はどこへも遷移できない", async () => {
    const supplier = await createPartner();
    const product = await createProduct();
    const draft = await createOk(supplier.id, [[product.id, 1, 10]]);
    expect(await statusOk(draft.id, "cancelled")).toMatchObject({
      from: "draft",
      to: "cancelled",
    });
    for (const to of ["ordered", "received", "cancelled"]) {
      expect(await changeStatus(STAFF, draft.id, to)).toEqual({
        ok: false,
        error: "この発注は「取消」のため、ステータスを変更できません",
      });
    }

    const ordered = await createOk(supplier.id, [[product.id, 1, 10]]);
    await statusOk(ordered.id, "ordered");
    await statusOk(ordered.id, "cancelled");
    // 取消では在庫は変わらない
    expect(await getStock(prisma, product.id)).toBe(0);

    const received = await createOk(supplier.id, [[product.id, 2, 10]]);
    await statusOk(received.id, "ordered");
    await statusOk(received.id, "received");
    expect(await changeStatus(STAFF, received.id, "cancelled")).toEqual({
      ok: false,
      error: "この発注は「入荷済」のため、ステータスを変更できません",
    });
    // draft から received への飛び越しも不可
    const skip = await createOk(supplier.id, [[product.id, 1, 10]]);
    expect(await changeStatus(STAFF, skip.id, "received")).toEqual({
      ok: false,
      error: "「下書き」から「入荷済」には変更できません",
    });
    expect(await getStock(prisma, product.id)).toBe(2);
  });

  it("変更先が正しくない・発注がない・viewer はエラー", async () => {
    const supplier = await createPartner();
    const product = await createProduct();
    const { id } = await createOk(supplier.id, [[product.id, 1, 10]]);
    for (const to of ["draft", "shipped", 1, null]) {
      expect(await changeStatus(STAFF, id, to)).toEqual({
        ok: false,
        error: "変更先のステータスが正しくありません",
      });
    }
    expect(await changeStatus(STAFF, 99_999_999, "ordered")).toEqual({
      ok: false,
      error: "発注が見つかりません",
    });
    expect(await changeStatus(STAFF, 99_999_999, "received")).toEqual({
      ok: false,
      error: "発注が見つかりません",
    });
    expect(await changeStatus(VIEWER, id, "ordered")).toEqual({
      ok: false,
      error: "この操作を行う権限がありません",
    });
    expect((await getPurchaseOrder(prisma, id))!.status).toBe("draft");
  });

  it("int の範囲外の id は例外ではなく「見つかりません」", async () => {
    const supplier = await createPartner();
    const product = await createProduct();
    const huge = 2 ** 40;
    expect(
      await changeStatus(STAFF, huge, "ordered", new Date().toISOString()),
    ).toEqual({
      ok: false,
      error: "発注が見つかりません",
    });
    expect(
      await updatePurchaseOrder(
        prisma,
        STAFF,
        huge,
        input(supplier.id, [[product.id, 1, 10]]),
        new Date().toISOString(),
      ),
    ).toEqual({ ok: false, error: "発注が見つかりません" });
  });

  it("途中で失敗したら全体が取り消される（存在しないユーザーで入出庫・操作履歴の外部キー違反）", async () => {
    const supplier = await createPartner();
    const product = await createProduct();
    const { id } = await createOk(supplier.id, [[product.id, 5, 10]]);
    await expect(changeStatus(MISSING_USER, id, "ordered")).rejects.toThrow();
    expect((await getPurchaseOrder(prisma, id))!.status).toBe("draft");

    await statusOk(id, "ordered");
    await expect(changeStatus(MISSING_USER, id, "received")).rejects.toThrow();
    expect((await getPurchaseOrder(prisma, id))!.status).toBe("ordered");
    expect(await getStock(prisma, product.id)).toBe(0);
    expect(await auditLogsOf(id)).toHaveLength(2);
  });
});

describe("ステータス変更の競合（詳細画面に表示した時点の updatedAt）", () => {
  it("表示した後に明細が編集されていたら発注済にしない。最新を表示し直せば変更できる", async () => {
    const supplier = await createPartner();
    const product = await createProduct();
    const { id } = await createOk(supplier.id, [[product.id, 1, 100]]);
    const shown = await versionOf(id);
    // 他の人が明細を編集する
    expect(
      (
        await updatePurchaseOrder(
          prisma,
          STAFF,
          id,
          input(supplier.id, [[product.id, 9, 100]]),
          shown,
        )
      ).ok,
    ).toBe(true);
    expect(await changeStatus(STAFF, id, "ordered", shown)).toEqual({
      ok: false,
      error: STATUS_CONFLICT_MESSAGE,
      conflict: true,
    });
    expect(await changeStatus(STAFF, id, "cancelled", shown)).toMatchObject({
      conflict: true,
    });
    expect((await getPurchaseOrder(prisma, id))!.status).toBe("draft");
    expect((await changeStatus(STAFF, id, "ordered")).ok).toBe(true);
    expect(
      (await auditLogsOf(id)).filter(
        (l) => l.action === PURCHASE_ORDER_STATUS_ACTION,
      ),
    ).toHaveLength(1);
  });

  it("入荷も、表示した後に更新されていたら入庫しない。形式の違う値も競合", async () => {
    const supplier = await createPartner();
    const product = await createProduct();
    const { id } = await createOk(supplier.id, [[product.id, 4, 100]]);
    await statusOk(id, "ordered");
    const shown = await versionOf(id);
    // 別の操作で発注が更新された（updatedAt が変わる）
    await prisma.purchaseOrder.update({
      where: { id },
      data: { note: "別の更新" },
    });
    expect(await changeStatus(STAFF, id, "received", shown)).toEqual({
      ok: false,
      error: STATUS_CONFLICT_MESSAGE,
      conflict: true,
    });
    for (const version of ["x", undefined, 0]) {
      expect(
        await changePurchaseOrderStatus(prisma, STAFF, id, "received", version),
      ).toMatchObject({ conflict: true });
    }
    expect((await getPurchaseOrder(prisma, id))!.status).toBe("ordered");
    expect(await getStock(prisma, product.id)).toBe(0);
    expect((await changeStatus(STAFF, id, "received")).ok).toBe(true);
    expect(await getStock(prisma, product.id)).toBe(4);
  });
});

describe("同時実行（発注・商品の行ロック）", () => {
  /** 発注の行を別のトランザクションでロックし続ける */
  function holdOrder(id: number) {
    return hold(
      (tx) =>
        tx.$queryRaw`SELECT "id" FROM "purchase_order" WHERE "id" = ${id} FOR NO KEY UPDATE`,
    );
  }

  it("A: 入荷と取消が同時でも、先に確定した入荷だけが通り、在庫は 1 回だけ増える", async () => {
    const supplier = await createPartner();
    const product = await createProduct();
    const { id } = await createOk(supplier.id, [[product.id, 5, 10]]);
    await statusOk(id, "ordered");
    const shown = await versionOf(id);

    const holder = await holdOrder(id);
    const receive = settle(changeStatus(STAFF, id, "received", shown));
    await waitUntil(
      "入荷がロック待ち",
      async () => (await blockedSessionCount()) >= 1,
    );
    const cancel = settle(changeStatus(STAFF, id, "cancelled", shown));
    await waitUntil(
      "取消もロック待ち",
      async () => (await blockedSessionCount()) >= 2,
    );
    await holder.release();

    const [received, cancelled] = await Promise.all([receive, cancel]);
    expect(received.ok && received.value.ok).toBe(true);
    expect(cancelled.ok && cancelled.value).toEqual({
      ok: false,
      error: "この発注は「入荷済」のため、ステータスを変更できません",
    });
    expect((await getPurchaseOrder(prisma, id))!.status).toBe("received");
    expect(await getStock(prisma, product.id)).toBe(5);
  });

  it("B1: 明細を 0 行にする編集が先に確定したら、待っていた発注済への変更は通らない", async () => {
    const supplier = await createPartner();
    const product = await createProduct();
    const { id } = await createOk(supplier.id, [[product.id, 1, 10]]);
    const shown = await versionOf(id);

    const holder = await holdOrder(id);
    const edit = settle(
      updatePurchaseOrder(prisma, STAFF, id, input(supplier.id, []), shown),
    );
    await waitUntil(
      "編集がロック待ち",
      async () => (await blockedSessionCount()) >= 1,
    );
    const order = settle(changeStatus(STAFF, id, "ordered", shown));
    await waitUntil(
      "発注済への変更もロック待ち",
      async () => (await blockedSessionCount()) >= 2,
    );
    await holder.release();

    const [edited, ordered] = await Promise.all([edit, order]);
    expect(edited.ok && edited.value.ok).toBe(true);
    expect(ordered.ok && ordered.value.ok).toBe(false);
    const after = await getPurchaseOrder(prisma, id);
    expect(after!.status).toBe("draft");
    expect(after!.lines).toHaveLength(0);
  });

  it("B2: 発注済への変更が先に確定したら、待っていた編集は明細を書き換えない", async () => {
    const supplier = await createPartner();
    const product = await createProduct();
    const { id } = await createOk(supplier.id, [[product.id, 1, 10]]);
    const shown = await versionOf(id);

    const holder = await holdOrder(id);
    const order = settle(changeStatus(STAFF, id, "ordered", shown));
    await waitUntil(
      "発注済への変更がロック待ち",
      async () => (await blockedSessionCount()) >= 1,
    );
    const edit = settle(
      updatePurchaseOrder(
        prisma,
        STAFF,
        id,
        input(supplier.id, [[product.id, 9, 10]]),
        shown,
      ),
    );
    await waitUntil(
      "編集もロック待ち",
      async () => (await blockedSessionCount()) >= 2,
    );
    await holder.release();

    const [ordered, edited] = await Promise.all([order, edit]);
    expect(ordered.ok && ordered.value.ok).toBe(true);
    expect(edited.ok && edited.value).toEqual({
      ok: false,
      error:
        "この発注は「発注済」のため編集できません（編集できるのは下書きだけです）",
    });
    const after = await getPurchaseOrder(prisma, id);
    expect(after!.status).toBe("ordered");
    expect(after!.lines.map((l) => l.quantity)).toEqual([1]);
  });

  it("C: 商品の無効化が確定するまで作成は待ち、確定後は無効な商品として拒否する", async () => {
    const supplier = await createPartner();
    const product = await createProduct();
    const holder = await hold((tx) =>
      tx.product.update({
        where: { id: product.id },
        data: { isActive: false },
      }),
    );
    const create = settle(
      createPurchaseOrder(
        prisma,
        STAFF,
        input(supplier.id, [[product.id, 1, 10]]),
      ),
    );
    await waitUntil(
      "作成が商品の行のロックを待つ",
      async () => (await sessionsBlockedBy(holder.pid)) >= 1,
    );
    await holder.release();
    const result = await create;
    expect(result.ok && !result.value.ok && result.value.fieldErrors).toEqual({
      "lines.0.productId": [
        `${product.code}「${product.name}」は無効になっているため選べません`,
      ],
    });
  });

  it("D: 作成と在庫の記録が同じ 2 商品で重なってもデッドロックしない（商品のロックは id 順）", async () => {
    const supplier = await createPartner();
    const a = await createProduct();
    const b = await createProduct();
    const [low, high] = a.id < b.id ? [a, b] : [b, a];
    // id の大きい商品を別のトランザクションでロックしておく
    const holder = await hold(
      (tx) =>
        tx.$queryRaw`SELECT "id" FROM "product" WHERE "id" = ${high.id} FOR NO KEY UPDATE`,
    );
    const create = settle(
      createPurchaseOrder(
        prisma,
        STAFF,
        input(supplier.id, [
          [low.id, 1, 10],
          [high.id, 1, 10],
        ]),
      ),
    );
    await waitUntil(
      "作成がロック待ち",
      async () => (await blockedSessionCount()) >= 1,
    );
    const record = settle(
      withStockTransaction(
        prisma,
        (tx) =>
          recordStockMovements(tx, STAFF.id, [
            { productId: low.id, type: "in", quantity: 1 },
            { productId: high.id, type: "in", quantity: 1 },
          ]),
        { timeout: TX_TIMEOUT },
      ),
    );
    await waitUntil(
      "在庫の記録もロック待ち",
      async () => (await blockedSessionCount()) >= 2,
    );
    await holder.release();

    const [created, recorded] = await Promise.all([create, record]);
    expect(created.ok && created.value.ok).toBe(true);
    expect(recorded.ok).toBe(true);
    expect(await getStock(prisma, low.id)).toBe(1);
  });

  it("lockProductsForLines（FOR SHARE）は在庫を記録するトランザクションでは使えない（昇格のデッドロックを防ぐ）", async () => {
    const product = await createProduct();
    await expect(
      withStockTransaction(prisma, (tx) =>
        lockProductsForLines(tx, [product.id]),
      ),
    ).rejects.toThrow("在庫を記録するトランザクションでは使えません");
    // 通常のトランザクションでは使える
    const locked = await prisma.$transaction((tx) =>
      lockProductsForLines(tx, [product.id]),
    );
    expect(locked.get(product.id)?.code).toBe(product.code);
  });
});

describe("取引先の種別変更との競合（取引先の行ロック）", () => {
  it("種別の変更が確定するまで発注の作成は待ち、確定後の種別で判定する", async () => {
    const supplier = await createPartner();
    const product = await createProduct();
    // 種別の変更（取引先の編集）が行をロックして更新し、確定前の状態
    const holder = await hold(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "partner" WHERE "id" = ${supplier.id} FOR NO KEY UPDATE`;
      await tx.partner.update({
        where: { id: supplier.id },
        data: { kind: "customer" },
      });
    });
    const created = settle(
      createPurchaseOrder(
        prisma,
        STAFF,
        input(supplier.id, [[product.id, 1, 10]]),
      ),
    );
    await waitUntil(
      "発注の作成が取引先の行のロックを待つ",
      async () => (await sessionsBlockedBy(holder.pid)) >= 1,
    );
    await holder.release();
    const result = await created;
    expect(result.ok && result.value).toMatchObject({ ok: false });
    expect(
      result.ok &&
        !result.value.ok &&
        result.value.fieldErrors?.supplierId?.[0],
    ).toContain("は仕入先ではありません");
    expect(
      await prisma.purchaseOrder.count({ where: { supplierId: supplier.id } }),
    ).toBe(0);
  });

  it("発注の作成が確定するまで種別の変更は待ち、確定後の発注を数えて拒否する", async () => {
    const supplier = await createPartner();
    const product = await createProduct();
    // 発注の作成が取引先の行を FOR SHARE でロックして発注を書き、確定前の状態
    const holder = await hold(async (tx) => {
      const locked = await lockPartnerForRole(tx, supplier.id, "supplier");
      if (!locked.ok) throw new Error(locked.message);
      await tx.purchaseOrder.create({
        data: {
          number: `${PREFIX}LOCK-${supplier.id}`,
          supplierId: supplier.id,
          orderDate: new Date(`${todayInTokyo()}T00:00:00Z`),
          lines: {
            create: { productId: product.id, quantity: 1, unitPrice: 1 },
          },
          subtotal: 1,
          tax: 0,
          total: 1,
        },
      });
    });
    const updated = settle(
      updatePartner(prisma, STAFF, supplier.id, {
        code: supplier.code,
        name: supplier.name,
        kind: "customer",
        postalCode: "",
        address: "",
        phone: "",
        email: "",
      }),
    );
    await waitUntil(
      "取引先の編集が取引先の行のロックを待つ",
      async () => (await sessionsBlockedBy(holder.pid)) >= 1,
    );
    await holder.release();
    const result = await updated;
    expect(result.ok && result.value).toMatchObject({ ok: false });
    expect(
      result.ok && !result.value.ok && result.value.fieldErrors?.kind?.[0],
    ).toContain("発注（1 件）で使われているため");
    expect(
      (await prisma.partner.findUniqueOrThrow({ where: { id: supplier.id } }))
        .kind,
    ).toBe("supplier");
  });
});

describe("一覧・CSV 出力", () => {
  it("番号・仕入先・ステータス・期間で絞り込み、並べ替える", async () => {
    const supplier = await createPartner();
    const product = await createProduct();
    const small = await createOk(supplier.id, [[product.id, 1, 10]]);
    const large = await createOk(supplier.id, [[product.id, 9, 10]]);
    await statusOk(large.id, "ordered");
    const today = todayInTokyo();
    const base = {
      ...DEFAULT_PURCHASE_ORDER_LIST_PARAMS,
      supplierId: supplier.id,
    };

    const all = await listPurchaseOrders(prisma, {
      ...base,
      sort: "total",
      order: "asc",
    });
    expect(all.items.map((o) => o.number)).toEqual([
      small.number,
      large.number,
    ]);
    expect(all.items[1]).toMatchObject({
      status: "ordered",
      total: 99,
      lineCount: 1,
      supplier: { id: supplier.id, code: supplier.code },
    });

    expect(
      (
        await listPurchaseOrders(prisma, { ...base, status: "ordered" })
      ).items.map((o) => o.id),
    ).toEqual([large.id]);
    expect(
      (
        await listPurchaseOrders(prisma, {
          ...base,
          q: large.number.toLowerCase(),
        })
      ).items.map((o) => o.id),
    ).toEqual([large.id]);
    // % _ は文字として検索する
    expect((await listPurchaseOrders(prisma, { ...base, q: "%" })).total).toBe(
      0,
    );
    expect(
      (await listPurchaseOrders(prisma, { ...base, from: today, to: today }))
        .total,
    ).toBe(2);
    expect(
      (await listPurchaseOrders(prisma, { ...base, to: "2000-01-01" })).total,
    ).toBe(0);
  });

  it("CSV 出力は上限＋1 件を読み、超えたら overLimit（黙って切り捨てない）", async () => {
    const supplier = await createPartner();
    const product = await createProduct();
    await createOk(supplier.id, [[product.id, 1, 10]]);
    await createOk(supplier.id, [[product.id, 1, 10]]);
    const params = {
      ...DEFAULT_PURCHASE_ORDER_LIST_PARAMS,
      supplierId: supplier.id,
    };
    expect(await listPurchaseOrdersForCsv(prisma, params, 2)).toMatchObject({
      overLimit: false,
    });
    const over = await listPurchaseOrdersForCsv(prisma, params, 1);
    expect(over.overLimit).toBe(true);
    expect(over.items).toHaveLength(1);
  });
});

// シードの発注（S- の仕入先）には触れていないことの確認（他のテストファイルのシード件数の確認に影響させない）
it("シードの発注 40 件はそのまま", async () => {
  const { partnerIds } = await testIds();
  expect(
    await prisma.purchaseOrder.count({
      where: { supplierId: { notIn: partnerIds } },
    }),
  ).toBe(40);
});
