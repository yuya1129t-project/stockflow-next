/**
 * 商品の読み取り（一覧・詳細・CSV 出力）。サーバー側でだけ使う。
 *
 * 現在庫は入出庫（stock_movement）の合計（spec §3）。一覧では商品ごとに問い合わせず（N+1 にしない）、
 * 入出庫を商品ごとに集計した結果を 1 本の SQL で結合する。現在庫での並べ替えもこの SQL で行う
 */
import { Prisma, type PrismaClient } from "@/generated/prisma/client";

import {
  PRODUCTS_PER_PAGE,
  type ProductListParams,
  type ProductSortKey,
} from "./search-params";

export interface ProductListItem {
  id: number;
  code: string;
  name: string;
  category: string;
  unit: string;
  salesPrice: number;
  purchasePrice: number;
  reorderPoint: number;
  isActive: boolean;
  /** 現在庫（入出庫の合計） */
  stock: number;
}

export interface ProductListResult {
  items: ProductListItem[];
  total: number;
  /** 実際に表示したページ（範囲外を指定されたら最終ページに丸める） */
  page: number;
  totalPages: number;
  perPage: number;
}

/** 並べ替えの列（ホワイトリスト。URL の値をそのまま SQL に入れない） */
const SORT_COLUMNS: Record<ProductSortKey, Prisma.Sql> = {
  code: Prisma.sql`p."code"`,
  name: Prisma.sql`p."name"`,
  category: Prisma.sql`p."category"`,
  salesPrice: Prisma.sql`p."salesPrice"`,
  reorderPoint: Prisma.sql`p."reorderPoint"`,
  stock: Prisma.sql`"stock"`,
};

/** LIKE の特殊文字（% _ \）をエスケープする */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * 発注点割れ（有効な商品で 現在庫 < 発注点。src/lib/stock/rules.ts の isBelowReorderPoint と同じ定義）。
 * 商品の別名 p と JOIN_STOCK の結合が前提
 */
export const LOW_STOCK_CONDITION = Prisma.sql`p."isActive" = TRUE AND COALESCE(s."stock", 0) < p."reorderPoint"`;

type FilterParams = Pick<ProductListParams, "q" | "category" | "status"> & {
  /** 発注点割れ（有効で 現在庫 < 発注点）の商品だけにする（在庫一覧 /stock の絞り込み） */
  lowStock?: boolean;
};

function whereClause({
  q,
  category,
  status,
  lowStock,
}: FilterParams): Prisma.Sql {
  const conditions: Prisma.Sql[] = [];
  if (q) {
    const pattern = `%${escapeLike(q)}%`;
    conditions.push(
      Prisma.sql`(p."code" ILIKE ${pattern} OR p."name" ILIKE ${pattern} OR p."category" ILIKE ${pattern})`,
    );
  }
  if (category) conditions.push(Prisma.sql`p."category" = ${category}`);
  if (status === "active") conditions.push(Prisma.sql`p."isActive" = TRUE`);
  if (status === "inactive") conditions.push(Prisma.sql`p."isActive" = FALSE`);
  if (lowStock) conditions.push(LOW_STOCK_CONDITION);
  return conditions.length > 0
    ? Prisma.sql`WHERE ${Prisma.join(conditions, " AND ")}`
    : Prisma.empty;
}

function orderClause({
  sort,
  order,
}: Pick<ProductListParams, "sort" | "order">): Prisma.Sql {
  const direction = order === "desc" ? Prisma.sql`DESC` : Prisma.sql`ASC`;
  // 同じ値の行の順番が毎回変わらないよう、最後に商品コードで並べる
  return sort === "code"
    ? Prisma.sql`ORDER BY p."code" ${direction}`
    : Prisma.sql`ORDER BY ${SORT_COLUMNS[sort]} ${direction}, p."code" ASC`;
}

/** 入出庫を商品ごとに集計して結合する（別名 s."stock"）。ダッシュボード（src/lib/dashboard）も使う */
export const JOIN_STOCK = Prisma.sql`
  LEFT JOIN (
    SELECT "productId", SUM("quantity") AS "stock"
    FROM "stock_movement"
    GROUP BY "productId"
  ) s ON s."productId" = p."id"`;

/** 商品と現在庫を取る SELECT（WHERE・ORDER BY・LIMIT は呼び出し側で付ける） */
const SELECT_WITH_STOCK = Prisma.sql`
  SELECT p."id", p."code", p."name", p."category", p."unit",
         p."salesPrice", p."purchasePrice", p."reorderPoint", p."isActive",
         COALESCE(s."stock", 0)::int AS "stock"
  FROM "product" p
  ${JOIN_STOCK}`;

/** 一覧（検索・並べ替え・ページ送り）。在庫一覧（/stock）も lowStock を付けてこれを使う */
export async function listProducts(
  db: PrismaClient,
  params: ProductListParams & { lowStock?: boolean },
): Promise<ProductListResult> {
  const where = whereClause(params);
  // 件数は、発注点割れで絞り込むときだけ現在庫の集計を結合する
  const [{ count }] = await db.$queryRaw<{ count: number }[]>`
    SELECT COUNT(*)::int AS "count" FROM "product" p
    ${params.lowStock ? JOIN_STOCK : Prisma.empty} ${where}`;
  const perPage = PRODUCTS_PER_PAGE;
  const totalPages = Math.max(1, Math.ceil(count / perPage));
  const page = Math.min(params.page, totalPages);

  const items = await db.$queryRaw<ProductListItem[]>`
    ${SELECT_WITH_STOCK}
    ${where}
    ${orderClause(params)}
    LIMIT ${perPage} OFFSET ${(page - 1) * perPage}`;

  return { items, total: count, page, totalPages, perPage };
}

/** CSV 出力の上限件数（超えたら出力せず、絞り込みを促す） */
export const PRODUCT_EXPORT_MAX_ROWS = 10_000;

/**
 * CSV 出力用（絞り込み・並べ替えは一覧と同じ。ページ送りはしない）。
 * 上限＋1 件まで取得し、上限を超えたら overLimit: true（黙って切り捨てない）
 */
export async function listProductsForCsv(
  db: PrismaClient,
  params: ProductListParams,
  limit: number = PRODUCT_EXPORT_MAX_ROWS,
): Promise<{ items: ProductListItem[]; overLimit: boolean }> {
  const rows = await db.$queryRaw<ProductListItem[]>`
    ${SELECT_WITH_STOCK}
    ${whereClause(params)}
    ${orderClause(params)}
    LIMIT ${limit + 1}`;
  return rows.length > limit
    ? { items: rows.slice(0, limit), overLimit: true }
    : { items: rows, overLimit: false };
}

/** 詳細（現在庫を含む）。無ければ null */
export async function getProduct(
  db: PrismaClient,
  id: number,
): Promise<ProductListItem | null> {
  const rows = await db.$queryRaw<ProductListItem[]>`
    ${SELECT_WITH_STOCK}
    WHERE p."id" = ${id}`;
  return rows[0] ?? null;
}

/** 登録済みのカテゴリ（検索の選択肢・入力候補） */
export async function listProductCategories(
  db: PrismaClient,
): Promise<string[]> {
  const rows = await db.product.findMany({
    distinct: ["category"],
    select: { category: true },
    orderBy: { category: "asc" },
  });
  return rows.map((r) => r.category);
}
