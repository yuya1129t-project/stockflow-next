/**
 * /api/v1 の下の、定義されていないパス。Next.js の既定の 404（HTML）ではなく RFC 9457 の 404 を返す
 */
import { problem } from "@/lib/api/v1/responses";

function notFound(): Response {
  return problem(
    404,
    "この URL の API はありません（/api-docs を参照してください）",
  );
}

export const GET = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
