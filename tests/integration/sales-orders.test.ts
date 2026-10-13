/**
 * 受注の結合テスト（実 DB = DATABASE_URL_TEST）。docs/spec.md §2〜§4・§7
 * 前提: pnpm db:test:reset でテスト用 DB にマイグレーションとシードを適用済み
 *
 * シードのデータは書き換えない。このファイル専用の取引先・商品（コードが ZS- で始まる）を作り、受注はその顧客で作る。
 * 開始時と終了時に 受注（明細は Cascade）→ 入出庫 → 操作履歴 → 商品・取引先 の順で削除し、
 * 採番テーブル（document_sequence の SO）を残っている受注の番号に合わせる（シードの結合テストが番号と採番表の一致を確かめるため）
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { SessionUser } from "@/lib/auth/session";
import { todayInTokyo } from "@/lib/orders/dates";
import { nextDocumentNumber } from "@/lib/orders/numbering";
import { PARTNER_TARGET_TYPE, updatePartner } from "@/lib/partners/service";
import {
  getSalesOrder,
  listSalesOrders,
  listSalesOrdersForCsv,
} from "@/lib/sales-orders/queries";
import { DEFAULT_SALES_ORDER_LIST_PARAMS } from "@/lib/sales-orders/search-params";
import {
  changeSalesOrderStatus,
  CONFLICT_MESSAGE,
  createSalesOrder,
  SALES_ORDER_STATUS_ACTION,
  SALES_ORDER_TARGET_TYPE,
  STATUS_CONFLICT_MESSAGE,
  updateSalesOrder,
} from "@/lib/sales-orders/service";
import { getStock, getStocks } from "@/lib/stock/movements";
import { listStockMovements } from "@/lib/stock/queries";

import { DEMO_USERS } from "../../prisma/seed-data";
import { connectTestDb, SETUP_HINT } from "./test-db";

let prisma: PrismaClient;

const [ADMIN, STAFF, VIEWER] = DEMO_USERS.map(
  ({ id, name, email, role }): SessionUser => ({ id, name, email, role }),
);
/** 存在しないユーザー（ロールは許可されたもの）。操作履歴・入出庫の外部キー違反で書き込みを失敗させる */
const MISSING_USER: SessionUser = {
  id: "zs-missing-user",
  name: "存在しないユーザー",
  email: "zs-missing@example.com",
  role: "staff",
};

const PREFIX = "ZS-";
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
  const orders = await prisma.salesOrder.findMany({
    where: { customerId: { in: partnerIds } },
    select: { id: true },
  });
  const orderIds = orders.map((o) => o.id);
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
      ],
    },
  });
  await prisma.product.deleteMany({ where: { id: { in: productIds } } });
  await prisma.partner.deleteMany({ where: { id: { in: partnerIds } } });
}

/**
 * 採番テーブル（SO）を、残っている受注の番号に合わせる（日付ごとに最大の連番。受注のない日の行は消す）。
 * シードの採番と同じ状態に戻る。開始時にも実行するので、前回の実行が途中で止まって進んだままでも直る
 */
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

async function createPartner({
  kind = "customer",
  isActive = true,
}: { kind?: "customer" | "supplier" | "both"; isActive?: boolean } = {}) {
  const code = nextCode();
  return prisma.partner.create({
    data: { code, name: `受注テスト取引先 ${code}`, kind, isActive },
  });
}

/** 商品を作る。stock を指定すると、その数を初期在庫（棚卸調整）として記録する */
async function createProduct({
  salesPrice = 100,
  reorderPoint = 0,
  isActive = true,
  stock = 0,
}: {
  salesPrice?: number;
  reorderPoint?: number;
  isActive?: boolean;
  stock?: number;
} = {}) {
  const code = nextCode();
  const product = await prisma.product.create({
    data: {
      code,
      name: `受注テスト商品 ${code}`,
      category: "受注テスト",
      unit: "個",
      salesPrice,
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

type LineSpec = [productId: number, quantity: number, unitPrice: number];

function input(
  customerId: number,
  lines: LineSpec[],
  overrides: Record<string, unknown> = {},
) {
  return {
    customerId: String(customerId),
    dueDate: "",
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
  customerId: number,
  lines: LineSpec[],
  user: SessionUser = STAFF,
) {
  const result = await createSalesOrder(prisma, user, input(customerId, lines));
  if (!result.ok) throw new Error(`作成に失敗: ${JSON.stringify(result)}`);
  return result.data;
}

/** 今の updatedAt（詳細画面に表示した時点の値として送る）。受注がなければ適当な値 */
async function versionOf(id: number): Promise<string> {
  const order = await prisma.salesOrder.findUnique({
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
  return changeSalesOrderStatus(
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

/** 確定済みの受注を作る */
async function createConfirmed(customerId: number, lines: LineSpec[]) {
  const created = await createOk(customerId, lines);
  await statusOk(created.id, "confirmed");
  return created;
}

function auditLogsOf(orderId: number) {
  return prisma.auditLog.findMany({
    where: {
      targetType: SALES_ORDER_TARGET_TYPE,
      targetId: String(orderId),
    },
    orderBy: { id: "asc" },
  });
}

function shipmentsOf(orderId: number) {
  return prisma.stockMovement.findMany({
    where: { refType: "sales_order", refId: orderId },
    orderBy: { productId: "asc" },
  });
}

async function soSequence(date: string): Promise<number> {
  const row = await prisma.documentSequence.findUnique({
    where: {
      kind_date: { kind: "SO", date: new Date(`${date}T00:00:00Z`) },
    },
  });
  return row?.lastNumber ?? 0;
}

// ---------------------------------------------------------------------------
// 同時実行の確認用（tests/integration/purchase-orders.test.ts と同じ方式。固定時間の経過を競合の証拠にしない）
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

/** 受注の行を別のトランザクションでロックし続ける */
function holdOrder(id: number) {
  return hold(
    (tx) =>
      tx.$queryRaw`SELECT "id" FROM "sales_order" WHERE "id" = ${id} FOR NO KEY UPDATE`,
  );
}

// ---------------------------------------------------------------------------

describe("作成", () => {
  it("採番（SO-今日-連番）・受注日・金額（サーバーで計算）・明細・操作履歴", async () => {
    const customer = await createPartner();
    const a = await createProduct();
    const b = await createProduct();
    const today = todayInTokyo();
    const before = await soSequence(today);

    const result = await createSalesOrder(
      prisma,
      STAFF,
      input(
        customer.id,
        [
          [a.id, 3, 333],
          [b.id, 1, 6],
        ],
        // 画面から送られた金額は使わない
        {
          subtotal: "1",
          tax: "0",
          total: "1",
          dueDate: today,
          note: "午前着",
        },
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const expectedNumber = `SO-${today.replaceAll("-", "")}-${String(before + 1).padStart(3, "0")}`;
    expect(result.data.number).toBe(expectedNumber);
    expect(await soSequence(today)).toBe(before + 1);

    const order = await getSalesOrder(prisma, result.data.id);
    expect(order).toMatchObject({
      number: expectedNumber,
      status: "draft",
      customerId: customer.id,
      note: "午前着",
      subtotal: 1005,
      tax: 100,
      total: 1105,
    });
    expect(order!.orderDate.toISOString().slice(0, 10)).toBe(today);
    expect(order!.dueDate!.toISOString().slice(0, 10)).toBe(today);
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

  it("明細の単価は保存時の値で固定（あとで商品の売価を変えても変わらない）", async () => {
    const customer = await createPartner();
    const product = await createProduct({ salesPrice: 100 });
    const { id } = await createOk(customer.id, [[product.id, 2, 100]]);
    await prisma.product.update({
      where: { id: product.id },
      data: { salesPrice: 999 },
    });
    const order = await getSalesOrder(prisma, id);
    expect(order!.lines[0].unitPrice).toBe(100);
    expect(order!.total).toBe(220);
  });

  it("同時に 2 件作成しても番号は重複しない（採番の行のロックで順番待ちになる）", async () => {
    const customer = await createPartner();
    const product = await createProduct();
    const today = todayInTokyo();
    const before = await soSequence(today);

    // 1 本目: 採番だけして確定を待たせる（今日の採番の行をロックしたまま）。最後は取り消すので番号は消費しない
    const holder = await hold((tx) => nextDocumentNumber(tx, "SO", today));
    const results = [1, 2].map(() =>
      settle(
        createSalesOrder(
          prisma,
          STAFF,
          input(customer.id, [[product.id, 1, 10]]),
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
    const prefix = `SO-${today.replaceAll("-", "")}-`;
    expect(new Set(numbers).size).toBe(2);
    expect(numbers.sort()).toEqual([
      `${prefix}${String(before + 1).padStart(3, "0")}`,
      `${prefix}${String(before + 2).padStart(3, "0")}`,
    ]);
    expect(await soSequence(today)).toBe(before + 2);
  });

  it("顧客は種別が customer か both で有効なものだけ", async () => {
    const product = await createProduct();
    const supplier = await createPartner({ kind: "supplier" });
    const inactive = await createPartner({ isActive: false });
    const both = await createPartner({ kind: "both" });
    const count = await prisma.salesOrder.count();

    const asSupplier = await createSalesOrder(
      prisma,
      STAFF,
      input(supplier.id, [[product.id, 1, 10]]),
    );
    expect(asSupplier).toMatchObject({ ok: false });
    expect(!asSupplier.ok && asSupplier.fieldErrors?.customerId?.[0]).toBe(
      `${supplier.code}「${supplier.name}」は顧客ではありません（種別が「顧客」か「顧客・仕入先」の取引先を選んでください）`,
    );
    const asInactive = await createSalesOrder(
      prisma,
      STAFF,
      input(inactive.id, [[product.id, 1, 10]]),
    );
    expect(!asInactive.ok && asInactive.fieldErrors?.customerId?.[0]).toContain(
      "無効になっているため選べません",
    );
    const missing = await createSalesOrder(
      prisma,
      STAFF,
      input(99_999_999, [[product.id, 1, 10]]),
    );
    expect(!missing.ok && missing.fieldErrors?.customerId).toEqual([
      "顧客が見つかりません",
    ]);
    expect(await prisma.salesOrder.count()).toBe(count);

    expect(
      (
        await createSalesOrder(
          prisma,
          STAFF,
          input(both.id, [[product.id, 1, 10]]),
        )
      ).ok,
    ).toBe(true);
  });

  it("無効な商品・存在しない商品は選べない（行ごとのエラー。採番もしない）", async () => {
    const customer = await createPartner();
    const active = await createProduct();
    const inactive = await createProduct({ isActive: false });
    const today = todayInTokyo();
    const before = await soSequence(today);
    const result = await createSalesOrder(
      prisma,
      STAFF,
      input(customer.id, [
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
    expect(await soSequence(today)).toBe(before);
  });

  it("同じ商品の明細の重複は検証エラー", async () => {
    const customer = await createPartner();
    const product = await createProduct();
    const result = await createSalesOrder(
      prisma,
      STAFF,
      input(customer.id, [
        [product.id, 1, 10],
        [product.id, 2, 10],
      ]),
    );
    expect(!result.ok && Object.keys(result.fieldErrors ?? {})).toEqual([
      "lines.1.productId",
    ]);
  });

  it("納期は受注日（今日）以降", async () => {
    const customer = await createPartner();
    const product = await createProduct();
    const result = await createSalesOrder(
      prisma,
      STAFF,
      input(customer.id, [[product.id, 1, 10]], { dueDate: "2000-01-01" }),
    );
    expect(!result.ok && result.fieldErrors?.dueDate?.[0]).toBe(
      `納期は受注日（${todayInTokyo()}）以降の日付にしてください`,
    );
  });

  it("viewer・未ログインは作成できない（何も書かない）", async () => {
    const customer = await createPartner();
    const product = await createProduct();
    const count = await prisma.salesOrder.count();
    expect(
      await createSalesOrder(
        prisma,
        VIEWER,
        input(customer.id, [[product.id, 1, 10]]),
      ),
    ).toEqual({ ok: false, error: "この操作を行う権限がありません" });
    expect(
      await createSalesOrder(
        prisma,
        null,
        input(customer.id, [[product.id, 1, 10]]),
      ),
    ).toEqual({ ok: false, error: "ログインが必要です" });
    expect(await prisma.salesOrder.count()).toBe(count);
  });

  it("操作履歴の保存に失敗したら、受注も採番も取り消される", async () => {
    const customer = await createPartner();
    const product = await createProduct();
    const today = todayInTokyo();
    const before = await soSequence(today);
    const count = await prisma.salesOrder.count();
    await expect(
      createSalesOrder(
        prisma,
        MISSING_USER,
        input(customer.id, [[product.id, 1, 10]]),
      ),
    ).rejects.toThrow();
    expect(await prisma.salesOrder.count()).toBe(count);
    expect(await soSequence(today)).toBe(before);
  });
});

describe("編集", () => {
  it("draft の明細・顧客・納期を変更でき、金額を計算し直して操作履歴に残す", async () => {
    const customer = await createPartner();
    const other = await createPartner({ kind: "both" });
    const a = await createProduct();
    const b = await createProduct();
    const { id } = await createOk(customer.id, [[a.id, 1, 100]]);
    const before = await getSalesOrder(prisma, id);

    const result = await updateSalesOrder(
      prisma,
      ADMIN,
      id,
      input(
        other.id,
        [
          [b.id, 2, 50],
          [a.id, 3, 100],
        ],
        { dueDate: "2099-12-31", total: "1" },
      ),
      before!.updatedAt.toISOString(),
    );
    expect(result).toEqual({ ok: true, data: null });
    const after = await getSalesOrder(prisma, id);
    expect(after).toMatchObject({
      customerId: other.id,
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
    const logs = await auditLogsOf(id);
    expect(logs.map((l) => l.action)).toEqual(["create", "update"]);
    expect(logs[1].summary).toBe(
      `受注 ${before!.number} を更新しました（顧客: ${customer.code} → ${other.code}、納期: （なし） → 2099-12-31、明細: 1 行 → 2 行、合計: 110 → 440 円）`,
    );
  });

  it("画面を開いた後に他の人が更新していたら保存しない（競合）", async () => {
    const customer = await createPartner();
    const product = await createProduct();
    const { id } = await createOk(customer.id, [[product.id, 1, 100]]);
    const opened = await versionOf(id);

    expect(
      (
        await updateSalesOrder(
          prisma,
          STAFF,
          id,
          input(customer.id, [[product.id, 5, 100]]),
          opened,
        )
      ).ok,
    ).toBe(true);
    expect(
      await updateSalesOrder(
        prisma,
        STAFF,
        id,
        input(customer.id, [[product.id, 9, 100]]),
        opened,
      ),
    ).toEqual({ ok: false, error: CONFLICT_MESSAGE, conflict: true });
    expect((await getSalesOrder(prisma, id))!.lines[0].quantity).toBe(5);
    expect(
      await updateSalesOrder(prisma, STAFF, id, input(customer.id, []), "x"),
    ).toMatchObject({ conflict: true });
  });

  it("draft 以外は編集できない", async () => {
    const customer = await createPartner();
    const product = await createProduct();
    const { id } = await createConfirmed(customer.id, [[product.id, 1, 100]]);
    const result = await updateSalesOrder(
      prisma,
      STAFF,
      id,
      input(customer.id, [[product.id, 2, 100]]),
      await versionOf(id),
    );
    expect(result).toEqual({
      ok: false,
      error:
        "この受注は「確定」のため編集できません（編集できるのは下書きだけです）",
    });
    expect((await getSalesOrder(prisma, id))!.lines[0].quantity).toBe(1);
  });

  it("もとからある明細の商品はその後に無効になっても残せる。新しく無効な商品は選べない", async () => {
    const customer = await createPartner();
    const kept = await createProduct();
    const added = await createProduct({ isActive: false });
    const { id } = await createOk(customer.id, [[kept.id, 1, 100]]);
    await prisma.product.update({
      where: { id: kept.id },
      data: { isActive: false },
    });
    const keep = await updateSalesOrder(
      prisma,
      STAFF,
      id,
      input(customer.id, [[kept.id, 4, 100]]),
      await versionOf(id),
    );
    expect(keep.ok).toBe(true);
    const add = await updateSalesOrder(
      prisma,
      STAFF,
      id,
      input(customer.id, [
        [kept.id, 4, 100],
        [added.id, 1, 100],
      ]),
      await versionOf(id),
    );
    expect(!add.ok && Object.keys(add.fieldErrors ?? {})).toEqual([
      "lines.1.productId",
    ]);
  });

  it("顧客が無効・種別違いになったら保存できない", async () => {
    const customer = await createPartner();
    const supplier = await createPartner({ kind: "supplier" });
    const product = await createProduct();
    const { id } = await createOk(customer.id, [[product.id, 1, 100]]);
    const toSupplier = await updateSalesOrder(
      prisma,
      STAFF,
      id,
      input(supplier.id, [[product.id, 1, 100]]),
      await versionOf(id),
    );
    expect(!toSupplier.ok && toSupplier.fieldErrors?.customerId?.[0]).toContain(
      "は顧客ではありません",
    );
    await prisma.partner.update({
      where: { id: customer.id },
      data: { isActive: false },
    });
    const result = await updateSalesOrder(
      prisma,
      STAFF,
      id,
      input(customer.id, [[product.id, 2, 100]]),
      await versionOf(id),
    );
    expect(!result.ok && result.fieldErrors?.customerId?.[0]).toContain("無効");
  });

  it("viewer は編集できない。操作履歴の保存に失敗したら明細も元のまま", async () => {
    const customer = await createPartner();
    const product = await createProduct();
    const { id } = await createOk(customer.id, [[product.id, 1, 100]]);
    const opened = await versionOf(id);
    expect(
      await updateSalesOrder(
        prisma,
        VIEWER,
        id,
        input(customer.id, [[product.id, 2, 100]]),
        opened,
      ),
    ).toEqual({ ok: false, error: "この操作を行う権限がありません" });
    await expect(
      updateSalesOrder(
        prisma,
        MISSING_USER,
        id,
        input(customer.id, [[product.id, 3, 100]]),
        opened,
      ),
    ).rejects.toThrow();
    const order = await getSalesOrder(prisma, id);
    expect(order!.lines.map((l) => l.quantity)).toEqual([1]);
    expect(order!.total).toBe(110);
    expect(await auditLogsOf(id)).toHaveLength(1);
  });
});

describe("ステータス遷移", () => {
  it("明細が 0 行の draft は confirmed にできない", async () => {
    const customer = await createPartner();
    const { id } = await createOk(customer.id, []);
    expect(await changeStatus(STAFF, id, "confirmed")).toEqual({
      ok: false,
      error: "明細が 1 行もないため、確定にできません",
    });
    expect((await getSalesOrder(prisma, id))!.status).toBe("draft");
  });

  it("draft → confirmed → shipped で全明細の在庫が減り、入出庫に受注の参照が残る。発注点割れに変わった商品を返す", async () => {
    const customer = await createPartner();
    const a = await createProduct({ stock: 10, reorderPoint: 5 });
    const b = await createProduct({ stock: 30, reorderPoint: 5 });
    const { id, number } = await createOk(customer.id, [
      [b.id, 20, 100],
      [a.id, 7, 100],
    ]);

    expect(await statusOk(id, "confirmed")).toMatchObject({
      from: "draft",
      to: "confirmed",
      shippedLines: 0,
      fellBelowReorderPoint: [],
    });
    // confirmed の時点では在庫は変わらない
    expect(Object.fromEntries(await getStocks(prisma, [a.id, b.id]))).toEqual({
      [a.id]: 10,
      [b.id]: 30,
    });
    expect(await statusOk(id, "shipped")).toEqual({
      number,
      from: "confirmed",
      to: "shipped",
      shippedLines: 2,
      // a は 10 → 3 で発注点（5）を下回った。b は 30 → 10 で発注点以上のまま
      fellBelowReorderPoint: [
        {
          productId: a.id,
          code: a.code,
          name: a.name,
          unit: "個",
          reorderPoint: 5,
          before: 10,
          after: 3,
        },
      ],
    });

    expect(await getStock(prisma, a.id)).toBe(3);
    expect(await getStock(prisma, b.id)).toBe(10);
    const movements = await shipmentsOf(id);
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
        { productId: a.id, quantity: -7 },
        { productId: b.id, quantity: -20 },
      ]
        .sort((x, y) => x.productId - y.productId)
        .map((m) => ({
          ...m,
          type: "out",
          reason: `受注 ${number} の出荷`,
          userId: STAFF.id,
        })),
    );
    // 入出庫履歴の参照に受注番号が出る（画面では受注の詳細へのリンクになる）
    const history = await listStockMovements(prisma, a.id, 1);
    expect(history.items[0].ref).toEqual({ type: "sales_order", id, number });

    const logs = await auditLogsOf(id);
    expect(logs.map((l) => [l.action, l.summary])).toEqual([
      ["create", expect.any(String)],
      [
        SALES_ORDER_STATUS_ACTION,
        `受注 ${number} のステータスを「下書き」から「確定」に変更しました`,
      ],
      [
        SALES_ORDER_STATUS_ACTION,
        `受注 ${number} のステータスを「確定」から「出荷済」に変更しました（出庫 2 品目）`,
      ],
    ]);
  });

  it("在庫が 1 行でも足りなければ全体を中止する（他の行も記録せず、状態は confirmed のまま）。不足する商品と数量を返す", async () => {
    const customer = await createPartner();
    const enough = await createProduct({ stock: 50 });
    const short = await createProduct({ stock: 3 });
    const { id } = await createConfirmed(customer.id, [
      [enough.id, 10, 100],
      [short.id, 5, 100],
    ]);
    const shown = await versionOf(id);

    const result = await changeStatus(STAFF, id, "shipped", shown);
    expect(result).toEqual({
      ok: false,
      error:
        "在庫が足りない商品が 1 品目あるため、出荷しませんでした（在庫・ステータスは変わっていません）",
      shortages: [
        {
          productId: short.id,
          code: short.code,
          name: short.name,
          unit: "個",
          available: 3,
          required: 5,
          shortage: 2,
        },
      ],
    });
    // 足りている行も出庫していない。状態・updatedAt・操作履歴も変わらない
    expect(await getStock(prisma, enough.id)).toBe(50);
    expect(await getStock(prisma, short.id)).toBe(3);
    expect(await shipmentsOf(id)).toEqual([]);
    expect((await getSalesOrder(prisma, id))!.status).toBe("confirmed");
    expect(await versionOf(id)).toBe(shown);
    expect(
      (await auditLogsOf(id)).filter((l) => l.summary.includes("出荷済")),
    ).toHaveLength(0);

    // 在庫を補充すれば、同じ画面のまま出荷できる
    await prisma.stockMovement.create({
      data: { productId: short.id, type: "adjust", quantity: 2 },
    });
    expect((await changeStatus(STAFF, id, "shipped", shown)).ok).toBe(true);
    expect(await getStock(prisma, enough.id)).toBe(40);
    expect(await getStock(prisma, short.id)).toBe(0);
  });

  it("出荷時に商品が無効になっていても出荷できる（無効の制限は新規の受注で選べないことだけ）", async () => {
    const customer = await createPartner();
    const product = await createProduct({ stock: 5 });
    const { id } = await createConfirmed(customer.id, [[product.id, 5, 100]]);
    await prisma.product.update({
      where: { id: product.id },
      data: { isActive: false },
    });
    expect((await changeStatus(STAFF, id, "shipped")).ok).toBe(true);
    expect(await getStock(prisma, product.id)).toBe(0);
  });

  it("draft／confirmed → cancelled。cancelled・shipped の後はどこへも遷移できない", async () => {
    const customer = await createPartner();
    const product = await createProduct({ stock: 10 });
    const draft = await createOk(customer.id, [[product.id, 1, 10]]);
    expect(await statusOk(draft.id, "cancelled")).toMatchObject({
      from: "draft",
      to: "cancelled",
    });
    for (const to of ["confirmed", "shipped", "cancelled"]) {
      expect(await changeStatus(STAFF, draft.id, to)).toEqual({
        ok: false,
        error: "この受注は「取消」のため、ステータスを変更できません",
      });
    }

    const confirmed = await createConfirmed(customer.id, [[product.id, 1, 10]]);
    await statusOk(confirmed.id, "cancelled");
    // 取消では在庫は変わらない。取り消した受注は出荷できない
    expect(await changeStatus(STAFF, confirmed.id, "shipped")).toEqual({
      ok: false,
      error: "この受注は「取消」のため、ステータスを変更できません",
    });
    expect(await getStock(prisma, product.id)).toBe(10);

    const shipped = await createConfirmed(customer.id, [[product.id, 2, 10]]);
    await statusOk(shipped.id, "shipped");
    expect(await changeStatus(STAFF, shipped.id, "cancelled")).toEqual({
      ok: false,
      error: "この受注は「出荷済」のため、ステータスを変更できません",
    });
    // draft から shipped への飛び越しも不可
    const skip = await createOk(customer.id, [[product.id, 1, 10]]);
    expect(await changeStatus(STAFF, skip.id, "shipped")).toEqual({
      ok: false,
      error: "「下書き」から「出荷済」には変更できません",
    });
    expect(await getStock(prisma, product.id)).toBe(8);
  });

  it("変更先が正しくない・受注がない・int の範囲外・viewer はエラー", async () => {
    const customer = await createPartner();
    const product = await createProduct();
    const { id } = await createOk(customer.id, [[product.id, 1, 10]]);
    for (const to of ["draft", "received", 1, null]) {
      expect(await changeStatus(STAFF, id, to)).toEqual({
        ok: false,
        error: "変更先のステータスが正しくありません",
      });
    }
    for (const missing of [99_999_999, 2 ** 40]) {
      for (const to of ["confirmed", "shipped"]) {
        expect(
          await changeStatus(STAFF, missing, to, new Date().toISOString()),
        ).toEqual({ ok: false, error: "受注が見つかりません" });
      }
    }
    expect(
      await updateSalesOrder(
        prisma,
        STAFF,
        2 ** 40,
        input(customer.id, [[product.id, 1, 10]]),
        new Date().toISOString(),
      ),
    ).toEqual({ ok: false, error: "受注が見つかりません" });
    expect(await changeStatus(VIEWER, id, "confirmed")).toEqual({
      ok: false,
      error: "この操作を行う権限がありません",
    });
    expect(await changeStatus(null, id, "confirmed")).toEqual({
      ok: false,
      error: "ログインが必要です",
    });
    expect((await getSalesOrder(prisma, id))!.status).toBe("draft");
  });

  it("viewer は出荷できない（在庫も変わらない）", async () => {
    const customer = await createPartner();
    const product = await createProduct({ stock: 5 });
    const { id } = await createConfirmed(customer.id, [[product.id, 5, 10]]);
    expect(await changeStatus(VIEWER, id, "shipped")).toEqual({
      ok: false,
      error: "この操作を行う権限がありません",
    });
    expect((await getSalesOrder(prisma, id))!.status).toBe("confirmed");
    expect(await getStock(prisma, product.id)).toBe(5);
  });

  it("途中で失敗したら全体が取り消される（存在しないユーザーで入出庫・操作履歴の外部キー違反）", async () => {
    const customer = await createPartner();
    const product = await createProduct({ stock: 5 });
    const { id } = await createOk(customer.id, [[product.id, 5, 10]]);
    await expect(changeStatus(MISSING_USER, id, "confirmed")).rejects.toThrow();
    expect((await getSalesOrder(prisma, id))!.status).toBe("draft");

    await statusOk(id, "confirmed");
    await expect(changeStatus(MISSING_USER, id, "shipped")).rejects.toThrow();
    expect((await getSalesOrder(prisma, id))!.status).toBe("confirmed");
    expect(await getStock(prisma, product.id)).toBe(5);
    expect(await shipmentsOf(id)).toEqual([]);
    expect(await auditLogsOf(id)).toHaveLength(2);
  });
});

describe("ステータス変更の競合（詳細画面に表示した時点の updatedAt）", () => {
  it("表示した後に明細が編集されていたら確定しない。最新を表示し直せば変更できる", async () => {
    const customer = await createPartner();
    const product = await createProduct();
    const { id } = await createOk(customer.id, [[product.id, 1, 100]]);
    const shown = await versionOf(id);
    expect(
      (
        await updateSalesOrder(
          prisma,
          STAFF,
          id,
          input(customer.id, [[product.id, 9, 100]]),
          shown,
        )
      ).ok,
    ).toBe(true);
    expect(await changeStatus(STAFF, id, "confirmed", shown)).toEqual({
      ok: false,
      error: STATUS_CONFLICT_MESSAGE,
      conflict: true,
    });
    expect(await changeStatus(STAFF, id, "cancelled", shown)).toMatchObject({
      conflict: true,
    });
    expect((await getSalesOrder(prisma, id))!.status).toBe("draft");
    expect((await changeStatus(STAFF, id, "confirmed")).ok).toBe(true);
  });

  it("出荷も、表示した後に更新されていたら出庫しない。形式の違う値も競合", async () => {
    const customer = await createPartner();
    const product = await createProduct({ stock: 10 });
    const { id } = await createConfirmed(customer.id, [[product.id, 4, 100]]);
    const shown = await versionOf(id);
    await prisma.salesOrder.update({
      where: { id },
      data: { note: "別の更新" },
    });
    expect(await changeStatus(STAFF, id, "shipped", shown)).toEqual({
      ok: false,
      error: STATUS_CONFLICT_MESSAGE,
      conflict: true,
    });
    for (const version of ["x", undefined, 0]) {
      expect(
        await changeSalesOrderStatus(prisma, STAFF, id, "shipped", version),
      ).toMatchObject({ conflict: true });
    }
    expect((await getSalesOrder(prisma, id))!.status).toBe("confirmed");
    expect(await getStock(prisma, product.id)).toBe(10);
    expect((await changeStatus(STAFF, id, "shipped")).ok).toBe(true);
    expect(await getStock(prisma, product.id)).toBe(6);
  });
});

describe("出荷の同時実行", () => {
  it("同じ受注を同時に 2 回出荷しても出庫は 1 回だけ（条件付き更新で二重出荷を防ぐ）", async () => {
    const customer = await createPartner();
    const a = await createProduct({ stock: 20 });
    const b = await createProduct({ stock: 20 });
    const { id } = await createConfirmed(customer.id, [
      [a.id, 7, 100],
      [b.id, 4, 100],
    ]);
    const shown = await versionOf(id);

    // 受注の行を別のトランザクションでロックし、2 本の出荷をその後ろで待たせてから同時に走らせる
    const holder = await holdOrder(id);
    const results = [1, 2].map(() =>
      settle(changeStatus(STAFF, id, "shipped", shown)),
    );
    // 同じ行を待つ 2 本目は、PostgreSQL では 1 本目の待ちの後ろに並ぶ（待つ相手は 1 本目になる）
    await waitUntil(
      "2 本の出荷がロック待ち",
      async () =>
        (await sessionsBlockedBy(holder.pid)) >= 1 &&
        (await blockedSessionCount()) >= 2,
    );
    await holder.release();

    const values = (await Promise.all(results)).map((r) => {
      if (!r.ok) throw r.error;
      return r.value;
    });
    expect(values.filter((v) => v.ok)).toHaveLength(1);
    expect(values.filter((v) => !v.ok)).toEqual([
      {
        ok: false,
        error: "この受注は「出荷済」のため、ステータスを変更できません",
      },
    ]);
    expect(await getStock(prisma, a.id)).toBe(13);
    expect(await getStock(prisma, b.id)).toBe(16);
    expect(await shipmentsOf(id)).toHaveLength(2);
    expect(
      (await auditLogsOf(id)).filter((l) => l.summary.includes("出荷済")),
    ).toHaveLength(1);
  });

  it("別々の受注が同じ商品を同時に出荷しても在庫は負にならない（後の出荷は先の出庫を含めた在庫で判定して中止）", async () => {
    const customer = await createPartner();
    const product = await createProduct({ stock: 10 });
    const first = await createConfirmed(customer.id, [[product.id, 7, 100]]);
    const second = await createConfirmed(customer.id, [[product.id, 6, 100]]);
    const versions = [await versionOf(first.id), await versionOf(second.id)];

    // 商品の行を別のトランザクションでロックし、2 本の出荷がその解放を待つ状態にしてから同時に進める
    const holder = await hold(
      (tx) =>
        tx.$queryRaw`SELECT "id" FROM "product" WHERE "id" = ${product.id} FOR NO KEY UPDATE`,
    );
    const results = [first.id, second.id].map((id, i) =>
      settle(changeStatus(STAFF, id, "shipped", versions[i])),
    );
    await waitUntil(
      "2 本の出荷が商品の行のロック待ち",
      async () =>
        (await sessionsBlockedBy(holder.pid)) >= 1 &&
        (await blockedSessionCount()) >= 2,
    );
    await holder.release();

    const values = (await Promise.all(results)).map((r) => {
      if (!r.ok) throw r.error;
      return r.value;
    });
    // どちらか一方だけが出荷され、もう一方は残りの在庫（10 − 先の出荷数）で不足と判定される
    expect(values.filter((v) => v.ok)).toHaveLength(1);
    const winner = values[0].ok ? 0 : 1;
    const loser = 1 - winner;
    const quantities = [7, 6];
    const remaining = 10 - quantities[winner];
    expect(values[loser]).toMatchObject({
      ok: false,
      shortages: [
        {
          productId: product.id,
          available: remaining,
          required: quantities[loser],
          shortage: quantities[loser] - remaining,
        },
      ],
    });
    expect(await getStock(prisma, product.id)).toBe(remaining);
    const orders = [first.id, second.id];
    expect((await getSalesOrder(prisma, orders[winner]))!.status).toBe(
      "shipped",
    );
    expect((await getSalesOrder(prisma, orders[loser]))!.status).toBe(
      "confirmed",
    );
    expect(await shipmentsOf(orders[loser])).toEqual([]);
  });

  it("出荷と取消が同時でも、先に確定した出荷だけが通り、在庫は 1 回だけ減る", async () => {
    const customer = await createPartner();
    const product = await createProduct({ stock: 10 });
    const { id } = await createConfirmed(customer.id, [[product.id, 5, 10]]);
    const shown = await versionOf(id);

    const holder = await holdOrder(id);
    const ship = settle(changeStatus(STAFF, id, "shipped", shown));
    await waitUntil(
      "出荷がロック待ち",
      async () => (await blockedSessionCount()) >= 1,
    );
    const cancel = settle(changeStatus(STAFF, id, "cancelled", shown));
    await waitUntil(
      "取消もロック待ち",
      async () => (await blockedSessionCount()) >= 2,
    );
    await holder.release();

    const [shipped, cancelled] = await Promise.all([ship, cancel]);
    expect(shipped.ok && shipped.value.ok).toBe(true);
    expect(cancelled.ok && cancelled.value).toEqual({
      ok: false,
      error: "この受注は「出荷済」のため、ステータスを変更できません",
    });
    expect((await getSalesOrder(prisma, id))!.status).toBe("shipped");
    expect(await getStock(prisma, product.id)).toBe(5);
  });

  it("明細を 0 行にする編集が先に確定したら、待っていた確定への変更は通らない", async () => {
    const customer = await createPartner();
    const product = await createProduct();
    const { id } = await createOk(customer.id, [[product.id, 1, 10]]);
    const shown = await versionOf(id);

    const holder = await holdOrder(id);
    const edit = settle(
      updateSalesOrder(prisma, STAFF, id, input(customer.id, []), shown),
    );
    await waitUntil(
      "編集がロック待ち",
      async () => (await blockedSessionCount()) >= 1,
    );
    const confirm = settle(changeStatus(STAFF, id, "confirmed", shown));
    await waitUntil(
      "確定への変更もロック待ち",
      async () => (await blockedSessionCount()) >= 2,
    );
    await holder.release();

    const [edited, confirmed] = await Promise.all([edit, confirm]);
    expect(edited.ok && edited.value.ok).toBe(true);
    expect(confirmed.ok && confirmed.value.ok).toBe(false);
    const after = await getSalesOrder(prisma, id);
    expect(after!.status).toBe("draft");
    expect(after!.lines).toHaveLength(0);
  });

  it("確定への変更が先に確定したら、待っていた編集は明細を書き換えない", async () => {
    const customer = await createPartner();
    const product = await createProduct();
    const { id } = await createOk(customer.id, [[product.id, 1, 10]]);
    const shown = await versionOf(id);

    const holder = await holdOrder(id);
    const confirm = settle(changeStatus(STAFF, id, "confirmed", shown));
    await waitUntil(
      "確定への変更がロック待ち",
      async () => (await blockedSessionCount()) >= 1,
    );
    const edit = settle(
      updateSalesOrder(
        prisma,
        STAFF,
        id,
        input(customer.id, [[product.id, 9, 10]]),
        shown,
      ),
    );
    await waitUntil(
      "編集もロック待ち",
      async () => (await blockedSessionCount()) >= 2,
    );
    await holder.release();

    const [confirmed, edited] = await Promise.all([confirm, edit]);
    expect(confirmed.ok && confirmed.value.ok).toBe(true);
    expect(edited.ok && edited.value).toEqual({
      ok: false,
      error:
        "この受注は「確定」のため編集できません（編集できるのは下書きだけです）",
    });
    const after = await getSalesOrder(prisma, id);
    expect(after!.status).toBe("confirmed");
    expect(after!.lines.map((l) => l.quantity)).toEqual([1]);
  });
});

describe("取引先の種別変更との競合（取引先の行ロック）", () => {
  it("受注の作成が確定するまで種別の変更は待ち、確定後の受注を数えて拒否する", async () => {
    const customer = await createPartner();
    const product = await createProduct();
    // 受注の作成（顧客の行を FOR SHARE でロックしてから受注を書く）を、確定前の状態で止める
    const holder = await hold(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "partner" WHERE "id" = ${customer.id} FOR SHARE`;
      await tx.salesOrder.create({
        data: {
          number: `${PREFIX}LOCK-${customer.id}`,
          customerId: customer.id,
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
      updatePartner(prisma, STAFF, customer.id, {
        code: customer.code,
        name: customer.name,
        kind: "supplier",
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
    expect(
      result.ok && !result.value.ok && result.value.fieldErrors?.kind?.[0],
    ).toContain("受注（1 件）で使われているため");
    expect(
      (await prisma.partner.findUniqueOrThrow({ where: { id: customer.id } }))
        .kind,
    ).toBe("customer");
  });
});

describe("一覧・CSV 出力", () => {
  it("番号・顧客・ステータス・期間で絞り込み、並べ替える", async () => {
    const customer = await createPartner();
    const product = await createProduct();
    const small = await createOk(customer.id, [[product.id, 1, 10]]);
    const large = await createConfirmed(customer.id, [[product.id, 9, 10]]);
    const today = todayInTokyo();
    const base = {
      ...DEFAULT_SALES_ORDER_LIST_PARAMS,
      customerId: customer.id,
    };

    const all = await listSalesOrders(prisma, {
      ...base,
      sort: "total",
      order: "asc",
    });
    expect(all.items.map((o) => o.number)).toEqual([
      small.number,
      large.number,
    ]);
    expect(all.items[1]).toMatchObject({
      status: "confirmed",
      total: 99,
      lineCount: 1,
      customer: { id: customer.id, code: customer.code },
    });
    expect(
      (
        await listSalesOrders(prisma, { ...base, status: "confirmed" })
      ).items.map((o) => o.id),
    ).toEqual([large.id]);
    expect(
      (
        await listSalesOrders(prisma, {
          ...base,
          q: large.number.toLowerCase(),
        })
      ).items.map((o) => o.id),
    ).toEqual([large.id]);
    // % _ は文字として検索する
    expect((await listSalesOrders(prisma, { ...base, q: "%" })).total).toBe(0);
    expect(
      (await listSalesOrders(prisma, { ...base, from: today, to: today }))
        .total,
    ).toBe(2);
    expect(
      (await listSalesOrders(prisma, { ...base, to: "2000-01-01" })).total,
    ).toBe(0);
  });

  it("CSV 出力は上限＋1 件を読み、超えたら overLimit（黙って切り捨てない）", async () => {
    const customer = await createPartner();
    const product = await createProduct();
    await createOk(customer.id, [[product.id, 1, 10]]);
    await createOk(customer.id, [[product.id, 1, 10]]);
    const params = {
      ...DEFAULT_SALES_ORDER_LIST_PARAMS,
      customerId: customer.id,
    };
    expect(await listSalesOrdersForCsv(prisma, params, 2)).toMatchObject({
      overLimit: false,
    });
    const over = await listSalesOrdersForCsv(prisma, params, 1);
    expect(over.overLimit).toBe(true);
    expect(over.items).toHaveLength(1);
  });
});

// シードの受注（C- の顧客）には触れていないことの確認（他のテストファイルのシード件数の確認に影響させない）
it("シードの受注 80 件はそのまま", async () => {
  const { partnerIds } = await testIds();
  expect(
    await prisma.salesOrder.count({
      where: { customerId: { notIn: partnerIds } },
    }),
  ).toBe(80);
});
