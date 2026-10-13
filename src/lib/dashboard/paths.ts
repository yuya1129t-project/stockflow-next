/**
 * ダッシュボードから伝票の詳細へのリンク先。
 *
 * 受注・発注の詳細画面は #8・#7 で作る。それまでダッシュボードでは番号をテキストで表示し、
 * 詳細画面ができたらこの関数でリンクにする（パスはここだけを直せばよい）
 */

/** 受注の詳細 */
export function salesOrderPath(id: number): string {
  return `/sales-orders/${id}`;
}

/** 発注の詳細 */
export function purchaseOrderPath(id: number): string {
  return `/purchase-orders/${id}`;
}
