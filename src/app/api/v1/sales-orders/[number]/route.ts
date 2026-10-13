/**
 * 受注詳細（GET /api/v1/sales-orders/{number}）。明細を含む。docs/spec.md §6-2。
 * 受注番号は大文字に揃えて探す
 */
import { authenticateApiRequest } from "@/lib/api/v1/auth";
import { readPathParam } from "@/lib/api/v1/request";
import {
  apiJson,
  methodNotAllowed,
  optionsHandler,
  problem,
  withApiErrors,
} from "@/lib/api/v1/responses";
import { toApiSalesOrder } from "@/lib/api/v1/serialize";
import { getPrisma } from "@/lib/db";
import { getSalesOrder } from "@/lib/sales-orders/queries";

export const GET = withApiErrors(
  async (
    request: Request,
    { params }: RouteContext<"/api/v1/sales-orders/[number]">,
  ) => {
    const auth = await authenticateApiRequest(request, "view");
    if (!auth.ok) return auth.response;

    const param = readPathParam("number", (await params).number);
    if (!param.ok) return param.response;
    const number = param.value.trim().toUpperCase();
    const db = getPrisma();
    const found = await db.salesOrder.findUnique({
      where: { number },
      select: { id: true },
    });
    const order = found ? await getSalesOrder(db, found.id) : null;
    if (!order) {
      return problem(404, `受注「${number}」が見つかりません`);
    }
    return apiJson(toApiSalesOrder(order));
  },
);

// 定義していないメソッドは 405（Allow 付き）。OPTIONS は定義したメソッドだけを Allow で返す
export const POST = methodNotAllowed(["GET"]);
export const PUT = methodNotAllowed(["GET"]);
export const PATCH = methodNotAllowed(["GET"]);
export const DELETE = methodNotAllowed(["GET"]);
export const OPTIONS = optionsHandler(["GET"]);
