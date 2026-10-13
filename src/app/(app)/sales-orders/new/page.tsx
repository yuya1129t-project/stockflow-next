import type { Metadata } from "next";
import Link from "next/link";

import { requirePermission } from "@/lib/auth/guards";
import { getPrisma } from "@/lib/db";
import { todayInTokyo } from "@/lib/orders/dates";
import {
  listLineProductOptions,
  listCustomerOptions,
} from "@/lib/sales-orders/queries";
import { emptySalesOrderForm } from "@/lib/sales-orders/schema";

import { createSalesOrderAction } from "../actions";
import { SalesOrderForm } from "../sales-order-form";

export const metadata: Metadata = { title: "受注の作成 | StockFlow" };

/** 受注の作成（admin／staff）。spec §2 */
export default async function NewSalesOrderPage() {
  await requirePermission("order:edit");
  const db = getPrisma();
  const [customers, products] = await Promise.all([
    listCustomerOptions(db, { activeOnly: true }),
    listLineProductOptions(db),
  ]);
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Link
          href="/sales-orders"
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          ← 受注一覧
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">受注の作成</h1>
        <p className="text-sm text-muted-foreground">
          下書きとして保存します。受注番号は保存したときに採番します
        </p>
      </div>
      <SalesOrderForm
        defaultValues={emptySalesOrderForm()}
        orderDate={todayInTokyo()}
        customers={customers}
        products={products}
        submitLabel="下書きを保存する"
        cancelHref="/sales-orders"
        action={createSalesOrderAction}
      />
    </div>
  );
}
