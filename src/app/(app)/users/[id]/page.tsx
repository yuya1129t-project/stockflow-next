import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { requirePermission } from "@/lib/auth/guards";
import { ROLE_LABELS } from "@/lib/auth/permissions";
import { formatDateTime } from "@/lib/format";
import { getPrisma } from "@/lib/db";
import { getUserDetail } from "@/lib/users/queries";
import { MAX_ACTIVE_API_TOKENS_PER_USER } from "@/lib/users/service";

import { ApiTokensPanel } from "./api-tokens";
import { PasswordResetForm, RoleForm, UserActiveToggle } from "./user-controls";

export const metadata: Metadata = { title: "ユーザーの詳細 | StockFlow" };

const SAVED_MESSAGES: Record<string, string> = {
  created: "ユーザーを登録しました",
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3 rounded-xl border p-4">
      <h2 className="font-medium">{title}</h2>
      {children}
    </section>
  );
}

/** ユーザーの詳細（admin のみ）: ロール変更・無効化・パスワード再設定・API トークン。spec §5-8 */
export default async function UserDetailPage({
  params,
  searchParams,
}: PageProps<"/users/[id]">) {
  const currentUser = await requirePermission("user:manage");
  const { id } = await params;
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) notFound();
  const user = await getUserDetail(getPrisma(), id);
  if (!user) notFound();
  const saved = (await searchParams).saved;
  const savedMessage =
    typeof saved === "string" ? SAVED_MESSAGES[saved] : undefined;
  const isSelf = user.id === currentUser.id;

  const rows: [string, ReactNode][] = [
    ["名前", user.name],
    [
      "メールアドレス",
      <span key="email" className="break-all">
        {user.email}
      </span>,
    ],
    ["ロール", `${ROLE_LABELS[user.role]}（${user.role}）`],
    [
      "状態",
      user.isActive ? (
        "有効"
      ) : (
        <Badge key="status" variant="outline">
          無効
        </Badge>
      ),
    ],
    ["作成日時", formatDateTime(user.createdAt)],
  ];

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Link
          href="/users"
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          ← ユーザー一覧
        </Link>
        <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight">
          {user.name}
          {user.isDemo && <Badge variant="secondary">デモ</Badge>}
          {isSelf && <Badge variant="outline">自分</Badge>}
        </h1>
      </div>

      {savedMessage && (
        <p
          role="status"
          className="rounded-lg border border-emerald-600/30 bg-emerald-600/5 px-3 py-2 text-sm"
        >
          {savedMessage}
        </p>
      )}

      <dl className="grid max-w-xl grid-cols-[8rem_1fr] gap-x-4 gap-y-2 rounded-xl border p-4 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 break-words">{value}</dd>
          </div>
        ))}
      </dl>

      <div className="max-w-3xl space-y-4">
        <Section title="アカウントの操作">
          {user.isDemo ? (
            <p className="text-sm text-muted-foreground">
              デモ用アカウントは、ほかの閲覧者もデモで使うため、ロール変更・無効化・パスワード再設定はできません。操作を試すときは新しいユーザーを登録してください。
            </p>
          ) : (
            <div className="space-y-5">
              {isSelf ? (
                <p className="text-sm text-muted-foreground">
                  自分自身のロール変更・無効化はできません（ほかの管理者に依頼してください）。
                </p>
              ) : (
                <>
                  <RoleForm userId={user.id} role={user.role} />
                  <div className="space-y-2">
                    <p className="text-sm font-medium">有効／無効</p>
                    <UserActiveToggle
                      userId={user.id}
                      name={user.name}
                      isActive={user.isActive}
                    />
                  </div>
                </>
              )}
              <PasswordResetForm userId={user.id} isSelf={isSelf} />
            </div>
          )}
        </Section>

        <Section title="API トークン">
          <p className="text-sm text-muted-foreground">
            外部向け REST
            API（/api/v1）の認証に使います。権限はこのユーザーのロールに従います。トークンは発行時に
            1 回だけ表示し、保存するのはハッシュだけです（有効なトークンは 1
            ユーザー {MAX_ACTIVE_API_TOKENS_PER_USER} 件まで）。
            {!user.isActive && " 無効なユーザーには発行できません。"}
          </p>
          <ApiTokensPanel
            userId={user.id}
            canIssue={user.isActive}
            tokens={user.apiTokens.map((t) => ({
              id: t.id,
              name: t.name,
              createdAt: formatDateTime(t.createdAt),
              lastUsedAt: t.lastUsedAt ? formatDateTime(t.lastUsedAt) : null,
              revokedAt: t.revokedAt ? formatDateTime(t.revokedAt) : null,
            }))}
          />
        </Section>
      </div>
    </div>
  );
}
