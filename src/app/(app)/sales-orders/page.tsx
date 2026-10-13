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
  listSalesOrders,
  listCustomerOptions,
  SALES_ORDER_EXPORT_MAX_ROWS,
} from "@/lib/sales-orders/queries";
import {
  parseSalesOrderListParams,
  toSalesOrderListQuery,
  type SalesOrderListParams,
  type SalesOrderSortKey,
} from "@/lib/sales-orders/search-params";
import {
  SALES_ORDER_STATUS_LABELS,
  SALES_ORDER_STATUSES,
} from "@/lib/sales-orders/status";
import { cn } from "@/lib/utils";

import { PageLink } from "../stock/page-link";
import { SalesOrderStatusBadge } from "./status-badge";

export const metadata: Metadata = { title: "受注 | StockFlow" };

const COLUMNS: {
  label: string;
  sort?: SalesOrderSortKey;
  align?: "right";
  className?: string;
}[] = [
  { label: "受注番号", sort: "number" },
  { label: "受注日", sort: "orderDate" },
  { label: "顧客", sort: "customer" },
  { label: "ステータス" },
  {
    label: "納期",
    sort: "dueDate",
    className: "hidden md:table-cell",
  },
  { label: "合計（円）", sort: "total", align: "right" },
];

function href(
  params: SalesOrderListParams,
  change: Partial<SalesOrderListParams>,
) {
  const query = toSalesOrderListQuery({ ...params, ...change });
  return query ? `/sales-orders?${query}` : "/sales-orders";
}

/** 受注一覧（番号・顧客・ステータス・期間で絞り込み、並べ替え、ページ送り、CSV 出力）。spec §5-5 */
export default async function SalesOrdersPage({
  searchParams,
}: PageProps<"/sales-orders">) {
  const user = await requirePermission("view");
  const params = parseSalesOrderListParams(await searchParams);
  const db = getPrisma();
  const [result, customers] = await Promise.all([
    listSalesOrders(db, params),
    listCustomerOptions(db, { activeOnly: false }),
  ]);
  const shown = { ...params, page: result.page };
  const from = result.total === 0 ? 0 : (result.page - 1) * result.perPage + 1;
  const to = Math.min(result.page * result.perPage, result.total);
  const exportQuery = toSalesOrderListQuery({ ...params, page: 1 });
  const exportTooMany = result.total > SALES_ORDER_EXPORT_MAX_ROWS;
  const exportTooManyMessage = `CSV 出力は ${formatNumber(SALES_ORDER_EXPORT_MAX_ROWS)} 件までです。絞り込んでから出力してください`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-xl font-semibold tracking-tight">受注</h1>
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
            href={`/api/sales-orders/export${exportQuery ? `?${exportQuery}` : ""}`}
            className={buttonVariants({ variant: "outline", size: "sm" })}
            download
          >
            CSV 出力
          </a>
        )}
        {can(user.role, "order:edit") && (
          <Link
            href="/sales-orders/new"
            className={buttonVariants({ size: "sm" })}
          >
            新規作成
          </Link>
        )}
      </div>

      <Form
        action="/sales-orders"
        className="flex flex-wrap items-end gap-2 rounded-xl border p-3"
      >
        <div className="grid w-full gap-1 sm:w-48">
          <label htmlFor="q" className="text-xs text-muted-foreground">
            受注番号
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
          <label htmlFor="customer" className="text-xs text-muted-foreground">
            顧客
          </label>
          <NativeSelect
            id="customer"
            name="customer"
            className="w-full sm:w-56"
            defaultValue={
              params.customerId === null ? "" : String(params.customerId)
            }
          >
            <NativeSelectOption value="">すべて</NativeSelectOption>
            {customers.map((s) => (
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
            {SALES_ORDER_STATUSES.map((s) => (
              <NativeSelectOption key={s} value={s}>
                {SALES_ORDER_STATUS_LABELS[s]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <fieldset className="grid gap-1">
          <legend className="text-xs text-muted-foreground">受注日</legend>
          <div className="flex items-center gap-1">
            <Input
              id="from"
              name="from"
              type="date"
              aria-label="受注日（から）"
              className="w-40"
              defaultValue={params.from}
            />
            <span aria-hidden="true">〜</span>
            <Input
              id="to"
              name="to"
              type="date"
              aria-label="受注日（まで）"
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
            href="/sales-orders"
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
          ? "該当する受注はありません"
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
                      href={`/sales-orders/${o.id}`}
                      className="underline-offset-4 hover:underline"
                    >
                      {o.number}
                    </Link>
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {displayDateOnly(o.orderDate)}
                  </TableCell>
                  <TableCell className="min-w-32 whitespace-normal">
                    {o.customer.name}
                  </TableCell>
                  <TableCell>
                    <SalesOrderStatusBadge status={o.status} />
                  </TableCell>
                  <TableCell className="hidden tabular-nums md:table-cell">
                    {displayDateOnly(o.dueDate)}
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
