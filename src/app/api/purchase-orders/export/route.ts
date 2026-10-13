/**
 * 発注の CSV 出力（GET /api/purchase-orders/export?q=&supplier=&status=&from=&to=&sort=&order=）。spec §7
 *
 * - 一覧画面と同じ検索条件（URL のクエリ）を反映する。ページ送りはせず、条件に合う全件を出力する（1 行 = 発注 1 件）
 * - 上限（PURCHASE_ORDER_EXPORT_MAX_ROWS）を超える場合は出力せず 413 と日本語のメッセージを返す（黙って切り捨てない）
 * - UTF-8（BOM 付き）・見出し行あり。数式として解釈される文字で始まるセルは無害化する（src/lib/csv.ts）
 * - 読み取りだけで副作用はない。権限は csv:export をサーバー側で検査
 */
import { requireApiPermission } from "@/lib/auth/guards";
import { CSV_BOM } from "@/lib/csv";
import { getPrisma } from "@/lib/db";
import { todayInTokyo } from "@/lib/orders/dates";
import { buildPurchaseOrderCsv } from "@/lib/purchase-orders/csv";
import {
  listPurchaseOrdersForCsv,
  PURCHASE_ORDER_EXPORT_MAX_ROWS,
} from "@/lib/purchase-orders/queries";
import { parsePurchaseOrderListParams } from "@/lib/purchase-orders/search-params";

export async function GET(request: Request) {
  const auth = await requireApiPermission(request, "csv:export");
  if (!auth.ok) return auth.response;

  const params = parsePurchaseOrderListParams(
    new URL(request.url).searchParams,
  );
  const { items, overLimit } = await listPurchaseOrdersForCsv(
    getPrisma(),
    params,
  );
  if (overLimit) {
    return new Response(
      `件数が多すぎます。絞り込んでから出力してください（上限 ${PURCHASE_ORDER_EXPORT_MAX_ROWS.toLocaleString("ja-JP")} 件）`,
      {
        status: 413,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        },
      },
    );
  }
  const fileName = `purchase_orders_${todayInTokyo().replaceAll("-", "")}.csv`;

  return new Response(CSV_BOM + buildPurchaseOrderCsv(items), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Cache-Control": "no-store",
    },
  });
}
