/**
 * シードデータの不変条件（docs/spec.md §3・§4・§9）を実 DB で確認する。
 * 前提: pnpm db:test:reset でテスト用 DB にマイグレーションとシードを適用済み
 */
import { verifyPassword } from "better-auth/crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";
import { calcTax } from "@/lib/tax";

import { APP_TABLES } from "../../prisma/app-tables";
import { DEMO_PASSWORD } from "../../prisma/seed-data";
import { connectTestDb, SETUP_HINT } from "./test-db";

let prisma: PrismaClient;

beforeAll(async () => {
  prisma = await connectTestDb();
  if ((await prisma.product.count()) === 0) {
    throw new Error(`テスト用 DB にシードが入っていません。${SETUP_HINT}`);
  }
});

afterAll(async () => {
  await prisma?.$disconnect();
});

/** 伝票 ID → 「商品 ID:数量」の並び（比較用） */
function lineKeys(lines: { productId: number; quantity: number }[]): string[] {
  return lines.map((l) => `${l.productId}:${l.quantity}`).sort();
}

describe("スキーマ", () => {
  it("シードが空にするテーブルの一覧（prisma/app-tables.ts）が、マイグレーション後のテーブルと一致する", async () => {
    const tables = await prisma.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = current_schema() AND tablename <> '_prisma_migrations'`;
    expect(tables.map((t) => t.tablename).sort()).toEqual(
      [...APP_TABLES].sort(),
    );
  });
});

describe("シードの件数", () => {
  it("商品 50・取引先 20（顧客 12・仕入先 8）・受注 80・発注 40", async () => {
    expect(await prisma.product.count()).toBe(50);
    expect(await prisma.partner.count()).toBe(20);
    expect(await prisma.partner.count({ where: { kind: "customer" } })).toBe(
      12,
    );
    expect(await prisma.partner.count({ where: { kind: "supplier" } })).toBe(8);
    expect(await prisma.salesOrder.count()).toBe(80);
    expect(await prisma.purchaseOrder.count()).toBe(40);
    expect(await prisma.stockMovement.count()).toBeGreaterThan(0);
  });

  it("デモユーザーは admin / staff / viewer の 3 人で、Better Auth の credential アカウントを持つ", async () => {
    const users = await prisma.user.findMany({
      include: { accounts: true },
      orderBy: { email: "asc" },
    });
    expect(users.map((u) => u.role).sort()).toEqual([
      "admin",
      "staff",
      "viewer",
    ]);
    for (const user of users) {
      expect(user.isActive).toBe(true);
      expect(user.email).toMatch(/@example\.com$/);
      expect(user.accounts).toHaveLength(1);
      const [account] = user.accounts;
      expect(account.providerId).toBe("credential");
      expect(account.accountId).toBe(user.id);
      // Better Auth と同じ方式（better-auth/crypto）で検証できるハッシュであること
      expect(
        await verifyPassword({
          hash: account.password!,
          password: DEMO_PASSWORD,
        }),
      ).toBe(true);
    }
  });
});

describe("在庫", () => {
  it("入出庫を時系列で累積して、どの時点でも全商品の在庫が 0 以上", async () => {
    const movements = await prisma.stockMovement.findMany({
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const stock = new Map<number, number>();
    for (const m of movements) {
      const next = (stock.get(m.productId) ?? 0) + m.quantity;
      expect(
        next,
        `商品 ${m.productId} の在庫が入出庫 ${m.id} の時点で負になる`,
      ).toBeGreaterThanOrEqual(0);
      stock.set(m.productId, next);
    }
    expect(stock.size).toBe(50);
  });

  it("入出庫の日時は現在より過去", async () => {
    const latest = await prisma.stockMovement.aggregate({
      _max: { createdAt: true },
    });
    expect(latest._max.createdAt!.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("発注点を下回る商品が 1 件以上ある（ダッシュボード・通知の確認用）", async () => {
    const products = await prisma.product.findMany({
      where: { isActive: true },
    });
    const totals = await prisma.stockMovement.groupBy({
      by: ["productId"],
      _sum: { quantity: true },
    });
    const stockOf = new Map(
      totals.map((t) => [t.productId, t._sum.quantity ?? 0]),
    );
    const belowReorderPoint = products.filter(
      (p) => (stockOf.get(p.id) ?? 0) < p.reorderPoint,
    );
    expect(belowReorderPoint.length).toBeGreaterThanOrEqual(1);
  });
});

describe("受注・発注と入出庫の対応", () => {
  it("出荷済みの受注は明細どおりの出庫を持ち、それ以外の受注は出庫を持たない", async () => {
    const orders = await prisma.salesOrder.findMany({
      include: { lines: true },
    });
    const outs = await prisma.stockMovement.findMany({
      where: { type: "out" },
    });
    expect(
      outs.every((m) => m.refType === "sales_order" && m.refId !== null),
    ).toBe(true);

    const outsByOrder = Map.groupBy(outs, (m) => m.refId!);
    for (const order of orders) {
      const movements = outsByOrder.get(order.id) ?? [];
      if (order.status === "shipped") {
        expect(
          lineKeys(movements.map((m) => ({ ...m, quantity: -m.quantity }))),
        ).toEqual(lineKeys(order.lines));
      } else {
        expect(
          movements,
          `${order.number}（${order.status}）に出庫がある`,
        ).toHaveLength(0);
      }
    }
    expect(orders.some((o) => o.status === "shipped")).toBe(true);
  });

  it("入荷済みの発注は明細どおりの入庫を持ち、それ以外の発注は入庫を持たない", async () => {
    const orders = await prisma.purchaseOrder.findMany({
      include: { lines: true },
    });
    const ins = await prisma.stockMovement.findMany({ where: { type: "in" } });
    expect(
      ins.every((m) => m.refType === "purchase_order" && m.refId !== null),
    ).toBe(true);

    const insByOrder = Map.groupBy(ins, (m) => m.refId!);
    for (const order of orders) {
      const movements = insByOrder.get(order.id) ?? [];
      if (order.status === "received") {
        expect(lineKeys(movements)).toEqual(lineKeys(order.lines));
      } else {
        expect(
          movements,
          `${order.number}（${order.status}）に入庫がある`,
        ).toHaveLength(0);
      }
    }
    expect(orders.some((o) => o.status === "received")).toBe(true);
    expect(orders.some((o) => o.status === "ordered")).toBe(true);
  });

  it("全入出庫の参照先（refType＋refId）が実在する伝票を指す（孤立参照がない）", async () => {
    const salesIds = new Set(
      (await prisma.salesOrder.findMany({ select: { id: true } })).map(
        (o) => o.id,
      ),
    );
    const purchaseIds = new Set(
      (await prisma.purchaseOrder.findMany({ select: { id: true } })).map(
        (o) => o.id,
      ),
    );
    const movements = await prisma.stockMovement.findMany();
    for (const m of movements) {
      const where = `入出庫 ${m.id}（${m.type}, ${m.refType}:${m.refId}）`;
      if (m.type === "out") {
        expect(m.refType, where).toBe("sales_order");
        expect(salesIds.has(m.refId!), where).toBe(true);
      } else if (m.type === "in") {
        expect(m.refType, where).toBe("purchase_order");
        expect(purchaseIds.has(m.refId!), where).toBe(true);
      } else {
        expect([m.refType, m.refId], where).toEqual([null, null]);
      }
    }
  });
});

describe("伝票", () => {
  it("受注・発注の小計・税・合計が明細から計算した値と一致する", async () => {
    const orders = [
      ...(await prisma.salesOrder.findMany({ include: { lines: true } })),
      ...(await prisma.purchaseOrder.findMany({ include: { lines: true } })),
    ];
    for (const order of orders) {
      expect(
        order.lines.length,
        `${order.number} に明細がない`,
      ).toBeGreaterThan(0);
      const subtotal = order.lines.reduce(
        (sum, l) => sum + l.quantity * l.unitPrice,
        0,
      );
      expect(
        { subtotal: order.subtotal, tax: order.tax, total: order.total },
        order.number,
      ).toEqual({
        subtotal,
        tax: calcTax(subtotal),
        total: subtotal + calcTax(subtotal),
      });
    }
  });

  it("伝票番号は種別-受注日-連番で、採番テーブルの最終番号と一致する", async () => {
    const sales = await prisma.salesOrder.findMany();
    const purchases = await prisma.purchaseOrder.findMany();
    const lastNumbers = new Map<string, number>();
    for (const [kind, orders] of [
      ["SO", sales],
      ["PO", purchases],
    ] as const) {
      for (const order of orders) {
        const ymd = order.orderDate
          .toISOString()
          .slice(0, 10)
          .replaceAll("-", "");
        const match = order.number.match(
          new RegExp(`^${kind}-${ymd}-(\\d{3})$`),
        );
        expect(match, order.number).not.toBeNull();
        const key = `${kind}:${ymd}`;
        lastNumbers.set(
          key,
          Math.max(lastNumbers.get(key) ?? 0, Number(match![1])),
        );
      }
    }
    const sequences = await prisma.documentSequence.findMany();
    expect(
      new Map(
        sequences.map((s) => [
          `${s.kind}:${s.date.toISOString().slice(0, 10).replaceAll("-", "")}`,
          s.lastNumber,
        ]),
      ),
    ).toEqual(lastNumbers);
  });

  it("受注の顧客は customer／both、発注の仕入先は supplier／both", async () => {
    const sales = await prisma.salesOrder.findMany({
      include: { customer: true },
    });
    const purchases = await prisma.purchaseOrder.findMany({
      include: { supplier: true },
    });
    expect(sales.every((o) => o.customer.kind !== "supplier")).toBe(true);
    expect(purchases.every((o) => o.supplier.kind !== "customer")).toBe(true);
  });

  it("シード基準月（最新の受注日の月）に確定・出荷済みの受注がある（ダッシュボードの「今月」の確認用）", async () => {
    // テストの実行日ではなく DB の最新の受注日（= シード実行日）を基準にし、月をまたいでも落ちないようにする
    const latest = await prisma.salesOrder.aggregate({
      _max: { orderDate: true },
    });
    const seedMonth = latest._max.orderDate!.toISOString().slice(0, 7);
    const orders = await prisma.salesOrder.findMany({
      where: { status: { in: ["confirmed", "shipped"] } },
    });
    expect(
      orders.some((o) => o.orderDate.toISOString().startsWith(seedMonth)),
    ).toBe(true);
  });
});

describe("架空データ", () => {
  it("取引先は名前に「デモ」か「サンプル」を含み、連絡先は実在しない形式", async () => {
    const partners = await prisma.partner.findMany();
    for (const p of partners) {
      expect(p.name).toMatch(/デモ|サンプル/);
      expect(p.email).toMatch(/@example\.(com|jp)$/);
      expect(p.phone).toMatch(/^000-/);
      expect(p.postalCode).toMatch(/^000\d{4}$/);
    }
  });
});
