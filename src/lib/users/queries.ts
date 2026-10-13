/**
 * ユーザー管理の読み取り（一覧・詳細）。サーバー側でだけ使う。権限の検査は呼び出し側（画面のガード）で行う
 */
import type { PrismaClient } from "@/generated/prisma/client";
import type { Role } from "@/lib/auth/permissions";

import { isProtectedDemoUser } from "./service";

export interface UserListItem {
  id: string;
  name: string;
  email: string;
  role: Role;
  isActive: boolean;
  createdAt: Date;
  /** デモ用アカウント（変更不可） */
  isDemo: boolean;
}

/** ユーザーの一覧（社内の数名を想定しているので、ページ送りはせず全件。登録順） */
export async function listUsers(db: PrismaClient): Promise<UserListItem[]> {
  const users = await db.user.findMany({
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      isActive: true,
      createdAt: true,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return users.map((u) => ({ ...u, isDemo: isProtectedDemoUser(u.id) }));
}

export interface ApiTokenListItem {
  id: number;
  name: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export interface UserDetail extends UserListItem {
  /** トークン本体・ハッシュは含めない */
  apiTokens: ApiTokenListItem[];
}

/** ユーザーの詳細と API トークンの一覧（有効なものを新しい順に、そのあと失効したものを失効の新しい順に） */
export async function getUserDetail(
  db: PrismaClient,
  id: string,
): Promise<UserDetail | null> {
  const user = await db.user.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      isActive: true,
      createdAt: true,
      apiTokens: {
        select: {
          id: true,
          name: true,
          createdAt: true,
          lastUsedAt: true,
          revokedAt: true,
        },
        orderBy: [
          { revokedAt: { sort: "desc", nulls: "first" } },
          { id: "desc" },
        ],
      },
    },
  });
  return user ? { ...user, isDemo: isProtectedDemoUser(user.id) } : null;
}
