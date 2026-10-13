import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { requirePermission } from "@/lib/auth/guards";
import { purchaseOrderPath, salesOrderPath } from "@/lib/dashboard/paths";
import type { MonthOverMonth } from "@/lib/dashboard/period";
import {
  getDashboardData,
  type DashboardOrderItem,
  type MonthlySales,
} from "@/lib/dashboard/queries";
import { getPrisma } from "@/lib/db";
import { formatNumber } from "@/lib/format";
import { toStockListQuery } from "@/lib/stock/search-params";
import { cn } from "@/lib/utils";

import { SalesTrendChart } from "./sales-trend-chart";

export const metadata: Metadata = { title: "ダッシュボード | StockFlow" };

const LOW_STOCK_HREF = `/stock?${toStockListQuery({ level: "low" })}`;

/** YYYY-MM-DD → YYYY/MM/DD */
function formatDate(ymd: string): string {
  return ymd.replaceAll("-", "/");
}

function monthLabel({ year, month }: MonthlySales): string {
  return `${year}年${month}月`;
}

function Card({
  title,
  action,
  children,
  className,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "flex min-w-0 flex-col gap-3 rounded-xl border p-4",
        className,
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium text-muted-foreground">{title}</h2>
        {action && <span className="shrink-0 whitespace-nowrap">{action}</span>}
      </div>
      {children}
    </section>
  );
}

/** 増減率（小数 1 桁）。丸めると 0 になる値は "±0%"（"+0.0%"・"-0.0%" と出さない） */
function formatRate(rate: number): string {
  const rounded = Number(rate.toFixed(1));
  if (rounded === 0) return "±0%";
  return `${rounded > 0 ? "+" : ""}${rounded.toFixed(1)}%`;
}

function ChangeText({ change }: { change: MonthOverMonth }) {
  const sign = change.diff > 0 ? "+" : "";
  const arrow = change.diff > 0 ? "↑" : change.diff < 0 ? "↓" : "→";
  return (
    <div className="space-y-0.5">
      <p className="text-sm text-muted-foreground">
        前月比{" "}
        <span className="font-medium text-foreground tabular-nums">
          <span aria-hidden="true">{arrow} </span>
          {sign}
          {formatNumber(change.diff)} 円
          {change.rate === null
            ? "（前月の受注なし）"
            : `（${formatRate(change.rate)}）`}
        </span>
      </p>
      <p className="text-xs text-muted-foreground">
        ※今月は本日までの合計、前月は月全体の合計との比較です
      </p>
    </div>
  );
}

/** 伝票の一覧（hrefOf があれば番号を詳細へのリンクにする） */
function OrderList({
  items,
  dateLabel,
  overdueLabel,
  hrefOf,
}: {
  items: DashboardOrderItem[];
  dateLabel: string;
  overdueLabel: string;
  hrefOf?: (id: number) => string;
}) {
  return (
    <ul className="divide-y text-sm">
      {items.map((o) => (
        <li
          key={o.id}
          className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 py-1.5"
        >
          <span className="min-w-0">
            {hrefOf ? (
              <Link
                href={hrefOf(o.id)}
                className="font-mono underline-offset-4 hover:underline"
              >
                {o.number}
              </Link>
            ) : (
              <span className="font-mono">{o.number}</span>
            )}
            <span className="ml-2 text-muted-foreground">{o.partnerName}</span>
          </span>
          <span
            className={cn(
              "inline-flex items-center gap-1.5 tabular-nums",
              o.overdue && "font-semibold text-destructive",
            )}
          >
            {o.overdue && <Badge variant="destructive">{overdueLabel}</Badge>}
            {dateLabel} {o.date ? formatDate(o.date) : "未設定"}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** ダッシュボード（ログイン後のトップ。全ロールが閲覧可）。spec §5-2 */
export default async function Home() {
  await requirePermission("view");
  const data = await getDashboardData(getPrisma());
  const { sales, unshipped, lowStock, awaitingReceipt } = data;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold tracking-tight">ダッシュボード</h1>
        <p className="text-xs text-muted-foreground">
          {formatDate(data.today)} 時点
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card title={`今月の受注額（${monthLabel(sales.current)}）`}>
          <p className="text-2xl font-semibold tabular-nums">
            {formatNumber(sales.current.total)}
            <span className="ml-1 text-sm font-normal">円</span>
          </p>
          <ChangeText change={sales.change} />
          <p className="text-xs text-muted-foreground">
            確定・出荷済の受注の合計（税込・受注日基準）
          </p>
        </Card>

        <Card title="未出荷の受注">
          <p className="text-2xl font-semibold tabular-nums">
            {formatNumber(unshipped.count)}
            <span className="ml-1 text-sm font-normal">件</span>
          </p>
          <p
            className={cn(
              "text-sm",
              unshipped.overdueCount > 0
                ? "font-semibold text-destructive"
                : "text-muted-foreground",
            )}
          >
            うち納期切れ {formatNumber(unshipped.overdueCount)} 件
          </p>
          <p className="text-xs text-muted-foreground">確定済で未出荷の受注</p>
        </Card>

        <Card
          title="発注点を下回る商品"
          action={
            <Link
              href={LOW_STOCK_HREF}
              className="text-sm underline-offset-4 hover:underline"
            >
              在庫を見る
            </Link>
          }
        >
          <p
            className={cn(
              "text-2xl font-semibold tabular-nums",
              lowStock.count > 0 && "text-destructive",
            )}
          >
            {formatNumber(lowStock.count)}
            <span className="ml-1 text-sm font-normal">件</span>
          </p>
          <p className="text-xs text-muted-foreground">
            有効な商品で 現在庫 &lt; 発注点
          </p>
        </Card>

        <Card title="入荷待ちの発注">
          <p className="text-2xl font-semibold tabular-nums">
            {formatNumber(awaitingReceipt.count)}
            <span className="ml-1 text-sm font-normal">件</span>
          </p>
          <p
            className={cn(
              "text-sm",
              awaitingReceipt.overdueCount > 0
                ? "font-semibold text-destructive"
                : "text-muted-foreground",
            )}
          >
            うち予定日超過 {formatNumber(awaitingReceipt.overdueCount)} 件
          </p>
          <p className="text-xs text-muted-foreground">発注済で未入荷の発注</p>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="月別の受注額（直近6か月）">
          <SalesTrendChart months={sales.trend} />
        </Card>

        <Card
          title="発注点を下回る商品（不足の大きい順）"
          action={
            <Link
              href={LOW_STOCK_HREF}
              className="text-sm underline-offset-4 hover:underline"
            >
              すべて見る
            </Link>
          }
        >
          {lowStock.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              発注点を下回る商品はありません
            </p>
          ) : (
            <ul className="divide-y text-sm">
              {lowStock.items.map((p) => (
                <li
                  key={p.id}
                  className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 py-1.5"
                >
                  <span className="min-w-0">
                    <Link
                      href={`/stock/${p.id}`}
                      className="font-mono underline-offset-4 hover:underline"
                    >
                      {p.code}
                    </Link>
                    <span className="ml-2">{p.name}</span>
                  </span>
                  <span className="text-muted-foreground tabular-nums">
                    在庫 {formatNumber(p.stock)} / 発注点{" "}
                    {formatNumber(p.reorderPoint)}
                    <span className="ml-2 font-semibold text-destructive">
                      不足 {formatNumber(p.shortage)}
                      {p.unit}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="納期を過ぎた未出荷の受注（納期の古い順）">
          {unshipped.overdue.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              納期を過ぎた受注はありません
            </p>
          ) : (
            <>
              <OrderList
                items={unshipped.overdue}
                dateLabel="納期"
                overdueLabel="納期切れ"
                hrefOf={salesOrderPath}
              />
              {unshipped.overdueCount > unshipped.overdue.length && (
                <p className="text-xs text-muted-foreground">
                  他{" "}
                  {formatNumber(
                    unshipped.overdueCount - unshipped.overdue.length,
                  )}{" "}
                  件
                </p>
              )}
            </>
          )}
        </Card>

        <Card title="入荷待ちの発注（入荷予定日の近い順）">
          {awaitingReceipt.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              入荷待ちの発注はありません
            </p>
          ) : (
            <OrderList
              items={awaitingReceipt.items}
              dateLabel="予定"
              overdueLabel="予定日超過"
              hrefOf={purchaseOrderPath}
            />
          )}
        </Card>
      </div>
    </div>
  );
}
