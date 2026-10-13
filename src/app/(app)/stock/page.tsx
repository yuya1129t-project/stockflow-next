import type { Metadata } from "next";
import Form from "next/form";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { requirePermission } from "@/lib/auth/guards";
import { getPrisma } from "@/lib/db";
import { formatNumber } from "@/lib/format";
import { listProductCategories } from "@/lib/products/queries";
import {
  PRODUCT_STATUS_LABELS,
  PRODUCT_STATUSES,
  type ProductSortKey,
} from "@/lib/products/search-params";
import { listStock } from "@/lib/stock/queries";
import { isBelowReorderPoint } from "@/lib/stock/rules";
import {
  parseStockListParams,
  STOCK_LEVEL_LABELS,
  STOCK_LEVELS,
  toStockListQuery,
  type StockListParams,
} from "@/lib/stock/search-params";
import { cn } from "@/lib/utils";

import { PageLink } from "./page-link";

export const metadata: Metadata = { title: "在庫 | StockFlow" };

const COLUMNS: {
  label: string;
  sort?: ProductSortKey;
  align?: "right";
  className?: string;
}[] = [
  { label: "商品コード", sort: "code" },
  { label: "商品名", sort: "name" },
  { label: "カテゴリ", sort: "category", className: "hidden sm:table-cell" },
  { label: "単位", className: "hidden md:table-cell" },
  { label: "発注点", sort: "reorderPoint", align: "right" },
  { label: "現在庫", sort: "stock", align: "right" },
];

function href(params: StockListParams, change: Partial<StockListParams>) {
  const query = toStockListQuery({ ...params, ...change });
  return query ? `/stock?${query}` : "/stock";
}

/** 現在庫一覧（発注点割れの強調・絞り込み、検索・並べ替え・ページ送り）。spec §5-7 */
export default async function StockPage({ searchParams }: PageProps<"/stock">) {
  await requirePermission("view");
  const params = parseStockListParams(await searchParams);
  const db = getPrisma();
  const [result, categories] = await Promise.all([
    listStock(db, params),
    listProductCategories(db),
  ]);
  const shown = { ...params, page: result.page };
  const from = result.total === 0 ? 0 : (result.page - 1) * result.perPage + 1;
  const to = Math.min(result.page * result.perPage, result.total);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">在庫</h1>

      <Form
        action="/stock"
        className="flex flex-wrap items-end gap-2 rounded-xl border p-3"
      >
        <div className="grid w-full gap-1 sm:w-64">
          <label htmlFor="q" className="text-xs text-muted-foreground">
            キーワード
          </label>
          <Input
            id="q"
            name="q"
            type="search"
            defaultValue={params.q}
            placeholder="商品コード・商品名・カテゴリ"
          />
        </div>
        <div className="grid gap-1">
          <label htmlFor="category" className="text-xs text-muted-foreground">
            カテゴリ
          </label>
          <NativeSelect
            id="category"
            name="category"
            defaultValue={params.category}
          >
            <NativeSelectOption value="">すべて</NativeSelectOption>
            {categories.map((c) => (
              <NativeSelectOption key={c} value={c}>
                {c}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1">
          <label htmlFor="level" className="text-xs text-muted-foreground">
            在庫
          </label>
          <NativeSelect id="level" name="level" defaultValue={params.level}>
            {STOCK_LEVELS.map((l) => (
              <NativeSelectOption key={l} value={l}>
                {STOCK_LEVEL_LABELS[l]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1">
          <label htmlFor="status" className="text-xs text-muted-foreground">
            状態
          </label>
          <NativeSelect id="status" name="status" defaultValue={params.status}>
            {PRODUCT_STATUSES.map((s) => (
              <NativeSelectOption key={s} value={s}>
                {PRODUCT_STATUS_LABELS[s]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        {/* 並べ替えは検索し直しても保つ（ページは 1 に戻す） */}
        <input type="hidden" name="sort" value={params.sort} />
        <input type="hidden" name="order" value={params.order} />
        <div className="flex gap-2">
          <Button type="submit">検索</Button>
          <Link href="/stock" className={buttonVariants({ variant: "ghost" })}>
            条件をクリア
          </Link>
        </div>
      </Form>

      <p className="text-sm text-muted-foreground" aria-live="polite">
        {result.total === 0
          ? "該当する商品はありません"
          : `全 ${formatNumber(result.total)} 件中 ${formatNumber(from)}〜${formatNumber(to)} 件`}
      </p>

      {result.total > 0 && (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                {COLUMNS.map((column) => {
                  const active = column.sort === params.sort;
                  return (
                    <TableHead
                      key={column.label}
                      className={cn(
                        column.align === "right" && "text-right",
                        column.className,
                      )}
                      aria-sort={
                        active
                          ? params.order === "asc"
                            ? "ascending"
                            : "descending"
                          : undefined
                      }
                    >
                      {column.sort ? (
                        <Link
                          href={href(params, {
                            sort: column.sort,
                            order:
                              active && params.order === "asc" ? "desc" : "asc",
                            page: 1,
                          })}
                          className="inline-flex items-center gap-1 hover:underline"
                        >
                          {column.label}
                          <span aria-hidden="true" className="text-xs">
                            {active
                              ? params.order === "asc"
                                ? "▲"
                                : "▼"
                              : "↕"}
                          </span>
                        </Link>
                      ) : (
                        column.label
                      )}
                    </TableHead>
                  );
                })}
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.items.map((p) => {
                const low = isBelowReorderPoint(p, p.stock);
                return (
                  <TableRow
                    key={p.id}
                    className={cn(
                      low && "bg-destructive/5",
                      !p.isActive && "text-muted-foreground",
                    )}
                  >
                    <TableCell className="font-mono">
                      <Link
                        href={`/stock/${p.id}`}
                        className="underline-offset-4 hover:underline"
                      >
                        {p.code}
                      </Link>
                    </TableCell>
                    <TableCell className="min-w-32 whitespace-normal">
                      <span className="mr-1">{p.name}</span>
                      {!p.isActive && <Badge variant="outline">無効</Badge>}
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      {p.category}
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      {p.unit}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(p.reorderPoint)}
                    </TableCell>
                    <TableCell
                      className={cn(
                        "text-right tabular-nums",
                        low && "font-semibold text-destructive",
                      )}
                    >
                      <span className="inline-flex items-center justify-end gap-1.5">
                        {low && (
                          // スマホ幅では行の色と赤字で示す（バッジは幅を取るので、読み上げ用にだけ残す）
                          <Badge
                            variant="destructive"
                            className="max-sm:sr-only"
                          >
                            発注点割れ
                          </Badge>
                        )}
                        {formatNumber(p.stock)}
                      </span>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {result.totalPages > 1 && (
        <nav
          aria-label="ページ送り"
          className="flex items-center justify-center gap-2 text-sm"
        >
          <PageLink
            disabled={result.page <= 1}
            href={href(shown, { page: result.page - 1 })}
          >
            前へ
          </PageLink>
          <span className="tabular-nums">
            {result.page} / {result.totalPages} ページ
          </span>
          <PageLink
            disabled={result.page >= result.totalPages}
            href={href(shown, { page: result.page + 1 })}
          >
            次へ
          </PageLink>
        </nav>
      )}
    </div>
  );
}
