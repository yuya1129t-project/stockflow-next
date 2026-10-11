/**
 * ログイン後の共通レイアウト（サイドバー・ヘッダー）。
 *
 * ここでもログインを確認するが、レイアウトは画面遷移のたびに再実行されるとは限らないため、
 * 各画面（page.tsx）でも requireUser() / requirePermission() を必ず呼ぶ
 */
import { MobileNav, SidebarNav } from "@/components/layout/sidebar-nav";
import { Button } from "@/components/ui/button";
import { logout } from "@/lib/auth/actions";
import { requireUser } from "@/lib/auth/guards";
import { can, ROLE_LABELS } from "@/lib/auth/permissions";
import { NAV_ITEMS } from "@/lib/navigation";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const user = await requireUser();
  const items = NAV_ITEMS.filter((item) => can(user.role, item.permission)).map(
    ({ label, href, ready }) => ({ label, href, ready }),
  );

  return (
    <div className="flex flex-1 flex-col md:flex-row">
      <aside className="hidden w-56 shrink-0 border-r bg-sidebar text-sidebar-foreground md:block">
        <div className="px-5 py-4 text-lg font-semibold tracking-tight">
          StockFlow
        </div>
        <div className="px-2 pb-4">
          <SidebarNav items={items} />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="relative flex items-center gap-2 border-b px-3 py-2.5 sm:gap-3 sm:px-4">
          <MobileNav items={items} />
          <span className="hidden font-semibold tracking-tight sm:inline md:hidden">
            StockFlow
          </span>
          <div className="ml-auto flex min-w-0 items-center gap-2 text-sm">
            <span className="min-w-0 truncate">{user.name}</span>
            <span
              className="shrink-0 rounded-full border px-2 py-0.5 text-xs"
              title={`ロール: ${user.role}`}
            >
              {ROLE_LABELS[user.role]}
              <span className="hidden sm:inline">（{user.role}）</span>
            </span>
            <form action={logout} className="shrink-0">
              <Button type="submit" variant="outline" size="sm">
                ログアウト
              </Button>
            </form>
          </div>
        </header>
        <main className="flex-1 p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
