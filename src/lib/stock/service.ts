/**
 * 在庫の更新系（棚卸調整）。サーバー側でだけ使う。docs/spec.md §2・§4
 *
 * - 権限は Server Action（checkActionPermission）で検査したうえで、ここでも操作したユーザーのロールを検査する
 * - 入力は必ずここで Zod スキーマ（画面と共通）で検証する
 * - 入出庫と操作履歴（AuditLog）は同じトランザクションで書く
 */
import type { PrismaClient } from "@/generated/prisma/client";
import {
  authErrorMessage,
  authorize,
  type SessionUser,
} from "@/lib/auth/session";
import { formatNumber, formatSignedNumber } from "@/lib/format";
import { PRODUCT_TARGET_TYPE } from "@/lib/products/service";

import { lockProductsForStock, recordStockMovements } from "./movements";
import { adjustmentDelta, type ReorderPointCrossing } from "./rules";
import {
  stockAdjustFieldErrors,
  stockAdjustSchema,
  type StockAdjustFieldErrors,
} from "./schema";

export type StockMutationError = {
  ok: false;
  error: string;
  fieldErrors?: StockAdjustFieldErrors;
};

export interface StockAdjustResult {
  /** 記録したか（実数が現在庫と同じなら記録しない） */
  recorded: boolean;
  before: number;
  after: number;
  /** 記録した差分（記録しなかったときは 0） */
  delta: number;
  /** 「発注点以上 → 発注点未満」に変わった商品（#12 の通知で使う） */
  fellBelowReorderPoint: ReorderPointCrossing[];
}

/** 操作履歴の action（targetType は商品） */
export const STOCK_ADJUST_ACTION = "stock_adjust";

/**
 * 棚卸調整: 実数を入力 → 現在庫との差分を adjust として記録する（spec §4）。
 * 差分は商品の行ロックを取った後の現在庫から求める（画面を開いた後に入出庫があっても、記録後の在庫は実数になる）。
 * 差分が 0 なら何も記録しない（操作履歴も残さない）
 */
export async function adjustStock(
  db: PrismaClient,
  user: SessionUser | null,
  productId: number,
  input: unknown,
): Promise<{ ok: true; data: StockAdjustResult } | StockMutationError> {
  const auth = authorize(user, "stock:adjust");
  if (!auth.ok) return { ok: false, error: authErrorMessage(auth.status) };
  const parsed = stockAdjustSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "入力内容に誤りがあります。各項目を確認してください",
      fieldErrors: stockAdjustFieldErrors(parsed.error),
    };
  }
  const { actualQuantity, reason } = parsed.data;

  return db.$transaction(async (tx) => {
    const [product] = await lockProductsForStock(tx, [productId]);
    if (!product) {
      return { ok: false as const, error: "商品が見つかりません" };
    }
    const before = product.stock;
    const delta = adjustmentDelta(before, actualQuantity);
    if (delta === 0) {
      return {
        ok: true as const,
        data: {
          recorded: false,
          before,
          after: before,
          delta: 0,
          fellBelowReorderPoint: [],
        },
      };
    }
    const recorded = await recordStockMovements(tx, auth.user.id, [
      { productId, type: "adjust", quantity: delta, reason },
    ]);
    await tx.auditLog.create({
      data: {
        userId: auth.user.id,
        action: STOCK_ADJUST_ACTION,
        targetType: PRODUCT_TARGET_TYPE,
        targetId: String(productId),
        summary: `商品 ${product.code} の在庫を棚卸で調整しました（${formatNumber(before)} → ${formatNumber(actualQuantity)}${product.unit}、差分 ${formatSignedNumber(delta)}、理由: ${reason}）`,
      },
    });
    return {
      ok: true as const,
      data: {
        recorded: true,
        before,
        after: actualQuantity,
        delta,
        fellBelowReorderPoint: recorded.fellBelowReorderPoint,
      },
    };
  });
}
