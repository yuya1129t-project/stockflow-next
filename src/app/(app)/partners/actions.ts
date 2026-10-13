"use server";

/**
 * 取引先の Server Action（登録・編集・無効化／再有効化）。
 *
 * 権限外・入力エラーは redirect / forbidden せず { ok: false, error } を返す（入力内容を消さない）。
 * Server Action は POST で呼ばれ、Next.js が Origin と Host の一致を確認する（CSRF 対策）
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { checkActionPermission } from "@/lib/auth/guards";
import { getPrisma } from "@/lib/db";
import {
  createPartner,
  setPartnerActive,
  updatePartner,
  type PartnerMutationError,
} from "@/lib/partners/service";

function refreshPartnerPages() {
  revalidatePath("/partners", "layout");
}

/** 登録。成功したら詳細画面へ移動する */
export async function createPartnerAction(
  input: unknown,
): Promise<PartnerMutationError> {
  const check = await checkActionPermission("master:edit");
  if (!check.ok) return check;
  const result = await createPartner(getPrisma(), check.user, input);
  if (!result.ok) return result;
  refreshPartnerPages();
  redirect(`/partners/${result.data.id}?saved=created`);
}

/** 編集。成功したら詳細画面へ移動する */
export async function updatePartnerAction(
  id: number,
  input: unknown,
): Promise<PartnerMutationError> {
  const check = await checkActionPermission("master:edit");
  if (!check.ok) return check;
  if (!Number.isSafeInteger(id)) {
    return { ok: false, error: "取引先が見つかりません" };
  }
  const result = await updatePartner(getPrisma(), check.user, id, input);
  if (!result.ok) return result;
  refreshPartnerPages();
  redirect(`/partners/${id}?saved=updated`);
}

/** 無効化・再有効化（admin のみ） */
export async function setPartnerActiveAction(
  id: number,
  isActive: boolean,
): Promise<{ ok: true } | PartnerMutationError> {
  const check = await checkActionPermission("master:deactivate");
  if (!check.ok) return check;
  if (!Number.isSafeInteger(id) || typeof isActive !== "boolean") {
    return { ok: false, error: "取引先が見つかりません" };
  }
  const result = await setPartnerActive(getPrisma(), check.user, id, isActive);
  if (!result.ok) return result;
  refreshPartnerPages();
  return { ok: true };
}
