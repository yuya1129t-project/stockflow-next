import type { MonthlySales } from "@/lib/dashboard/queries";
import { formatNumber } from "@/lib/format";

/**
 * 月別受注額の棒グラフ（依存を増やさず CSS だけで描く。サーバーで描画する）。
 * 今月の棒を濃くする。各棒にマウスを乗せると金額を表示し、数値は表でも確認できる
 */
export function SalesTrendChart({ months }: { months: MonthlySales[] }) {
  const max = Math.max(...months.map((m) => m.total), 0);
  const lastIndex = months.length - 1;

  return (
    <div className="space-y-2">
      <ol
        className="flex h-36 items-end gap-2 border-b border-border sm:gap-3"
        aria-label="月別の受注額"
      >
        {months.map((m, i) => {
          const label = `${m.year}年${m.month}月: ${formatNumber(m.total)} 円`;
          // 0 でない月は最低でも高さの 2% を出す（見えなくならないように）
          const height =
            max === 0
              ? 0
              : Math.max((m.total / max) * 100, m.total > 0 ? 2 : 0);
          return (
            <li
              key={m.key}
              className="group flex h-full flex-1 items-end"
              title={label}
            >
              <span className="sr-only">{label}</span>
              <span
                aria-hidden="true"
                className={
                  i === lastIndex
                    ? "w-full rounded-t-[4px] bg-chart-4"
                    : "w-full rounded-t-[4px] bg-chart-2 group-hover:bg-chart-3"
                }
                style={{ height: `${height}%` }}
              />
            </li>
          );
        })}
      </ol>
      <div
        aria-hidden="true"
        className="flex gap-2 text-center text-xs text-muted-foreground sm:gap-3"
      >
        {months.map((m, i) => (
          <span
            key={m.key}
            className={
              i === lastIndex ? "flex-1 font-medium text-foreground" : "flex-1"
            }
          >
            {m.month}月
          </span>
        ))}
      </div>
      <details className="text-sm">
        <summary className="cursor-pointer text-xs text-muted-foreground">
          数値を表で見る
        </summary>
        <table className="mt-2 w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground">
              <th className="text-left font-normal">月</th>
              <th className="text-right font-normal">受注額（円）</th>
            </tr>
          </thead>
          <tbody>
            {months.map((m) => (
              <tr key={m.key}>
                <td>
                  {m.year}年{m.month}月
                </td>
                <td className="text-right tabular-nums">
                  {formatNumber(m.total)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
