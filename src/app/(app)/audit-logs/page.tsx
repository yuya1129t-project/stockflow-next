import type { Metadata } from "next";
import Form from "next/form";
import Link from "next/link";
import type { ReactNode } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { auditLogFilterOptions, listAuditLogs } from "@/lib/audit-logs/queries";
import {
  auditActionLabel,
  auditTargetPath,
  auditTargetTypeLabel,
  parseAuditLogListParams,
  toAuditLogListQuery,
  type AuditLogListParams,
} from "@/lib/audit-logs/search-params";
import { requirePermission } from "@/lib/auth/guards";
import { getPrisma } from "@/lib/db";
import { formatDateTime, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "操作履歴 | StockFlow" };

function href(params: AuditLogListParams, change: Partial<AuditLogListParams>) {
  const query = toAuditLogListQuery({ ...params, ...change });
  return query ? `/audit-logs?${query}` : "/audit-logs";
}

/** 操作履歴（admin のみ。spec §2・§5-9）: 新しい順の一覧、ユーザー・操作・対象の種類・期間で絞り込み */
export default async function AuditLogsPage({
  searchParams,
}: PageProps<"/audit-logs">) {
  await requirePermission("audit:view");
  const params = parseAuditLogListParams(await searchParams);
  const db = getPrisma();
  const [result, options] = await Promise.all([
    listAuditLogs(db, params),
    auditLogFilterOptions(db),
  ]);
  const shown = { ...params, page: result.page };
  const from = result.total === 0 ? 0 : (result.page - 1) * result.perPage + 1;
  const to = Math.min(result.page * result.perPage, result.total);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">操作履歴</h1>

      <Form
        action="/audit-logs"
        className="flex flex-wrap items-end gap-2 rounded-xl border p-3"
      >
        <div className="grid gap-1">
          <label htmlFor="user" className="text-xs text-muted-foreground">
            ユーザー
          </label>
          <NativeSelect id="user" name="user" defaultValue={params.userId}>
            <NativeSelectOption value="">すべて</NativeSelectOption>
            {options.users.map((u) => (
              <NativeSelectOption key={u.id} value={u.id}>
                {u.name}（{u.email}）
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1">
          <label htmlFor="action" className="text-xs text-muted-foreground">
            操作
          </label>
          <NativeSelect id="action" name="action" defaultValue={params.action}>
            <NativeSelectOption value="">すべて</NativeSelectOption>
            {options.actions.map((action) => (
              <NativeSelectOption key={action} value={action}>
                {auditActionLabel(action)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1">
          <label htmlFor="targetType" className="text-xs text-muted-foreground">
            対象の種類
          </label>
          <NativeSelect
            id="targetType"
            name="targetType"
            defaultValue={params.targetType}
          >
            <NativeSelectOption value="">すべて</NativeSelectOption>
            {options.targetTypes.map((type) => (
              <NativeSelectOption key={type} value={type}>
                {auditTargetTypeLabel(type)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1">
          <span className="text-xs text-muted-foreground">期間</span>
          <div className="flex items-center gap-1">
            <Input
              id="from"
              name="from"
              type="date"
              aria-label="期間（から）"
              className="w-40"
              defaultValue={params.from}
            />
            <span className="text-sm text-muted-foreground">〜</span>
            <Input
              id="to"
              name="to"
              type="date"
              aria-label="期間（まで）"
              className="w-40"
              defaultValue={params.to}
            />
          </div>
        </div>
        <div className="flex gap-2">
          <Button type="submit">絞り込む</Button>
          <Link
            href="/audit-logs"
            className={buttonVariants({ variant: "ghost" })}
          >
            条件をクリア
          </Link>
        </div>
      </Form>

      <p className="text-sm text-muted-foreground" aria-live="polite">
        {result.total === 0
          ? "該当する操作履歴はありません"
          : `全 ${formatNumber(result.total)} 件中 ${formatNumber(from)}〜${formatNumber(to)} 件（新しい順）`}
      </p>

      {result.total > 0 && (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>日時</TableHead>
                <TableHead>ユーザー</TableHead>
                <TableHead>操作</TableHead>
                <TableHead>対象</TableHead>
                <TableHead>内容</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.items.map((log) => {
                const path = auditTargetPath(log.targetType, log.targetId);
                return (
                  <TableRow key={log.id}>
                    <TableCell className="tabular-nums">
                      {formatDateTime(log.createdAt)}
                    </TableCell>
                    <TableCell>
                      {log.user ? (
                        log.user.name
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>{auditActionLabel(log.action)}</TableCell>
                    <TableCell>
                      {log.targetType ? (
                        path ? (
                          <Link
                            href={path}
                            className="underline-offset-4 hover:underline"
                          >
                            {auditTargetTypeLabel(log.targetType)}
                          </Link>
                        ) : (
                          auditTargetTypeLabel(log.targetType)
                        )
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="min-w-64 whitespace-normal">
                      {log.summary}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {result.totalPages > 1 && (
        <nav
          aria-label="ページ送り"
          className="flex items-center justify-center gap-2 text-sm"
        >
          <PageLink
            disabled={result.page <= 1}
            href={href(shown, { page: result.page - 1 })}
          >
            前へ
          </PageLink>
          <span className="tabular-nums">
            {result.page} / {result.totalPages} ページ
          </span>
          <PageLink
            disabled={result.page >= result.totalPages}
            href={href(shown, { page: result.page + 1 })}
          >
            次へ
          </PageLink>
        </nav>
      )}
    </div>
  );
}

function PageLink({
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
