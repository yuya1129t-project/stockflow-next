import Link from "next/link";
import type { ReactNode } from "react";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** ページ送りのリンク（端のページでは押せない表示にする） */
export function PageLink({
  href,
  disabled,
  children,
}: {
  href: string;
  disabled: boolean;
  children: ReactNode;
}) {
  const className = buttonVariants({ variant: "outline", size: "sm" });
  return disabled ? (
    <span
      aria-disabled="true"
      className={cn(className, "pointer-events-none opacity-50")}
    >
      {children}
    </span>
  ) : (
    <Link href={href} className={className}>
      {children}
    </Link>
  );
}
