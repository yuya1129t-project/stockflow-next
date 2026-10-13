import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { buttonVariants } from "@/components/ui/button";
import { requirePermission } from "@/lib/auth/guards";
import { getPrisma } from "@/lib/db";
import { formatDateOnly } from "@/lib/orders/dates";
import {
  getPurchaseOrder,
  listLineProductOptions,
  listSupplierOptions,
} from "@/lib/purchase-orders/queries";
import { toPurchaseOrderFormValues } from "@/lib/purchase-orders/schema";
import {
  isPurchaseOrderEditable,
  PURCHASE_ORDER_STATUS_LABELS,
} from "@/lib/purchase-orders/status";

import { updatePurchaseOrderAction } from "../../actions";
import { PurchaseOrderForm } from "../../purchase-order-form";
import { parsePurchaseOrderId } from "../purchase-order-id";

export const metadata: Metadata = { title: "発注の編集 | StockFlow" };

/** 発注の編集（admin／staff。下書きのときだけ）。spec §2・§4 */
export default async function EditPurchaseOrderPage({
  params,
}: PageProps<"/purchase-orders/[id]/edit">) {
  await requirePermission("order:edit");
  const id = parsePurchaseOrderId((await params).id);
  if (id === null) notFound();
  const db = getPrisma();
  const order = await getPurchaseOrder(db, id);
  if (!order) notFound();
  const detailHref = `/purchase-orders/${id}`;

  const header = (
    <div className="space-y-1">
      <Link
        href={detailHref}
        className="text-sm text-muted-foreground underline-offset-4 hover:underline"
      >
        ← 発注の詳細
      </Link>
      <h1 className="text-xl font-semibold tracking-tight">
        発注の編集
        <span className="ml-2 font-mono text-base font-normal text-muted-foreground">
          {order.number}
        </span>
      </h1>
    </div>
  );

  if (!isPurchaseOrderEditable(order.status)) {
    return (
      <div className="space-y-4">
        {header}
        <p role="status" className="rounded-lg border px-3 py-2 text-sm">
          この発注は「{PURCHASE_ORDER_STATUS_LABELS[order.status]}
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

  const [suppliers, products] = await Promise.all([
    listSupplierOptions(db, { activeOnly: true, includeId: order.supplierId }),
    listLineProductOptions(
      db,
      order.lines.map((l) => l.productId),
    ),
  ]);

  return (
    <div className="space-y-4">
      {header}
      <PurchaseOrderForm
        defaultValues={toPurchaseOrderFormValues(order)}
        orderDate={formatDateOnly(order.orderDate)}
        suppliers={suppliers}
        products={products}
        submitLabel="保存する"
        cancelHref={detailHref}
        reloadHref={`${detailHref}/edit`}
        // 画面を開いた時点の updatedAt を送り、保存の時点で変わっていれば保存しない（競合の検出）
        action={updatePurchaseOrderAction.bind(
          null,
          id,
          order.updatedAt.toISOString(),
        )}
      />
    </div>
  );
}
