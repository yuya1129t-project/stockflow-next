"use server";

/** ログイン・ログアウトの Server Actions */
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { getAuth } from "./auth";
import { loginErrorMessage, safeCallbackPath } from "./session";

export interface LoginState {
  error?: string;
  email?: string;
}

export async function login(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const callbackPath = safeCallbackPath(formData.get("callbackUrl"));

  if (!email || !password) {
    return { error: "メールアドレスとパスワードを入力してください", email };
  }
  try {
    // 成功するとセッション Cookie が設定される（auth.ts の nextCookies プラグイン）
    await getAuth().api.signInEmail({
      body: { email, password },
      headers: await headers(),
    });
  } catch (error) {
    return { error: loginErrorMessage(error), email };
  }
  redirect(callbackPath);
}

export async function logout(): Promise<void> {
  await getAuth().api.signOut({ headers: await headers() });
  redirect("/login");
}
