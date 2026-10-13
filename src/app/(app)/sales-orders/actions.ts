"use server";

/**
 * 受注の Server Action（作成・編集・ステータス変更）。
 *
 * 権限外・入力エラーは redirect / forbidden せず { ok: false, error } を返す（入力内容を消さない）。
 * Server Action は POST で呼ばれ、Next.js が Origin と Host の一致を確認する（CSRF 対策）
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { checkActionPermission } from "@/lib/auth/guards";
import { getPrisma } from "@/lib/db";
import { notifyReorderPointAfterResponse } from "@/lib/notifications/reorder-point";
import { isValidDbId } from "@/lib/orders/schema";
import {
  changeSalesOrderStatus,
  createSalesOrder,
  updateSalesOrder,
  type SalesOrderMutationError,
} from "@/lib/sales-orders/service";

const NOT_FOUND: SalesOrderMutationError = {
  ok: false,
  error: "受注が見つかりません",
};

function refreshSalesOrderPages() {
  revalidatePath("/sales-orders", "layout");
}

/** 作成。成功したら詳細画面へ移動する */
export async function createSalesOrderAction(
  input: unknown,
): Promise<SalesOrderMutationError> {
  const check = await checkActionPermission("order:edit");
  if (!check.ok) return check;
  const result = await createSalesOrder(getPrisma(), check.user, input);
  if (!result.ok) return result;
  refreshSalesOrderPages();
  redirect(`/sales-orders/${result.data.id}?saved=created`);
}

/** 編集（draft のみ）。expectedUpdatedAt は画面を開いた時点の updatedAt。成功したら詳細画面へ移動する */
export async function updateSalesOrderAction(
  id: number,
  expectedUpdatedAt: string,
  input: unknown,
): Promise<SalesOrderMutationError> {
  const check = await checkActionPermission("order:edit");
  if (!check.ok) return check;
  if (!isValidDbId(id)) return NOT_FOUND;
  const result = await updateSalesOrder(
    getPrisma(),
    check.user,
    id,
    input,
    expectedUpdatedAt,
  );
  if (!result.ok) return result;
  refreshSalesOrderPages();
  redirect(`/sales-orders/${id}?saved=updated`);
}

/**
 * ステータス変更。expectedUpdatedAt は詳細画面に表示した時点の updatedAt（変わっていれば変更しない）。
 * 出荷では在庫が変わるので、在庫・商品の画面も最新にする。在庫が足りなければ shortages（不足する商品と数量）を返す。
 * 出荷で発注点割れに変わった商品（fellBelowReorderPoint）は、トランザクション確定後のここから、応答を返した後に通知する（#12）
 */
export async function changeSalesOrderStatusAction(
  id: number,
  to: string,
  expectedUpdatedAt: string,
): Promise<{ ok: true } | SalesOrderMutationError> {
  const check = await checkActionPermission("order:edit");
  if (!check.ok) return check;
  if (!isValidDbId(id)) return NOT_FOUND;
  const result = await changeSalesOrderStatus(
    getPrisma(),
    check.user,
    id,
    to,
    expectedUpdatedAt,
  );
  if (!result.ok) return result;
  refreshSalesOrderPages();
  if (result.data.to === "shipped") {
    revalidatePath("/stock", "layout");
    revalidatePath("/products", "layout");
    notifyReorderPointAfterResponse({
      crossings: result.data.fellBelowReorderPoint,
      trigger: {
        kind: "sales_order_shipped",
        salesOrderId: id,
        number: result.data.number,
      },
      userId: check.user.id,
    });
  }
  return { ok: true };
}
