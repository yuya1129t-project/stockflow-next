import type { Metadata } from "next";

import { requirePermission } from "@/lib/auth/guards";

export const metadata: Metadata = { title: "操作履歴 | StockFlow" };

/** 操作履歴（admin のみ）。画面は #10 で作る。権限の検査だけ先に入れておく */
export default async function AuditLogsPage() {
  await requirePermission("audit:view");
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">操作履歴</h1>
      <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
        この画面は準備中です。
      </p>
    </div>
  );
}
