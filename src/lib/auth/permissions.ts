/**
 * ロール × 操作の権限表（docs/spec.md §2）。権限の定義はこのファイルだけに置く。
 *
 * - 画面の表示切り替え（メニューやボタンを隠す）にも使うが、それは補助。
 *   権限は必ずサーバー側のガード（src/lib/auth/guards.ts）で検査する
 * - DB やフレームワークに依存しない純粋なモジュール（クライアントからも import できる）
 */

export const ROLES = ["admin", "staff", "viewer"] as const;
export type Role = (typeof ROLES)[number];

/** 画面に出すロール名 */
export const ROLE_LABELS: Record<Role, string> = {
  admin: "管理者",
  staff: "担当者",
  viewer: "閲覧者",
};

/**
 * 操作ごとに許可するロール。キーの説明（label）は spec §2 の表の「機能」列と同じ文言にしてあり、
 * 単体テストで spec の表と突き合わせる（src/lib/auth/permissions.test.ts）
 */
export const PERMISSIONS = {
  view: {
    label: "ダッシュボード・各一覧・詳細の閲覧",
    roles: ["admin", "staff", "viewer"],
  },
  "master:edit": {
    label: "商品・取引先の登録・編集",
    roles: ["admin", "staff"],
  },
  "master:deactivate": {
    label: "商品・取引先の無効化（論理削除）",
    roles: ["admin"],
  },
  "order:edit": {
    label: "受注・発注の作成・編集・ステータス変更",
    roles: ["admin", "staff"],
  },
  "stock:adjust": {
    label: "在庫の棚卸調整",
    roles: ["admin", "staff"],
  },
  "csv:export": {
    label: "CSV 出力",
    roles: ["admin", "staff", "viewer"],
  },
  "csv:import": {
    label: "CSV 取込（商品）",
    roles: ["admin", "staff"],
  },
  "user:manage": {
    label: "ユーザー管理",
    roles: ["admin"],
  },
  "audit:view": {
    label: "操作履歴の閲覧",
    roles: ["admin"],
  },
} as const satisfies Record<string, { label: string; roles: readonly Role[] }>;

export type Action = keyof typeof PERMISSIONS;

export const ACTIONS = Object.keys(PERMISSIONS) as Action[];

export function isRole(value: unknown): value is Role {
  return (
    typeof value === "string" && (ROLES as readonly string[]).includes(value)
  );
}

/** role が action を実行できるか */
export function can(role: Role, action: Action): boolean {
  return (PERMISSIONS[action].roles as readonly Role[]).includes(role);
}
