/**
 * 受注詳細（GET /api/v1/sales-orders/{number}）。明細を含む。docs/spec.md §6-2。
 * 受注番号は大文字に揃えて探す
 */
import { authenticateApiRequest } from "@/lib/api/v1/auth";
import { apiJson, problem, withApiErrors } from "@/lib/api/v1/responses";
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

    const number = (await params).number.trim().toUpperCase();
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
