/**
 * OpenAPI 3.1 の定義（GET /api/v1/openapi.json）。docs/spec.md §6-2。
 * 認証は不要（API の形だけで、秘密やデータは含まない。/api-docs の閲覧画面もここを読む）
 */
import { buildOpenApiDocument } from "@/lib/api/v1/openapi";
import { apiJson } from "@/lib/api/v1/responses";

export function GET() {
  return apiJson(buildOpenApiDocument());
}
