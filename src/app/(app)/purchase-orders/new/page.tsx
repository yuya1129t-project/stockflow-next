import type { Metadata } from "next";
import Link from "next/link";

import { requirePermission } from "@/lib/auth/guards";
import { getPrisma } from "@/lib/db";
import { todayInTokyo } from "@/lib/orders/dates";
import {
  listLineProductOptions,
  listSupplierOptions,
} from "@/lib/purchase-orders/queries";
import { emptyPurchaseOrderForm } from "@/lib/purchase-orders/schema";

import { createPurchaseOrderAction } from "../actions";
import { PurchaseOrderForm } from "../purchase-order-form";

export const metadata: Metadata = { title: "発注の作成 | StockFlow" };

/** 発注の作成（admin／staff）。spec §2 */
export default async function NewPurchaseOrderPage() {
  await requirePermission("order:edit");
  const db = getPrisma();
  const [suppliers, products] = await Promise.all([
    listSupplierOptions(db, { activeOnly: true }),
    listLineProductOptions(db),
  ]);
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Link
          href="/purchase-orders"
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          ← 発注一覧
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">発注の作成</h1>
        <p className="text-sm text-muted-foreground">
          下書きとして保存します。発注番号は保存したときに採番します
        </p>
      </div>
      <PurchaseOrderForm
        defaultValues={emptyPurchaseOrderForm()}
        orderDate={todayInTokyo()}
        suppliers={suppliers}
        products={products}
        submitLabel="下書きを保存する"
        cancelHref="/purchase-orders"
        action={createPurchaseOrderAction}
      />
    </div>
  );
}
