/**
 * 在庫の画面用の読み取り（現在庫一覧・入出庫履歴）。サーバー側でだけ使う
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { listProducts, type ProductListResult } from "@/lib/products/queries";

import type { StockMovementKind } from "./rules";
import type { StockListParams } from "./search-params";

/** 現在庫一覧（商品一覧の集計を使い、発注点割れのみの絞り込みを加える） */
export function listStock(
  db: PrismaClient,
  params: StockListParams,
): Promise<ProductListResult> {
  return listProducts(db, { ...params, lowStock: params.level === "low" });
}

export const STOCK_MOVEMENTS_PER_PAGE = 20;

export interface StockMovementListItem {
  id: number;
  createdAt: Date;
  type: StockMovementKind;
  /** 符号付き */
  quantity: number;
  reason: string | null;
  /** 参照元の伝票（受注・発注）。棚卸調整は null */
  ref: {
    type: "sales_order" | "purchase_order";
    id: number;
    /** 伝票番号（伝票が見つからなければ null） */
    number: string | null;
  } | null;
  /** 担当者の名前（記録したユーザーがなければ null） */
  userName: string | null;
}

export interface StockMovementListResult {
  items: StockMovementListItem[];
  total: number;
  page: number;
  totalPages: number;
  perPage: number;
}

/** 商品の入出庫履歴（新しい順・ページ送り）。参照元の伝票番号はまとめて引く（N+1 にしない） */
export async function listStockMovements(
  db: PrismaClient,
  productId: number,
  requestedPage: number,
): Promise<StockMovementListResult> {
  const where = { productId };
  const total = await db.stockMovement.count({ where });
  const perPage = STOCK_MOVEMENTS_PER_PAGE;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const page = Math.min(Math.max(1, requestedPage), totalPages);

  const rows = await db.stockMovement.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    skip: (page - 1) * perPage,
    take: perPage,
    include: { user: { select: { name: true } } },
  });

  const idsOf = (type: "sales_order" | "purchase_order") => [
    ...new Set(
      rows.filter((r) => r.refType === type).map((r) => r.refId as number),
    ),
  ];
  const salesIds = idsOf("sales_order");
  const purchaseIds = idsOf("purchase_order");
  const [salesOrders, purchaseOrders] = await Promise.all([
    salesIds.length > 0
      ? db.salesOrder.findMany({
          where: { id: { in: salesIds } },
          select: { id: true, number: true },
        })
      : [],
    purchaseIds.length > 0
      ? db.purchaseOrder.findMany({
          where: { id: { in: purchaseIds } },
          select: { id: true, number: true },
        })
      : [],
  ]);
  const numbers = {
    sales_order: new Map(salesOrders.map((o) => [o.id, o.number])),
    purchase_order: new Map(purchaseOrders.map((o) => [o.id, o.number])),
  };

  const items = rows.map((r): StockMovementListItem => ({
    id: r.id,
    createdAt: r.createdAt,
    type: r.type,
    quantity: r.quantity,
    reason: r.reason,
    ref:
      r.refType && r.refId !== null
        ? {
            type: r.refType,
            id: r.refId,
            number: numbers[r.refType].get(r.refId) ?? null,
          }
        : null,
    userName: r.user?.name ?? null,
  }));
  return { items, total, page, totalPages, perPage };
}
