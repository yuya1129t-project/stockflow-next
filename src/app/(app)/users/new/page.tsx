import type { Metadata } from "next";
import Link from "next/link";

import { requirePermission } from "@/lib/auth/guards";

import { UserForm } from "../user-form";

export const metadata: Metadata = { title: "ユーザーの登録 | StockFlow" };

/** ユーザーの登録（admin のみ。spec §2） */
export default async function NewUserPage() {
  await requirePermission("user:manage");
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Link
          href="/users"
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          ← ユーザー一覧
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">ユーザーの登録</h1>
      </div>
      <UserForm />
    </div>
  );
}
