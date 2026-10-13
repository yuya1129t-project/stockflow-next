import type { Metadata } from "next";
import Form from "next/form";
import Link from "next/link";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
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
import { requirePermission } from "@/lib/auth/guards";
import { can } from "@/lib/auth/permissions";
import { getPrisma } from "@/lib/db";
import { formatNumber } from "@/lib/format";
import { listPartners } from "@/lib/partners/queries";
import {
  formatPostalCode,
  PARTNER_KIND_LABELS,
  PARTNER_KINDS,
} from "@/lib/partners/schema";
import {
  parsePartnerListParams,
  PARTNER_KIND_FILTER_LABELS,
  PARTNER_STATUS_LABELS,
  PARTNER_STATUSES,
  toPartnerListQuery,
  type PartnerListParams,
  type PartnerSortKey,
} from "@/lib/partners/search-params";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "取引先 | StockFlow" };

const COLUMNS: {
  label: string;
  sort?: PartnerSortKey;
  className?: string;
}[] = [
  { label: "取引先コード", sort: "code" },
  { label: "取引先名", sort: "name" },
  { label: "種別", sort: "kind" },
  { label: "住所", className: "hidden lg:table-cell" },
  { label: "電話番号", className: "hidden md:table-cell" },
];

function href(params: PartnerListParams, change: Partial<PartnerListParams>) {
  const query = toPartnerListQuery({ ...params, ...change });
  return query ? `/partners?${query}` : "/partners";
}

/** 取引先一覧（検索・種別の絞り込み・並べ替え・ページ送り）。spec §5-4 */
export default async function PartnersPage({
  searchParams,
}: PageProps<"/partners">) {
  const user = await requirePermission("view");
  const params = parsePartnerListParams(await searchParams);
  const result = await listPartners(getPrisma(), params);
  const shown = { ...params, page: result.page };
  const from = result.total === 0 ? 0 : (result.page - 1) * result.perPage + 1;
  const to = Math.min(result.page * result.perPage, result.total);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-xl font-semibold tracking-tight">取引先</h1>
        {can(user.role, "master:edit") && (
          <Link href="/partners/new" className={buttonVariants({ size: "sm" })}>
            新規登録
          </Link>
        )}
      </div>

      <Form
        action="/partners"
        className="flex flex-wrap items-end gap-2 rounded-xl border p-3"
      >
        <div className="grid w-full gap-1 sm:w-64">
          <label htmlFor="q" className="text-xs text-muted-foreground">
            キーワード
          </label>
          <Input
            id="q"
            name="q"
            type="search"
            defaultValue={params.q}
            placeholder="取引先コード・取引先名"
          />
        </div>
        <div className="grid gap-1">
          <label htmlFor="kind" className="text-xs text-muted-foreground">
            種別
          </label>
          <NativeSelect id="kind" name="kind" defaultValue={params.kind}>
            <NativeSelectOption value="">すべて</NativeSelectOption>
            {PARTNER_KINDS.map((kind) => (
              <NativeSelectOption key={kind} value={kind}>
                {PARTNER_KIND_FILTER_LABELS[kind]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1">
          <label htmlFor="status" className="text-xs text-muted-foreground">
            状態
          </label>
          <NativeSelect id="status" name="status" defaultValue={params.status}>
            {PARTNER_STATUSES.map((s) => (
              <NativeSelectOption key={s} value={s}>
                {PARTNER_STATUS_LABELS[s]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        {/* 並べ替えは検索し直しても保つ（ページは 1 に戻す） */}
        <input type="hidden" name="sort" value={params.sort} />
        <input type="hidden" name="order" value={params.order} />
        <div className="flex gap-2">
          <Button type="submit">検索</Button>
          <Link
            href="/partners"
            className={buttonVariants({ variant: "ghost" })}
          >
            条件をクリア
          </Link>
        </div>
      </Form>

      <p className="text-sm text-muted-foreground" aria-live="polite">
        {result.total === 0
          ? "該当する取引先はありません"
          : `全 ${formatNumber(result.total)} 件中 ${formatNumber(from)}〜${formatNumber(to)} 件`}
      </p>

      {result.total > 0 && (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                {COLUMNS.map((column) => {
                  const active = column.sort === params.sort;
                  return (
                    <TableHead
                      key={column.label}
                      className={column.className}
                      aria-sort={
                        active
                          ? params.order === "asc"
                            ? "ascending"
                            : "descending"
                          : undefined
                      }
                    >
                      {column.sort ? (
                        <Link
                          href={href(params, {
                            sort: column.sort,
                            order:
                              active && params.order === "asc" ? "desc" : "asc",
                            page: 1,
                          })}
                          className="inline-flex items-center gap-1 hover:underline"
                        >
                          {column.label}
                          <span aria-hidden="true" className="text-xs">
                            {active
                              ? params.order === "asc"
                                ? "▲"
                                : "▼"
                              : "↕"}
                          </span>
                        </Link>
                      ) : (
                        column.label
                      )}
                    </TableHead>
                  );
                })}
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.items.map((p) => (
                <TableRow
                  key={p.id}
                  className={cn(!p.isActive && "text-muted-foreground")}
                >
                  <TableCell className="font-mono">
                    <Link
                      href={`/partners/${p.id}`}
                      className="underline-offset-4 hover:underline"
                    >
                      {p.code}
                    </Link>
                  </TableCell>
                  <TableCell className="min-w-32 whitespace-normal">
                    <span className="mr-1">{p.name}</span>
                    {!p.isActive && <Badge variant="outline">無効</Badge>}
                  </TableCell>
                  <TableCell>{PARTNER_KIND_LABELS[p.kind]}</TableCell>
                  <TableCell className="hidden whitespace-normal lg:table-cell">
                    {p.postalCode && (
                      <span className="mr-1 text-muted-foreground tabular-nums">
                        〒{formatPostalCode(p.postalCode)}
                      </span>
                    )}
                    {p.address}
                  </TableCell>
                  <TableCell className="hidden tabular-nums md:table-cell">
                    {p.phone}
                  </TableCell>
                </TableRow>
              ))}
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
