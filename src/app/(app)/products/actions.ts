"use server";

/**
 * 商品の Server Action（登録・編集・無効化／再有効化・CSV 取込）。
 *
 * 権限外・入力エラーは redirect / forbidden せず { ok: false, error } を返す（入力内容を消さない）。
 * Server Action は POST で呼ばれ、Next.js が Origin と Host の一致を確認する（CSRF 対策）
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { checkActionPermission } from "@/lib/auth/guards";
import { getPrisma } from "@/lib/db";
import {
  PRODUCT_IMPORT_MAX_BYTES,
  type ProductImportError,
} from "@/lib/products/csv";
import {
  createProduct,
  importProductCsv,
  setProductActive,
  updateProduct,
  type MutationError,
  type ProductImportSummary,
} from "@/lib/products/service";

function refreshProductPages() {
  revalidatePath("/products", "layout");
}

/** 登録。成功したら詳細画面へ移動する */
export async function createProductAction(
  input: unknown,
): Promise<MutationError> {
  const check = await checkActionPermission("master:edit");
  if (!check.ok) return check;
  const result = await createProduct(getPrisma(), check.user, input);
  if (!result.ok) return result;
  refreshProductPages();
  redirect(`/products/${result.data.id}?saved=created`);
}

/** 編集。成功したら詳細画面へ移動する */
export async function updateProductAction(
  id: number,
  input: unknown,
): Promise<MutationError> {
  const check = await checkActionPermission("master:edit");
  if (!check.ok) return check;
  if (!Number.isSafeInteger(id)) {
    return { ok: false, error: "商品が見つかりません" };
  }
  const result = await updateProduct(getPrisma(), check.user, id, input);
  if (!result.ok) return result;
  refreshProductPages();
  redirect(`/products/${id}?saved=updated`);
}

/** 無効化・再有効化（admin のみ） */
export async function setProductActiveAction(
  id: number,
  isActive: boolean,
): Promise<{ ok: true } | MutationError> {
  const check = await checkActionPermission("master:deactivate");
  if (!check.ok) return check;
  if (!Number.isSafeInteger(id) || typeof isActive !== "boolean") {
    return { ok: false, error: "商品が見つかりません" };
  }
  const result = await setProductActive(getPrisma(), check.user, id, isActive);
  if (!result.ok) return result;
  refreshProductPages();
  return { ok: true };
}

export type ImportProductsState =
  | { status: "idle" }
  | { status: "success"; fileName: string; summary: ProductImportSummary }
  | {
      status: "error";
      fileName?: string;
      message: string;
      errors: ProductImportError[];
      totalErrors: number;
    };

function importError(message: string, fileName?: string): ImportProductsState {
  return { status: "error", fileName, message, errors: [], totalErrors: 0 };
}

/** ファイル名を操作履歴・画面に出せる形にする（制御文字を除き、長さを制限） */
function displayFileName(name: string): string {
  return (
    name.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 100) || "（名前なし）"
  );
}

/** CSV 取込（useActionState から呼ぶ）。1 行でもエラーがあれば何も取り込まない */
export async function importProductsAction(
  _prev: ImportProductsState,
  formData: FormData,
): Promise<ImportProductsState> {
  const check = await checkActionPermission("csv:import");
  if (!check.ok) return importError(check.error);

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return importError("CSV ファイルを選択してください");
  }
  const fileName = displayFileName(file.name);
  if (file.size > PRODUCT_IMPORT_MAX_BYTES) {
    return importError(
      `ファイルが大きすぎます（上限 ${PRODUCT_IMPORT_MAX_BYTES / 1024}KB）`,
      fileName,
    );
  }

  const result = await importProductCsv(
    getPrisma(),
    check.user,
    new Uint8Array(await file.arrayBuffer()),
    fileName,
  );
  if (!result.ok) {
    return {
      status: "error",
      fileName,
      message: result.error,
      errors: result.errors,
      totalErrors: result.totalErrors,
    };
  }
  refreshProductPages();
  return { status: "success", fileName, summary: result.data };
}
