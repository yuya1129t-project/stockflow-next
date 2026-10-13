/**
 * 受注の入力検証（Zod）。docs/spec.md §3「SalesOrder」・§8。純粋なモジュール（クライアントからも import できる）。
 *
 * 画面（React Hook Form）と Server Action で同じスキーマを使う。受注日は作成した日（Asia/Tokyo）で、
 * 伝票番号の日付と一致させるため入力では受け取らない。金額（小計・税・合計）も受け取らず、サーバーで明細から計算する
 */
import { z } from "zod";

import {
  EMPTY_ORDER_LINE,
  idSchema,
  optionalDateSchema,
  orderLinesSchema,
  orderNoteSchema,
  toOrderLineFormValues,
  type OrderLineInput,
} from "@/lib/orders/schema";
import { formatDateOnly } from "@/lib/orders/dates";

export const SALES_ORDER_FIELD_LABELS = {
  customerId: "顧客",
  orderDate: "受注日",
  dueDate: "納期",
  note: "備考",
  lines: "明細",
} as const;

export const salesOrderInputSchema = z.object({
  customerId: idSchema("顧客を選択してください"),
  dueDate: optionalDateSchema(SALES_ORDER_FIELD_LABELS.dueDate),
  note: orderNoteSchema,
  lines: orderLinesSchema,
});

/** フォームから受け取る値（すべて文字列） */
export type SalesOrderFormValues = z.input<typeof salesOrderInputSchema>;
/** 検証後の値 */
export type SalesOrderInput = z.output<typeof salesOrderInputSchema>;

/** 納期は受注日以降（逆転した日付は入力の誤りとして扱う） */
export function checkDueDate(
  orderDate: Date,
  dueDate: Date | null,
): string | null {
  if (dueDate && dueDate < orderDate) {
    return `納期は受注日（${formatDateOnly(orderDate)}）以降の日付にしてください`;
  }
  return null;
}

/** 新規作成フォームの初期値（明細は 1 行の空行） */
export function emptySalesOrderForm(): SalesOrderFormValues {
  return {
    customerId: "",
    dueDate: "",
    note: "",
    lines: [{ ...EMPTY_ORDER_LINE }],
  };
}

/** 保存済みの受注をフォームの値にする（編集画面の初期値） */
export function toSalesOrderFormValues(order: {
  customerId: number;
  dueDate: Date | null;
  note: string | null;
  lines: readonly OrderLineInput[];
}): SalesOrderFormValues {
  return {
    customerId: String(order.customerId),
    dueDate: order.dueDate ? formatDateOnly(order.dueDate) : "",
    note: order.note ?? "",
    lines: order.lines.map(toOrderLineFormValues),
  };
}
