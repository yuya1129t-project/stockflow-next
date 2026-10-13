/**
 * 発注の CSV 出力（spec §7）。1 行 = 発注 1 件。純粋なモジュール。
 * 文字列のセルは src/lib/csv.ts の toCsv で無害化（数式として解釈される先頭文字に ' を付ける）する
 */
import { toCsv } from "@/lib/csv";
import { formatDateOnly } from "@/lib/orders/dates";

import type { PurchaseOrderListItem } from "./queries";
import { PURCHASE_ORDER_STATUS_LABELS } from "./status";

export const PURCHASE_ORDER_CSV_HEADERS = [
  "発注番号",
  "発注日",
  "入荷予定日",
  "仕入先コード",
  "仕入先名",
  "ステータス",
  "明細数",
  "小計",
  "消費税",
  "合計",
  "備考",
] as const;

export function buildPurchaseOrderCsv(
  orders: readonly PurchaseOrderListItem[],
): string {
  return toCsv([
    PURCHASE_ORDER_CSV_HEADERS,
    ...orders.map((o) => [
      o.number,
      formatDateOnly(o.orderDate),
      o.expectedDate ? formatDateOnly(o.expectedDate) : "",
      o.supplier.code,
      o.supplier.name,
      PURCHASE_ORDER_STATUS_LABELS[o.status],
      o.lineCount,
      o.subtotal,
      o.tax,
      o.total,
      o.note,
    ]),
  ]);
}
