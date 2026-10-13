import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { buttonVariants } from "@/components/ui/button";
import { requirePermission } from "@/lib/auth/guards";
import { getPrisma } from "@/lib/db";
import { formatDateOnly } from "@/lib/orders/dates";
import {
  getSalesOrder,
  listLineProductOptions,
  listCustomerOptions,
} from "@/lib/sales-orders/queries";
import { toSalesOrderFormValues } from "@/lib/sales-orders/schema";
import {
  isSalesOrderEditable,
  SALES_ORDER_STATUS_LABELS,
} from "@/lib/sales-orders/status";

import { updateSalesOrderAction } from "../../actions";
import { SalesOrderForm } from "../../sales-order-form";
import { parseSalesOrderId } from "../sales-order-id";

export const metadata: Metadata = { title: "受注の編集 | StockFlow" };

/** 受注の編集（admin／staff。下書きのときだけ）。spec §2・§4 */
export default async function EditSalesOrderPage({
  params,
}: PageProps<"/sales-orders/[id]/edit">) {
  await requirePermission("order:edit");
  const id = parseSalesOrderId((await params).id);
  if (id === null) notFound();
  const db = getPrisma();
  const order = await getSalesOrder(db, id);
  if (!order) notFound();
  const detailHref = `/sales-orders/${id}`;

  const header = (
    <div className="space-y-1">
      <Link
        href={detailHref}
        className="text-sm text-muted-foreground underline-offset-4 hover:underline"
      >
        ← 受注の詳細
      </Link>
      <h1 className="text-xl font-semibold tracking-tight">
        受注の編集
        <span className="ml-2 font-mono text-base font-normal text-muted-foreground">
          {order.number}
        </span>
      </h1>
    </div>
  );

  if (!isSalesOrderEditable(order.status)) {
    return (
      <div className="space-y-4">
        {header}
        <p role="status" className="rounded-lg border px-3 py-2 text-sm">
          この受注は「{SALES_ORDER_STATUS_LABELS[order.status]}
          」のため編集できません（編集できるのは下書きだけです）
        </p>
        <Link
          href={detailHref}
          className={buttonVariants({ variant: "outline" })}
        >
          詳細に戻る
        </Link>
      </div>
    );
  }

  const [customers, products] = await Promise.all([
    listCustomerOptions(db, { activeOnly: true, includeId: order.customerId }),
    listLineProductOptions(
      db,
      order.lines.map((l) => l.productId),
    ),
  ]);

  return (
    <div className="space-y-4">
      {header}
      <SalesOrderForm
        defaultValues={toSalesOrderFormValues(order)}
        orderDate={formatDateOnly(order.orderDate)}
        customers={customers}
        products={products}
        submitLabel="保存する"
        cancelHref={detailHref}
        reloadHref={`${detailHref}/edit`}
        // 画面を開いた時点の updatedAt を送り、保存の時点で変わっていれば保存しない（競合の検出）
        action={updateSalesOrderAction.bind(
          null,
          id,
          order.updatedAt.toISOString(),
        )}
      />
    </div>
  );
}
