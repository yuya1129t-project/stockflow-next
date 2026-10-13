/**
 * 受注の読み取り（一覧・CSV 出力・詳細・入力の選択肢）。サーバー側でだけ使う
 */
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { parseDateOnly } from "@/lib/orders/dates";
import type { LineProductOption } from "@/lib/orders/schema";
import { partnerKindsFor } from "@/lib/partners/schema";

import {
  SALES_ORDERS_PER_PAGE,
  type SalesOrderListParams,
} from "./search-params";
import type { SalesOrderStatus } from "./status";

export interface SalesOrderListItem {
  id: number;
  number: string;
  orderDate: Date;
  dueDate: Date | null;
  status: SalesOrderStatus;
  subtotal: number;
  tax: number;
  total: number;
  note: string | null;
  customer: { id: number; code: string; name: string };
  lineCount: number;
}

export interface SalesOrderListResult {
  items: SalesOrderListItem[];
  total: number;
  /** 実際に表示したページ（範囲外を指定されたら最終ページに丸める） */
  page: number;
  totalPages: number;
  perPage: number;
}

const LIST_SELECT = {
  id: true,
  number: true,
  orderDate: true,
  dueDate: true,
  status: true,
  subtotal: true,
  tax: true,
  total: true,
  note: true,
  customer: { select: { id: true, code: true, name: true } },
  _count: { select: { lines: true } },
} as const satisfies Prisma.SalesOrderSelect;

type ListRow = Prisma.SalesOrderGetPayload<{ select: typeof LIST_SELECT }>;

function toListItem({ _count, ...row }: ListRow): SalesOrderListItem {
  return { ...row, lineCount: _count.lines };
}

/** LIKE の特殊文字（% _ \）をエスケープする（Prisma の contains はワイルドカードのまま渡すため） */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function where(params: SalesOrderListParams): Prisma.SalesOrderWhereInput {
  const conditions: Prisma.SalesOrderWhereInput[] = [];
  if (params.q) {
    conditions.push({
      number: { contains: escapeLike(params.q), mode: "insensitive" },
    });
  }
  if (params.customerId !== null)
    conditions.push({ customerId: params.customerId });
  if (params.status) conditions.push({ status: params.status });
  const from = params.from ? parseDateOnly(params.from) : null;
  const to = params.to ? parseDateOnly(params.to) : null;
  if (from) conditions.push({ orderDate: { gte: from } });
  if (to) conditions.push({ orderDate: { lte: to } });
  return { AND: conditions };
}

/** 並べ替え（キーはホワイトリスト）。同じ値の行の順番が変わらないよう、最後に番号で並べる */
function orderBy(
  params: Pick<SalesOrderListParams, "sort" | "order">,
): Prisma.SalesOrderOrderByWithRelationInput[] {
  const { sort, order } = params;
  switch (sort) {
    case "number":
      return [{ number: order }];
    case "customer":
      return [{ customer: { name: order } }, { number: "desc" }];
    case "dueDate":
      return [{ dueDate: { sort: order, nulls: "last" } }, { number: "desc" }];
    case "orderDate":
    case "total":
      return [{ [sort]: order }, { number: order }];
  }
}

/** 一覧（絞り込み・並べ替え・ページ送り） */
export async function listSalesOrders(
  db: PrismaClient,
  params: SalesOrderListParams,
): Promise<SalesOrderListResult> {
  const filter = where(params);
  const total = await db.salesOrder.count({ where: filter });
  const perPage = SALES_ORDERS_PER_PAGE;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const page = Math.min(params.page, totalPages);
  const rows = await db.salesOrder.findMany({
    where: filter,
    select: LIST_SELECT,
    orderBy: orderBy(params),
    skip: (page - 1) * perPage,
    take: perPage,
  });
  return { items: rows.map(toListItem), total, page, totalPages, perPage };
}

/** CSV 出力の上限件数（超えたら出力せず、絞り込みを促す） */
export const SALES_ORDER_EXPORT_MAX_ROWS = 10_000;

/**
 * CSV 出力用（絞り込み・並べ替えは一覧と同じ。ページ送りはしない）。
 * 上限＋1 件まで取得し、上限を超えたら overLimit: true（黙って切り捨てない）
 */
export async function listSalesOrdersForCsv(
  db: PrismaClient,
  params: SalesOrderListParams,
  limit: number = SALES_ORDER_EXPORT_MAX_ROWS,
): Promise<{ items: SalesOrderListItem[]; overLimit: boolean }> {
  const rows = await db.salesOrder.findMany({
    where: where(params),
    select: LIST_SELECT,
    orderBy: orderBy(params),
    take: limit + 1,
  });
  const items = rows.map(toListItem);
  return items.length > limit
    ? { items: items.slice(0, limit), overLimit: true }
    : { items, overLimit: false };
}

export interface SalesOrderDetail {
  id: number;
  number: string;
  orderDate: Date;
  dueDate: Date | null;
  status: SalesOrderStatus;
  note: string | null;
  subtotal: number;
  tax: number;
  total: number;
  createdAt: Date;
  updatedAt: Date;
  customerId: number;
  customer: { id: number; code: string; name: string; isActive: boolean };
  lines: {
    id: number;
    productId: number;
    quantity: number;
    unitPrice: number;
    product: {
      id: number;
      code: string;
      name: string;
      unit: string;
      isActive: boolean;
    };
  }[];
}

/** 詳細（明細を含む。明細は登録した順）。無ければ null */
export async function getSalesOrder(
  db: PrismaClient,
  id: number,
): Promise<SalesOrderDetail | null> {
  return db.salesOrder.findUnique({
    where: { id },
    select: {
      id: true,
      number: true,
      orderDate: true,
      dueDate: true,
      status: true,
      note: true,
      subtotal: true,
      tax: true,
      total: true,
      createdAt: true,
      updatedAt: true,
      customerId: true,
      customer: {
        select: { id: true, code: true, name: true, isActive: true },
      },
      lines: {
        orderBy: { id: "asc" },
        select: {
          id: true,
          productId: true,
          quantity: true,
          unitPrice: true,
          product: {
            select: {
              id: true,
              code: true,
              name: true,
              unit: true,
              isActive: true,
            },
          },
        },
      },
    },
  });
}

export interface CustomerOption {
  id: number;
  code: string;
  name: string;
  isActive: boolean;
}

/**
 * 顧客の選択肢（種別が customer か both）。
 * activeOnly のときは有効なものだけ（作成・編集）。includeId は無効でも含める（編集中の受注の今の顧客）
 */
export async function listCustomerOptions(
  db: PrismaClient,
  { activeOnly, includeId }: { activeOnly: boolean; includeId?: number },
): Promise<CustomerOption[]> {
  return db.partner.findMany({
    where: {
      kind: { in: partnerKindsFor("customer") },
      ...(activeOnly
        ? {
            OR: [
              { isActive: true },
              ...(includeId !== undefined ? [{ id: includeId }] : []),
            ],
          }
        : {}),
    },
    select: { id: true, code: true, name: true, isActive: true },
    orderBy: { code: "asc" },
  });
}

/** 明細の商品の選択肢: 有効な商品と、includeIds（編集中の受注の明細にある商品。無効でも含める） */
export async function listLineProductOptions(
  db: PrismaClient,
  includeIds: readonly number[] = [],
): Promise<LineProductOption[]> {
  const rows = await db.product.findMany({
    where: {
      OR: [
        { isActive: true },
        ...(includeIds.length > 0 ? [{ id: { in: [...includeIds] } }] : []),
      ],
    },
    select: {
      id: true,
      code: true,
      name: true,
      unit: true,
      salesPrice: true,
      isActive: true,
    },
    orderBy: { code: "asc" },
  });
  return rows.map(({ salesPrice, ...p }) => ({
    ...p,
    price: salesPrice,
  }));
}
