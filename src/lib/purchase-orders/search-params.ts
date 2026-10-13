/**
 * 発注一覧の検索条件（URL のクエリ）。一覧画面と CSV 出力で同じ解釈をする。
 * 不正な値は既定値に置き換える（エラーにしない）。純粋なモジュール
 */
import { parseDateOnly } from "@/lib/orders/dates";

import { PURCHASE_ORDER_STATUSES, type PurchaseOrderStatus } from "./status";

export const PURCHASE_ORDER_SORT_KEYS = [
  "orderDate",
  "number",
  "supplier",
  "expectedDate",
  "total",
] as const;
export type PurchaseOrderSortKey = (typeof PURCHASE_ORDER_SORT_KEYS)[number];

export type SortOrder = "asc" | "desc";

export interface PurchaseOrderListParams {
  /** 発注番号の部分一致 */
  q: string;
  /** 仕入先（null ならすべて） */
  supplierId: number | null;
  /** ステータス（空ならすべて） */
  status: PurchaseOrderStatus | "";
  /** 発注日の範囲（"YYYY-MM-DD"。空なら制限なし。両端を含む） */
  from: string;
  to: string;
  sort: PurchaseOrderSortKey;
  order: SortOrder;
  /** 1 始まり */
  page: number;
}

export const PURCHASE_ORDERS_PER_PAGE = 20;

const MAX_QUERY_LENGTH = 100;

export const DEFAULT_PURCHASE_ORDER_LIST_PARAMS: PurchaseOrderListParams = {
  q: "",
  supplierId: null,
  status: "",
  from: "",
  to: "",
  sort: "orderDate",
  order: "desc",
  page: 1,
};

type RawSearchParams =
  URLSearchParams | Record<string, string | string[] | undefined>;

function first(params: RawSearchParams, key: string): string | undefined {
  if (params instanceof URLSearchParams) return params.get(key) ?? undefined;
  const value = params[key];
  return Array.isArray(value) ? value[0] : value;
}

function oneOf<T extends string>(
  value: string | undefined,
  options: readonly T[],
  fallback: T,
): T {
  return value !== undefined && (options as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/** 実在する日付（YYYY-MM-DD）だけを残す */
function dateParam(value: string | undefined): string {
  const trimmed = (value ?? "").trim();
  return parseDateOnly(trimmed) ? trimmed : "";
}

export function parsePurchaseOrderListParams(
  params: RawSearchParams,
): PurchaseOrderListParams {
  const page = Number(first(params, "page"));
  const supplier = (first(params, "supplier") ?? "").trim();
  return {
    q: (first(params, "q") ?? "").trim().slice(0, MAX_QUERY_LENGTH),
    supplierId:
      /^\d{1,9}$/.test(supplier) && Number(supplier) >= 1
        ? Number(supplier)
        : null,
    status: oneOf<PurchaseOrderStatus | "">(
      first(params, "status"),
      PURCHASE_ORDER_STATUSES,
      "",
    ),
    from: dateParam(first(params, "from")),
    to: dateParam(first(params, "to")),
    sort: oneOf(
      first(params, "sort"),
      PURCHASE_ORDER_SORT_KEYS,
      DEFAULT_PURCHASE_ORDER_LIST_PARAMS.sort,
    ),
    order: oneOf(
      first(params, "order"),
      ["asc", "desc"] as const,
      DEFAULT_PURCHASE_ORDER_LIST_PARAMS.order,
    ),
    page: Number.isSafeInteger(page) && page >= 1 ? page : 1,
  };
}

/** 検索条件を URL のクエリ文字列にする（既定値の項目は省く）。先頭の "?" は付けない */
export function toPurchaseOrderListQuery(
  params: Partial<PurchaseOrderListParams>,
): string {
  const merged = { ...DEFAULT_PURCHASE_ORDER_LIST_PARAMS, ...params };
  const search = new URLSearchParams();
  if (merged.q) search.set("q", merged.q);
  if (merged.supplierId !== null)
    search.set("supplier", String(merged.supplierId));
  if (merged.status) search.set("status", merged.status);
  if (merged.from) search.set("from", merged.from);
  if (merged.to) search.set("to", merged.to);
  if (
    merged.sort !== DEFAULT_PURCHASE_ORDER_LIST_PARAMS.sort ||
    merged.order !== DEFAULT_PURCHASE_ORDER_LIST_PARAMS.order
  ) {
    search.set("sort", merged.sort);
    search.set("order", merged.order);
  }
  if (merged.page > 1) search.set("page", String(merged.page));
  return search.toString();
}
