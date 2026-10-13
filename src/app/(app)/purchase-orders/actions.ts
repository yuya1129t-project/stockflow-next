"use server";

/**
 * 発注の Server Action（作成・編集・ステータス変更）。
 *
 * 権限外・入力エラーは redirect / forbidden せず { ok: false, error } を返す（入力内容を消さない）。
 * Server Action は POST で呼ばれ、Next.js が Origin と Host の一致を確認する（CSRF 対策）
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { checkActionPermission } from "@/lib/auth/guards";
import { getPrisma } from "@/lib/db";
import { isValidDbId } from "@/lib/orders/schema";
import {
  changePurchaseOrderStatus,
  createPurchaseOrder,
  updatePurchaseOrder,
  type PurchaseOrderMutationError,
} from "@/lib/purchase-orders/service";

const NOT_FOUND: PurchaseOrderMutationError = {
  ok: false,
  error: "発注が見つかりません",
};

function refreshPurchaseOrderPages() {
  revalidatePath("/purchase-orders", "layout");
}

/** 作成。成功したら詳細画面へ移動する */
export async function createPurchaseOrderAction(
  input: unknown,
): Promise<PurchaseOrderMutationError> {
  const check = await checkActionPermission("order:edit");
  if (!check.ok) return check;
  const result = await createPurchaseOrder(getPrisma(), check.user, input);
  if (!result.ok) return result;
  refreshPurchaseOrderPages();
  redirect(`/purchase-orders/${result.data.id}?saved=created`);
}

/** 編集（draft のみ）。expectedUpdatedAt は画面を開いた時点の updatedAt。成功したら詳細画面へ移動する */
export async function updatePurchaseOrderAction(
  id: number,
  expectedUpdatedAt: string,
  input: unknown,
): Promise<PurchaseOrderMutationError> {
  const check = await checkActionPermission("order:edit");
  if (!check.ok) return check;
  if (!isValidDbId(id)) return NOT_FOUND;
  const result = await updatePurchaseOrder(
    getPrisma(),
    check.user,
    id,
    input,
    expectedUpdatedAt,
  );
  if (!result.ok) return result;
  refreshPurchaseOrderPages();
  redirect(`/purchase-orders/${id}?saved=updated`);
}

/**
 * ステータス変更。expectedUpdatedAt は詳細画面に表示した時点の updatedAt（変わっていれば変更しない）。
 * 入荷では在庫が変わるので、在庫・商品の画面も最新にする
 */
export async function changePurchaseOrderStatusAction(
  id: number,
  to: string,
  expectedUpdatedAt: string,
): Promise<{ ok: true } | PurchaseOrderMutationError> {
  const check = await checkActionPermission("order:edit");
  if (!check.ok) return check;
  if (!isValidDbId(id)) return NOT_FOUND;
  const result = await changePurchaseOrderStatus(
    getPrisma(),
    check.user,
    id,
    to,
    expectedUpdatedAt,
  );
  if (!result.ok) return result;
  refreshPurchaseOrderPages();
  if (result.data.to === "received") {
    revalidatePath("/stock", "layout");
    revalidatePath("/products", "layout");
  }
  return { ok: true };
}
