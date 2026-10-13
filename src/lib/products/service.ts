/**
 * 商品の更新系（登録・編集・無効化／再有効化・CSV 取込）。サーバー側でだけ使う。
 *
 * - 権限は Server Action（checkActionPermission）で検査したうえで、ここでも操作したユーザーのロールを
 *   検査する（二重の確認。結合テストはこの関数を直接呼んで権限を確かめる）
 * - 入力は必ずここで Zod スキーマ（画面と共通）で検証する
 * - 更新と操作履歴（AuditLog）は同じトランザクションで書く（spec §3）
 */
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import {
  authErrorMessage,
  authorize,
  type SessionUser,
} from "@/lib/auth/session";
import type { Action } from "@/lib/auth/permissions";

import {
  parseProductImport,
  type ProductImportError,
  type ProductImportRow,
} from "./csv";
import {
  PRODUCT_FIELD_LABELS,
  PRODUCT_FIELDS,
  productFieldErrors,
  productInputSchema,
  type ProductFieldErrors,
  type ProductInput,
} from "./schema";

export type MutationError = {
  ok: false;
  error: string;
  fieldErrors?: ProductFieldErrors;
};
export type MutationResult<T = null> = { ok: true; data: T } | MutationError;

/** 操作履歴の targetType */
export const PRODUCT_TARGET_TYPE = "product";

function checkRole(
  user: SessionUser | null,
  action: Action,
): { ok: true; user: SessionUser } | { ok: false; error: string } {
  const result = authorize(user, action);
  return result.ok
    ? result
    : { ok: false, error: authErrorMessage(result.status) };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

function duplicateCodeError(code: string): MutationError {
  const message = `商品コード「${code}」はすでに登録されています`;
  return { ok: false, error: message, fieldErrors: { code: [message] } };
}

const NOT_FOUND: MutationError = { ok: false, error: "商品が見つかりません" };
const DONE: MutationResult = { ok: true, data: null };

const INVALID_INPUT_MESSAGE =
  "入力内容に誤りがあります。各項目を確認してください";

/** 商品を登録する */
export async function createProduct(
  db: PrismaClient,
  user: SessionUser | null,
  input: unknown,
): Promise<MutationResult<{ id: number }>> {
  const auth = checkRole(user, "master:edit");
  if (!auth.ok) return auth;
  const parsed = productInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: INVALID_INPUT_MESSAGE,
      fieldErrors: productFieldErrors(parsed.error),
    };
  }
  const data = parsed.data;
  try {
    const product = await db.$transaction(async (tx) => {
      const created = await tx.product.create({ data });
      await tx.auditLog.create({
        data: {
          userId: auth.user.id,
          action: "create",
          targetType: PRODUCT_TARGET_TYPE,
          targetId: String(created.id),
          summary: `商品 ${data.code}「${data.name}」を登録しました`,
        },
      });
      return created;
    });
    return { ok: true, data: { id: product.id } };
  } catch (error) {
    if (isUniqueViolation(error)) return duplicateCodeError(data.code);
    throw error;
  }
}

/** 変更点の説明（操作履歴の summary 用）。変更がなければ空配列 */
export function describeProductChanges(
  before: ProductInput,
  after: ProductInput,
): string[] {
  return PRODUCT_FIELDS.filter((field) => before[field] !== after[field]).map(
    (field) =>
      `${PRODUCT_FIELD_LABELS[field]}: ${before[field]} → ${after[field]}`,
  );
}

function pickInput(product: ProductInput): ProductInput {
  return Object.fromEntries(
    PRODUCT_FIELDS.map((field) => [field, product[field]]),
  ) as ProductInput;
}

/** 商品を編集する（商品コードも変更できる。一意でなければエラー） */
export async function updateProduct(
  db: PrismaClient,
  user: SessionUser | null,
  id: number,
  input: unknown,
): Promise<MutationResult> {
  const auth = checkRole(user, "master:edit");
  if (!auth.ok) return auth;
  const parsed = productInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: INVALID_INPUT_MESSAGE,
      fieldErrors: productFieldErrors(parsed.error),
    };
  }
  const data = parsed.data;
  try {
    return await db.$transaction(async (tx): Promise<MutationResult> => {
      const before = await tx.product.findUnique({ where: { id } });
      if (!before) return NOT_FOUND;
      const changes = describeProductChanges(pickInput(before), data);
      // 変更がなければ何もしない（操作履歴も残さない）
      if (changes.length === 0) return DONE;
      await tx.product.update({ where: { id }, data });
      await tx.auditLog.create({
        data: {
          userId: auth.user.id,
          action: "update",
          targetType: PRODUCT_TARGET_TYPE,
          targetId: String(id),
          summary: `商品 ${data.code} を更新しました（${changes.join("、")}）`,
        },
      });
      return DONE;
    });
  } catch (error) {
    if (isUniqueViolation(error)) return duplicateCodeError(data.code);
    throw error;
  }
}

/** 商品を無効化（isActive = false）または再有効化する。admin のみ（spec §2） */
export async function setProductActive(
  db: PrismaClient,
  user: SessionUser | null,
  id: number,
  isActive: boolean,
): Promise<MutationResult> {
  const auth = checkRole(user, "master:deactivate");
  if (!auth.ok) return auth;
  return db.$transaction(async (tx): Promise<MutationResult> => {
    const product = await tx.product.findUnique({ where: { id } });
    if (!product) return NOT_FOUND;
    if (product.isActive === isActive) return DONE;
    await tx.product.update({ where: { id }, data: { isActive } });
    await tx.auditLog.create({
      data: {
        userId: auth.user.id,
        action: isActive ? "reactivate" : "deactivate",
        targetType: PRODUCT_TARGET_TYPE,
        targetId: String(id),
        summary: `商品 ${product.code}「${product.name}」を${isActive ? "再度有効に" : "無効に"}しました`,
      },
    });
    return DONE;
  });
}

export interface ProductImportSummary {
  created: number;
  updated: number;
  unchanged: number;
}

/** 取込の更新を 1 文にまとめる行数（1 行あたり 7 個のパラメータ。PostgreSQL の上限 65,535 個に十分収まる） */
export const IMPORT_UPDATE_CHUNK_SIZE = 500;

/** UPDATE … FROM (VALUES …) で複数の商品をまとめて更新する SQL（値はすべてパラメータで渡す） */
function bulkUpdateSql(
  rows: readonly { id: number; data: ProductInput }[],
): Prisma.Sql {
  const values = rows.map(
    ({ id, data }) =>
      Prisma.sql`(${id}::int, ${data.name}::text, ${data.category}::text, ${data.unit}::text, ${data.salesPrice}::int, ${data.purchasePrice}::int, ${data.reorderPoint}::int)`,
  );
  return Prisma.sql`
    UPDATE "product" AS p SET
      "name" = v."name",
      "category" = v."category",
      "unit" = v."unit",
      "salesPrice" = v."salesPrice",
      "purchasePrice" = v."purchasePrice",
      "reorderPoint" = v."reorderPoint",
      -- Prisma の @updatedAt と同じく UTC で保存する（列は timestamp without time zone）
      "updatedAt" = NOW() AT TIME ZONE 'UTC'
    FROM (VALUES ${Prisma.join(values)})
      AS v("id", "name", "category", "unit", "salesPrice", "purchasePrice", "reorderPoint")
    WHERE p."id" = v."id"`;
}

/**
 * CSV 取込の書き込み（検証済みの行。parseProductImport の結果）。
 * code が既存なら更新、なければ新規（有効／無効は変えない）。1 トランザクションで行い、
 * 操作履歴は商品ごとの登録・更新と、件数の要約 1 件を残す
 */
export async function importProducts(
  db: PrismaClient,
  user: SessionUser | null,
  rows: readonly ProductImportRow[],
  fileName: string,
): Promise<MutationResult<ProductImportSummary>> {
  const auth = checkRole(user, "csv:import");
  if (!auth.ok) return auth;
  if (rows.length === 0) {
    return { ok: false, error: "取り込むデータ行がありません" };
  }

  try {
    const summary = await db.$transaction(
      async (tx) => {
        const codes = rows.map((r) => r.data.code);
        // 更新し得る既存の商品の行を、先に id の順でまとめてロックする。在庫の記録（src/lib/stock/movements.ts）と
        // ロックの順番をそろえ、CSV の並びの順に UPDATE することでのデッドロックを避ける
        await tx.$queryRaw`
          SELECT "id" FROM "product"
          WHERE "code" IN (${Prisma.join(codes)})
          ORDER BY "id"
          FOR NO KEY UPDATE`;
        const existing = await tx.product.findMany({
          where: { code: { in: codes } },
        });
        const byCode = new Map(existing.map((p) => [p.code, p]));

        const toCreate: ProductInput[] = [];
        const toUpdate: {
          id: number;
          data: ProductInput;
          changes: string[];
        }[] = [];
        let unchanged = 0;
        for (const { data } of rows) {
          const current = byCode.get(data.code);
          if (!current) {
            toCreate.push(data);
            continue;
          }
          const changes = describeProductChanges(pickInput(current), data);
          if (changes.length === 0) {
            unchanged++;
            continue;
          }
          toUpdate.push({ id: current.id, data, changes });
        }

        // 更新は数百行ずつ 1 文にまとめる（1 行ずつだと DB との往復が行数分かかる）
        for (let i = 0; i < toUpdate.length; i += IMPORT_UPDATE_CHUNK_SIZE) {
          await tx.$executeRaw(
            bulkUpdateSql(toUpdate.slice(i, i + IMPORT_UPDATE_CHUNK_SIZE)),
          );
        }
        const created =
          toCreate.length > 0
            ? await tx.product.createManyAndReturn({
                data: toCreate,
                select: { id: true, code: true, name: true },
              })
            : [];

        // 商品ごとの履歴（画面での登録・編集と同じ形。CSV 取込によるものと分かるようにする）と、件数の要約 1 件
        const result = {
          created: created.length,
          updated: toUpdate.length,
          unchanged,
        };
        await tx.auditLog.createMany({
          data: [
            ...created.map((p) => ({
              userId: auth.user.id,
              action: "create",
              targetType: PRODUCT_TARGET_TYPE,
              targetId: String(p.id),
              summary: `商品 ${p.code}「${p.name}」を登録しました（CSV 取込）`,
            })),
            ...toUpdate.map((u) => ({
              userId: auth.user.id,
              action: "update",
              targetType: PRODUCT_TARGET_TYPE,
              targetId: String(u.id),
              summary: `商品 ${u.data.code} を更新しました（CSV 取込: ${u.changes.join("、")}）`,
            })),
            {
              userId: auth.user.id,
              action: "import",
              targetType: PRODUCT_TARGET_TYPE,
              targetId: null,
              summary: `商品を CSV で取り込みました（${fileName}: 新規 ${result.created} 件・更新 ${result.updated} 件・変更なし ${result.unchanged} 件）`,
            },
          ],
        });
        return result;
      },
      { timeout: 30_000 },
    );
    return { ok: true, data: summary };
  } catch (error) {
    // 取込の途中で別の操作が同じ商品コードを登録した場合
    if (isUniqueViolation(error)) {
      return {
        ok: false,
        error:
          "取込中に同じ商品コードが別の操作で登録されました。もう一度取り込んでください",
      };
    }
    throw error;
  }
}

export type ProductCsvImportResult =
  | { ok: true; data: ProductImportSummary }
  | {
      ok: false;
      error: string;
      /** 行ごとのエラー（行番号付き）。ファイル全体・権限のエラーでは空のこともある */
      errors: ProductImportError[];
      totalErrors: number;
    };

/**
 * CSV 取込（ファイルの検証 → 書き込み）。Server Action から呼ぶ本体。
 * 1 行でもエラーがあれば DB には何も書かない
 */
export async function importProductCsv(
  db: PrismaClient,
  user: SessionUser | null,
  bytes: Uint8Array,
  fileName: string,
): Promise<ProductCsvImportResult> {
  const auth = checkRole(user, "csv:import");
  if (!auth.ok) return { ...auth, errors: [], totalErrors: 0 };

  const parsed = parseProductImport(bytes);
  if (!parsed.ok) {
    return {
      ok: false,
      error:
        "エラーがあるため取り込みませんでした（1 件も登録・更新していません）。修正してからもう一度取り込んでください",
      errors: parsed.errors,
      totalErrors: parsed.totalErrors,
    };
  }
  const result = await importProducts(db, auth.user, parsed.rows, fileName);
  return result.ok ? result : { ...result, errors: [], totalErrors: 0 };
}
