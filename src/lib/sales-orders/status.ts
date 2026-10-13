/**
 * 受注のステータスと遷移（docs/spec.md §4）。純粋なモジュール（クライアントからも import できる）。
 *
 * draft（下書き）→ confirmed（確定）→ shipped（出荷済）、draft／confirmed → cancelled（取消）。
 * shipped と cancelled は最終状態。明細の編集は draft のときだけ。confirmed には明細が 1 行以上必要
 */
import {
  canTransition,
  isFinalStatus,
  type TransitionTable,
} from "@/lib/orders/status";

export const SALES_ORDER_STATUSES = [
  "draft",
  "confirmed",
  "shipped",
  "cancelled",
] as const;
export type SalesOrderStatus = (typeof SALES_ORDER_STATUSES)[number];

export const SALES_ORDER_STATUS_LABELS: Record<SalesOrderStatus, string> = {
  draft: "下書き",
  confirmed: "確定",
  shipped: "出荷済",
  cancelled: "取消",
};

export const SALES_ORDER_TRANSITIONS: TransitionTable<SalesOrderStatus> = {
  draft: ["confirmed", "cancelled"],
  confirmed: ["shipped", "cancelled"],
  shipped: [],
  cancelled: [],
};

/** 遷移の操作名（ボタン・確認ダイアログ） */
export const SALES_ORDER_TRANSITION_LABELS: Record<
  Exclude<SalesOrderStatus, "draft">,
  { action: string; question: string; description: string }
> = {
  confirmed: {
    action: "確定する",
    question: "確定しますか？",
    description:
      "確定すると明細は編集できなくなります。出荷したら「出荷済にする」で在庫から出庫します。",
  },
  shipped: {
    action: "出荷済にする",
    question: "出荷済にしますか？",
    description:
      "全明細の数量を在庫から出庫として記録します。1 品目でも在庫が足りなければ出荷しません。出荷済は最終状態で、元に戻せません。",
  },
  cancelled: {
    action: "取り消す",
    question: "取り消しますか？",
    description: "取消は最終状態で、元に戻せません。在庫は変わりません。",
  },
};

export function isSalesOrderStatus(value: unknown): value is SalesOrderStatus {
  return (
    typeof value === "string" &&
    (SALES_ORDER_STATUSES as readonly string[]).includes(value)
  );
}

/** 明細の編集ができるのは draft のときだけ */
export function isSalesOrderEditable(status: SalesOrderStatus): boolean {
  return status === "draft";
}

/** 次に進めるステータス（画面のボタン） */
export function nextSalesOrderStatuses(
  status: SalesOrderStatus,
): readonly SalesOrderStatus[] {
  return SALES_ORDER_TRANSITIONS[status];
}

/**
 * 遷移の可否と、できないときの理由（日本語）。lineCount は明細の行数
 */
export function checkSalesOrderTransition(
  from: SalesOrderStatus,
  to: SalesOrderStatus,
  lineCount: number,
): { ok: true } | { ok: false; message: string } {
  if (!canTransition(SALES_ORDER_TRANSITIONS, from, to)) {
    const fromLabel = SALES_ORDER_STATUS_LABELS[from];
    const toLabel = SALES_ORDER_STATUS_LABELS[to];
    return {
      ok: false,
      message: isFinalStatus(SALES_ORDER_TRANSITIONS, from)
        ? `この受注は「${fromLabel}」のため、ステータスを変更できません`
        : `「${fromLabel}」から「${toLabel}」には変更できません`,
    };
  }
  if (to === "confirmed" && lineCount < 1) {
    return {
      ok: false,
      message: "明細が 1 行もないため、確定にできません",
    };
  }
  return { ok: true };
}
