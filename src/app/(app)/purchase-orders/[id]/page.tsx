import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { requirePermission } from "@/lib/auth/guards";
import { can } from "@/lib/auth/permissions";
import { getPrisma } from "@/lib/db";
import { formatDateTime, formatNumber } from "@/lib/format";
import { lineAmount } from "@/lib/orders/amounts";
import { displayDateOnly } from "@/lib/orders/dates";
import { getPurchaseOrder } from "@/lib/purchase-orders/queries";
import {
  isPurchaseOrderEditable,
  nextPurchaseOrderStatuses,
  PURCHASE_ORDER_STATUS_LABELS,
} from "@/lib/purchase-orders/status";

import { PurchaseOrderStatusBadge } from "../status-badge";
import { parsePurchaseOrderId } from "./purchase-order-id";
import { PurchaseOrderStatusActions } from "./status-actions";

export const metadata: Metadata = { title: "発注の詳細 | StockFlow" };

const SAVED_MESSAGES: Record<string, string> = {
  created: "発注を作成しました（下書き）",
  updated: "発注を保存しました",
  ordered: "発注済にしました",
  received: "入荷済にしました（全明細の数量を在庫に入庫しました）",
  cancelled: "発注を取り消しました",
};

/** 発注の詳細（全ロール閲覧可）。編集・ステータス変更は admin／staff（spec §2） */
export default async function PurchaseOrderDetailPage({
  params,
  searchParams,
}: PageProps<"/purchase-orders/[id]">) {
  const user = await requirePermission("view");
  const id = parsePurchaseOrderId((await params).id);
  if (id === null) notFound();
  const order = await getPurchaseOrder(getPrisma(), id);
  if (!order) notFound();
  const saved = (await searchParams).saved;
  const savedMessage =
    typeof saved === "string" ? SAVED_MESSAGES[saved] : undefined;
  const canEdit = can(user.role, "order:edit");
  const targets = nextPurchaseOrderStatuses(order.status).filter(
    (s) => s !== "draft",
  );

  const rows: [string, ReactNode][] = [
    [
      "発注番号",
      <span key="number" className="font-mono">
        {order.number}
      </span>,
    ],
    [
      "ステータス",
      <PurchaseOrderStatusBadge key="status" status={order.status} />,
    ],
    [
      "仕入先",
      <span key="supplier">
        <Link
          href={`/partners/${order.supplier.id}`}
          className="underline-offset-4 hover:underline"
        >
          <span className="font-mono">{order.supplier.code}</span>{" "}
          {order.supplier.name}
        </Link>
        {!order.supplier.isActive && (
          <Badge variant="outline" className="ml-1">
            無効
          </Badge>
        )}
      </span>,
    ],
    ["発注日", displayDateOnly(order.orderDate)],
    ["入荷予定日", displayDateOnly(order.expectedDate)],
    [
      "備考",
      order.note ? (
        <span key="note" className="whitespace-pre-wrap">
          {order.note}
        </span>
      ) : (
        "—"
      ),
    ],
    ["最終更新", formatDateTime(order.updatedAt)],
  ];

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Link
          href="/purchase-orders"
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          ← 発注一覧
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">
          発注 <span className="font-mono">{order.number}</span>
        </h1>
      </div>

      {savedMessage && (
        <p
          role="status"
          className="rounded-lg border border-emerald-600/30 bg-emerald-600/5 px-3 py-2 text-sm"
        >
          {savedMessage}
        </p>
      )}

      <dl className="grid max-w-xl grid-cols-[7rem_1fr] gap-x-4 gap-y-2 rounded-xl border p-4 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 break-words">{value}</dd>
          </div>
        ))}
      </dl>

      <section className="space-y-2">
        <h2 className="text-base font-semibold">明細</h2>
        {order.lines.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            明細はありません（発注済にするには 1 行以上必要です）
          </p>
        ) : (
          <div className="max-w-4xl rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>商品</TableHead>
                  <TableHead className="text-right">数量</TableHead>
                  <TableHead className="text-right">単価</TableHead>
                  <TableHead className="text-right">金額</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {order.lines.map((line) => (
                  <TableRow key={line.id}>
                    <TableCell className="min-w-40 whitespace-normal">
                      <Link
                        href={`/stock/${line.product.id}`}
                        className="underline-offset-4 hover:underline"
                      >
                        <span className="font-mono">{line.product.code}</span>{" "}
                        {line.product.name}
                      </Link>
                      {!line.product.isActive && (
                        <Badge variant="outline" className="ml-1">
                          無効
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(line.quantity)} {line.product.unit}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(line.unitPrice)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(lineAmount(line))}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                {(
                  [
                    ["小計", order.subtotal],
                    ["消費税（10%）", order.tax],
                    ["合計", order.total],
                  ] as const
                ).map(([label, value]) => (
                  <TableRow key={label}>
                    <TableCell colSpan={3} className="text-right">
                      {label}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(value)} 円
                    </TableCell>
                  </TableRow>
                ))}
              </TableFooter>
            </Table>
          </div>
        )}
      </section>

      {canEdit &&
        (isPurchaseOrderEditable(order.status) || targets.length > 0) && (
          <section className="space-y-2">
            <h2 className="text-base font-semibold">操作</h2>
            {isPurchaseOrderEditable(order.status) && (
              <Link
                href={`/purchase-orders/${order.id}/edit`}
                className={buttonVariants({ variant: "outline" })}
              >
                編集する
              </Link>
            )}
            {targets.length > 0 && (
              <PurchaseOrderStatusActions
                id={order.id}
                number={order.number}
                updatedAt={order.updatedAt.toISOString()}
                targets={targets}
              />
            )}
          </section>
        )}
      {(order.status === "received" || order.status === "cancelled") && (
        <p className="text-sm text-muted-foreground">
          「{PURCHASE_ORDER_STATUS_LABELS[order.status]}
          」は最終状態のため、ステータスは変更できません
          {order.status === "received" &&
            "（入荷した数量は各商品の入出庫履歴に入庫として記録されています）"}
        </p>
      )}
    </div>
  );
}
