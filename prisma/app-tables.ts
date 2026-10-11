/**
 * このアプリのテーブル（schema.prisma の @@map 名）。シードで TRUNCATE する対象。
 * 参照する側を先に並べている。schema.prisma とずれていないことは結合テストで確認する。
 */
export const APP_TABLES = [
  "sales_order_line",
  "purchase_order_line",
  "stock_movement",
  "audit_log",
  "api_token",
  "session",
  "account",
  "verification",
  "rate_limit",
  "document_sequence",
  "sales_order",
  "purchase_order",
  "product",
  "partner",
  "user",
] as const;
