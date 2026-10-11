/**
 * 商品マスタの結合テスト（実 DB = DATABASE_URL_TEST）。docs/spec.md §2・§3・§5・§7
 * 前提: pnpm db:test:reset でテスト用 DB にマイグレーションとシードを適用済み
 *
 * シードの商品は書き換えない。登録・編集・取込はこのファイル専用の商品コード（ZT- で始まる）で行い、
 * 作った商品とその操作履歴は終了時に削除する（他のテストファイルのシード件数の確認に影響させない）
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";
import { toCsv } from "@/lib/csv";
import type { SessionUser } from "@/lib/auth/session";
import { PRODUCT_IMPORT_MAX_ROWS } from "@/lib/products/csv";
import {
  getProduct,
  listProductCategories,
  listProducts,
  listProductsForCsv,
} from "@/lib/products/queries";
import {
  DEFAULT_PRODUCT_LIST_PARAMS,
  PRODUCTS_PER_PAGE,
  type ProductListParams,
} from "@/lib/products/search-params";
import type { ProductFormValues } from "@/lib/products/schema";
import {
  createProduct,
  importProductCsv,
  importProducts,
  IMPORT_UPDATE_CHUNK_SIZE,
  PRODUCT_TARGET_TYPE,
  setProductActive,
  updateProduct,
} from "@/lib/products/service";

import { DEMO_USERS } from "../../prisma/seed-data";
import { connectTestDb, SETUP_HINT } from "./test-db";

let prisma: PrismaClient;
const startedAt = new Date();

const [ADMIN, STAFF, VIEWER] = DEMO_USERS.map(
  ({ id, name, email, role }): SessionUser => ({ id, name, email, role }),
);

/** このファイルで作る商品のコードの接頭辞 */
const PREFIX = "ZT-";

function form(code: string, overrides: Partial<ProductFormValues> = {}) {
  return {
    code,
    name: `結合テスト商品 ${code}`,
    category: "結合テスト",
    unit: "個",
    salesPrice: "150",
    purchasePrice: "100",
    reorderPoint: "5",
    ...overrides,
  } satisfies ProductFormValues;
}

async function testProductIds(): Promise<string[]> {
  const products = await prisma.product.findMany({
    where: { code: { startsWith: PREFIX } },
    select: { id: true },
  });
  return products.map((p) => String(p.id));
}

async function cleanUp() {
  await prisma.auditLog.deleteMany({
    where: {
      targetType: PRODUCT_TARGET_TYPE,
      OR: [
        { targetId: { in: await testProductIds() } },
        // CSV 取込の履歴（targetId なし）。このファイルの実行中に作られたものだけ
        { action: "import", createdAt: { gte: startedAt } },
      ],
    },
  });
  await prisma.product.deleteMany({ where: { code: { startsWith: PREFIX } } });
}

beforeAll(async () => {
  prisma = await connectTestDb();
  if ((await prisma.product.count()) === 0) {
    throw new Error(`テスト用 DB にシードが入っていません。${SETUP_HINT}`);
  }
  await cleanUp();
});

afterAll(async () => {
  if (!prisma) return;
  try {
    await cleanUp();
  } finally {
    await prisma.$disconnect();
  }
});

/** CSV 出力と同じ取得（上限内の行） */
async function exportRows(p: ProductListParams) {
  return (await listProductsForCsv(prisma, p)).items;
}

function params(overrides: Partial<ProductListParams> = {}): ProductListParams {
  return { ...DEFAULT_PRODUCT_LIST_PARAMS, ...overrides };
}

/** 商品を作って ID を返す（失敗したらテストを失敗させる） */
async function create(
  code: string,
  overrides: Partial<ProductFormValues> = {},
) {
  const result = await createProduct(prisma, STAFF, form(code, overrides));
  if (!result.ok) throw new Error(result.error);
  return result.data.id;
}

function auditLogsOf(id: number) {
  return prisma.auditLog.findMany({
    where: { targetType: PRODUCT_TARGET_TYPE, targetId: String(id) },
    orderBy: { id: "asc" },
  });
}

function csvBytes(rows: string[][]): Uint8Array {
  return new TextEncoder().encode(toCsv(rows));
}

const CSV_HEADER = [
  "商品コード",
  "商品名",
  "カテゴリ",
  "単位",
  "売価",
  "仕入単価",
  "発注点",
];

function csvRow(code: string, overrides: Partial<ProductFormValues> = {}) {
  const v = form(code, overrides);
  return [
    v.code,
    v.name,
    v.category,
    v.unit,
    v.salesPrice,
    v.purchasePrice,
    v.reorderPoint,
  ];
}

describe("一覧（検索・並べ替え・ページ送り・現在庫）", () => {
  it("既定は有効な商品を商品コード順に 20 件ずつ", async () => {
    const activeCount = await prisma.product.count({
      where: { isActive: true },
    });
    const result = await listProducts(prisma, params());
    expect(result.total).toBe(activeCount);
    expect(result.items).toHaveLength(Math.min(PRODUCTS_PER_PAGE, activeCount));
    const codes = result.items.map((p) => p.code);
    expect(codes).toEqual([...codes].sort());
    expect(result.items.every((p) => p.isActive)).toBe(true);
  });

  it("現在庫は入出庫の合計と一致する（全商品）", async () => {
    const sums = await prisma.stockMovement.groupBy({
      by: ["productId"],
      _sum: { quantity: true },
    });
    const expected = new Map(sums.map((s) => [s.productId, s._sum.quantity]));
    const all = await exportRows(params({ status: "all" }));
    expect(all.length).toBe(await prisma.product.count());
    const rows = await listProducts(prisma, params({ status: "all" }));
    for (const item of rows.items) {
      expect(item.stock).toBe(expected.get(item.id) ?? 0);
    }
    // 詳細も同じ値
    const first = rows.items[0];
    expect((await getProduct(prisma, first.id))?.stock).toBe(first.stock);
  });

  it("シードには発注点を下回る商品がある（強調表示の対象）", async () => {
    const all = await exportRows(params());
    expect(all.some((p) => p.stock < p.reorderPoint)).toBe(true);
  });

  it("キーワードは商品コード・商品名・カテゴリの部分一致（大文字小文字を区別しない）", async () => {
    const byCode = await listProducts(prisma, params({ q: "p-000" }));
    expect(byCode.total).toBe(9); // P-0001〜P-0009
    expect(byCode.items.every((p) => p.code.startsWith("P-000"))).toBe(true);

    const seed = await prisma.product.findFirstOrThrow({
      where: { isActive: true },
      orderBy: { id: "asc" },
    });
    const byName = await listProducts(prisma, params({ q: seed.name }));
    expect(byName.items.map((p) => p.id)).toContain(seed.id);

    const byCategory = await listProducts(prisma, params({ q: seed.category }));
    expect(byCategory.total).toBe(
      await prisma.product.count({
        where: { isActive: true, category: { contains: seed.category } },
      }),
    );
  });

  it("キーワードの % _ は文字として扱う（LIKE のワイルドカードにしない）", async () => {
    expect((await listProducts(prisma, params({ q: "%" }))).total).toBe(0);
    expect((await listProducts(prisma, params({ q: "_" }))).total).toBe(0);
  });

  it("カテゴリで絞り込める（カテゴリの一覧はシードから取れる）", async () => {
    const categories = await listProductCategories(prisma);
    expect(categories.length).toBeGreaterThan(1);
    const category = categories[0];
    const result = await listProducts(prisma, params({ category }));
    expect(result.total).toBe(
      await prisma.product.count({ where: { category, isActive: true } }),
    );
    expect(result.items.every((p) => p.category === category)).toBe(true);
  });

  it("現在庫・売価・商品名で並べ替えられる（昇順・降順）", async () => {
    const byStockDesc = await exportRows(
      params({ sort: "stock", order: "desc" }),
    );
    const stocks = byStockDesc.map((p) => p.stock);
    expect(stocks).toEqual([...stocks].sort((a, b) => b - a));

    const byPrice = await exportRows(
      params({ sort: "salesPrice", order: "asc" }),
    );
    const prices = byPrice.map((p) => p.salesPrice);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));

    const byNameAsc = await exportRows(params({ sort: "name" }));
    const byNameDesc = await exportRows(
      params({ sort: "name", order: "desc" }),
    );
    expect(byNameDesc.map((p) => p.id)).toEqual(
      byNameAsc.map((p) => p.id).reverse(),
    );
  });

  it("ページ送り: 2 ページ目は続きの 20 件。範囲外のページは最終ページに丸める", async () => {
    const page1 = await listProducts(prisma, params());
    const page2 = await listProducts(prisma, params({ page: 2 }));
    expect(page2.page).toBe(2);
    expect(page2.items[0].code > page1.items.at(-1)!.code).toBe(true);
    const all = await exportRows(params());
    expect([...page1.items, ...page2.items].map((p) => p.code)).toEqual(
      all.slice(0, PRODUCTS_PER_PAGE * 2).map((p) => p.code),
    );

    const beyond = await listProducts(prisma, params({ page: 999 }));
    expect(beyond.page).toBe(beyond.totalPages);
    expect(beyond.items.length).toBeGreaterThan(0);
  });

  it("無効な商品は「有効のみ」に出ず、「無効のみ」「無効も表示」に出る", async () => {
    const id = await create(`${PREFIX}LIST-INACTIVE`);
    expect((await setProductActive(prisma, ADMIN, id, false)).ok).toBe(true);
    const q = `${PREFIX}LIST-INACTIVE`;
    expect((await listProducts(prisma, params({ q }))).total).toBe(0);
    expect(
      (await listProducts(prisma, params({ q, status: "inactive" }))).items,
    ).toMatchObject([{ id, isActive: false, stock: 0 }]);
    expect(
      (await listProducts(prisma, params({ q, status: "all" }))).total,
    ).toBe(1);
  });
});

describe("登録・編集", () => {
  it("staff は登録でき、操作履歴（create）が残る", async () => {
    const result = await createProduct(
      prisma,
      STAFF,
      form(`${PREFIX}NEW-1`, { salesPrice: "1,200" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const product = await prisma.product.findUniqueOrThrow({
      where: { id: result.data.id },
    });
    expect(product).toMatchObject({
      code: `${PREFIX}NEW-1`,
      salesPrice: 1200,
      isActive: true,
    });
    const logs = await auditLogsOf(product.id);
    expect(logs).toMatchObject([
      {
        userId: STAFF.id,
        action: "create",
        targetType: "product",
        summary: `商品 ${PREFIX}NEW-1「結合テスト商品 ${PREFIX}NEW-1」を登録しました`,
      },
    ]);
  });

  it("商品コードが重複するとエラー（分かりやすいメッセージ）で、何も記録しない", async () => {
    await create(`${PREFIX}DUP`);
    const before = await prisma.auditLog.count();
    const result = await createProduct(prisma, ADMIN, form(`${PREFIX}DUP`));
    expect(result).toEqual({
      ok: false,
      error: `商品コード「${PREFIX}DUP」はすでに登録されています`,
      fieldErrors: {
        code: [`商品コード「${PREFIX}DUP」はすでに登録されています`],
      },
    });
    expect(await prisma.auditLog.count()).toBe(before);
    expect(
      await prisma.product.count({ where: { code: `${PREFIX}DUP` } }),
    ).toBe(1);
  });

  it("商品コードは大文字に揃えて保存し、小文字で書いても重複として扱う", async () => {
    const id = await create(`${PREFIX}case-1`.toLowerCase());
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id } })).code,
    ).toBe(`${PREFIX}CASE-1`);
    const result = await createProduct(prisma, STAFF, form(`${PREFIX}Case-1`));
    expect(!result.ok && result.error).toBe(
      `商品コード「${PREFIX}CASE-1」はすでに登録されています`,
    );
  });

  it("入力エラーは項目ごとの日本語のエラーで、登録しない", async () => {
    const result = await createProduct(
      prisma,
      STAFF,
      form(`${PREFIX}BAD`, { salesPrice: "-1", name: "" }),
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.fieldErrors).toEqual({
      name: ["商品名を入力してください"],
      salesPrice: ["売価は0以上の整数で入力してください"],
    });
    expect(
      await prisma.product.count({ where: { code: `${PREFIX}BAD` } }),
    ).toBe(0);
  });

  it("編集すると変更点が操作履歴（update）に残る。変更がなければ記録しない", async () => {
    const id = await create(`${PREFIX}EDIT`);
    const result = await updateProduct(
      prisma,
      STAFF,
      id,
      form(`${PREFIX}EDIT`, { salesPrice: "200", unit: "箱" }),
    );
    expect(result).toEqual({ ok: true, data: null });
    expect(
      await prisma.product.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({ salesPrice: 200, unit: "箱" });
    const same = await updateProduct(
      prisma,
      STAFF,
      id,
      form(`${PREFIX}EDIT`, { salesPrice: "200", unit: "箱" }),
    );
    expect(same.ok).toBe(true);
    const logs = await auditLogsOf(id);
    expect(logs.map((l) => l.action)).toEqual(["create", "update"]);
    expect(logs[1].summary).toBe(
      `商品 ${PREFIX}EDIT を更新しました（単位: 個 → 箱、売価: 150 → 200）`,
    );
  });

  it("編集で他の商品と同じ商品コードにするとエラー", async () => {
    await create(`${PREFIX}EDIT-A`);
    const id = await create(`${PREFIX}EDIT-B`);
    const result = await updateProduct(
      prisma,
      STAFF,
      id,
      form(`${PREFIX}EDIT-A`),
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.fieldErrors?.code).toEqual([
      `商品コード「${PREFIX}EDIT-A」はすでに登録されています`,
    ]);
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id } })).code,
    ).toBe(`${PREFIX}EDIT-B`);
  });

  it("存在しない商品の編集はエラー", async () => {
    expect(
      await updateProduct(prisma, STAFF, 999_999_999, form(`${PREFIX}NONE`)),
    ).toEqual({ ok: false, error: "商品が見つかりません" });
  });
});

describe("無効化・再有効化", () => {
  it("admin は無効化・再有効化でき、操作履歴（deactivate／reactivate）が残る", async () => {
    const id = await create(`${PREFIX}ACTIVE`);
    expect(await setProductActive(prisma, ADMIN, id, false)).toEqual({
      ok: true,
      data: null,
    });
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id } })).isActive,
    ).toBe(false);
    expect((await setProductActive(prisma, ADMIN, id, true)).ok).toBe(true);
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id } })).isActive,
    ).toBe(true);
    const logs = await auditLogsOf(id);
    expect(logs.map((l) => [l.action, l.userId])).toEqual([
      ["create", STAFF.id],
      ["deactivate", ADMIN.id],
      ["reactivate", ADMIN.id],
    ]);
  });
});

describe("権限（サーバー側で検査する）", () => {
  const FORBIDDEN = { ok: false, error: "この操作を行う権限がありません" };

  it("viewer は登録・編集・無効化・CSV 取込のすべてを拒否され、DB は変わらない", async () => {
    const id = await create(`${PREFIX}PERM`);
    const before = await prisma.auditLog.count();

    expect(
      await createProduct(prisma, VIEWER, form(`${PREFIX}PERM-V`)),
    ).toEqual(FORBIDDEN);
    expect(
      await updateProduct(
        prisma,
        VIEWER,
        id,
        form(`${PREFIX}PERM`, { salesPrice: "1" }),
      ),
    ).toEqual(FORBIDDEN);
    expect(await setProductActive(prisma, VIEWER, id, false)).toEqual(
      FORBIDDEN,
    );
    expect(
      await importProductCsv(
        prisma,
        VIEWER,
        csvBytes([CSV_HEADER, csvRow(`${PREFIX}PERM-CSV`)]),
        "viewer.csv",
      ),
    ).toEqual({ ...FORBIDDEN, errors: [], totalErrors: 0 });

    expect(
      await prisma.product.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({ salesPrice: 150, isActive: true });
    expect(
      await prisma.product.count({
        where: { code: { in: [`${PREFIX}PERM-V`, `${PREFIX}PERM-CSV`] } },
      }),
    ).toBe(0);
    expect(await prisma.auditLog.count()).toBe(before);
  });

  it("staff は無効化・再有効化を拒否される（admin のみ）", async () => {
    const id = await create(`${PREFIX}PERM-S`);
    expect(await setProductActive(prisma, STAFF, id, false)).toEqual(FORBIDDEN);
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id } })).isActive,
    ).toBe(true);
  });

  it("未ログイン（null）はすべて拒否される", async () => {
    const LOGIN = { ok: false, error: "ログインが必要です" };
    expect(await createProduct(prisma, null, form(`${PREFIX}ANON`))).toEqual(
      LOGIN,
    );
    expect(await setProductActive(prisma, null, 1, false)).toEqual(LOGIN);
  });
});

describe("CSV 取込", () => {
  it("全件成功: 既存の商品コードは更新・未登録は新規（小文字のコードも照合）。操作履歴は商品ごと＋件数の要約 1 件", async () => {
    const existingId = await create(`${PREFIX}CSV-1`);
    const unchangedId = await create(`${PREFIX}CSV-2`);
    const beforeLogs = await prisma.auditLog.count();

    const result = await importProductCsv(
      prisma,
      STAFF,
      csvBytes([
        CSV_HEADER,
        // 小文字で書いても既存の ZT-CSV-1 の更新になる
        csvRow(`${PREFIX}csv-1`.toLowerCase(), {
          salesPrice: "999",
          name: "名前を変更",
        }),
        csvRow(`${PREFIX}CSV-2`), // 変更なし
        csvRow(`${PREFIX}CSV-3`),
        csvRow(`${PREFIX}CSV-4`, { reorderPoint: "0" }),
      ]),
      "products.csv",
    );
    expect(result).toEqual({
      ok: true,
      data: { created: 2, updated: 1, unchanged: 1 },
    });
    expect(
      await prisma.product.findUniqueOrThrow({ where: { id: existingId } }),
    ).toMatchObject({
      code: `${PREFIX}CSV-1`,
      salesPrice: 999,
      name: "名前を変更",
    });
    const created4 = await prisma.product.findUniqueOrThrow({
      where: { code: `${PREFIX}CSV-4` },
    });
    expect(created4).toMatchObject({ reorderPoint: 0, isActive: true });

    // 新規 2・更新 1 の商品ごとの履歴と、要約 1 件（変更なしの商品には残さない）
    expect(await prisma.auditLog.count()).toBe(beforeLogs + 4);
    expect((await auditLogsOf(existingId)).at(-1)).toMatchObject({
      userId: STAFF.id,
      action: "update",
      summary: `商品 ${PREFIX}CSV-1 を更新しました（CSV 取込: 商品名: 結合テスト商品 ${PREFIX}CSV-1 → 名前を変更、売価: 150 → 999）`,
    });
    expect((await auditLogsOf(created4.id)).map((l) => l.summary)).toEqual([
      `商品 ${PREFIX}CSV-4「結合テスト商品 ${PREFIX}CSV-4」を登録しました（CSV 取込）`,
    ]);
    expect((await auditLogsOf(unchangedId)).map((l) => l.action)).toEqual([
      "create",
    ]);
    const log = await prisma.auditLog.findFirstOrThrow({
      where: { action: "import" },
      orderBy: { id: "desc" },
    });
    expect(log).toMatchObject({
      userId: STAFF.id,
      targetType: "product",
      targetId: null,
      summary:
        "商品を CSV で取り込みました（products.csv: 新規 2 件・更新 1 件・変更なし 1 件）",
    });
  });

  it("無効な商品を「状態=有効」の CSV で更新しても無効のまま。現在庫（入出庫）も変わらない", async () => {
    const id = await create(`${PREFIX}CSV-INACTIVE`);
    expect((await setProductActive(prisma, ADMIN, id, false)).ok).toBe(true);
    const movementsBefore = await prisma.stockMovement.count();

    // 出力 CSV と同じ 9 列（現在庫・状態の列は読み飛ばされる）
    const result = await importProductCsv(
      prisma,
      STAFF,
      csvBytes([
        [...CSV_HEADER, "現在庫", "状態"],
        [
          ...csvRow(`${PREFIX}CSV-INACTIVE`, { salesPrice: "321" }),
          "999",
          "有効",
        ],
      ]),
      "status.csv",
    );
    expect(result).toEqual({
      ok: true,
      data: { created: 0, updated: 1, unchanged: 0 },
    });
    expect(
      await prisma.product.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({ salesPrice: 321, isActive: false });
    expect(await prisma.stockMovement.count()).toBe(movementsBefore);
  });

  it("まとめて更新する単位（500 行）をまたぐ件数でも、すべての行を更新する", async () => {
    const count = IMPORT_UPDATE_CHUNK_SIZE + 1;
    const codes = Array.from(
      { length: count },
      (_, i) => `${PREFIX}BULK-${String(i).padStart(4, "0")}`,
    );
    await prisma.product.createMany({
      data: codes.map((code) => ({
        code,
        name: "一括",
        category: "結合テスト",
        unit: "個",
        salesPrice: 1,
        purchasePrice: 1,
        reorderPoint: 1,
      })),
    });
    const result = await importProductCsv(
      prisma,
      ADMIN,
      csvBytes([
        CSV_HEADER,
        ...codes.map((code, i) =>
          csvRow(code, {
            name: "一括",
            salesPrice: String(i + 10),
            purchasePrice: "1",
            reorderPoint: "1",
          }),
        ),
      ]),
      "bulk.csv",
    );
    expect(result).toEqual({
      ok: true,
      data: { created: 0, updated: count, unchanged: 0 },
    });
    const updated = await prisma.product.findMany({
      where: { code: { in: codes } },
      orderBy: { code: "asc" },
    });
    expect(updated.map((p) => p.salesPrice)).toEqual(
      codes.map((_, i) => i + 10),
    );
    expect(updated.every((p) => p.unit === "個" && p.isActive)).toBe(true);
  });

  it("列ずれ（囲んでいない 1,200）・閉じ忘れの引用符は取り込まない", async () => {
    const before = await prisma.product.count();
    const text = (body: string) =>
      new TextEncoder().encode(`${CSV_HEADER.join(",")}\r\n${body}`);
    const shifted = await importProductCsv(
      prisma,
      ADMIN,
      text(`${PREFIX}SHIFT,ペン,文具,個,1,200,800,5\r\n`),
      "shift.csv",
    );
    expect(!shifted.ok && shifted.errors[0].message).toContain(
      "列の数が見出し行と違います（見出し 7 列・この行 8 列）",
    );
    const unclosed = await importProductCsv(
      prisma,
      ADMIN,
      text(
        `${PREFIX}Q2,"ペン,文具,個,100,50,5\r\n${PREFIX}Q3,ノート,文具,冊,200,100,5\r\n${PREFIX}Q4,"消しゴム",文具,個,80,40,5\r\n`,
      ),
      "quote.csv",
    );
    expect(unclosed.ok).toBe(false);
    expect(await prisma.product.count()).toBe(before);
  });

  it(`CSV 出力は上限を超えると overLimit（黙って切り捨てない）`, async () => {
    const total = await prisma.product.count({ where: { isActive: true } });
    expect(await listProductsForCsv(prisma, params(), total)).toMatchObject({
      overLimit: false,
    });
    const over = await listProductsForCsv(prisma, params(), 3);
    expect(over.overLimit).toBe(true);
    expect(over.items).toHaveLength(3);
  });

  it("1 行でもエラーがあれば全体を取り込まない（行番号付きのエラー）", async () => {
    const id = await create(`${PREFIX}CSV-ERR-1`);
    const before = await prisma.auditLog.count();
    const result = await importProductCsv(
      prisma,
      ADMIN,
      csvBytes([
        CSV_HEADER,
        csvRow(`${PREFIX}CSV-ERR-1`, { salesPrice: "500" }),
        csvRow(`${PREFIX}CSV-ERR-2`),
        csvRow(`${PREFIX}CSV-ERR-3`, { purchasePrice: "abc" }),
      ]),
      "error.csv",
    );
    expect(result).toMatchObject({
      ok: false,
      totalErrors: 1,
      errors: [
        {
          line: 4,
          field: "仕入単価",
          message: "仕入単価は0以上の整数で入力してください",
        },
      ],
    });
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id } })).salesPrice,
    ).toBe(150);
    expect(
      await prisma.product.count({
        where: { code: { in: [`${PREFIX}CSV-ERR-2`, `${PREFIX}CSV-ERR-3`] } },
      }),
    ).toBe(0);
    expect(await prisma.auditLog.count()).toBe(before);
  });

  it(`データ行が上限（${PRODUCT_IMPORT_MAX_ROWS} 行）を超えると取り込まない`, async () => {
    const rows = Array.from({ length: PRODUCT_IMPORT_MAX_ROWS + 1 }, (_, i) =>
      csvRow(`${PREFIX}MAX-${i + 1}`),
    );
    const result = await importProductCsv(
      prisma,
      ADMIN,
      csvBytes([CSV_HEADER, ...rows]),
      "too-many.csv",
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors[0].message).toContain("上限");
    expect(
      await prisma.product.count({
        where: { code: { startsWith: `${PREFIX}MAX-` } },
      }),
    ).toBe(0);
  });

  it("書き込みの途中で DB のエラーが起きたら、それまでの更新も含めて全体を取り消す（1 トランザクション）", async () => {
    const id = await create(`${PREFIX}TX-1`);
    const before = await prisma.auditLog.count();
    // 検証済みの行として、同じ新規コードを 2 行渡す（一意制約違反を DB で起こす）
    const row = (code: string, salesPrice: number) => ({
      line: 0,
      data: {
        code,
        name: "トランザクション確認",
        category: "結合テスト",
        unit: "個",
        salesPrice,
        purchasePrice: 1,
        reorderPoint: 1,
      },
    });
    const result = await importProducts(
      prisma,
      ADMIN,
      [
        row(`${PREFIX}TX-1`, 777),
        row(`${PREFIX}TX-2`, 1),
        row(`${PREFIX}TX-2`, 2),
      ],
      "tx.csv",
    );
    expect(result.ok).toBe(false);
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id } })).salesPrice,
    ).toBe(150);
    expect(
      await prisma.product.count({ where: { code: `${PREFIX}TX-2` } }),
    ).toBe(0);
    expect(await prisma.auditLog.count()).toBe(before);
  });
});
