import type { Metadata } from "next";

import { requirePermission } from "@/lib/auth/guards";

export const metadata: Metadata = { title: "ユーザー管理 | StockFlow" };

/** ユーザー管理（admin のみ）。画面は #10 で作る。権限の検査だけ先に入れておく */
export default async function UsersPage() {
  await requirePermission("user:manage");
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">ユーザー管理</h1>
      <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
        この画面は準備中です。
      </p>
    </div>
  );
}
