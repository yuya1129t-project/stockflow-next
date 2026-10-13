/**
 * 取引先マスタの結合テスト（実 DB = DATABASE_URL_TEST）。docs/spec.md §2・§3・§5
 * 前提: pnpm db:test:reset でテスト用 DB にマイグレーションとシードを適用済み
 *
 * シードの取引先は書き換えない。登録・編集はこのファイル専用の取引先コード（ZP- で始まる）で行い、
 * 作った取引先とその操作履歴は終了時に削除する（他のテストファイルのシード件数の確認に影響させない）。
 * 外部 API（zipcloud）はここでは使わない（住所検索は単体テストでモックして確認している）
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";
import type { SessionUser } from "@/lib/auth/session";
import {
  getPartner,
  listPartners,
  suggestPartnerCodes,
} from "@/lib/partners/queries";
import type { PartnerFormValues } from "@/lib/partners/schema";
import {
  DEFAULT_PARTNER_LIST_PARAMS,
  PARTNERS_PER_PAGE,
  type PartnerListParams,
} from "@/lib/partners/search-params";
import {
  createPartner,
  PARTNER_TARGET_TYPE,
  setPartnerActive,
  updatePartner,
} from "@/lib/partners/service";

import { DEMO_USERS } from "../../prisma/seed-data";
import { connectTestDb, SETUP_HINT } from "./test-db";

let prisma: PrismaClient;

const [ADMIN, STAFF, VIEWER] = DEMO_USERS.map(
  ({ id, name, email, role }): SessionUser => ({ id, name, email, role }),
);

/** このファイルで作る取引先のコードの接頭辞 */
const PREFIX = "ZP-";

function form(code: string, overrides: Partial<PartnerFormValues> = {}) {
  return {
    code,
    name: `結合テスト取引先 ${code}`,
    kind: "customer",
    postalCode: "000-0001",
    address: "デモ県サンプル市中央1丁目1-1",
    phone: "000-0000-0001",
    email: "zp@example.com",
    ...overrides,
  } satisfies PartnerFormValues;
}

async function testPartnerIds(): Promise<string[]> {
  const partners = await prisma.partner.findMany({
    where: { code: { startsWith: PREFIX } },
    select: { id: true },
  });
  return partners.map((p) => String(p.id));
}

async function cleanUp() {
  await prisma.auditLog.deleteMany({
    where: {
      targetType: PARTNER_TARGET_TYPE,
      targetId: { in: await testPartnerIds() },
    },
  });
  await prisma.partner.deleteMany({ where: { code: { startsWith: PREFIX } } });
}

beforeAll(async () => {
  prisma = await connectTestDb();
  if ((await prisma.partner.count()) === 0) {
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

function params(overrides: Partial<PartnerListParams> = {}): PartnerListParams {
  return { ...DEFAULT_PARTNER_LIST_PARAMS, ...overrides };
}

/** 取引先を作って ID を返す（失敗したらテストを失敗させる） */
async function create(
  code: string,
  overrides: Partial<PartnerFormValues> = {},
) {
  const result = await createPartner(prisma, STAFF, form(code, overrides));
  if (!result.ok) throw new Error(result.error);
  return result.data.id;
}

function auditLogsOf(id: number) {
  return prisma.auditLog.findMany({
    where: { targetType: PARTNER_TARGET_TYPE, targetId: String(id) },
    orderBy: { id: "asc" },
  });
}

describe("一覧（検索・絞り込み・並べ替え・ページ送り）", () => {
  it("既定は有効な取引先をコード順に 20 件ずつ", async () => {
    const activeCount = await prisma.partner.count({
      where: { isActive: true },
    });
    const result = await listPartners(prisma, params());
    expect(result.total).toBe(activeCount);
    expect(result.perPage).toBe(PARTNERS_PER_PAGE);
    expect(result.items).toHaveLength(Math.min(PARTNERS_PER_PAGE, activeCount));
    const codes = result.items.map((p) => p.code);
    expect(codes).toEqual([...codes].sort());
    expect(result.items.every((p) => p.isActive)).toBe(true);
  });

  it("キーワードは取引先コード・取引先名の部分一致（大文字小文字を区別しない）", async () => {
    const byCode = await listPartners(prisma, params({ q: "s-000" }));
    expect(byCode.total).toBe(8); // シードの仕入先 S-0001〜S-0008
    expect(byCode.items.every((p) => p.code.startsWith("S-000"))).toBe(true);

    const seed = await prisma.partner.findFirstOrThrow({
      where: { isActive: true },
      orderBy: { id: "asc" },
    });
    const byName = await listPartners(prisma, params({ q: seed.name }));
    expect(byName.items.map((p) => p.id)).toContain(seed.id);
  });

  it("キーワードの % _ は文字として扱う（LIKE のワイルドカードにしない）", async () => {
    expect((await listPartners(prisma, params({ q: "%" }))).total).toBe(0);
    expect((await listPartners(prisma, params({ q: "_" }))).total).toBe(0);
    const id = await create(`${PREFIX}LIKE`, { name: "結合テスト 100%_商事" });
    expect(
      (await listPartners(prisma, params({ q: "100%_" }))).items.map(
        (p) => p.id,
      ),
    ).toEqual([id]);
  });

  it("種別で絞り込める（完全一致）", async () => {
    const both = await create(`${PREFIX}KIND-BOTH`, { kind: "both" });
    for (const kind of ["customer", "supplier", "both"] as const) {
      const result = await listPartners(
        prisma,
        params({ kind, status: "all" }),
      );
      expect(result.total).toBe(
        await prisma.partner.count({ where: { kind } }),
      );
      expect(result.items.every((p) => p.kind === kind)).toBe(true);
    }
    const customers = await listPartners(prisma, params({ kind: "customer" }));
    expect(customers.items.map((p) => p.id)).not.toContain(both);
  });

  it("取引先名・種別で並べ替えられる（昇順・降順）", async () => {
    // 1 ページ（20 件）に収まるよう仕入先（シード 8 件）に絞る
    const supplier = { kind: "supplier" as const };
    const byNameAsc = await listPartners(
      prisma,
      params({ ...supplier, sort: "name" }),
    );
    const byNameDesc = await listPartners(
      prisma,
      params({ ...supplier, sort: "name", order: "desc" }),
    );
    expect(byNameAsc.totalPages).toBe(1);
    // 文字列の順序は DB の照合順序に従うので、昇順と降順が逆順になっていることを確かめる
    expect(byNameDesc.items.map((p) => p.id)).toEqual(
      byNameAsc.items.map((p) => p.id).reverse(),
    );

    const byKind = await listPartners(
      prisma,
      params({ sort: "kind", order: "desc" }),
    );
    // enum の定義順（customer → supplier → both）の逆
    const order = ["both", "supplier", "customer"];
    const kinds = byKind.items.map((p) => order.indexOf(p.kind));
    expect(kinds).toEqual([...kinds].sort((a, b) => a - b));
  });

  it("ページ送り: 2 ページ目は続き。範囲外のページは最終ページに丸める", async () => {
    // シードは 20 件なので、21 件以上になるよう作る
    await create(`${PREFIX}PAGE-1`);
    await create(`${PREFIX}PAGE-2`);
    const page1 = await listPartners(prisma, params());
    const page2 = await listPartners(prisma, params({ page: 2 }));
    expect(page1.totalPages).toBeGreaterThanOrEqual(2);
    expect(page2.page).toBe(2);
    expect(page2.items[0].code > page1.items.at(-1)!.code).toBe(true);
    expect(page1.items.length + page2.items.length).toBe(
      Math.min(page1.total, PARTNERS_PER_PAGE * 2),
    );

    const beyond = await listPartners(prisma, params({ page: 999 }));
    expect(beyond.page).toBe(beyond.totalPages);
    expect(beyond.items.length).toBeGreaterThan(0);
  });

  it("無効な取引先は「有効のみ」に出ず、「無効のみ」「無効も表示」に出る", async () => {
    const id = await create(`${PREFIX}LIST-INACTIVE`);
    expect((await setPartnerActive(prisma, ADMIN, id, false)).ok).toBe(true);
    const q = `${PREFIX}LIST-INACTIVE`;
    expect((await listPartners(prisma, params({ q }))).total).toBe(0);
    expect(
      (await listPartners(prisma, params({ q, status: "inactive" }))).items,
    ).toMatchObject([{ id, isActive: false }]);
    expect(
      (await listPartners(prisma, params({ q, status: "all" }))).total,
    ).toBe(1);
  });

  it("次のコードの提案はシードの続き（C-0013・S-0009）", async () => {
    expect(await suggestPartnerCodes(prisma)).toEqual({
      customer: "C-0013",
      supplier: "S-0009",
      both: "B-0001",
    });
  });
});

describe("登録・編集", () => {
  it("staff は登録でき、郵便番号はハイフンなしで保存し、操作履歴（create）が残る", async () => {
    const result = await createPartner(
      prisma,
      STAFF,
      form(`${PREFIX}NEW-1`, { postalCode: "123-4567", kind: "supplier" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const partner = await getPartner(prisma, result.data.id);
    expect(partner).toMatchObject({
      code: `${PREFIX}NEW-1`,
      kind: "supplier",
      postalCode: "1234567",
      isActive: true,
    });
    expect(await auditLogsOf(result.data.id)).toMatchObject([
      {
        userId: STAFF.id,
        action: "create",
        targetType: "partner",
        summary: `取引先 ${PREFIX}NEW-1「結合テスト取引先 ${PREFIX}NEW-1」を登録しました`,
      },
    ]);
  });

  it("任意の項目は空なら null で保存する", async () => {
    const id = await create(`${PREFIX}NULLS`, {
      postalCode: "",
      address: "",
      phone: "",
      email: "",
    });
    expect(await getPartner(prisma, id)).toMatchObject({
      postalCode: null,
      address: null,
      phone: null,
      email: null,
    });
  });

  it("取引先コードが重複するとエラーで、何も記録しない。小文字で書いても重複として扱う", async () => {
    await create(`${PREFIX}DUP`);
    const before = await prisma.auditLog.count();
    const message = `取引先コード「${PREFIX}DUP」はすでに登録されています`;
    expect(await createPartner(prisma, ADMIN, form(`${PREFIX}DUP`))).toEqual({
      ok: false,
      error: message,
      fieldErrors: { code: [message] },
    });
    const lower = await createPartner(
      prisma,
      ADMIN,
      form(`${PREFIX}dup`.toLowerCase()),
    );
    expect(!lower.ok && lower.error).toBe(message);
    expect(await prisma.auditLog.count()).toBe(before);
    expect(
      await prisma.partner.count({ where: { code: `${PREFIX}DUP` } }),
    ).toBe(1);
  });

  it("入力エラーは項目ごとの日本語のエラーで、登録しない", async () => {
    const result = await createPartner(
      prisma,
      STAFF,
      form(`${PREFIX}BAD`, {
        postalCode: "12-345",
        phone: "abc",
        email: "x@",
        name: "改行\nあり",
      }),
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && Object.keys(result.fieldErrors ?? {}).sort()).toEqual([
      "email",
      "name",
      "phone",
      "postalCode",
    ]);
    expect(
      await prisma.partner.count({ where: { code: `${PREFIX}BAD` } }),
    ).toBe(0);
  });

  it("編集すると変更点が操作履歴（update）に残る。変更がなければ記録しない", async () => {
    const id = await create(`${PREFIX}EDIT`);
    const changed = form(`${PREFIX}EDIT`, {
      kind: "both",
      postalCode: "1234567",
      phone: "",
    });
    expect(await updatePartner(prisma, STAFF, id, changed)).toEqual({
      ok: true,
      data: null,
    });
    expect(await getPartner(prisma, id)).toMatchObject({
      kind: "both",
      postalCode: "1234567",
      phone: null,
    });
    // 同じ内容（郵便番号の書き方だけ違う）は変更なし
    expect(
      (
        await updatePartner(prisma, STAFF, id, {
          ...changed,
          postalCode: "123-4567",
        })
      ).ok,
    ).toBe(true);
    const logs = await auditLogsOf(id);
    expect(logs.map((l) => l.action)).toEqual(["create", "update"]);
    expect(logs[1].summary).toBe(
      `取引先 ${PREFIX}EDIT を更新しました（種別: 顧客 → 顧客・仕入先、郵便番号: 000-0001 → 123-4567、電話番号: 000-0000-0001 → （なし））`,
    );
  });

  it("編集で他の取引先と同じコードにするとエラー", async () => {
    await create(`${PREFIX}EDIT-A`);
    const id = await create(`${PREFIX}EDIT-B`);
    const result = await updatePartner(
      prisma,
      STAFF,
      id,
      form(`${PREFIX}EDIT-A`),
    );
    expect(!result.ok && result.fieldErrors?.code).toEqual([
      `取引先コード「${PREFIX}EDIT-A」はすでに登録されています`,
    ]);
    expect((await getPartner(prisma, id))?.code).toBe(`${PREFIX}EDIT-B`);
  });

  it("存在しない取引先の編集はエラー", async () => {
    expect(
      await updatePartner(prisma, STAFF, 999_999_999, form(`${PREFIX}NONE`)),
    ).toEqual({ ok: false, error: "取引先が見つかりません" });
  });

  it("シードの取引先（000 始まりの郵便番号・電話番号）は、そのままの値で検証を通る", async () => {
    const seed = await prisma.partner.findFirstOrThrow({
      orderBy: { id: "asc" },
    });
    // 値を変えずに保存しても変更なし（シードは書き換えない）
    const before = await prisma.auditLog.count();
    const result = await updatePartner(prisma, STAFF, seed.id, {
      code: seed.code,
      name: seed.name,
      kind: seed.kind,
      postalCode: seed.postalCode ?? "",
      address: seed.address ?? "",
      phone: seed.phone ?? "",
      email: seed.email ?? "",
    });
    expect(result).toEqual({ ok: true, data: null });
    expect(await prisma.auditLog.count()).toBe(before);
  });
});

describe("無効化・再有効化", () => {
  it("admin は無効化・再有効化でき、操作履歴（deactivate／reactivate）が残る", async () => {
    const id = await create(`${PREFIX}ACTIVE`);
    expect(await setPartnerActive(prisma, ADMIN, id, false)).toEqual({
      ok: true,
      data: null,
    });
    expect((await getPartner(prisma, id))?.isActive).toBe(false);
    expect((await setPartnerActive(prisma, ADMIN, id, true)).ok).toBe(true);
    expect((await getPartner(prisma, id))?.isActive).toBe(true);
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

  it("viewer は登録・編集・無効化のすべてを拒否され、DB は変わらない", async () => {
    const id = await create(`${PREFIX}PERM`);
    const before = await prisma.auditLog.count();

    expect(
      await createPartner(prisma, VIEWER, form(`${PREFIX}PERM-V`)),
    ).toEqual(FORBIDDEN);
    expect(
      await updatePartner(
        prisma,
        VIEWER,
        id,
        form(`${PREFIX}PERM`, { name: "書き換え" }),
      ),
    ).toEqual(FORBIDDEN);
    expect(await setPartnerActive(prisma, VIEWER, id, false)).toEqual(
      FORBIDDEN,
    );

    expect(await getPartner(prisma, id)).toMatchObject({
      name: `結合テスト取引先 ${PREFIX}PERM`,
      isActive: true,
    });
    expect(
      await prisma.partner.count({ where: { code: `${PREFIX}PERM-V` } }),
    ).toBe(0);
    expect(await prisma.auditLog.count()).toBe(before);
  });

  it("staff は無効化・再有効化を拒否される（admin のみ）", async () => {
    const id = await create(`${PREFIX}PERM-S`);
    expect(await setPartnerActive(prisma, STAFF, id, false)).toEqual(FORBIDDEN);
    expect((await getPartner(prisma, id))?.isActive).toBe(true);
  });

  it("未ログイン（user なし）はすべて拒否される", async () => {
    const UNAUTHORIZED = { ok: false, error: "ログインが必要です" };
    const id = await create(`${PREFIX}PERM-N`);
    expect(await createPartner(prisma, null, form(`${PREFIX}PERM-N2`))).toEqual(
      UNAUTHORIZED,
    );
    expect(
      await updatePartner(prisma, null, id, form(`${PREFIX}PERM-N`)),
    ).toEqual(UNAUTHORIZED);
    expect(await setPartnerActive(prisma, null, id, false)).toEqual(
      UNAUTHORIZED,
    );
  });
});
