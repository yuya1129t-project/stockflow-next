"use server";

/** ログアウトの Server Action（ログインは HTTP の /api/auth/sign-in/email を経由する。login-form.tsx） */
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { getAuth } from "./auth";

export async function logout(): Promise<void> {
  await getAuth().api.signOut({ headers: await headers() });
  redirect("/login");
}
