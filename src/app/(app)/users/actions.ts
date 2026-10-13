"use server";

/**
 * ユーザー管理・API トークンの Server Action（admin のみ）。
 *
 * 権限外・入力エラーは redirect / forbidden せず { ok: false, error } を返す（入力内容を消さない）。
 * Server Action は POST で呼ばれ、Next.js が Origin と Host の一致を確認する（CSRF 対策）
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { checkActionPermission } from "@/lib/auth/guards";
import { getPrisma } from "@/lib/db";
import {
  changeUserRole,
  createUser,
  issueApiToken,
  resetUserPassword,
  revokeApiToken,
  setUserActive,
  type UserMutationError,
} from "@/lib/users/service";

const USER_NOT_FOUND: UserMutationError = {
  ok: false,
  error: "ユーザーが見つかりません",
};

function isUserId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value);
}

function refreshUserPages() {
  revalidatePath("/users", "layout");
}

/** 登録。成功したら詳細画面へ移動する */
export async function createUserAction(
  input: unknown,
): Promise<UserMutationError> {
  const check = await checkActionPermission("user:manage");
  if (!check.ok) return check;
  const result = await createUser(getPrisma(), check.user, input);
  if (!result.ok) return result;
  refreshUserPages();
  redirect(`/users/${result.data.id}?saved=created`);
}

/** ロール変更 */
export async function changeUserRoleAction(
  userId: string,
  input: unknown,
): Promise<{ ok: true } | UserMutationError> {
  const check = await checkActionPermission("user:manage");
  if (!check.ok) return check;
  if (!isUserId(userId)) return USER_NOT_FOUND;
  const result = await changeUserRole(getPrisma(), check.user, userId, input);
  if (!result.ok) return result;
  refreshUserPages();
  return { ok: true };
}

/** 無効化・再有効化 */
export async function setUserActiveAction(
  userId: string,
  isActive: boolean,
): Promise<{ ok: true } | UserMutationError> {
  const check = await checkActionPermission("user:manage");
  if (!check.ok) return check;
  if (!isUserId(userId) || typeof isActive !== "boolean") return USER_NOT_FOUND;
  const result = await setUserActive(getPrisma(), check.user, userId, isActive);
  if (!result.ok) return result;
  refreshUserPages();
  return { ok: true };
}

/** パスワード再設定 */
export async function resetUserPasswordAction(
  userId: string,
  input: unknown,
): Promise<{ ok: true } | UserMutationError> {
  const check = await checkActionPermission("user:manage");
  if (!check.ok) return check;
  if (!isUserId(userId)) return USER_NOT_FOUND;
  const result = await resetUserPassword(
    getPrisma(),
    check.user,
    userId,
    input,
  );
  if (!result.ok) return result;
  refreshUserPages();
  return { ok: true };
}

/** API トークンの発行。平文のトークンはこの戻り値でだけ返す（画面に 1 回だけ表示する） */
export async function issueApiTokenAction(
  userId: string,
  input: unknown,
): Promise<{ ok: true; token: string } | UserMutationError> {
  const check = await checkActionPermission("user:manage");
  if (!check.ok) return check;
  if (!isUserId(userId)) return USER_NOT_FOUND;
  const result = await issueApiToken(getPrisma(), check.user, userId, input);
  if (!result.ok) return result;
  refreshUserPages();
  return { ok: true, token: result.data.token };
}

/** API トークンの失効 */
export async function revokeApiTokenAction(
  userId: string,
  tokenId: number,
): Promise<{ ok: true } | UserMutationError> {
  const check = await checkActionPermission("user:manage");
  if (!check.ok) return check;
  if (!isUserId(userId) || !Number.isSafeInteger(tokenId)) {
    return { ok: false, error: "API トークンが見つかりません" };
  }
  const result = await revokeApiToken(getPrisma(), check.user, userId, tokenId);
  if (!result.ok) return result;
  refreshUserPages();
  return { ok: true };
}
