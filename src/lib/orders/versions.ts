/**
 * 伝票の競合の検出（楽観的ロック）。受注・発注で共通。純粋なモジュール。
 *
 * 画面を開いた時点の updatedAt（ISO 8601）を編集・ステータス変更の操作と一緒に送り、サーバーで伝票の行をロックした後の
 * updatedAt と比べる。違っていれば他の人が先に更新しているので、操作を行わずに競合として返す
 * （見ていない内容のまま保存・確定しないため）
 */

/** 送られた updatedAt を Date にする。形式が違えば null（競合として扱う） */
export function parseExpectedUpdatedAt(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 今の updatedAt が、画面を開いた時点のものと同じか */
export function isSameVersion(current: Date, expected: Date): boolean {
  return current.getTime() === expected.getTime();
}

/** 競合のメッセージ（documentLabel は「発注」「受注」、notDone は行わなかった操作。例「保存していません」） */
export function conflictMessage(
  documentLabel: string,
  notDone: string,
): string {
  return `他の人がこの${documentLabel}を更新しました。${notDone}。画面を開き直して最新の内容を確認してください`;
}
