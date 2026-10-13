/**
 * DB から読んだ値を REST API（/api/v1）の応答の形にする。型は schemas.ts の z.output に合わせる。
 *
 * 内部の ID（商品・取引先・受注の id）は出さず、商品コード・取引先コード・受注番号で表す
 * （② Laravel・③ FastAPI 版と同じ応答にするため。ID は DB の実装に依存する）。
 * 金額・数量は整数、日付（DB の DATE）は YYYY-MM-DD、日時は ISO 8601（UTC）
 */
import type { z } from "zod";

import { lineAmount } from "@/lib/orders/amounts";
import { formatDateOnly } from "@/lib/orders/dates";
import type { ProductListItem } from "@/lib/products/queries";
import type {
  SalesOrderDetail,
  SalesOrderListItem,
} from "@/lib/sales-orders/queries";
import { isBelowReorderPoint } from "@/lib/stock/rules";

import type {
  productSchema,
  productStockSchema,
  salesOrderSchema,
  salesOrderSummarySchema,
} from "./schemas";

export function toApiProduct(
  item: ProductListItem,
): z.output<typeof productSchema> {
  return {
    code: item.code,
    name: item.name,
    category: item.category,
    unit: item.unit,
    salesPrice: item.salesPrice,
    purchasePrice: item.purchasePrice,
    reorderPoint: item.reorderPoint,
    isActive: item.isActive,
    stock: item.stock,
    belowReorderPoint: isBelowReorderPoint(item, item.stock),
  };
}

export function toApiProductStock(
  item: ProductListItem,
): z.output<typeof productStockSchema> {
  return {
    code: item.code,
    name: item.name,
    unit: item.unit,
    isActive: item.isActive,
    stock: item.stock,
    reorderPoint: item.reorderPoint,
    belowReorderPoint: isBelowReorderPoint(item, item.stock),
  };
}

export function toApiSalesOrderSummary(
  item: SalesOrderListItem,
): z.output<typeof salesOrderSummarySchema> {
  return {
    number: item.number,
    orderDate: formatDateOnly(item.orderDate),
    dueDate: item.dueDate ? formatDateOnly(item.dueDate) : null,
    status: item.status,
    customer: { code: item.customer.code, name: item.customer.name },
    subtotal: item.subtotal,
    tax: item.tax,
    total: item.total,
    note: item.note,
    lineCount: item.lineCount,
  };
}

export function toApiSalesOrder(
  order: SalesOrderDetail,
): z.output<typeof salesOrderSchema> {
  return {
    number: order.number,
    orderDate: formatDateOnly(order.orderDate),
    dueDate: order.dueDate ? formatDateOnly(order.dueDate) : null,
    status: order.status,
    customer: { code: order.customer.code, name: order.customer.name },
    note: order.note,
    subtotal: order.subtotal,
    tax: order.tax,
    total: order.total,
    lines: order.lines.map((line) => ({
      product: {
        code: line.product.code,
        name: line.product.name,
        unit: line.product.unit,
      },
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      amount: lineAmount(line),
    })),
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
  };
}
