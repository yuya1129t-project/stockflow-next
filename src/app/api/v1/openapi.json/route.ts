/**
 * OpenAPI 3.1 の定義（GET /api/v1/openapi.json）。docs/spec.md §6-2。
 * 認証は不要（API の形だけで、秘密やデータは含まない。/api-docs の閲覧画面もここを読む）
 */
import { buildOpenApiDocument } from "@/lib/api/v1/openapi";
import {
  apiJson,
  methodNotAllowed,
  optionsHandler,
} from "@/lib/api/v1/responses";

export function GET() {
  return apiJson(buildOpenApiDocument());
}

// 定義していないメソッドは 405（Allow 付き）。OPTIONS は定義したメソッドだけを Allow で返す
export const POST = methodNotAllowed(["GET"]);
export const PUT = methodNotAllowed(["GET"]);
export const PATCH = methodNotAllowed(["GET"]);
export const DELETE = methodNotAllowed(["GET"]);
export const OPTIONS = optionsHandler(["GET"]);
