import type { Metadata } from "next";
import Link from "next/link";

import { requireUser } from "@/lib/auth/guards";

export const metadata: Metadata = { title: "403 権限がありません | StockFlow" };

/** 権限外の画面を開いたときの表示（requirePermission からリダイレクトされる） */
export default async function ForbiddenPage() {
  await requireUser();
  return (
    <div className="mx-auto max-w-md space-y-3 py-10 text-center">
      <p className="text-sm font-medium text-muted-foreground">403</p>
      <h1 className="text-xl font-semibold tracking-tight">
        この画面を表示する権限がありません
      </h1>
      <p className="text-sm text-muted-foreground">
        必要な場合は管理者に権限の変更を依頼してください。
      </p>
      <Link
        href="/"
        className="inline-block text-sm underline underline-offset-4"
      >
        トップへ戻る
      </Link>
    </div>
  );
}
