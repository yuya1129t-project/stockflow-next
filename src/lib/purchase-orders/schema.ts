/**
 * 発注の入力検証（Zod）。docs/spec.md §3「PurchaseOrder」・§8。純粋なモジュール（クライアントからも import できる）。
 *
 * 画面（React Hook Form）と Server Action で同じスキーマを使う。発注日は作成した日（Asia/Tokyo）で、
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

export const PURCHASE_ORDER_FIELD_LABELS = {
  supplierId: "仕入先",
  orderDate: "発注日",
  expectedDate: "入荷予定日",
  note: "備考",
  lines: "明細",
} as const;

export const purchaseOrderInputSchema = z.object({
  supplierId: idSchema("仕入先を選択してください"),
  expectedDate: optionalDateSchema(PURCHASE_ORDER_FIELD_LABELS.expectedDate),
  note: orderNoteSchema,
  lines: orderLinesSchema,
});

/** フォームから受け取る値（すべて文字列） */
export type PurchaseOrderFormValues = z.input<typeof purchaseOrderInputSchema>;
/** 検証後の値 */
export type PurchaseOrderInput = z.output<typeof purchaseOrderInputSchema>;

/** 入荷予定日は発注日以降（spec にはないが、逆転した日付は入力の誤りとして扱う） */
export function checkExpectedDate(
  orderDate: Date,
  expectedDate: Date | null,
): string | null {
  if (expectedDate && expectedDate < orderDate) {
    return `入荷予定日は発注日（${formatDateOnly(orderDate)}）以降の日付にしてください`;
  }
  return null;
}

/** 新規作成フォームの初期値（明細は 1 行の空行） */
export function emptyPurchaseOrderForm(): PurchaseOrderFormValues {
  return {
    supplierId: "",
    expectedDate: "",
    note: "",
    lines: [{ ...EMPTY_ORDER_LINE }],
  };
}

/** 保存済みの発注をフォームの値にする（編集画面の初期値） */
export function toPurchaseOrderFormValues(order: {
  supplierId: number;
  expectedDate: Date | null;
  note: string | null;
  lines: readonly OrderLineInput[];
}): PurchaseOrderFormValues {
  return {
    supplierId: String(order.supplierId),
    expectedDate: order.expectedDate ? formatDateOnly(order.expectedDate) : "",
    note: order.note ?? "",
    lines: order.lines.map(toOrderLineFormValues),
  };
}
