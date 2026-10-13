/**
 * 商品の現在庫と発注点（GET /api/v1/products/{code}/stock）。docs/spec.md §6-2。
 * 商品コードは大文字に揃えて探す（画面と同じく p-0001 と P-0001 は同じ商品）
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
import { toApiProductStock } from "@/lib/api/v1/serialize";
import { getPrisma } from "@/lib/db";
import { getProduct } from "@/lib/products/queries";

export const GET = withApiErrors(
  async (
    request: Request,
    { params }: RouteContext<"/api/v1/products/[code]/stock">,
  ) => {
    const auth = await authenticateApiRequest(request, "view");
    if (!auth.ok) return auth.response;

    const param = readPathParam("code", (await params).code);
    if (!param.ok) return param.response;
    const code = param.value.trim().toUpperCase();
    const db = getPrisma();
    const found = await db.product.findUnique({
      where: { code },
      select: { id: true },
    });
    const product = found ? await getProduct(db, found.id) : null;
    if (!product) {
      return problem(404, `商品「${code}」が見つかりません`);
    }
    return apiJson(toApiProductStock(product));
  },
);

// 定義していないメソッドは 405（Allow 付き）。OPTIONS は定義したメソッドだけを Allow で返す
export const POST = methodNotAllowed(["GET"]);
export const PUT = methodNotAllowed(["GET"]);
export const PATCH = methodNotAllowed(["GET"]);
export const DELETE = methodNotAllowed(["GET"]);
export const OPTIONS = optionsHandler(["GET"]);
