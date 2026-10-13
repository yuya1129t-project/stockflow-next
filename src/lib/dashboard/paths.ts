/**
 * ダッシュボードから伝票の詳細へのリンク先（パスはここだけを直せばよい）
 */

/** 受注の詳細 */
export function salesOrderPath(id: number): string {
  return `/sales-orders/${id}`;
}

/** 発注の詳細 */
export function purchaseOrderPath(id: number): string {
  return `/purchase-orders/${id}`;
}
