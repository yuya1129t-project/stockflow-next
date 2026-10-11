import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getCurrentUser } from "@/lib/auth/guards";
import { safeCallbackPath } from "@/lib/auth/session";

import { DEMO_PASSWORD, DEMO_USERS } from "../../../prisma/seed-data";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "ログイン | StockFlow" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const { callbackUrl } = await searchParams;
  const callbackPath = safeCallbackPath(callbackUrl);

  // ログイン済みならログイン画面は出さない
  if (await getCurrentUser()) redirect(callbackPath);

  return (
    <main className="flex flex-1 items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-1 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">StockFlow</h1>
          <p className="text-sm text-muted-foreground">
            受発注・在庫管理（デモ）
          </p>
        </div>
        <LoginForm
          callbackUrl={callbackPath}
          demoAccounts={DEMO_USERS.map(({ email, role, name }) => ({
            email,
            role,
            name,
          }))}
          demoPassword={DEMO_PASSWORD}
        />
      </div>
    </main>
  );
}
