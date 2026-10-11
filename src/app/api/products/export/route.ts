/**
 * 商品の CSV 出力（GET /api/products/export?q=&category=&status=&sort=&order=）。spec §7
 *
 * - 一覧画面と同じ検索条件（URL のクエリ）を反映する。ページ送りはせず、条件に合う全件を出力する
 * - UTF-8（BOM 付き）・見出し行あり。数式として解釈される文字で始まるセルは無害化する（src/lib/csv.ts）
 * - 読み取りだけで副作用はない（Cookie 認証の GET に副作用を持たせない）。権限は csv:export をサーバー側で検査
 */
import { requireApiPermission } from "@/lib/auth/guards";
import { CSV_BOM } from "@/lib/csv";
import { getPrisma } from "@/lib/db";
import { buildProductCsv } from "@/lib/products/csv";
import { listProductsForCsv } from "@/lib/products/queries";
import { parseProductListParams } from "@/lib/products/search-params";

/** ファイル名に使う日付（JST の YYYYMMDD） */
function jstDate(now: Date): string {
  return now
    .toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" })
    .replace(/-/g, "");
}

export async function GET(request: Request) {
  const auth = await requireApiPermission(request, "csv:export");
  if (!auth.ok) return auth.response;

  const params = parseProductListParams(new URL(request.url).searchParams);
  const products = await listProductsForCsv(getPrisma(), params);
  const fileName = `products_${jstDate(new Date())}.csv`;

  return new Response(CSV_BOM + buildProductCsv(products), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Cache-Control": "no-store",
    },
  });
}
