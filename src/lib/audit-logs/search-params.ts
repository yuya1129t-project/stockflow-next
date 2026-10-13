/**
 * 操作履歴の一覧の絞り込み条件（URL のクエリ）と表示用の名前。純粋なモジュール。
 *
 * 不正な値は既定値（絞り込みなし）に置き換える（エラーにしない）
 */
import { parseDateOnly } from "@/lib/orders/dates";

export interface AuditLogListParams {
  /** 操作したユーザーの ID（空ならすべて） */
  userId: string;
  /** 操作（AuditLog.action。空ならすべて） */
  action: string;
  /** 対象の種類（AuditLog.targetType。空ならすべて） */
  targetType: string;
  /** 期間（Asia/Tokyo の日付 YYYY-MM-DD。両端を含む。空なら制限なし） */
  from: string;
  to: string;
  /** 1 始まり */
  page: number;
}

export const AUDIT_LOGS_PER_PAGE = 50;

export const DEFAULT_AUDIT_LOG_LIST_PARAMS: AuditLogListParams = {
  userId: "",
  action: "",
  targetType: "",
  from: "",
  to: "",
  page: 1,
};

/** 操作の表示名（ここにない操作は記録された値をそのまま表示する） */
export const AUDIT_ACTION_LABELS: Record<string, string> = {
  login: "ログイン",
  create: "登録",
  update: "更新",
  deactivate: "無効化",
  reactivate: "再有効化",
  import: "CSV 取込",
  status_change: "ステータス変更",
  stock_adjust: "棚卸調整",
  role_change: "ロール変更",
  password_reset: "パスワード再設定",
  token_create: "API トークン発行",
  token_revoke: "API トークン失効",
  // 発注点割れの通知（#12）の送信失敗。対象は棚卸調整なら商品、出荷なら受注
  notify_failed: "通知の送信失敗",
};

/** 対象の種類の表示名 */
export const AUDIT_TARGET_TYPE_LABELS: Record<string, string> = {
  product: "商品",
  partner: "取引先",
  sales_order: "受注",
  purchase_order: "発注",
  user: "ユーザー",
  api_token: "API トークン",
};

export function auditActionLabel(action: string): string {
  return AUDIT_ACTION_LABELS[action] ?? action;
}

export function auditTargetTypeLabel(targetType: string): string {
  return AUDIT_TARGET_TYPE_LABELS[targetType] ?? targetType;
}

/** 操作・対象の種類として受け付ける値（英小文字とアンダースコア） */
const CODE_PATTERN = /^[a-z_]{1,50}$/;
/** ユーザー ID として受け付ける値（シードの demo_admin や UUID） */
const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

type RawSearchParams =
  URLSearchParams | Record<string, string | string[] | undefined>;

function first(params: RawSearchParams, key: string): string | undefined {
  if (params instanceof URLSearchParams) return params.get(key) ?? undefined;
  const value = params[key];
  return Array.isArray(value) ? value[0] : value;
}

function matching(value: string | undefined, pattern: RegExp): string {
  const trimmed = (value ?? "").trim();
  return pattern.test(trimmed) ? trimmed : "";
}

function dateParam(value: string | undefined): string {
  const trimmed = (value ?? "").trim();
  return parseDateOnly(trimmed) ? trimmed : "";
}

export function parseAuditLogListParams(
  params: RawSearchParams,
): AuditLogListParams {
  const page = Number(first(params, "page"));
  return {
    userId: matching(first(params, "user"), USER_ID_PATTERN),
    action: matching(first(params, "action"), CODE_PATTERN),
    targetType: matching(first(params, "targetType"), CODE_PATTERN),
    from: dateParam(first(params, "from")),
    to: dateParam(first(params, "to")),
    page: Number.isSafeInteger(page) && page >= 1 ? page : 1,
  };
}

/** 絞り込み条件を URL のクエリ文字列にする（空の項目は省く）。先頭の "?" は付けない */
export function toAuditLogListQuery(
  params: Partial<AuditLogListParams>,
): string {
  const merged = { ...DEFAULT_AUDIT_LOG_LIST_PARAMS, ...params };
  const search = new URLSearchParams();
  if (merged.userId) search.set("user", merged.userId);
  if (merged.action) search.set("action", merged.action);
  if (merged.targetType) search.set("targetType", merged.targetType);
  if (merged.from) search.set("from", merged.from);
  if (merged.to) search.set("to", merged.to);
  if (merged.page > 1) search.set("page", String(merged.page));
  return search.toString();
}

/**
 * 期間（JST の日付）を日時の範囲にする。from の 0 時（JST）以上、to の翌日 0 時（JST）未満
 */
export function auditLogDateRange(
  from: string,
  to: string,
): { gte?: Date; lt?: Date } {
  const range: { gte?: Date; lt?: Date } = {};
  const start = from ? parseDateOnly(from) : null;
  const end = to ? parseDateOnly(to) : null;
  const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
  const DAY_MS = 24 * 60 * 60 * 1000;
  // parseDateOnly はその日の UTC 0 時。JST の 0 時は 9 時間前
  if (start) range.gte = new Date(start.getTime() - JST_OFFSET_MS);
  if (end) range.lt = new Date(end.getTime() + DAY_MS - JST_OFFSET_MS);
  return range;
}

/** 対象の詳細画面へのリンク先（商品・取引先・受注・発注・ユーザー）。なければ null */
export function auditTargetPath(
  targetType: string | null,
  targetId: string | null,
): string | null {
  if (!targetType || !targetId) return null;
  const numeric = /^\d{1,9}$/.test(targetId);
  switch (targetType) {
    case "product":
      return numeric ? `/products/${targetId}` : null;
    case "partner":
      return numeric ? `/partners/${targetId}` : null;
    case "sales_order":
      return numeric ? `/sales-orders/${targetId}` : null;
    case "purchase_order":
      return numeric ? `/purchase-orders/${targetId}` : null;
    case "user":
      return USER_ID_PATTERN.test(targetId)
        ? `/users/${encodeURIComponent(targetId)}`
        : null;
    default:
      return null;
  }
}
