/**
 * 郵便番号から住所を検索する（GET /api/partners/address-lookup?postalCode=1234567）。spec §6
 *
 * - 外部 API（zipcloud）はブラウザから直接呼ばず、このサーバー側の Route Handler から呼ぶ
 * - 読み取りだけで副作用はない（Cookie 認証の GET に副作用を持たせない）。取引先の登録・編集の画面で使うので、
 *   権限は master:edit をサーバー側で検査する（未ログインは 401、権限外は 403）
 * - 負荷対策: ユーザーごとの回数制限（超えたら 429）と、郵便番号ごとの結果のキャッシュ（address-lookup-limits.ts）
 * - 応答: 200 { postalCode, addresses } ／ 400 形式エラー ／ 404 該当なし ／ 429 回数超過 ／ 502 失敗・不正な応答 ／
 *   504 タイムアウト。失敗時の本文は { error: 日本語のメッセージ（「住所を手入力してください」を含む）, reason }
 */
import { requireApiPermission } from "@/lib/auth/guards";
import {
  ADDRESS_LOOKUP_MESSAGES,
  type AddressLookupFailure,
} from "@/lib/partners/address-lookup";
import {
  ADDRESS_LOOKUP_RATE_LIMIT_MESSAGE,
  addressLookupRateLimiter,
  lookupAddressCached,
} from "@/lib/partners/address-lookup-limits";

const STATUS: Record<AddressLookupFailure, number> = {
  invalid_postal_code: 400,
  not_found: 404,
  timeout: 504,
  unavailable: 502,
  invalid_response: 502,
};

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  const auth = await requireApiPermission(request, "master:edit");
  if (!auth.ok) return auth.response;

  const rate = addressLookupRateLimiter.hit(auth.user.id);
  if (!rate.ok) {
    return Response.json(
      { error: ADDRESS_LOOKUP_RATE_LIMIT_MESSAGE, reason: "rate_limited" },
      {
        status: 429,
        headers: { ...NO_STORE, "Retry-After": String(rate.retryAfterSeconds) },
      },
    );
  }

  const postalCode =
    new URL(request.url).searchParams.get("postalCode")?.slice(0, 20) ?? "";
  const result = await lookupAddressCached(postalCode);
  if (!result.ok) {
    return Response.json(
      { error: ADDRESS_LOOKUP_MESSAGES[result.reason], reason: result.reason },
      { status: STATUS[result.reason], headers: NO_STORE },
    );
  }
  return Response.json(
    { postalCode: result.postalCode, addresses: result.addresses },
    { headers: NO_STORE },
  );
}
