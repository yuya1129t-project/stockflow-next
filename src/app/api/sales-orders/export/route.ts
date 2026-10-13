/**
 * 受注の CSV 出力（GET /api/sales-orders/export?q=&customer=&status=&from=&to=&sort=&order=）。spec §7
 *
 * - 一覧画面と同じ検索条件（URL のクエリ）を反映する。ページ送りはせず、条件に合う全件を出力する（1 行 = 受注 1 件）
 * - 上限（SALES_ORDER_EXPORT_MAX_ROWS）を超える場合は出力せず 413 と日本語のメッセージを返す（黙って切り捨てない）
 * - UTF-8（BOM 付き）・見出し行あり。数式として解釈される文字で始まるセルは無害化する（src/lib/csv.ts）
 * - 読み取りだけで副作用はない。権限は csv:export をサーバー側で検査
 */
import { requireApiPermission } from "@/lib/auth/guards";
import { CSV_BOM } from "@/lib/csv";
import { getPrisma } from "@/lib/db";
import { todayInTokyo } from "@/lib/orders/dates";
import { buildSalesOrderCsv } from "@/lib/sales-orders/csv";
import {
  listSalesOrdersForCsv,
  SALES_ORDER_EXPORT_MAX_ROWS,
} from "@/lib/sales-orders/queries";
import { parseSalesOrderListParams } from "@/lib/sales-orders/search-params";

export async function GET(request: Request) {
  const auth = await requireApiPermission(request, "csv:export");
  if (!auth.ok) return auth.response;

  const params = parseSalesOrderListParams(new URL(request.url).searchParams);
  const { items, overLimit } = await listSalesOrdersForCsv(getPrisma(), params);
  if (overLimit) {
    return new Response(
      `件数が多すぎます。絞り込んでから出力してください（上限 ${SALES_ORDER_EXPORT_MAX_ROWS.toLocaleString("ja-JP")} 件）`,
      {
        status: 413,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        },
      },
    );
  }
  const fileName = `sales_orders_${todayInTokyo().replaceAll("-", "")}.csv`;

  return new Response(CSV_BOM + buildSalesOrderCsv(items), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Cache-Control": "no-store",
    },
  });
}
