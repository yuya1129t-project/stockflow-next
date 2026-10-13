/**
 * 受注一覧（GET /api/v1/sales-orders?status=&from=&to=&page=&perPage=）と受注の登録（POST /api/v1/sales-orders）。
 * docs/spec.md §6-2、定義は src/lib/api/v1/openapi.ts。
 *
 * - 一覧は受注日の新しい順（同じ日は受注番号の降順。画面の既定と同じ）
 * - 登録は admin／staff（order:edit）。画面と同じ受注の service で draft を作成する（src/lib/api/v1/sales-orders.ts）。
 *   認証・認可を先に行い、本文はその後で読む（認証されていないリクエストの本文は読まない）
 */
import { authenticateApiRequest } from "@/lib/api/v1/auth";
import { QueryReader, readJsonBody } from "@/lib/api/v1/request";
import { apiJson, withApiErrors } from "@/lib/api/v1/responses";
import { createSalesOrderFromApi } from "@/lib/api/v1/sales-orders";
import {
  toApiSalesOrder,
  toApiSalesOrderSummary,
} from "@/lib/api/v1/serialize";
import { getPrisma } from "@/lib/db";
import { listSalesOrders } from "@/lib/sales-orders/queries";
import { DEFAULT_SALES_ORDER_LIST_PARAMS } from "@/lib/sales-orders/search-params";
import { SALES_ORDER_STATUSES } from "@/lib/sales-orders/status";

export const GET = withApiErrors(async (request: Request) => {
  const auth = await authenticateApiRequest(request, "view");
  if (!auth.ok) return auth.response;

  const query = new QueryReader(new URL(request.url).searchParams);
  const status = query.oneOf("status", SALES_ORDER_STATUSES);
  const from = query.date("from");
  const to = query.date("to");
  if (from && to && from > to) {
    query.errors.push({
      parameter: "to",
      detail: "to は from 以降の日付で指定してください",
    });
  }
  const { page, perPage } = query.paging();
  const invalid = query.problem();
  if (invalid) return invalid;

  const result = await listSalesOrders(
    getPrisma(),
    { ...DEFAULT_SALES_ORDER_LIST_PARAMS, status, from, to, page },
    { perPage, clampPage: false },
  );
  return apiJson({
    data: result.items.map(toApiSalesOrderSummary),
    meta: { page, perPage, total: result.total },
  });
});

export const POST = withApiErrors(async (request: Request) => {
  const auth = await authenticateApiRequest(request, "order:edit");
  if (!auth.ok) return auth.response;

  const body = await readJsonBody(request);
  if (!body.ok) return body.response;

  const result = await createSalesOrderFromApi(
    getPrisma(),
    auth.user,
    auth.tokenId,
    body.value,
  );
  if (!result.ok) return result.response;
  return apiJson(toApiSalesOrder(result.order), {
    status: 201,
    headers: {
      Location: `/api/v1/sales-orders/${encodeURIComponent(result.order.number)}`,
    },
  });
});
