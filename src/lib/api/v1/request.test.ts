/**
 * REST API のリクエストの読み取り（本文・クエリ）と、エラーの組み立ての単体テスト
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  API_BODY_MAX_BYTES,
  QueryReader,
  readJsonBody,
  readPathParam,
  toJsonPointer,
  zodFieldErrors,
} from "./request";
import { servicePointer } from "./sales-orders";

function post(body: BodyInit | null, headers: Record<string, string>) {
  return new Request("http://localhost:3000/api/v1/sales-orders", {
    method: "POST",
    body,
    headers,
    // ReadableStream を本文にするときに必要
    duplex: "half",
  } as RequestInit);
}

/** Content-Length のない（チャンクで届く）本文 */
function stream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function problemOf(result: Awaited<ReturnType<typeof readJsonBody>>) {
  if (result.ok) throw new Error("成功してしまいました");
  return {
    status: result.response.status,
    contentType: result.response.headers.get("content-type"),
    body: (await result.response.json()) as { detail: string },
  };
}

describe("readJsonBody", () => {
  it.each([
    "application/json",
    "application/json; charset=utf-8",
    'Application/JSON; Charset="UTF-8"',
    "application/merge-patch+json",
  ])("Content-Type %s の JSON を読む", async (contentType) => {
    expect(
      await readJsonBody(
        post('{"a":[1,"あ"]}', { "content-type": contentType }),
      ),
    ).toEqual({ ok: true, value: { a: [1, "あ"] } });
  });

  it.each([
    [undefined],
    ["text/plain"],
    ["application/jsonx"],
    ["application/json; charset=shift_jis"],
    ["multipart/form-data; boundary=x"],
  ])("Content-Type %s は 415（Accept-Post を付ける）", async (contentType) => {
    const result = await readJsonBody(
      post("{}", contentType ? { "content-type": contentType } : {}),
    );
    if (result.ok) throw new Error("成功してしまいました");
    expect(result.response.status).toBe(415);
    expect(result.response.headers.get("accept-post")).toBe("application/json");
  });

  it("Content-Length が上限を超えていれば読まずに 413", async () => {
    const result = await readJsonBody(
      post("{}", {
        "content-type": "application/json",
        "content-length": String(API_BODY_MAX_BYTES + 1),
      }),
    );
    expect(await problemOf(result)).toMatchObject({
      status: 413,
      contentType: "application/problem+json",
    });
  });

  it("Content-Length がなくても、読みながら上限を超えたら 413。上限ちょうどは読める", async () => {
    const big = await readJsonBody(
      post(stream(['{"a":"', "x".repeat(40), '"}']), {
        "content-type": "application/json",
      }),
      40,
    );
    expect((await problemOf(big)).status).toBe(413);

    const exact = `{"a":"${"x".repeat(32)}"}`; // 40 バイト
    expect(exact).toHaveLength(40);
    expect(
      await readJsonBody(
        post(stream([exact.slice(0, 10), exact.slice(10)]), {
          "content-type": "application/json",
        }),
        40,
      ),
    ).toEqual({ ok: true, value: { a: "x".repeat(32) } });
  });

  it.each([
    ["JSON として正しくない", '{"a":', "本文が JSON として正しくありません"],
    ["空", "", "本文が空です"],
    ["空白だけ", "  \n", "本文が空です"],
  ])("%s本文は 400", async (_label, body, detail) => {
    expect(
      await problemOf(
        await readJsonBody(post(body, { "content-type": "application/json" })),
      ),
    ).toMatchObject({ status: 400, body: { detail } });
  });

  it("UTF-8 として正しくない本文は 400", async () => {
    const result = await readJsonBody(
      post(new Uint8Array([0x22, 0xff, 0xfe, 0x22]), {
        "content-type": "application/json",
      }),
    );
    expect(await problemOf(result)).toMatchObject({
      status: 400,
      body: { detail: "本文が UTF-8 として正しくありません" },
    });
  });
});

describe("NUL（U+0000）", () => {
  const json = (body: string) =>
    readJsonBody(post(body, { "content-type": "application/json" }));

  it("本文の文字列（値・キー）に NUL があれば 400 で位置を返す（入れ子・配列の中も）", async () => {
    const result = await json(
      JSON.stringify({
        customerCode: "C\u0000",
        note: "ok",
        lines: [{ productCode: "P\u0000" }, { productCode: "P-1" }],
        ["k\u0000"]: 1,
      }),
    );
    if (result.ok) throw new Error("成功してしまいました");
    expect(result.response.status).toBe(400);
    expect(await result.response.json()).toMatchObject({
      errors: [
        { pointer: "#/customerCode", detail: "NUL 文字（U+0000）は使えません" },
        { pointer: "#/k\u0000", detail: "NUL 文字（U+0000）は使えません" },
        {
          pointer: "#/lines/0/productCode",
          detail: "NUL 文字（U+0000）は使えません",
        },
      ],
    });
  });

  it("NUL のない本文と、深い入れ子（再帰しない）はそのまま読む", async () => {
    expect(await json('{"a":"\\u0001 改行\\n"}')).toEqual({
      ok: true,
      value: { a: "\u0001 改行\n" },
    });
    const deep = `${"[".repeat(30_000)}"x"${"]".repeat(30_000)}`;
    expect((await json(deep)).ok).toBe(true);
    const deepNul = `${"[".repeat(30_000)}"\\u0000"${"]".repeat(30_000)}`;
    expect((await json(deepNul)).ok).toBe(false);
  });

  it("クエリ・パスのパラメーターに NUL があれば 400", async () => {
    const r = new QueryReader(new URLSearchParams("q=%00&page=1%00"));
    expect(r.string("q", 100)).toBe("");
    r.paging();
    expect(r.errors).toEqual([
      { parameter: "q", detail: "NUL 文字（U+0000）は使えません" },
      { parameter: "page", detail: "NUL 文字（U+0000）は使えません" },
    ]);

    expect(readPathParam("code", "P-0001")).toEqual({
      ok: true,
      value: "P-0001",
    });
    const path = readPathParam("code", "\u0000");
    if (path.ok) throw new Error("成功してしまいました");
    expect(path.response.status).toBe(400);
    expect(await path.response.json()).toMatchObject({
      errors: [{ parameter: "code", detail: "NUL 文字（U+0000）は使えません" }],
    });
  });
});

describe("QueryReader", () => {
  const reader = (query: string) => new QueryReader(new URLSearchParams(query));

  it("page・perPage は既定 1・20、上限 100（範囲外・整数でない値・重複はエラー）", () => {
    expect(reader("").paging()).toEqual({ page: 1, perPage: 20 });
    expect(reader("page=3&perPage=100").paging()).toEqual({
      page: 3,
      perPage: 100,
    });
    for (const query of [
      "perPage=101",
      "perPage=0",
      "perPage=1.0",
      "perPage=+5",
      "perPage=",
      "perPage=1&perPage=2",
    ]) {
      const r = reader(query);
      r.paging();
      expect(
        r.errors.map((e) => e.parameter),
        query,
      ).toEqual(["perPage"]);
    }
  });

  it("日付は実在する YYYY-MM-DD だけ。選択肢は列挙した値だけ", () => {
    const r = reader("from=2026-10-13&to=2026-13-01&status=draft&x=1");
    expect(r.date("from")).toBe("2026-10-13");
    expect(r.date("to")).toBe("");
    expect(r.oneOf("status", ["draft", "confirmed"] as const)).toBe("draft");
    expect(r.errors.map((e) => e.parameter)).toEqual(["to"]);
    expect(r.problem()?.status).toBe(400);
    expect(reader("").problem()).toBeNull();
  });
});

describe("項目ごとのエラー", () => {
  it("JSON Pointer（RFC 6901）は ~ と / をエスケープする", () => {
    expect(toJsonPointer([])).toBe("#");
    expect(toJsonPointer(["lines", 0, "a/b~c"])).toBe("#/lines/0/a~1b~0c");
  });

  it("Zod のエラーを日本語の項目ごとのエラーにする。余分な項目は 1 項目ずつ", () => {
    const schema = z.strictObject({
      name: z.string().max(3),
      count: z.int().min(1),
      items: z.array(z.string()).min(1),
    });
    const input = { name: "abcd", count: 0.5, items: [], x: 1, y: 2 };
    expect(zodFieldErrors(schema.safeParse(input).error!, input)).toEqual([
      { pointer: "#/name", detail: "3 文字以内で指定してください" },
      { pointer: "#/count", detail: "整数で指定してください" },
      { pointer: "#/items", detail: "1 件以上で指定してください" },
      { pointer: "#/x", detail: "この項目は指定できません" },
      { pointer: "#/y", detail: "この項目は指定できません" },
    ]);
    const missing = {};
    expect(zodFieldErrors(schema.safeParse(missing).error!, missing)).toEqual([
      { pointer: "#/name", detail: "必須の項目です" },
      { pointer: "#/count", detail: "必須の項目です" },
      { pointer: "#/items", detail: "必須の項目です" },
    ]);
    const wrongType = { name: 1, count: "1", items: {} };
    expect(
      zodFieldErrors(schema.safeParse(wrongType).error!, wrongType),
    ).toEqual([
      { pointer: "#/name", detail: "文字列で指定してください" },
      { pointer: "#/count", detail: "数値で指定してください" },
      { pointer: "#/items", detail: "配列で指定してください" },
    ]);
  });

  it("受注の service の項目のキーを本文の項目にする（ID → コード）", () => {
    expect(servicePointer("customerId")).toBe("#/customerCode");
    expect(servicePointer("lines.2.productId")).toBe("#/lines/2/productCode");
    expect(servicePointer("lines.2.unitPrice")).toBe("#/lines/2/productCode");
    expect(servicePointer("lines.0.quantity")).toBe("#/lines/0/quantity");
    expect(servicePointer("lines")).toBe("#/lines");
    expect(servicePointer("dueDate")).toBe("#/dueDate");
    expect(servicePointer("_form")).toBe("#");
  });
});
