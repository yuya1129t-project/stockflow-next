"use server";

/**
 * 在庫の Server Action（棚卸調整）。
 *
 * 権限外・入力エラーは redirect / forbidden せず { ok: false, error } を返す（入力内容を消さない）。
 * Server Action は POST で呼ばれ、Next.js が Origin と Host の一致を確認する（CSRF 対策）
 */
import { revalidatePath } from "next/cache";

import { checkActionPermission } from "@/lib/auth/guards";
import { getPrisma } from "@/lib/db";
import { formatNumber, formatSignedNumber } from "@/lib/format";
import { adjustStock, type StockMutationError } from "@/lib/stock/service";

/** 棚卸調整（admin／staff）。成功したら結果のメッセージを返す（画面は再描画される） */
export async function adjustStockAction(
  productId: number,
  input: unknown,
): Promise<
  { ok: true; recorded: boolean; message: string } | StockMutationError
> {
  const check = await checkActionPermission("stock:adjust");
  if (!check.ok) return check;
  if (!Number.isSafeInteger(productId)) {
    return { ok: false, error: "商品が見つかりません" };
  }
  const result = await adjustStock(getPrisma(), check.user, productId, input);
  if (!result.ok) return result;
  const { recorded, before, after, delta } = result.data;
  if (!recorded) {
    return {
      ok: true,
      recorded: false,
      message: `実数が現在庫（${formatNumber(before)}）と同じため、記録しませんでした`,
    };
  }
  // 在庫一覧・入出庫履歴・商品の一覧と詳細（現在庫を表示している）を最新にする
  revalidatePath("/stock", "layout");
  revalidatePath("/products", "layout");
  return {
    ok: true,
    recorded: true,
    message: `棚卸調整を記録しました（${formatNumber(before)} → ${formatNumber(after)}、差分 ${formatSignedNumber(delta)}）`,
  };
}
