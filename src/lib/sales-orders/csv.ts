/**
 * 受注の CSV 出力（spec §7）。1 行 = 受注 1 件。純粋なモジュール。
 * 文字列のセルは src/lib/csv.ts の toCsv で無害化（数式として解釈される先頭文字に ' を付ける）する
 */
import { toCsv } from "@/lib/csv";
import { formatDateOnly } from "@/lib/orders/dates";

import type { SalesOrderListItem } from "./queries";
import { SALES_ORDER_STATUS_LABELS } from "./status";

export const SALES_ORDER_CSV_HEADERS = [
  "受注番号",
  "受注日",
  "納期",
  "顧客コード",
  "顧客名",
  "ステータス",
  "明細数",
  "小計",
  "消費税",
  "合計",
  "備考",
] as const;

export function buildSalesOrderCsv(
  orders: readonly SalesOrderListItem[],
): string {
  return toCsv([
    SALES_ORDER_CSV_HEADERS,
    ...orders.map((o) => [
      o.number,
      formatDateOnly(o.orderDate),
      o.dueDate ? formatDateOnly(o.dueDate) : "",
      o.customer.code,
      o.customer.name,
      SALES_ORDER_STATUS_LABELS[o.status],
      o.lineCount,
      o.subtotal,
      o.tax,
      o.total,
      o.note,
    ]),
  ]);
}
