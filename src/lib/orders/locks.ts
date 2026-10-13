/**
 * 受注・発注の作成・更新で、取引先と明細の商品を検査する（サーバー側でだけ使う）。
 *
 * どちらも伝票を書くトランザクションの中で、行を FOR SHARE でロックしてから検査する。
 * - 取引先: 種別（spec §3: 顧客は customer か both、仕入先は supplier か both）と有効を検査する。
 *   取引先の編集（src/lib/partners/service.ts）は行を FOR NO KEY UPDATE でロックしてから受注・発注の件数を数えるので、
 *   「伝票を作成する」と「その役割を外す種別変更」が同時に走っても、片方は他方の確定を待ってから判定する
 * - 商品: 存在と有効を検査する（無効な商品は新規の受注・発注で選べない。spec §3）。無効化（商品の UPDATE）と競合する。
 *   ロックは id の順にまとめて 1 回で取る（在庫の記録 src/lib/stock/movements.ts と同じ順番。デッドロックを避ける）
 *
 * 注意（受注の出荷・発注の入荷など、在庫を記録するトランザクション）:
 * lockProductsForLines（FOR SHARE）は、同じトランザクションで在庫の記録（lockProductsForStock／recordStockMovements の
 * FOR NO KEY UPDATE）と併用しない。FOR SHARE を持った 2 本が同じ商品で FOR NO KEY UPDATE への引き上げを互いに待ち、
 * デッドロックする。withStockTransaction の tx で呼ぶと例外にしている。在庫を記録するトランザクションで商品の有効などを
 * 確かめたいときは、lockProductsForStock(tx, 全商品) の結果（isActive・code・name を含む）で検査してから、
 * 同じ tx で recordStockMovements を呼ぶ（同じ強さのロックを取り直すだけなのでデッドロックしない）
 */
import { Prisma } from "@/generated/prisma/client";
import { isStockTransaction } from "@/lib/stock/movements";
import {
  hasPartnerRole,
  type PartnerKind,
  type PartnerRole,
} from "@/lib/partners/schema";

import type { OrderFieldErrors } from "./schema";

const ROLE_LABELS: Record<PartnerRole, string> = {
  customer: "顧客",
  supplier: "仕入先",
};

export interface LockedPartner {
  id: number;
  code: string;
  name: string;
}

/**
 * 取引先の行を FOR SHARE でロックし、役割（顧客・仕入先）と有効を検査する。
 * 問題があれば画面に出すメッセージを返す
 */
export async function lockPartnerForRole(
  tx: Prisma.TransactionClient,
  partnerId: number,
  role: PartnerRole,
): Promise<
  { ok: true; partner: LockedPartner } | { ok: false; message: string }
> {
  const label = ROLE_LABELS[role];
  const [partner] = await tx.$queryRaw<
    (LockedPartner & { kind: PartnerKind; isActive: boolean })[]
  >`
    SELECT "id", "code", "name", "kind", "isActive"
    FROM "partner"
    WHERE "id" = ${partnerId}
    FOR SHARE`;
  if (!partner) return { ok: false, message: `${label}が見つかりません` };
  if (!hasPartnerRole(partner.kind, role)) {
    return {
      ok: false,
      message: `${partner.code}「${partner.name}」は${label}ではありません（種別が「${label}」か「顧客・仕入先」の取引先を選んでください）`,
    };
  }
  if (!partner.isActive) {
    return {
      ok: false,
      message: `${partner.code}「${partner.name}」は無効になっているため選べません`,
    };
  }
  return {
    ok: true,
    partner: { id: partner.id, code: partner.code, name: partner.name },
  };
}

export interface LockedProduct {
  id: number;
  code: string;
  name: string;
  unit: string;
  isActive: boolean;
}

/**
 * 明細の商品の行を id の順に FOR SHARE でロックして読む（存在しない商品は含まれない）。
 *
 * 伝票の作成・編集（在庫を記録しないトランザクション）専用。在庫を記録するトランザクション（withStockTransaction の tx）
 * では使わない（ロックの引き上げでデッドロックするため。ファイル冒頭の注意を参照）。その tx で呼ぶと例外にする。
 * 在庫を記録するトランザクションで商品を検査するときは lockProductsForStock の結果を使う
 */
export async function lockProductsForLines(
  tx: Prisma.TransactionClient,
  productIds: readonly number[],
): Promise<Map<number, LockedProduct>> {
  if (isStockTransaction(tx)) {
    throw new Error(
      "lockProductsForLines（FOR SHARE）は在庫を記録するトランザクションでは使えません（デッドロックするため）。lockProductsForStock の結果で検査してください",
    );
  }
  const ids = [...new Set(productIds)].sort((a, b) => a - b);
  if (ids.length === 0) return new Map();
  const rows = await tx.$queryRaw<LockedProduct[]>`
    SELECT "id", "code", "name", "unit", "isActive"
    FROM "product"
    WHERE "id" IN (${Prisma.join(ids)})
    ORDER BY "id"
    FOR SHARE`;
  return new Map(rows.map((p) => [p.id, p]));
}

/**
 * 明細の商品を検査する（存在しない・無効な商品は行ごとのエラー）。
 * allowInactive は無効でも認める商品（編集で、もとから明細にあった商品。spec §3 の「新規の」受注・発注の制限）
 */
export function checkLineProducts(
  lines: readonly { productId: number }[],
  products: ReadonlyMap<number, LockedProduct>,
  allowInactive: ReadonlySet<number> = new Set(),
): OrderFieldErrors | null {
  const errors: OrderFieldErrors = {};
  lines.forEach((line, index) => {
    const product = products.get(line.productId);
    if (!product) {
      errors[`lines.${index}.productId`] = ["商品が見つかりません"];
    } else if (!product.isActive && !allowInactive.has(product.id)) {
      errors[`lines.${index}.productId`] = [
        `${product.code}「${product.name}」は無効になっているため選べません`,
      ];
    }
  });
  return Object.keys(errors).length > 0 ? errors : null;
}
