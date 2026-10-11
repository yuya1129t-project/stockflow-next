import type { Metadata } from "next";
import Form from "next/form";
import Link from "next/link";
import type { ReactNode } from "react";

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
import { can } from "@/lib/auth/permissions";
import { getPrisma } from "@/lib/db";
import { formatNumber } from "@/lib/format";
import {
  listProductCategories,
  listProducts,
  PRODUCT_EXPORT_MAX_ROWS,
} from "@/lib/products/queries";
import {
  parseProductListParams,
  PRODUCT_STATUS_LABELS,
  PRODUCT_STATUSES,
  toProductListQuery,
  type ProductListParams,
  type ProductSortKey,
} from "@/lib/products/search-params";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "商品 | StockFlow" };

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
  {
    label: "売価",
    sort: "salesPrice",
    align: "right",
    className: "hidden md:table-cell",
  },
  { label: "仕入単価", align: "right", className: "hidden lg:table-cell" },
  { label: "発注点", sort: "reorderPoint", align: "right" },
  { label: "現在庫", sort: "stock", align: "right" },
];

function href(params: ProductListParams, change: Partial<ProductListParams>) {
  const query = toProductListQuery({ ...params, ...change });
  return query ? `/products?${query}` : "/products";
}

/** 商品一覧（検索・並べ替え・ページ送り・現在庫と発注点割れの表示）。spec §5-3 */
export default async function ProductsPage({
  searchParams,
}: PageProps<"/products">) {
  const user = await requirePermission("view");
  const params = parseProductListParams(await searchParams);
  const db = getPrisma();
  const [result, categories] = await Promise.all([
    listProducts(db, params),
    listProductCategories(db),
  ]);
  const shown = { ...params, page: result.page };
  const from = result.total === 0 ? 0 : (result.page - 1) * result.perPage + 1;
  const to = Math.min(result.page * result.perPage, result.total);
  const exportQuery = toProductListQuery({ ...params, page: 1 });
  const exportTooMany = result.total > PRODUCT_EXPORT_MAX_ROWS;
  const exportTooManyMessage = `CSV 出力は ${formatNumber(PRODUCT_EXPORT_MAX_ROWS)} 件までです。絞り込んでから出力してください`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-xl font-semibold tracking-tight">商品</h1>
        {exportTooMany ? (
          // 上限を超えると出力は 413 になるので、ボタンを押せないようにして理由を示す
          <span
            aria-disabled="true"
            title={exportTooManyMessage}
            className={cn(
              buttonVariants({ variant: "outline", size: "sm" }),
              "pointer-events-none opacity-50",
            )}
          >
            CSV 出力
          </span>
        ) : (
          <a
            href={`/api/products/export${exportQuery ? `?${exportQuery}` : ""}`}
            className={buttonVariants({ variant: "outline", size: "sm" })}
            download
          >
            CSV 出力
          </a>
        )}
        {can(user.role, "csv:import") && (
          <Link
            href="/products/import"
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            CSV 取込
          </Link>
        )}
        {can(user.role, "master:edit") && (
          <Link href="/products/new" className={buttonVariants({ size: "sm" })}>
            新規登録
          </Link>
        )}
      </div>

      <Form
        action="/products"
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
          <Link
            href="/products"
            className={buttonVariants({ variant: "ghost" })}
          >
            条件をクリア
          </Link>
        </div>
      </Form>

      {exportTooMany && (
        <p className="text-sm text-destructive">{exportTooManyMessage}</p>
      )}

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
                const low = p.isActive && p.stock < p.reorderPoint;
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
                        href={`/products/${p.id}`}
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
                    <TableCell className="hidden text-right tabular-nums md:table-cell">
                      {formatNumber(p.salesPrice)}
                    </TableCell>
                    <TableCell className="hidden text-right tabular-nums lg:table-cell">
                      {formatNumber(p.purchasePrice)}
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

function PageLink({
  href,
  disabled,
  children,
}: {
  href: string;
  disabled: boolean;
  children: ReactNode;
}) {
  const className = buttonVariants({ variant: "outline", size: "sm" });
  return disabled ? (
    <span
      aria-disabled="true"
      className={cn(className, "pointer-events-none opacity-50")}
    >
      {children}
    </span>
  ) : (
    <Link href={href} className={className}>
      {children}
    </Link>
  );
}
