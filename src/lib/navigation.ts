/**
 * サイドバーの項目（docs/spec.md §5 の画面）。
 * ready: false の画面は未実装（リンクにせず「準備中」と表示する）。permission はその画面を開く権限で、
 * 権限のないロールにはメニュー自体を出さない（表示の補助。検査は各画面のガードで行う）
 */
import type { Action } from "@/lib/auth/permissions";

export interface NavItem {
  label: string;
  href: string;
  permission: Action;
  ready: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  // ダッシュボードの中身は #9。トップページ自体はあるのでリンクにする
  { label: "ダッシュボード", href: "/", permission: "view", ready: true },
  { label: "商品", href: "/products", permission: "view", ready: true },
  { label: "取引先", href: "/partners", permission: "view", ready: false },
  { label: "受注", href: "/sales-orders", permission: "view", ready: false },
  { label: "発注", href: "/purchase-orders", permission: "view", ready: false },
  { label: "在庫", href: "/stock", permission: "view", ready: true },
  {
    label: "ユーザー管理",
    href: "/users",
    permission: "user:manage",
    ready: false,
  },
  {
    label: "操作履歴",
    href: "/audit-logs",
    permission: "audit:view",
    ready: false,
  },
];
