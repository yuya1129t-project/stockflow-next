import type { Metadata } from "next";
import Form from "next/form";
import Link from "next/link";

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
import { displayDateOnly } from "@/lib/orders/dates";
import {
  listPurchaseOrders,
  listSupplierOptions,
  PURCHASE_ORDER_EXPORT_MAX_ROWS,
} from "@/lib/purchase-orders/queries";
import {
  parsePurchaseOrderListParams,
  toPurchaseOrderListQuery,
  type PurchaseOrderListParams,
  type PurchaseOrderSortKey,
} from "@/lib/purchase-orders/search-params";
import {
  PURCHASE_ORDER_STATUS_LABELS,
  PURCHASE_ORDER_STATUSES,
} from "@/lib/purchase-orders/status";
import { cn } from "@/lib/utils";

import { PageLink } from "../stock/page-link";
import { PurchaseOrderStatusBadge } from "./status-badge";

export const metadata: Metadata = { title: "発注 | StockFlow" };

const COLUMNS: {
  label: string;
  sort?: PurchaseOrderSortKey;
  align?: "right";
  className?: string;
}[] = [
  { label: "発注番号", sort: "number" },
  { label: "発注日", sort: "orderDate" },
  { label: "仕入先", sort: "supplier" },
  { label: "ステータス" },
  {
    label: "入荷予定日",
    sort: "expectedDate",
    className: "hidden md:table-cell",
  },
  { label: "合計（円）", sort: "total", align: "right" },
];

function href(
  params: PurchaseOrderListParams,
  change: Partial<PurchaseOrderListParams>,
) {
  const query = toPurchaseOrderListQuery({ ...params, ...change });
  return query ? `/purchase-orders?${query}` : "/purchase-orders";
}

/** 発注一覧（番号・仕入先・ステータス・期間で絞り込み、並べ替え、ページ送り、CSV 出力）。spec §5-6 */
export default async function PurchaseOrdersPage({
  searchParams,
}: PageProps<"/purchase-orders">) {
  const user = await requirePermission("view");
  const params = parsePurchaseOrderListParams(await searchParams);
  const db = getPrisma();
  const [result, suppliers] = await Promise.all([
    listPurchaseOrders(db, params),
    listSupplierOptions(db, { activeOnly: false }),
  ]);
  const shown = { ...params, page: result.page };
  const from = result.total === 0 ? 0 : (result.page - 1) * result.perPage + 1;
  const to = Math.min(result.page * result.perPage, result.total);
  const exportQuery = toPurchaseOrderListQuery({ ...params, page: 1 });
  const exportTooMany = result.total > PURCHASE_ORDER_EXPORT_MAX_ROWS;
  const exportTooManyMessage = `CSV 出力は ${formatNumber(PURCHASE_ORDER_EXPORT_MAX_ROWS)} 件までです。絞り込んでから出力してください`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-xl font-semibold tracking-tight">発注</h1>
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
            href={`/api/purchase-orders/export${exportQuery ? `?${exportQuery}` : ""}`}
            className={buttonVariants({ variant: "outline", size: "sm" })}
            download
          >
            CSV 出力
          </a>
        )}
        {can(user.role, "order:edit") && (
          <Link
            href="/purchase-orders/new"
            className={buttonVariants({ size: "sm" })}
          >
            新規作成
          </Link>
        )}
      </div>

      <Form
        action="/purchase-orders"
        className="flex flex-wrap items-end gap-2 rounded-xl border p-3"
      >
        <div className="grid w-full gap-1 sm:w-48">
          <label htmlFor="q" className="text-xs text-muted-foreground">
            発注番号
          </label>
          <Input
            id="q"
            name="q"
            type="search"
            defaultValue={params.q}
            placeholder="例 PO-20261013"
          />
        </div>
        <div className="grid w-full gap-1 sm:w-auto">
          <label htmlFor="supplier" className="text-xs text-muted-foreground">
            仕入先
          </label>
          <NativeSelect
            id="supplier"
            name="supplier"
            className="w-full sm:w-56"
            defaultValue={
              params.supplierId === null ? "" : String(params.supplierId)
            }
          >
            <NativeSelectOption value="">すべて</NativeSelectOption>
            {suppliers.map((s) => (
              <NativeSelectOption key={s.id} value={String(s.id)}>
                {s.code} {s.name}
                {s.isActive ? "" : "（無効）"}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1">
          <label htmlFor="status" className="text-xs text-muted-foreground">
            ステータス
          </label>
          <NativeSelect id="status" name="status" defaultValue={params.status}>
            <NativeSelectOption value="">すべて</NativeSelectOption>
            {PURCHASE_ORDER_STATUSES.map((s) => (
              <NativeSelectOption key={s} value={s}>
                {PURCHASE_ORDER_STATUS_LABELS[s]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <fieldset className="grid gap-1">
          <legend className="text-xs text-muted-foreground">発注日</legend>
          <div className="flex items-center gap-1">
            <Input
              id="from"
              name="from"
              type="date"
              aria-label="発注日（から）"
              className="w-40"
              defaultValue={params.from}
            />
            <span aria-hidden="true">〜</span>
            <Input
              id="to"
              name="to"
              type="date"
              aria-label="発注日（まで）"
              className="w-40"
              defaultValue={params.to}
            />
          </div>
        </fieldset>
        {/* 並べ替えは検索し直しても保つ（ページは 1 に戻す） */}
        <input type="hidden" name="sort" value={params.sort} />
        <input type="hidden" name="order" value={params.order} />
        <div className="flex gap-2">
          <Button type="submit">検索</Button>
          <Link
            href="/purchase-orders"
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
          ? "該当する発注はありません"
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
              {result.items.map((o) => (
                <TableRow
                  key={o.id}
                  className={cn(
                    o.status === "cancelled" && "text-muted-foreground",
                  )}
                >
                  <TableCell className="font-mono">
                    <Link
                      href={`/purchase-orders/${o.id}`}
                      className="underline-offset-4 hover:underline"
                    >
                      {o.number}
                    </Link>
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {displayDateOnly(o.orderDate)}
                  </TableCell>
                  <TableCell className="min-w-32 whitespace-normal">
                    {o.supplier.name}
                  </TableCell>
                  <TableCell>
                    <PurchaseOrderStatusBadge status={o.status} />
                  </TableCell>
                  <TableCell className="hidden tabular-nums md:table-cell">
                    {displayDateOnly(o.expectedDate)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(o.total)}
                  </TableCell>
                </TableRow>
              ))}
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
