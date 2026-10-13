/**
 * 商品一覧（GET /api/v1/products?q=&page=&perPage=）。docs/spec.md §6-2、定義は src/lib/api/v1/openapi.ts。
 * 現在庫を含む。無効な商品も含める（isActive で区別）。並びは商品コードの昇順
 */
import { authenticateApiRequest } from "@/lib/api/v1/auth";
import { QueryReader } from "@/lib/api/v1/request";
import { apiJson, withApiErrors } from "@/lib/api/v1/responses";
import { API_QUERY_MAX_LENGTH } from "@/lib/api/v1/schemas";
import { toApiProduct } from "@/lib/api/v1/serialize";
import { getPrisma } from "@/lib/db";
import { listProducts } from "@/lib/products/queries";
import { DEFAULT_PRODUCT_LIST_PARAMS } from "@/lib/products/search-params";

export const GET = withApiErrors(async (request: Request) => {
  const auth = await authenticateApiRequest(request, "view");
  if (!auth.ok) return auth.response;

  const query = new QueryReader(new URL(request.url).searchParams);
  const q = query.string("q", API_QUERY_MAX_LENGTH);
  const { page, perPage } = query.paging();
  const invalid = query.problem();
  if (invalid) return invalid;

  const result = await listProducts(
    getPrisma(),
    { ...DEFAULT_PRODUCT_LIST_PARAMS, q, status: "all", page },
    { perPage, clampPage: false },
  );
  return apiJson({
    data: result.items.map(toApiProduct),
    meta: { page, perPage, total: result.total },
  });
});
