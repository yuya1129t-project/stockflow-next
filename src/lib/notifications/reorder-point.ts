/**
 * 発注点割れの通知（Slack Incoming Webhook 形式）。docs/spec.md §6-3。サーバー側でだけ使う。
 *
 * - 入出庫の結果「発注点以上 → 発注点未満」に変わった有効な商品（recordStockMovements の fellBelowReorderPoint。
 *   無効な商品はそこに含まれない）を、1 回の操作につき 1 通にまとめて送る
 * - Webhook URL は環境変数 STOCKFLOW_SLACK_WEBHOOK_URL。未設定なら送らない（デモは未設定）。
 *   https 以外（http の平文など）は送らずにログと操作履歴に残す
 * - 送信はトランザクション確定後。Server Action から notifyReorderPointAfterResponse で、応答を返した後（after()）に送る
 * - タイムアウト 3 秒、リダイレクトはたどらない。失敗しても業務処理は取り消さず、操作履歴（action = notify_failed）に
 *   原因の種類だけを記録する（Webhook URL・応答本文は記録しない）。成功は記録しない
 * - 送信の失敗では例外を投げない（本文の組み立ての例外はプログラムの誤りとしてそのまま投げる。after() の中なので
 *   業務処理には影響しない）。fetch・環境変数は引数で差し替えられる（テストでは外部へ送らない）
 */
import { after } from "next/server";

import type { PrismaClient } from "@/generated/prisma/client";
import { getPrisma } from "@/lib/db";
import { formatNumber } from "@/lib/format";
import { PRODUCT_TARGET_TYPE } from "@/lib/products/service";
import { SALES_ORDER_TARGET_TYPE } from "@/lib/sales-orders/service";
import type { ReorderPointCrossing } from "@/lib/stock/rules";

/** Webhook URL の環境変数 */
export const REORDER_WEBHOOK_URL_ENV = "STOCKFLOW_SLACK_WEBHOOK_URL";

/** 送信のタイムアウト（spec §6-3） */
export const REORDER_NOTIFICATION_TIMEOUT_MS = 3_000;

/** 送信に失敗したときの操作履歴の action */
export const NOTIFY_FAILED_ACTION = "notify_failed";

/** 1 通に商品ごとの行を出す上限（超えた分は「ほか N 件」にまとめる。Slack の blocks は 50 個まで） */
export const MAX_LISTED_PRODUCTS = 20;

/** 通知のきっかけになった操作 */
export type ReorderPointTrigger =
  | { kind: "stock_adjust"; productId: number }
  | { kind: "sales_order_shipped"; salesOrderId: number; number: string };

export interface ReorderPointNotification {
  crossings: readonly ReorderPointCrossing[];
  trigger: ReorderPointTrigger;
  /** 操作したユーザー（失敗の操作履歴に記録する） */
  userId: string | null;
}

export type NotifyFailureReason =
  /** Webhook URL の設定が不正（https の URL でない） */
  | "invalid_url"
  /** 3 秒以内に応答がない */
  | "timeout"
  /** HTTP エラー（2xx 以外） */
  | "http_error"
  /** 通信エラー（接続できない・リダイレクトなど） */
  | "network_error";

export type ReorderNotificationOutcome =
  | { status: "skipped"; reason: "no_crossings" | "not_configured" }
  | { status: "sent" }
  | { status: "failed"; reason: NotifyFailureReason; httpStatus?: number };

/**
 * Slack の mrkdwn のテキスト。verbatim: true で Slack の自動解析（@here・@channel などのメンション化、
 * URL・チャンネル名のリンク化）を止める（商品名・単位などの利用者の入力を含むため）。
 * 明示的に組み立てた <URL|ラベル> のリンクは verbatim でも解釈される
 */
export interface SlackMrkdwn {
  type: "mrkdwn";
  text: string;
  verbatim: true;
}

/** Slack Incoming Webhook の本文（使う項目だけ） */
export interface SlackMessage {
  /** 通知のプレビューに使われる（verbatim を指定できないので、利用者の入力を含めない） */
  text: string;
  blocks: (
    | { type: "section"; text: SlackMrkdwn }
    | { type: "context"; elements: SlackMrkdwn[] }
  )[];
}

function mrkdwn(text: string): SlackMrkdwn {
  return { type: "mrkdwn", text, verbatim: true };
}

export type WebhookUrlCheck =
  | { ok: true; url: string }
  | { ok: false; reason: "unset" | "invalid" | "not_https" };

/** Webhook URL の設定値を検証する。空・空白だけは未設定。https 以外・認証情報入りの URL は使わない */
export function checkWebhookUrl(value: string | undefined): WebhookUrlCheck {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") return { ok: false, reason: "unset" };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "not_https" };
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: "invalid" };
  }
  return { ok: true, url: url.toString() };
}

/**
 * 在庫画面へのリンクの基準になるアプリの URL（BETTER_AUTH_URL。ログインの基準と同じ公開 URL）。
 * http／https の URL でなければ null（リンクなしで送る）。末尾の "/" は除く
 */
export function appBaseUrl(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

/** Slack の mrkdwn で特別な意味を持つ &・<・> をエスケープする（商品名などの利用者の入力を埋め込むため） */
export function escapeSlackText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** きっかけの表示（例「棚卸調整」「受注 SO-20261013-001 の出荷」） */
export function triggerLabel(trigger: ReorderPointTrigger): string {
  return trigger.kind === "stock_adjust"
    ? "棚卸調整"
    : `受注 ${trigger.number} の出荷`;
}

/**
 * 発注点割れの通知の本文（1 回の操作につき 1 通）。baseUrl が null なら在庫画面へのリンクを付けない。
 * 利用者の入力（商品コード・商品名・単位）は & < > をエスケープしたうえで、verbatim の blocks にだけ入れる。
 * トップレベルの text は件数ときっかけだけ（自動解析を止められないため）。商品名は書式（*…* など）で囲まない
 */
export function buildReorderPointMessage(
  crossings: readonly ReorderPointCrossing[],
  trigger: ReorderPointTrigger,
  baseUrl: string | null,
): SlackMessage {
  const title = `発注点を下回った商品が ${formatNumber(crossings.length)} 件あります（${escapeSlackText(triggerLabel(trigger))}）`;
  const listed = crossings.slice(0, MAX_LISTED_PRODUCTS);
  const rest = crossings.length - listed.length;

  const lines = listed.map((c) => {
    const label = `${escapeSlackText(c.code)} ${escapeSlackText(c.name)}`;
    const unit = escapeSlackText(c.unit);
    const link = baseUrl ? `<${baseUrl}/stock/${c.productId}|${label}>` : label;
    return {
      link,
      detail: `現在庫 ${formatNumber(c.after)}${unit}（発注点 ${formatNumber(c.reorderPoint)}${unit}・変更前 ${formatNumber(c.before)}${unit}）`,
    };
  });
  const restText =
    rest > 0
      ? `ほか ${formatNumber(rest)} 件${baseUrl ? `（<${baseUrl}/stock?level=low|在庫一覧の発注点割れ>で確認してください）` : ""}`
      : null;

  return {
    text: title,
    blocks: [
      { type: "section", text: mrkdwn(`*${title}*`) },
      ...lines.map((l) => ({
        type: "section" as const,
        text: mrkdwn(`${l.link}\n${l.detail}`),
      })),
      ...(restText
        ? [{ type: "context" as const, elements: [mrkdwn(restText)] }]
        : []),
    ],
  };
}

const FAILURE_LABELS: Record<NotifyFailureReason, string> = {
  invalid_url: "Webhook URL の設定が不正（https の URL ではない）",
  timeout: "タイムアウト（3 秒）",
  http_error: "HTTP エラー",
  network_error: "通信エラー（接続できない・リダイレクトなど）",
};

/** 失敗の操作履歴の要約（URL・応答本文は含めない） */
export function failureSummary(
  notification: Pick<ReorderPointNotification, "crossings" | "trigger">,
  reason: NotifyFailureReason,
  httpStatus?: number,
): string {
  const codes = notification.crossings.map((c) => c.code);
  const shown = codes.slice(0, 10).join("、");
  const more = codes.length > 10 ? ` ほか ${codes.length - 10} 件` : "";
  const cause =
    reason === "http_error" && httpStatus != null
      ? `${FAILURE_LABELS.http_error}（${httpStatus}）`
      : FAILURE_LABELS[reason];
  return `発注点割れの通知を送信できませんでした（${triggerLabel(notification.trigger)}・商品 ${shown}${more}）。原因: ${cause}`;
}

function auditTarget(trigger: ReorderPointTrigger) {
  return trigger.kind === "stock_adjust"
    ? { targetType: PRODUCT_TARGET_TYPE, targetId: String(trigger.productId) }
    : {
        targetType: SALES_ORDER_TARGET_TYPE,
        targetId: String(trigger.salesOrderId),
      };
}

/** AbortSignal.timeout による中断（DOMException の TimeoutError。実装によっては AbortError） */
function isTimeout(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

/** ログ用の例外の要約（メッセージは URL を含み得るので出さない。種類とエラーコードだけ） */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  const cause = error.cause as { code?: unknown; name?: unknown } | undefined;
  const code = cause?.code ?? cause?.name;
  return `${error.name}${code ? ` [${String(code)}]` : ""}`;
}

async function recordFailure(
  db: PrismaClient,
  notification: ReorderPointNotification,
  reason: NotifyFailureReason,
  httpStatus?: number,
): Promise<ReorderNotificationOutcome> {
  try {
    await db.auditLog.create({
      data: {
        userId: notification.userId,
        action: NOTIFY_FAILED_ACTION,
        ...auditTarget(notification.trigger),
        summary: failureSummary(notification, reason, httpStatus),
      },
    });
  } catch (error) {
    console.error(
      `[reorder-notification] 送信失敗の操作履歴を記録できませんでした: ${describeError(error)}`,
    );
  }
  return httpStatus != null
    ? { status: "failed", reason, httpStatus }
    : { status: "failed", reason };
}

/**
 * 発注点割れの通知を送る。トランザクション確定後に呼ぶこと。送信の失敗では例外を投げない（組み立ての例外は投げる）。
 * 失敗したら操作履歴（notify_failed）に記録して { status: "failed" } を返す（業務処理には影響させない）
 */
export async function sendReorderPointNotification(
  db: PrismaClient,
  notification: ReorderPointNotification,
  options: {
    fetch?: typeof fetch;
    env?: Record<string, string | undefined>;
    timeoutMs?: number;
  } = {},
): Promise<ReorderNotificationOutcome> {
  if (notification.crossings.length === 0) {
    return { status: "skipped", reason: "no_crossings" };
  }
  const env = options.env ?? process.env;
  const webhook = checkWebhookUrl(env[REORDER_WEBHOOK_URL_ENV]);
  if (!webhook.ok) {
    if (webhook.reason === "unset") {
      return { status: "skipped", reason: "not_configured" };
    }
    console.error(
      `[reorder-notification] ${REORDER_WEBHOOK_URL_ENV} が https の URL ではないため送信しません（${webhook.reason}）`,
    );
    return recordFailure(db, notification, "invalid_url");
  }

  const fetchFn = options.fetch ?? fetch;
  // 組み立ての例外を通信エラーとして記録しないよう、送信の try の外で組み立てる
  const message = buildReorderPointMessage(
    notification.crossings,
    notification.trigger,
    appBaseUrl(env.BETTER_AUTH_URL),
  );
  try {
    const response = await fetchFn(webhook.url, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(
        options.timeoutMs ?? REORDER_NOTIFICATION_TIMEOUT_MS,
      ),
      cache: "no-store",
      // 宛先は設定した URL だけ。リダイレクトはたどらずエラーにする
      redirect: "error",
    });
    // 応答本文は使わない（読まずに破棄する）
    await response.body?.cancel().catch(() => {});
    if (!response.ok) {
      console.warn(
        `[reorder-notification] 送信に失敗しました: HTTP ${response.status}`,
      );
      return recordFailure(db, notification, "http_error", response.status);
    }
    return { status: "sent" };
  } catch (error) {
    const reason = isTimeout(error) ? "timeout" : "network_error";
    console.warn(
      `[reorder-notification] 送信に失敗しました: ${reason}（${describeError(error)}）`,
    );
    return recordFailure(db, notification, reason);
  }
}

/**
 * Server Action から呼ぶ: 応答を返した後（Next.js の after()）に通知を送る。
 * 業務処理（トランザクション）が成功して確定した後に呼ぶこと。対象の商品がなければ何もしない
 */
export function notifyReorderPointAfterResponse(
  notification: ReorderPointNotification,
): void {
  if (notification.crossings.length === 0) return;
  after(async () => {
    await sendReorderPointNotification(getPrisma(), notification);
  });
}
