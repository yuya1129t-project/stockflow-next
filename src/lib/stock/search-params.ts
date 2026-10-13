/**
 * 在庫一覧（/stock）の検索条件（URL のクエリ）。商品一覧の条件（キーワード・カテゴリ・状態・並べ替え・ページ）に
 * 「発注点割れのみ」の絞り込みを加えたもの。不正な値は既定値に置き換える。純粋なモジュール
 */
import {
  parseProductListParams,
  toProductListQuery,
  type ProductListParams,
} from "@/lib/products/search-params";

export const STOCK_LEVELS = ["all", "low"] as const;
export type StockLevelFilter = (typeof STOCK_LEVELS)[number];

export const STOCK_LEVEL_LABELS: Record<StockLevelFilter, string> = {
  all: "すべて",
  low: "発注点割れのみ",
};

export interface StockListParams extends ProductListParams {
  level: StockLevelFilter;
}

type RawSearchParams =
  URLSearchParams | Record<string, string | string[] | undefined>;

function first(params: RawSearchParams, key: string): string | undefined {
  if (params instanceof URLSearchParams) return params.get(key) ?? undefined;
  const value = params[key];
  return Array.isArray(value) ? value[0] : value;
}

/** URL のクエリを在庫一覧の検索条件にする */
export function parseStockListParams(params: RawSearchParams): StockListParams {
  const level = first(params, "level");
  return {
    ...parseProductListParams(params),
    level: level === "low" ? "low" : "all",
  };
}

/** 検索条件を URL のクエリ文字列にする（既定値の項目は省く）。先頭の "?" は付けない */
export function toStockListQuery(params: Partial<StockListParams>): string {
  const { level, ...rest } = params;
  const search = new URLSearchParams(toProductListQuery(rest));
  if (level === "low") search.set("level", "low");
  return search.toString();
}
