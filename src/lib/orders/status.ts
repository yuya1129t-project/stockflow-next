/**
 * 伝票のステータス遷移の判定（受注・発注で共通の部品）。純粋なモジュール。
 * 遷移表は伝票ごとに定義する（発注は src/lib/purchase-orders/status.ts）
 */

/** ステータスごとに、次に進めるステータスの一覧（最終状態は空配列） */
export type TransitionTable<S extends string> = Readonly<
  Record<S, readonly S[]>
>;

/** from から to へ遷移できるか */
export function canTransition<S extends string>(
  table: TransitionTable<S>,
  from: S,
  to: S,
): boolean {
  return table[from].includes(to);
}

/** 最終状態（どこへも遷移できない）か */
export function isFinalStatus<S extends string>(
  table: TransitionTable<S>,
  status: S,
): boolean {
  return table[status].length === 0;
}
