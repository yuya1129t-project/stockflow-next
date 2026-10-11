"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

export interface SidebarNavItem {
  label: string;
  href: string;
  ready: boolean;
}

/** 表示中の画面がその項目の配下か（/products/123 でも「商品」を強調する。"/" は完全一致だけ） */
export function isNavItemActive(pathname: string, href: string): boolean {
  return pathname === href || (href !== "/" && pathname.startsWith(`${href}/`));
}

/** サイドバーのメニュー。未実装の画面はリンクにせず「準備中」と表示する */
export function SidebarNav({ items }: { items: SidebarNavItem[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label="メインメニュー">
      <ul className="space-y-0.5">
        {items.map((item) => {
          const active = isNavItemActive(pathname, item.href);
          return (
            <li key={item.href}>
              {item.ready ? (
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex items-center rounded-lg px-3 py-2 text-sm hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                    active &&
                      "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
                  )}
                >
                  {item.label}
                </Link>
              ) : (
                <span
                  aria-disabled="true"
                  className="flex cursor-default items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground"
                >
                  {item.label}
                  <span className="rounded border px-1.5 py-px text-[0.7rem]">
                    準備中
                  </span>
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** スマホ幅用: メニューを開閉できるようにする（画面を移動したら閉じる） */
export function MobileNav({ items }: { items: SidebarNavItem[] }) {
  const pathname = usePathname();
  return (
    <details key={pathname} className="shrink-0 md:hidden">
      <summary className="cursor-pointer list-none rounded-lg border px-3 py-1.5 text-sm whitespace-nowrap select-none">
        メニュー
      </summary>
      <div className="absolute inset-x-0 top-full z-20 border-b bg-sidebar p-3 shadow-sm">
        <SidebarNav items={items} />
      </div>
    </details>
  );
}
