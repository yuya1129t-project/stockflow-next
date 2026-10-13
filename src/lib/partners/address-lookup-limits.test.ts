/**
 * 住所検索の負荷対策（キャッシュ・回数制限）。時計は差し替え、外部 API は呼ばない
 */
import { describe, expect, it, vi } from "vitest";

import type { AddressLookupResult } from "./address-lookup";
import {
  ADDRESS_CACHE_MAX_ENTRIES,
  ADDRESS_CACHE_TTL_MS,
  ADDRESS_LOOKUP_RATE_LIMIT,
  FixedWindowRateLimiter,
  lookupAddressCached,
  TtlCache,
} from "./address-lookup-limits";

function clock(start = 0) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("設定値", () => {
  it("キャッシュは TTL 1 日・上限 1,000 件、回数制限は 1 分 30 回", () => {
    expect(ADDRESS_CACHE_TTL_MS).toBe(86_400_000);
    expect(ADDRESS_CACHE_MAX_ENTRIES).toBe(1_000);
    expect(ADDRESS_LOOKUP_RATE_LIMIT).toEqual({ limit: 30, windowMs: 60_000 });
  });
});

describe("TtlCache", () => {
  it("TTL を過ぎたら消える", () => {
    const c = clock();
    const cache = new TtlCache<string>({
      ttlMs: 1000,
      maxEntries: 10,
      now: c.now,
    });
    cache.set("a", "A");
    c.advance(999);
    expect(cache.get("a")).toBe("A");
    c.advance(1);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("件数の上限を超えたら、古く入れたものから捨てる", () => {
    const cache = new TtlCache<number>({ ttlMs: 1000, maxEntries: 2 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("a", 11); // 入れ直すと新しい扱い
    cache.set("c", 3);
    expect(cache.size).toBe(2);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(11);
    expect(cache.get("c")).toBe(3);
  });
});

describe("FixedWindowRateLimiter", () => {
  it("1 分に上限回数まで通し、超えたら拒否。時間がたてば戻る。ユーザーごとに別に数える", () => {
    const c = clock();
    const limiter = new FixedWindowRateLimiter({
      limit: 3,
      windowMs: 60_000,
      now: c.now,
    });
    for (let i = 0; i < 3; i++) expect(limiter.hit("u1")).toEqual({ ok: true });
    c.advance(15_000);
    expect(limiter.hit("u1")).toEqual({ ok: false, retryAfterSeconds: 45 });
    expect(limiter.hit("u2")).toEqual({ ok: true });
    c.advance(45_000);
    expect(limiter.hit("u1")).toEqual({ ok: true });
  });
});

describe("lookupAddressCached", () => {
  const FOUND: AddressLookupResult = {
    ok: true,
    postalCode: "0000001",
    addresses: ["デモ県サンプル市中央"],
  };

  function setup(result: AddressLookupResult) {
    const cache = new TtlCache<AddressLookupResult>({
      ttlMs: 1000,
      maxEntries: 10,
    });
    const lookup = vi.fn(async () => result);
    return { cache, lookup };
  }

  it("成功は郵便番号（ハイフンなし）ごとにキャッシュし、2 回目は外部 API を呼ばない", async () => {
    const { cache, lookup } = setup(FOUND);
    await expect(
      lookupAddressCached("000-0001", { cache, lookup }),
    ).resolves.toEqual(FOUND);
    await expect(
      lookupAddressCached("0000001", { cache, lookup }),
    ).resolves.toEqual(FOUND);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith("0000001");
  });

  it("該当なしもキャッシュする", async () => {
    const { cache, lookup } = setup({ ok: false, reason: "not_found" });
    await lookupAddressCached("0000001", { cache, lookup });
    await lookupAddressCached("0000001", { cache, lookup });
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it.each(["timeout", "unavailable", "invalid_response"] as const)(
    "一時的な失敗（%s）はキャッシュしない",
    async (reason) => {
      const { cache, lookup } = setup({ ok: false, reason });
      await lookupAddressCached("0000001", { cache, lookup });
      await lookupAddressCached("0000001", { cache, lookup });
      expect(lookup).toHaveBeenCalledTimes(2);
      expect(cache.size).toBe(0);
    },
  );

  it("形式が違う郵便番号は外部 API もキャッシュも使わない", async () => {
    const { cache, lookup } = setup(FOUND);
    await expect(lookupAddressCached("12", { cache, lookup })).resolves.toEqual(
      {
        ok: false,
        reason: "invalid_postal_code",
      },
    );
    expect(lookup).not.toHaveBeenCalled();
  });
});
