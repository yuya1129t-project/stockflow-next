/**
 * 発注のステータスと遷移（docs/spec.md §4）。純粋なモジュール（クライアントからも import できる）。
 *
 * draft（下書き）→ ordered（発注済）→ received（入荷済）、draft／ordered → cancelled（取消）。
 * received と cancelled は最終状態。明細の編集は draft のときだけ。ordered には明細が 1 行以上必要
 */
import {
  canTransition,
  isFinalStatus,
  type TransitionTable,
} from "@/lib/orders/status";

export const PURCHASE_ORDER_STATUSES = [
  "draft",
  "ordered",
  "received",
  "cancelled",
] as const;
export type PurchaseOrderStatus = (typeof PURCHASE_ORDER_STATUSES)[number];

export const PURCHASE_ORDER_STATUS_LABELS: Record<PurchaseOrderStatus, string> =
  {
    draft: "下書き",
    ordered: "発注済",
    received: "入荷済",
    cancelled: "取消",
  };

export const PURCHASE_ORDER_TRANSITIONS: TransitionTable<PurchaseOrderStatus> =
  {
    draft: ["ordered", "cancelled"],
    ordered: ["received", "cancelled"],
    received: [],
    cancelled: [],
  };

/** 遷移の操作名（ボタン・確認ダイアログ） */
export const PURCHASE_ORDER_TRANSITION_LABELS: Record<
  Exclude<PurchaseOrderStatus, "draft">,
  { action: string; question: string; description: string }
> = {
  ordered: {
    action: "発注済にする",
    question: "発注済にしますか？",
    description:
      "発注済にすると明細は編集できなくなります。入荷したら「入荷済にする」で在庫に加えます。",
  },
  received: {
    action: "入荷済にする",
    question: "入荷済にしますか？",
    description:
      "全明細の数量を在庫に入庫として記録します。入荷済は最終状態で、元に戻せません。",
  },
  cancelled: {
    action: "取り消す",
    question: "取り消しますか？",
    description: "取消は最終状態で、元に戻せません。在庫は変わりません。",
  },
};

export function isPurchaseOrderStatus(
  value: unknown,
): value is PurchaseOrderStatus {
  return (
    typeof value === "string" &&
    (PURCHASE_ORDER_STATUSES as readonly string[]).includes(value)
  );
}

/** 明細の編集ができるのは draft のときだけ */
export function isPurchaseOrderEditable(status: PurchaseOrderStatus): boolean {
  return status === "draft";
}

/** 次に進めるステータス（画面のボタン） */
export function nextPurchaseOrderStatuses(
  status: PurchaseOrderStatus,
): readonly PurchaseOrderStatus[] {
  return PURCHASE_ORDER_TRANSITIONS[status];
}

/**
 * 遷移の可否と、できないときの理由（日本語）。lineCount は明細の行数
 */
export function checkPurchaseOrderTransition(
  from: PurchaseOrderStatus,
  to: PurchaseOrderStatus,
  lineCount: number,
): { ok: true } | { ok: false; message: string } {
  if (!canTransition(PURCHASE_ORDER_TRANSITIONS, from, to)) {
    const fromLabel = PURCHASE_ORDER_STATUS_LABELS[from];
    const toLabel = PURCHASE_ORDER_STATUS_LABELS[to];
    return {
      ok: false,
      message: isFinalStatus(PURCHASE_ORDER_TRANSITIONS, from)
        ? `この発注は「${fromLabel}」のため、ステータスを変更できません`
        : `「${fromLabel}」から「${toLabel}」には変更できません`,
    };
  }
  if (to === "ordered" && lineCount < 1) {
    return {
      ok: false,
      message: "明細が 1 行もないため、発注済にできません",
    };
  }
  return { ok: true };
}
