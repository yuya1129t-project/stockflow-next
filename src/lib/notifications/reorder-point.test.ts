/**
 * 発注点割れの通知の単体テスト（DB・外部への送信なし。fetch と操作履歴の書き込みはモック）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";
import type { ReorderPointCrossing } from "@/lib/stock/rules";

import {
  appBaseUrl,
  buildReorderPointMessage,
  checkWebhookUrl,
  MAX_LISTED_PRODUCTS,
  NOTIFY_FAILED_ACTION,
  REORDER_NOTIFICATION_TIMEOUT_MS,
  sendReorderPointNotification,
  type ReorderPointNotification,
} from "./reorder-point";

const WEBHOOK = "https://hooks.example.test/services/T000/B000/secret-token";
const ENV = {
  STOCKFLOW_SLACK_WEBHOOK_URL: WEBHOOK,
  BETTER_AUTH_URL: "https://stockflow.example.test",
};

function crossing(
  productId: number,
  overrides: Partial<ReorderPointCrossing> = {},
): ReorderPointCrossing {
  return {
    productId,
    code: `P-${String(productId).padStart(4, "0")}`,
    name: `商品 ${productId}`,
    unit: "個",
    reorderPoint: 10,
    before: 12,
    after: 3,
    ...overrides,
  };
}

const SHIPPED: ReorderPointNotification = {
  crossings: [crossing(1), crossing(2, { unit: "箱", after: 0 })],
  trigger: {
    kind: "sales_order_shipped",
    salesOrderId: 7,
    number: "SO-20261013-001",
  },
  userId: "user-1",
};

function fakeDb() {
  const create = vi.fn(async (args: unknown) => args);
  return { db: { auditLog: { create } } as unknown as PrismaClient, create };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("checkWebhookUrl", () => {
  it("未設定・空白だけは unset", () => {
    expect(checkWebhookUrl(undefined)).toEqual({ ok: false, reason: "unset" });
    expect(checkWebhookUrl("")).toEqual({ ok: false, reason: "unset" });
    expect(checkWebhookUrl("  ")).toEqual({ ok: false, reason: "unset" });
  });

  it("https の URL だけを使う（前後の空白は除く）", () => {
    expect(checkWebhookUrl(` ${WEBHOOK} `)).toEqual({ ok: true, url: WEBHOOK });
  });

  it("http（平文）・ほかのスキームは not_https、URL でない・認証情報入りは invalid", () => {
    expect(checkWebhookUrl("http://hooks.example.test/x")).toEqual({
      ok: false,
      reason: "not_https",
    });
    expect(checkWebhookUrl("ftp://hooks.example.test/x")).toEqual({
      ok: false,
      reason: "not_https",
    });
    expect(checkWebhookUrl("hooks.example.test/x")).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(checkWebhookUrl("https://user:pass@hooks.example.test/x")).toEqual({
      ok: false,
      reason: "invalid",
    });
  });
});

describe("appBaseUrl", () => {
  it("末尾の / を除いた http／https の URL。それ以外・未設定は null", () => {
    expect(appBaseUrl("https://stockflow.example.test/")).toBe(
      "https://stockflow.example.test",
    );
    expect(appBaseUrl("http://127.0.0.1:3112")).toBe("http://127.0.0.1:3112");
    expect(appBaseUrl("https://example.test/app/")).toBe(
      "https://example.test/app",
    );
    expect(appBaseUrl(undefined)).toBeNull();
    expect(appBaseUrl("javascript:alert(1)")).toBeNull();
    expect(appBaseUrl("not a url")).toBeNull();
  });
});

describe("buildReorderPointMessage", () => {
  it("きっかけ・商品コード・名前・現在庫・発注点・在庫画面へのリンクを 1 通にまとめる", () => {
    const message = buildReorderPointMessage(
      SHIPPED.crossings,
      SHIPPED.trigger,
      "https://stockflow.example.test",
    );
    expect(message.text).toBe(
      [
        "発注点を下回った商品が 2 件あります（受注 SO-20261013-001 の出荷）",
        "・<https://stockflow.example.test/stock/1|P-0001 商品 1>: 現在庫 3個（発注点 10個・変更前 12個）",
        "・<https://stockflow.example.test/stock/2|P-0002 商品 2>: 現在庫 0箱（発注点 10箱・変更前 12箱）",
      ].join("\n"),
    );
    expect(message.blocks).toEqual([
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*発注点を下回った商品が 2 件あります（受注 SO-20261013-001 の出荷）*",
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*<https://stockflow.example.test/stock/1|P-0001 商品 1>*\n現在庫 3個（発注点 10個・変更前 12個）",
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*<https://stockflow.example.test/stock/2|P-0002 商品 2>*\n現在庫 0箱（発注点 10箱・変更前 12箱）",
        },
      },
    ]);
  });

  it("棚卸調整のきっかけ。ベース URL がなければリンクなし。数は 3 桁区切り", () => {
    const message = buildReorderPointMessage(
      [crossing(3, { before: 12_000, after: 900, reorderPoint: 1_000 })],
      { kind: "stock_adjust", productId: 3 },
      null,
    );
    expect(message.text).toBe(
      "発注点を下回った商品が 1 件あります（棚卸調整）\n・P-0003 商品 3: 現在庫 900個（発注点 1,000個・変更前 12,000個）",
    );
    expect(message.text).not.toContain("<");
  });

  it("商品名の &・<・> はエスケープする（リンクや宛先の書式として解釈させない）", () => {
    const message = buildReorderPointMessage(
      [crossing(4, { name: "<!channel> A&B >" })],
      { kind: "stock_adjust", productId: 4 },
      "https://stockflow.example.test",
    );
    expect(message.text).toContain(
      "<https://stockflow.example.test/stock/4|P-0004 &lt;!channel&gt; A&amp;B &gt;>",
    );
    expect(message.text).not.toContain("<!channel>");
  });

  it(`${MAX_LISTED_PRODUCTS} 件を超えた分は「ほか N 件」にまとめる`, () => {
    const many = Array.from({ length: MAX_LISTED_PRODUCTS + 3 }, (_, i) =>
      crossing(i + 1),
    );
    const message = buildReorderPointMessage(
      many,
      { kind: "sales_order_shipped", salesOrderId: 1, number: "SO-1" },
      "https://stockflow.example.test",
    );
    // 見出し 1 + 商品 20 + ほか 1
    expect(message.blocks).toHaveLength(MAX_LISTED_PRODUCTS + 2);
    expect(message.blocks.at(-1)).toEqual({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "ほか 3 件（<https://stockflow.example.test/stock?level=low|在庫一覧の発注点割れ>で確認してください）",
        },
      ],
    });
    expect(message.text.split("\n")).toHaveLength(MAX_LISTED_PRODUCTS + 2);
    expect(message.text).toContain("発注点を下回った商品が 23 件あります");
  });
});

describe("sendReorderPointNotification", () => {
  it("成功: Webhook URL に JSON を POST する（3 秒のタイムアウト・リダイレクトはエラー）。操作履歴は残さない", async () => {
    const { db, create } = fakeDb();
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    const timeout = vi.spyOn(AbortSignal, "timeout");

    const result = await sendReorderPointNotification(db, SHIPPED, {
      fetch: fetchMock,
      env: ENV,
    });

    expect(result).toEqual({ status: "sent" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(WEBHOOK);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.headers).toEqual({
      "Content-Type": "application/json; charset=utf-8",
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(timeout).toHaveBeenCalledWith(REORDER_NOTIFICATION_TIMEOUT_MS);
    expect(JSON.parse(init.body as string)).toEqual(
      buildReorderPointMessage(
        SHIPPED.crossings,
        SHIPPED.trigger,
        "https://stockflow.example.test",
      ),
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("Webhook URL が未設定なら送らない（操作履歴も残さない）", async () => {
    const { db, create } = fakeDb();
    const fetchMock = vi.fn();
    for (const value of [undefined, "", "  "]) {
      expect(
        await sendReorderPointNotification(db, SHIPPED, {
          fetch: fetchMock,
          env: { ...ENV, STOCKFLOW_SLACK_WEBHOOK_URL: value },
        }),
      ).toEqual({ status: "skipped", reason: "not_configured" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("対象の商品がなければ送らない", async () => {
    const { db } = fakeDb();
    const fetchMock = vi.fn();
    expect(
      await sendReorderPointNotification(
        db,
        { ...SHIPPED, crossings: [] },
        { fetch: fetchMock, env: ENV },
      ),
    ).toEqual({ status: "skipped", reason: "no_crossings" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("https でない URL には送らず、ログと操作履歴（設定が不正）に残す。URL は記録しない", async () => {
    const { db, create } = fakeDb();
    const fetchMock = vi.fn();
    const result = await sendReorderPointNotification(db, SHIPPED, {
      fetch: fetchMock,
      env: {
        ...ENV,
        STOCKFLOW_SLACK_WEBHOOK_URL: "http://hooks.example.test/x",
      },
    });
    expect(result).toEqual({ status: "failed", reason: "invalid_url" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      data: {
        userId: "user-1",
        action: NOTIFY_FAILED_ACTION,
        targetType: "sales_order",
        targetId: "7",
        summary:
          "発注点割れの通知を送信できませんでした（受注 SO-20261013-001 の出荷・商品 P-0001、P-0002）。原因: Webhook URL の設定が不正（https の URL ではない）",
      },
    });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
      "hooks.example.test",
    );
  });

  it("HTTP エラー: 操作履歴に原因（ステータス）を記録する。応答本文・URL は記録しない", async () => {
    const { db, create } = fakeDb();
    const fetchMock = vi.fn(
      async () => new Response("invalid_token secret-detail", { status: 403 }),
    );
    const result = await sendReorderPointNotification(
      db,
      {
        ...SHIPPED,
        trigger: { kind: "stock_adjust", productId: 1 },
        crossings: [crossing(1)],
      },
      { fetch: fetchMock, env: ENV },
    );
    expect(result).toEqual({
      status: "failed",
      reason: "http_error",
      httpStatus: 403,
    });
    expect(create).toHaveBeenCalledWith({
      data: {
        userId: "user-1",
        action: NOTIFY_FAILED_ACTION,
        targetType: "product",
        targetId: "1",
        summary:
          "発注点割れの通知を送信できませんでした（棚卸調整・商品 P-0001）。原因: HTTP エラー（403）",
      },
    });
    const recorded = JSON.stringify(create.mock.calls);
    expect(recorded).not.toContain("secret");
    expect(recorded).not.toContain("hooks.example.test");
  });

  it("タイムアウト: 応答がなければ中断して操作履歴に残す", async () => {
    const { db, create } = fakeDb();
    // signal が中断されるまで応答しない
    const fetchMock = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal!.reason),
          );
        }),
    );
    const result = await sendReorderPointNotification(db, SHIPPED, {
      fetch: fetchMock,
      env: ENV,
      timeoutMs: 20,
    });
    expect(result).toEqual({ status: "failed", reason: "timeout" });
    expect(create.mock.calls[0][0]).toMatchObject({
      data: {
        action: NOTIFY_FAILED_ACTION,
        summary: expect.stringContaining("原因: タイムアウト（3 秒）"),
      },
    });
  });

  it("リダイレクト: たどらずに通信エラーとして操作履歴に残す", async () => {
    const { db, create } = fakeDb();
    // redirect: "error" のとき、fetch は 3xx の応答で TypeError を投げる（undici と同じ形）
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.redirect === "error") {
          throw new TypeError("fetch failed", {
            cause: new Error("unexpected redirect"),
          });
        }
        return new Response(null, {
          status: 302,
          headers: { Location: "http://evil.example.test/" },
        });
      },
    );
    const result = await sendReorderPointNotification(db, SHIPPED, {
      fetch: fetchMock,
      env: ENV,
    });
    expect(result).toEqual({ status: "failed", reason: "network_error" });
    expect(create.mock.calls[0][0]).toMatchObject({
      data: {
        summary: expect.stringContaining(
          "原因: 通信エラー（接続できない・リダイレクトなど）",
        ),
      },
    });
  });

  it("通信エラー: 例外を投げず、操作履歴に残す。ログには例外の種類だけを出す", async () => {
    const { db, create } = fakeDb();
    const fetchMock = vi.fn(async () => {
      throw new TypeError(`fetch failed ${WEBHOOK}`, {
        cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }),
      });
    });
    const result = await sendReorderPointNotification(db, SHIPPED, {
      fetch: fetchMock,
      env: ENV,
    });
    expect(result).toEqual({ status: "failed", reason: "network_error" });
    expect(create).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(vi.mocked(console.warn).mock.calls);
    expect(logged).toContain("ECONNREFUSED");
    expect(logged).not.toContain("secret-token");
  });

  it("操作履歴の書き込みに失敗しても例外を投げない", async () => {
    const create = vi.fn(async () => {
      throw new Error("db down");
    });
    const db = { auditLog: { create } } as unknown as PrismaClient;
    const fetchMock = vi.fn(async () => new Response("", { status: 500 }));
    await expect(
      sendReorderPointNotification(db, SHIPPED, { fetch: fetchMock, env: ENV }),
    ).resolves.toEqual({
      status: "failed",
      reason: "http_error",
      httpStatus: 500,
    });
    expect(console.error).toHaveBeenCalled();
  });
});
