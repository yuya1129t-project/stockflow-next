import type { Metadata } from "next";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { requirePermission } from "@/lib/auth/guards";
import { ROLE_LABELS } from "@/lib/auth/permissions";
import { jstDateString } from "@/lib/dashboard/period";
import { getPrisma } from "@/lib/db";
import { listUsers } from "@/lib/users/queries";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "ユーザー管理 | StockFlow" };

/** ユーザー管理（admin のみ。spec §2・§5-8）。一覧から詳細（ロール変更・無効化・API トークン）へ */
export default async function UsersPage() {
  const currentUser = await requirePermission("user:manage");
  const users = await listUsers(getPrisma());

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-xl font-semibold tracking-tight">
          ユーザー管理
        </h1>
        <Link href="/users/new" className={buttonVariants({ size: "sm" })}>
          新規登録
        </Link>
      </div>

      <p className="text-sm text-muted-foreground">
        「デモ」の付いたアカウントはほかの閲覧者もデモで使うため、ロール変更・無効化・パスワード再設定はできません。
      </p>

      <div className="rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名前</TableHead>
              <TableHead>メールアドレス</TableHead>
              <TableHead>ロール</TableHead>
              <TableHead>状態</TableHead>
              <TableHead className="hidden md:table-cell">作成日</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((u) => (
              <TableRow
                key={u.id}
                className={cn(!u.isActive && "text-muted-foreground")}
              >
                <TableCell className="min-w-32 whitespace-normal">
                  <Link
                    href={`/users/${u.id}`}
                    className="mr-1 underline-offset-4 hover:underline"
                  >
                    {u.name}
                  </Link>
                  {u.isDemo && <Badge variant="secondary">デモ</Badge>}
                  {u.id === currentUser.id && (
                    <Badge variant="outline" className="ml-1">
                      自分
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="break-all whitespace-normal">
                  {u.email}
                </TableCell>
                <TableCell>{ROLE_LABELS[u.role]}</TableCell>
                <TableCell>
                  {u.isActive ? "有効" : <Badge variant="outline">無効</Badge>}
                </TableCell>
                <TableCell className="hidden tabular-nums md:table-cell">
                  {jstDateString(u.createdAt).replaceAll("-", "/")}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
