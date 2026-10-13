/**
 * 住所検索（zipcloud の中継）の負荷対策。サーバー側でだけ使う（Route Handler から呼ぶ）。
 *
 * - 郵便番号ごとの結果（住所・該当なし）をメモリにキャッシュする（TTL 1 日・上限 1,000 件）。
 *   郵便番号と住所の対応はほとんど変わらないので、同じ郵便番号で外部 API を何度も呼ばない
 * - ユーザーごとの回数制限（1 分 30 回）。超えたら Route Handler が 429 を返す
 * - どちらもプロセスのメモリ上にあるので、サーバーのインスタンスごとに効く（インスタンス間では共有しない）
 */
import { lookupAddress, type AddressLookupResult } from "./address-lookup";
import { normalizePostalCode } from "./schema";

type Clock = () => number;

/** TTL と件数の上限があるキャッシュ。上限を超えたら古く入れたものから捨てる */
export class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();

  constructor(
    private readonly options: {
      ttlMs: number;
      maxEntries: number;
      now?: Clock;
    },
  ) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, {
      value,
      expiresAt: this.now() + this.options.ttlMs,
    });
    while (this.entries.size > this.options.maxEntries) {
      // Map は入れた順に並ぶので、先頭が最も古い
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}

/** キー（ユーザー ID）ごとに、一定時間の回数を数える簡単な回数制限（固定ウィンドウ） */
export class FixedWindowRateLimiter {
  private readonly windows = new Map<
    string,
    { count: number; resetAt: number }
  >();

  constructor(
    private readonly options: {
      limit: number;
      windowMs: number;
      /** 数えるキーの上限（超えたら期限切れのものを捨てる） */
      maxKeys?: number;
      now?: Clock;
    },
  ) {}

  /** 1 回分を数える。上限を超えていれば ok: false と、次に使えるまでの秒数 */
  hit(key: string): { ok: true } | { ok: false; retryAfterSeconds: number } {
    const now = (this.options.now ?? Date.now)();
    let window = this.windows.get(key);
    if (!window || window.resetAt <= now) {
      window = { count: 0, resetAt: now + this.options.windowMs };
      this.windows.set(key, window);
      this.prune(now);
    }
    window.count++;
    if (window.count > this.options.limit) {
      return {
        ok: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((window.resetAt - now) / 1000),
        ),
      };
    }
    return { ok: true };
  }

  private prune(now: number) {
    if (this.windows.size <= (this.options.maxKeys ?? 10_000)) return;
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }
  }

  clear(): void {
    this.windows.clear();
  }
}

export const ADDRESS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const ADDRESS_CACHE_MAX_ENTRIES = 1_000;
export const ADDRESS_LOOKUP_RATE_LIMIT = { limit: 30, windowMs: 60 * 1000 };

export const ADDRESS_LOOKUP_RATE_LIMIT_MESSAGE =
  "住所の検索回数が多すぎます。しばらくしてからもう一度お試しいただくか、住所を手入力してください";

/** プロセス内のキャッシュ（郵便番号 7 桁 → 結果） */
export const addressCache = new TtlCache<AddressLookupResult>({
  ttlMs: ADDRESS_CACHE_TTL_MS,
  maxEntries: ADDRESS_CACHE_MAX_ENTRIES,
});

/** プロセス内の回数制限（ユーザー ID ごと） */
export const addressLookupRateLimiter = new FixedWindowRateLimiter(
  ADDRESS_LOOKUP_RATE_LIMIT,
);

/**
 * キャッシュを通した住所検索。成功と「該当なし」だけをキャッシュする
 * （タイムアウト・通信エラーなどの一時的な失敗はキャッシュしない）
 */
export async function lookupAddressCached(
  input: string,
  options: {
    lookup?: typeof lookupAddress;
    cache?: TtlCache<AddressLookupResult>;
  } = {},
): Promise<AddressLookupResult> {
  const postalCode = normalizePostalCode(input);
  if (!postalCode) return { ok: false, reason: "invalid_postal_code" };
  const cache = options.cache ?? addressCache;
  const cached = cache.get(postalCode);
  if (cached) return cached;
  const result = await (options.lookup ?? lookupAddress)(postalCode);
  if (result.ok || result.reason === "not_found") cache.set(postalCode, result);
  return result;
}
