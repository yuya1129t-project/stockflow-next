/**
 * ダッシュボードの集計（docs/spec.md §5-2）。サーバー側でだけ使う。
 *
 * 集計はすべて DB 側で行い、件ごとに問い合わせない（N+1 にしない）。次の 4 種類（計 6 本）を並列に投げる
 * 1. 直近 6 か月の月別受注額（confirmed＋shipped、受注日基準）。今月・前月の受注額もここから取る
 * 2. 未出荷の受注（confirmed）の件数・納期切れの件数と、納期切れの上位（納期の古い順）
 * 3. 発注点割れの商品（有効な商品のみ。商品一覧・在庫一覧と同じ SQL の定義）の件数と、不足の大きい順の上位
 * 4. 入荷待ちの発注（ordered）の件数・予定日切れの件数と、入荷予定日の近い順の上位
 *
 * 月・日の境界は Asia/Tokyo（./period.ts）。date 型の列とは YYYY-MM-DD の文字列を ::date にして比べる
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { JOIN_STOCK, LOW_STOCK_CONDITION } from "@/lib/products/queries";

import {
  jstDateString,
  monthOverMonth,
  recentMonthRanges,
  type MonthOverMonth,
  type MonthRange,
} from "./period";

/** 月別受注額のグラフに出す月数（今月を含む） */
export const SALES_TREND_MONTHS = 6;
/** 各カードに一覧で出す件数の既定値 */
export const DASHBOARD_LIST_LIMIT = 5;

export interface MonthlySales extends MonthRange {
  /** confirmed＋shipped の受注の合計（total。税込） */
  total: number;
}

export interface DashboardOrderItem {
  id: number;
  number: string;
  partnerName: string;
  /** 納期（受注）・入荷予定日（発注）。YYYY-MM-DD。未設定は null */
  date: string | null;
  /** 今日（JST）より前の日付なら true */
  overdue: boolean;
  total: number;
}

export interface DashboardLowStockItem {
  id: number;
  code: string;
  name: string;
  unit: string;
  reorderPoint: number;
  stock: number;
  /** 発注点 − 現在庫（1 以上） */
  shortage: number;
}

export interface DashboardData {
  /** 集計の基準日（JST の今日。YYYY-MM-DD） */
  today: string;
  sales: {
    current: MonthlySales;
    previous: MonthlySales;
    change: MonthOverMonth;
    /** 直近の月別（古い順。最後が今月） */
    trend: MonthlySales[];
  };
  unshipped: {
    count: number;
    overdueCount: number;
    /** 納期を過ぎた受注（納期の古い順） */
    overdue: DashboardOrderItem[];
  };
  lowStock: {
    count: number;
    /** 不足の大きい順 */
    items: DashboardLowStockItem[];
  };
  awaitingReceipt: {
    count: number;
    overdueCount: number;
    /** 入荷予定日の近い順（予定日なしは最後） */
    items: DashboardOrderItem[];
  };
}

export interface DashboardOptions {
  /** 基準の日時（既定は現在。テストで固定する） */
  now?: Date;
  /** 各一覧の件数 */
  limit?: number;
}

/** DATE 列の値（UTC 0 時の Date）を YYYY-MM-DD にする */
function toDateString(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

async function monthlySales(
  db: PrismaClient,
  months: MonthRange[],
): Promise<MonthlySales[]> {
  const rows = await db.$queryRaw<{ month: string; total: bigint }[]>`
    SELECT to_char(o."orderDate", 'YYYY-MM') AS "month",
           SUM(o."total")::bigint AS "total"
    FROM "sales_order" o
    WHERE o."status" IN ('confirmed', 'shipped')
      AND o."orderDate" >= ${months[0].start}::date
      AND o."orderDate" < ${months[months.length - 1].end}::date
    GROUP BY 1`;
  const totals = new Map(rows.map((r) => [r.month, Number(r.total)]));
  return months.map((m) => ({ ...m, total: totals.get(m.key) ?? 0 }));
}

async function unshippedOrders(db: PrismaClient, today: string, limit: number) {
  const [counts, rows] = await Promise.all([
    db.$queryRaw<{ count: number; overdueCount: number }[]>`
      SELECT COUNT(*)::int AS "count",
             (COUNT(*) FILTER (WHERE o."dueDate" < ${today}::date))::int AS "overdueCount"
      FROM "sales_order" o
      WHERE o."status" = 'confirmed'`,
    db.$queryRaw<
      {
        id: number;
        number: string;
        partnerName: string;
        date: string;
        total: number;
      }[]
    >`
      SELECT o."id", o."number", c."name" AS "partnerName",
             to_char(o."dueDate", 'YYYY-MM-DD') AS "date", o."total"
      FROM "sales_order" o
      JOIN "partner" c ON c."id" = o."customerId"
      WHERE o."status" = 'confirmed' AND o."dueDate" < ${today}::date
      ORDER BY o."dueDate" ASC, o."number" ASC
      LIMIT ${limit}`,
  ]);
  return {
    count: counts[0].count,
    overdueCount: counts[0].overdueCount,
    overdue: rows.map((r): DashboardOrderItem => ({ ...r, overdue: true })),
  };
}

async function lowStockProducts(db: PrismaClient, limit: number) {
  // 件数はウィンドウ関数で同じ問い合わせから取る（0 件なら行がないので 0）
  const rows = await db.$queryRaw<
    (DashboardLowStockItem & { totalCount: number })[]
  >`
    SELECT p."id", p."code", p."name", p."unit", p."reorderPoint",
           COALESCE(s."stock", 0)::int AS "stock",
           (p."reorderPoint" - COALESCE(s."stock", 0))::int AS "shortage",
           (COUNT(*) OVER ())::int AS "totalCount"
    FROM "product" p
    ${JOIN_STOCK}
    WHERE ${LOW_STOCK_CONDITION}
    ORDER BY "shortage" DESC, p."code" ASC
    LIMIT ${limit}`;
  return {
    count: rows[0]?.totalCount ?? 0,
    items: rows.map((r): DashboardLowStockItem => ({
      id: r.id,
      code: r.code,
      name: r.name,
      unit: r.unit,
      reorderPoint: r.reorderPoint,
      stock: r.stock,
      shortage: r.shortage,
    })),
  };
}

async function awaitingPurchaseOrders(
  db: PrismaClient,
  today: string,
  limit: number,
) {
  const [counts, rows] = await Promise.all([
    db.$queryRaw<{ count: number; overdueCount: number }[]>`
      SELECT COUNT(*)::int AS "count",
             (COUNT(*) FILTER (WHERE o."expectedDate" < ${today}::date))::int AS "overdueCount"
      FROM "purchase_order" o
      WHERE o."status" = 'ordered'`,
    db.purchaseOrder.findMany({
      where: { status: "ordered" },
      orderBy: [
        { expectedDate: { sort: "asc", nulls: "last" } },
        { number: "asc" },
      ],
      take: limit,
      select: {
        id: true,
        number: true,
        expectedDate: true,
        total: true,
        supplier: { select: { name: true } },
      },
    }),
  ]);
  return {
    count: counts[0].count,
    overdueCount: counts[0].overdueCount,
    items: rows.map((r): DashboardOrderItem => {
      const date = toDateString(r.expectedDate);
      return {
        id: r.id,
        number: r.number,
        partnerName: r.supplier.name,
        date,
        overdue: date !== null && date < today,
        total: r.total,
      };
    }),
  };
}

/** ダッシュボードの集計をまとめて取る */
export async function getDashboardData(
  db: PrismaClient,
  { now = new Date(), limit = DASHBOARD_LIST_LIMIT }: DashboardOptions = {},
): Promise<DashboardData> {
  const today = jstDateString(now);
  const months = recentMonthRanges(now, SALES_TREND_MONTHS);
  const [trend, unshipped, lowStock, awaitingReceipt] = await Promise.all([
    monthlySales(db, months),
    unshippedOrders(db, today, limit),
    lowStockProducts(db, limit),
    awaitingPurchaseOrders(db, today, limit),
  ]);
  const current = trend[trend.length - 1];
  const previous = trend[trend.length - 2];
  return {
    today,
    sales: {
      current,
      previous,
      change: monthOverMonth(current.total, previous.total),
      trend,
    },
    unshipped,
    lowStock,
    awaitingReceipt,
  };
}
