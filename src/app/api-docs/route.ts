/**
 * REST API の閲覧画面（GET /api-docs）。Swagger UI で /api/v1/openapi.json を表示する。docs/spec.md §6-2。
 * ログインなしで閲覧できる（src/proxy.ts で対象外）。HTML・CSP・SRI は src/lib/api/v1/docs-page.ts
 */
import { apiDocsResponse } from "@/lib/api/v1/docs-page";

export function GET() {
  return apiDocsResponse();
}
