import { requirePermission } from "@/lib/auth/guards";
import { ROLE_LABELS } from "@/lib/auth/permissions";

/** ログイン後のトップ（ダッシュボードは #9 で作る。ここでは仮の表示） */
export default async function Home() {
  const user = await requirePermission("view");
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">ダッシュボード</h1>
      <p className="text-sm">
        {user.name} さん（{ROLE_LABELS[user.role]}）としてログインしています。
      </p>
      <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
        ダッシュボード（今月の受注額・未出荷の受注・発注点割れ・入荷待ち）は準備中です。
        各画面も順次追加します。
      </p>
    </div>
  );
}
