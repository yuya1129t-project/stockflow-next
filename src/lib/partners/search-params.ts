/**
 * 取引先一覧の検索条件（URL のクエリ）。
 *
 * 検索条件を URL に持つので、共有・再読み込み・ブラウザの「戻る」で同じ一覧を再現できる。
 * 不正な値は既定値に置き換える（エラーにしない）。純粋なモジュール
 */
import { PARTNER_KINDS, type PartnerKind } from "./schema";

export const PARTNER_SORT_KEYS = ["code", "name", "kind"] as const;
export type PartnerSortKey = (typeof PARTNER_SORT_KEYS)[number];

export const PARTNER_STATUSES = ["active", "all", "inactive"] as const;
export type PartnerStatusFilter = (typeof PARTNER_STATUSES)[number];

export const PARTNER_STATUS_LABELS: Record<PartnerStatusFilter, string> = {
  active: "有効のみ",
  all: "無効も表示",
  inactive: "無効のみ",
};

/** 一覧の種別の絞り込みの選択肢（「顧客」「仕入先」は両方の役割を持つ取引先も含む） */
export const PARTNER_KIND_FILTER_LABELS: Record<PartnerKind, string> = {
  customer: "顧客（顧客・仕入先を含む）",
  supplier: "仕入先（顧客・仕入先を含む）",
  both: "顧客・仕入先のみ",
};

export type SortOrder = "asc" | "desc";

export interface PartnerListParams {
  /** 取引先コード・取引先名の部分一致 */
  q: string;
  /** 種別（customer は both を含む、supplier も both を含む、both は both だけ。空ならすべて） */
  kind: PartnerKind | "";
  status: PartnerStatusFilter;
  sort: PartnerSortKey;
  order: SortOrder;
  /** 1 始まり */
  page: number;
}

export const PARTNERS_PER_PAGE = 20;

/** 検索語の最大長（これより長い部分は切り捨てる） */
const MAX_QUERY_LENGTH = 100;

export const DEFAULT_PARTNER_LIST_PARAMS: PartnerListParams = {
  q: "",
  kind: "",
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
export function parsePartnerListParams(
  params: RawSearchParams,
): PartnerListParams {
  const page = Number(first(params, "page"));
  return {
    q: (first(params, "q") ?? "").trim().slice(0, MAX_QUERY_LENGTH),
    kind: oneOf<PartnerKind | "">(
      first(params, "kind"),
      PARTNER_KINDS,
      DEFAULT_PARTNER_LIST_PARAMS.kind,
    ),
    status: oneOf(
      first(params, "status"),
      PARTNER_STATUSES,
      DEFAULT_PARTNER_LIST_PARAMS.status,
    ),
    sort: oneOf(
      first(params, "sort"),
      PARTNER_SORT_KEYS,
      DEFAULT_PARTNER_LIST_PARAMS.sort,
    ),
    order: oneOf(
      first(params, "order"),
      ["asc", "desc"] as const,
      DEFAULT_PARTNER_LIST_PARAMS.order,
    ),
    page: Number.isSafeInteger(page) && page >= 1 ? page : 1,
  };
}

/**
 * 検索条件を URL のクエリ文字列にする（既定値の項目は省く）。先頭の "?" は付けない
 */
export function toPartnerListQuery(params: Partial<PartnerListParams>): string {
  const merged = { ...DEFAULT_PARTNER_LIST_PARAMS, ...params };
  const search = new URLSearchParams();
  if (merged.q) search.set("q", merged.q);
  if (merged.kind) search.set("kind", merged.kind);
  if (merged.status !== DEFAULT_PARTNER_LIST_PARAMS.status)
    search.set("status", merged.status);
  if (
    merged.sort !== DEFAULT_PARTNER_LIST_PARAMS.sort ||
    merged.order !== DEFAULT_PARTNER_LIST_PARAMS.order
  ) {
    search.set("sort", merged.sort);
    search.set("order", merged.order);
  }
  if (merged.page > 1) search.set("page", String(merged.page));
  return search.toString();
}
