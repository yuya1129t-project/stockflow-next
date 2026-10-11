/**
 * 商品一覧の検索条件（URL のクエリ）。一覧画面と CSV 出力で同じ解釈をする。
 *
 * 検索条件を URL に持つので、共有・再読み込み・ブラウザの「戻る」で同じ一覧を再現できる。
 * 不正な値は既定値に置き換える（エラーにしない）。純粋なモジュール
 */

export const PRODUCT_SORT_KEYS = [
  "code",
  "name",
  "category",
  "salesPrice",
  "reorderPoint",
  "stock",
] as const;
export type ProductSortKey = (typeof PRODUCT_SORT_KEYS)[number];

export const PRODUCT_STATUSES = ["active", "all", "inactive"] as const;
export type ProductStatusFilter = (typeof PRODUCT_STATUSES)[number];

export const PRODUCT_STATUS_LABELS: Record<ProductStatusFilter, string> = {
  active: "有効のみ",
  all: "無効も表示",
  inactive: "無効のみ",
};

export type SortOrder = "asc" | "desc";

export interface ProductListParams {
  /** 商品コード・商品名・カテゴリの部分一致 */
  q: string;
  /** カテゴリ（完全一致。空ならすべて） */
  category: string;
  status: ProductStatusFilter;
  sort: ProductSortKey;
  order: SortOrder;
  /** 1 始まり */
  page: number;
}

export const PRODUCTS_PER_PAGE = 20;

/** 検索語の最大長（これより長い部分は切り捨てる） */
const MAX_QUERY_LENGTH = 100;

export const DEFAULT_PRODUCT_LIST_PARAMS: ProductListParams = {
  q: "",
  category: "",
  status: "active",
  sort: "code",
  order: "asc",
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

/** URL のクエリ（Next.js の searchParams または URLSearchParams）を検索条件にする */
export function parseProductListParams(
  params: RawSearchParams,
): ProductListParams {
  const page = Number(first(params, "page"));
  return {
    q: (first(params, "q") ?? "").trim().slice(0, MAX_QUERY_LENGTH),
    category: (first(params, "category") ?? "")
      .trim()
      .slice(0, MAX_QUERY_LENGTH),
    status: oneOf(
      first(params, "status"),
      PRODUCT_STATUSES,
      DEFAULT_PRODUCT_LIST_PARAMS.status,
    ),
    sort: oneOf(
      first(params, "sort"),
      PRODUCT_SORT_KEYS,
      DEFAULT_PRODUCT_LIST_PARAMS.sort,
    ),
    order: oneOf(
      first(params, "order"),
      ["asc", "desc"] as const,
      DEFAULT_PRODUCT_LIST_PARAMS.order,
    ),
    page: Number.isSafeInteger(page) && page >= 1 ? page : 1,
  };
}

/**
 * 検索条件を URL のクエリ文字列にする（既定値の項目は省く）。先頭の "?" は付けない
 */
export function toProductListQuery(params: Partial<ProductListParams>): string {
  const merged = { ...DEFAULT_PRODUCT_LIST_PARAMS, ...params };
  const search = new URLSearchParams();
  if (merged.q) search.set("q", merged.q);
  if (merged.category) search.set("category", merged.category);
  if (merged.status !== DEFAULT_PRODUCT_LIST_PARAMS.status)
    search.set("status", merged.status);
  if (
    merged.sort !== DEFAULT_PRODUCT_LIST_PARAMS.sort ||
    merged.order !== DEFAULT_PRODUCT_LIST_PARAMS.order
  ) {
    search.set("sort", merged.sort);
    search.set("order", merged.order);
  }
  if (merged.page > 1) search.set("page", String(merged.page));
  return search.toString();
}
